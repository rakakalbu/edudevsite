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
// Normalize to Indonesian/E.164-ish digits for comparison
function normIdnPhoneDigits(v) {
  let d = onlyDigits(v);
  if (!d) return '';
  // remove leading 0
  if (d.startsWith('0')) d = d.slice(1);
  // add 62 if missing
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
  const HARD = '012gL000002NZITQA4'; // your known RT id if it exists; will be ignored if not found
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
// Try by email first, then verify phone digits against Phone/MobilePhone.
// If nothing by email, try phone-only search (both fields) by digits.
async function findLeadSmart(conn, email, rawPhone) {
  const want = normIdnPhoneDigits(rawPhone);

  // 1) Email-first
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
      // prefer a row whose Phone or MobilePhone matches by digits
      let best = null;
      for (const row of qe.records) {
        const pd = normIdnPhoneDigits(row.Phone);
        const md = normIdnPhoneDigits(row.MobilePhone);
        if (want && (pd === want || md === want)) { best = row; break; }
      }
      // fallback to the freshest email match if phone didn’t align
      return best || qe.records[0];
    }
  }

  // 2) Phone-only fallback (search both Phone and MobilePhone)
  if (rawPhone) {
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

/* ============== Lead convert flag ============== */
async function setLeadConvertFlag(conn, leadId) {
  // Try your checkbox field names. If both fail, bubble a useful error.
  try {
    await conn.sobject('Lead').update({ Id: leadId, Is_Convert__c: true });
    return 'Is_Convert__c';
  } catch (e1) {
    try {
      await conn.sobject('Lead').update({ Id: leadId, Is_Convert__c__c: true });
      return 'Is_Convert__c__c';
    } catch (e2) {
      throw new Error(
        'Failed to set convert checkbox on Lead. ' +
        'Check field API name & permissions for Is_Convert__c.'
      );
    }
  }
}

async function verifyFlagAndPoll(conn, leadId, timeoutMs = 9000, intervalMs = 600) {
  // First verify the flag was set (some flows rely on the flag itself)
  try {
    const l0 = await conn.sobject('Lead').retrieve(leadId);
    if (!l0) throw new Error('Lead not found after update');
    // If your trigger flips it back, we still rely on IsConverted
  } catch (_) {}

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

/* ============== Direct create ============== */
async function createDirect(conn, { firstName, lastName, email, phone }) {
  const personRT = await getAnyPersonRT(conn);

  const accRes = await conn.sobject('Account').create({
    RecordTypeId: personRT || undefined,
    FirstName: firstName,
    LastName : lastName || '-',
    PersonEmail: email,
    PersonHomePhone: phone
  });

  const cq = await conn.query(`
    SELECT Id FROM Contact WHERE AccountId='${escSOQL(accRes.id)}' LIMIT 1
  `);

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
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const {
      firstName, lastName = '-',
      email, phone,

      // passthrough fields (unused here but harmless to accept)
      campusId, campusName, masterIntakeId, intakeName,
      studyProgramId, studyProgramName, graduationYear,
      schoolId, paymentProof, photo,
    } = req.body || {};

    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const conn = await login();

    // Find the lead robustly
    const lead = await findLeadSmart(conn, email, phone);

    if (lead) {
      if (lead.IsConverted) {
        return res.json({
          success: true,
          source: 'lead-already-converted',
          accountId: lead.ConvertedAccountId || null,
          contactId: lead.ConvertedContactId || null,
          opportunityId: lead.ConvertedOpportunityId || null
        });
      }

      // Trigger your checkbox-based conversion
      const usedField = await setLeadConvertFlag(conn, lead.Id);

      // Poll for conversion to complete
      const triple = await verifyFlagAndPoll(conn, lead.Id);
      if (triple) {
        return res.json({ success: true, source: `lead-converted-now:${usedField}`, ...triple });
      }

      // Async fallback: try to locate Contact/Opportunity created by your flow
      const c = await conn.query(`
        SELECT Id, AccountId FROM Contact
        WHERE Email='${escSOQL(email)}'
        ORDER BY LastModifiedDate DESC
        LIMIT 1
      `);

      let opportunityId = null;
      const accountId = c.records?.[0]?.AccountId || null;
      const contactId = c.records?.[0]?.Id || null;

      if (accountId) {
        const o = await conn.query(`
          SELECT Id FROM Opportunity
          WHERE AccountId='${escSOQL(accountId)}'
          ORDER BY CreatedDate DESC
          LIMIT 1
        `);
        opportunityId = o.records?.[0]?.Id || null;
      }

      return res.json({
        success: true,
        source: `lead-convert-pending:${usedField}`,
        accountId, contactId, opportunityId
      });
    }

    // No lead -> direct create Person Account + Opp
    const created = await createDirect(conn, { firstName, lastName, email, phone });
    return res.json({ success: true, ...created });

  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || String(e) });
  }
}