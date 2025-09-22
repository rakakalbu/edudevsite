// src/api/register.js
import jsforce from 'jsforce';

/* ============== Utilities ============== */
function need(v, name) {
  if (!v) throw new Error(`${name} is required`);
  return v;
}
function escSOQL(v = '') {
  return String(v).replace(/'/g, "\\'");
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}
// Normalize to Indonesian/E.164-ish digits for comparison (no plus)
function normIdnPhoneDigits(v) {
  let d = onlyDigits(v);
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('62')) d = '62' + d;
  return d;
}
async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, (SF_PASSWORD || '') + (SF_TOKEN || ''));
  return conn;
}

/* ============== Record Types ============== */
async function getOppRT(conn) {
  // If you have a known RT for Opportunity, keep it here as fallback:
  const HARD = '012gL000002NZITQA4';
  try {
    const rt = await conn.sobject('RecordType').retrieve(HARD);
    if (rt && rt.SobjectType === 'Opportunity') return HARD;
  } catch (_) {}
  const q = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Opportunity' AND (DeveloperName='University' OR Name='University')
    LIMIT 1
  `);
  return q.records?.[0]?.Id || HARD;
}

async function getAnyPersonRT(conn) {
  const q = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Account' AND IsPersonType=true
    LIMIT 1
  `);
  return q.records?.[0]?.Id || null;
}

/* ============== Lead search (robust) ============== */
// Email-first; verify by digits across Phone/MobilePhone; fallback to phone-only.
async function findLeadSmart(conn, email, rawPhone) {
  const want = normIdnPhoneDigits(rawPhone);

  if (email) {
    const qe = await conn.query(`
      SELECT Id, Email, Phone, MobilePhone, IsConverted,
             ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
      FROM Lead
      WHERE Email='${escSOQL(email)}'
      ORDER BY LastModifiedDate DESC
      LIMIT 10
    `);
    if (qe.totalSize > 0) {
      for (const row of qe.records) {
        const pd = normIdnPhoneDigits(row.Phone);
        const md = normIdnPhoneDigits(row.MobilePhone);
        if (want && (pd === want || md === want)) return row;
      }
      // If no exact phone match, take most recent by email
      return qe.records[0];
    }
  }

  if (rawPhone) {
    // We can’t filter by normalized digits in SOQL, so pull a small window and match in JS
    const qp = await conn.query(`
      SELECT Id, Email, Phone, MobilePhone, IsConverted,
             ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
      FROM Lead
      WHERE Phone != null OR MobilePhone != null
      ORDER BY LastModifiedDate DESC
      LIMIT 200
    `);
    const match = qp.records.find(row => {
      const pd = normIdnPhoneDigits(row.Phone);
      const md = normIdnPhoneDigits(row.MobilePhone);
      return (pd && pd === want) || (md && md === want);
    });
    if (match) return match;
  }

  return null;
}

/* ============== Lead convert helpers ============== */
async function getAnyConvertedLeadStatus(conn) {
  const q = await conn.query(`
    SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1
  `);
  return q.records?.[0]?.MasterLabel || 'Qualified';
}

// Best-effort set your checkbox so existing Apex/Flow can still react (optional).
async function setLeadConvertFlagBestEffort(conn, leadId) {
  try {
    await conn.sobject('Lead').update({ Id: leadId, Is_Convert__c: true });
    return 'Is_Convert__c';
  } catch {
    try {
      await conn.sobject('Lead').update({ Id: leadId, Is_Convert__c__c: true });
      return 'Is_Convert__c__c';
    } catch {
      return 'flag-not-set';
    }
  }
}

async function leadConvertAPI(conn, leadId) {
  const convertedStatus = await getAnyConvertedLeadStatus(conn);
  const result = await conn.sobject('Lead').convert([{
    leadId,
    convertedStatus,
    doNotCreateOpportunity: false,    // we DO want an opp
    sendNotificationEmail: false,
  }]);
  const r = Array.isArray(result) ? result[0] : result;

  if (!r.success) {
    const msg = (r.errors && r.errors[0] && r.errors[0].message) || 'Lead conversion failed';

    // If it says "already converted", recover by re-reading the lead
    if (/converted lead/i.test(msg) || /update converted lead/i.test(msg)) {
      const l = await conn.sobject('Lead').retrieve(leadId);
      if (l?.IsConverted) {
        return {
          accountId: l.ConvertedAccountId || r.accountId || null,
          contactId: l.ConvertedContactId || r.contactId || null,
          opportunityId: l.ConvertedOpportunityId || r.opportunityId || null,
        };
      }
    }
    throw new Error(msg);
  }

  return {
    accountId: r.accountId || null,
    contactId: r.contactId || null,
    opportunityId: r.opportunityId || null,
  };
}

async function pollConvertedTriple(conn, leadId, timeoutMs = 8000, intervalMs = 600) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const l = await conn.sobject('Lead').retrieve(leadId);
    if (l.IsConverted) {
      return {
        accountId: l.ConvertedAccountId || null,
        contactId: l.ConvertedContactId || null,
        opportunityId: l.ConvertedOpportunityId || null,
      };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/* ============== Direct create (Person Account + Opp) ============== */
async function createDirect(conn, { firstName, lastName, email, phone }) {
  const personRT = await getAnyPersonRT(conn);

  // Create Person Account
  const accRes = await conn.sobject('Account').create({
    RecordTypeId: personRT || undefined,
    FirstName: firstName,
    LastName : lastName || '-',
    PersonEmail: email,
    PersonHomePhone: phone
  });

  // Get the Contact Salesforce auto-created for the Person Account
  const cq = await conn.query(`
    SELECT Id FROM Contact WHERE AccountId='${escSOQL(accRes.id)}' LIMIT 1
  `);

  // Create Opportunity attached to the new Account
  const oppRes = await conn.sobject('Opportunity').create({
    Name: `${(firstName || '')} ${(lastName || '')}/REG`.trim(),
    AccountId: accRes.id,
    StageName: 'Prospecting',
    CloseDate: today(),
    RecordTypeId: await getOppRT(conn)
  });

  return {
    accountId: accRes.id,
    contactId: cq.records?.[0]?.Id || null,
    opportunityId: oppRes.id,
    source: 'direct-create'
  };
}

/* ============== API Handler ============== */
// This endpoint implements:
//   - find existing Lead by email/phone → convert → return triple
//   - else create Person Account + Contact + Opportunity → return triple
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const {
      firstName, lastName = '-',
      email, phone,

      // passthrough (accepted but unused here; keep for future use)
      campusId, campusName, masterIntakeId, intakeName,
      studyProgramId, studyProgramName, graduationYear,
      schoolId, paymentProof, photo,
    } = req.body || {};

    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const conn = await login();

    // 1) Robust lead lookup (email + phone matching)
    const lead = await findLeadSmart(conn, email, phone);

    if (lead) {
      if (lead.IsConverted) {
        // Already converted — give the converted triple
        return res.json({
          success: true,
          source: 'lead-already-converted',
          accountId: lead.ConvertedAccountId || null,
          contactId: lead.ConvertedContactId || null,
          opportunityId: lead.ConvertedOpportunityId || null
        });
      }

      // 2) Convert the lead now
      const flagField = await setLeadConvertFlagBestEffort(conn, lead.Id);

      let triple = null;
      try {
        triple = await leadConvertAPI(conn, lead.Id);
      } catch (err) {
        // If your org has async/racy automation, poll briefly as last resort
        const polled = await pollConvertedTriple(conn, lead.Id, 8000, 600);
        if (polled) triple = polled;
        else throw err; // bubble up real error to client
      }

      // 2c) Sometimes the conversion doesn't create an Opp (org config); pick latest if missing
      if (triple && triple.accountId && !triple.opportunityId) {
        const oq = await conn.query(`
          SELECT Id FROM Opportunity
          WHERE AccountId='${escSOQL(triple.accountId)}'
          ORDER BY CreatedDate DESC
          LIMIT 1
        `);
        triple.opportunityId = oq.records?.[0]?.Id || null;
      }

      return res.json({ success: true, source: `lead-converted:${flagField}`, ...triple });
    }

    // 3) No matching lead → direct create Person Account + Contact + Opp
    const created = await createDirect(conn, { firstName, lastName, email, phone });
    return res.json({ success: true, ...created });

  } catch (e) {
    // Don’t leak SF stack traces
    return res.status(400).json({ success: false, message: e.message || String(e) });
  }
}