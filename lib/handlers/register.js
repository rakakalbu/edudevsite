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
async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, (SF_PASSWORD || '') + (SF_TOKEN || ''));
  return conn;
}

/* ============== Lookups ============== */
async function getOppRT(conn) {
  // Prefer University RT when available; else fallback to known ID (if valid in your org)
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

/* ============== Lead helpers ============== */
async function findLeadByEmailPhone(conn, email, phone) {
  const q = await conn.query(`
    SELECT Id, IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE Email='${escSOQL(email)}' AND Phone='${escSOQL(phone)}'
    LIMIT 1
  `);
  return q.records?.[0] || null;
}

// Some orgs rename the field (managed packages). Try common variants once.
async function setLeadConvertFlag(conn, leadId) {
  try {
    await conn.sobject('Lead').update({ Id: leadId, Is_Convert__c: true });
    return 'Is_Convert__c';
  } catch (e1) {
    try {
      await conn.sobject('Lead').update({ Id: leadId, Is_Convert__c__c: true });
      return 'Is_Convert__c__c';
    } catch (e2) {
      throw new Error('Failed to set the Lead convert flag (Is_Convert__c)');
    }
  }
}

async function pollConvertedTriple(conn, leadId, timeoutMs = 7000, intervalMs = 600) {
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

/* ============== Direct create path (PersonAcct + Opp) ============== */
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

  // Fetch its auto-created Contact
  const cq = await conn.query(`
    SELECT Id FROM Contact WHERE AccountId='${escSOQL(accRes.id)}' LIMIT 1
  `);

  // Create Opportunity
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

      // Optional extra fields you already send; we pass them through untouched
      campusId, campusName, masterIntakeId, intakeName,
      studyProgramId, studyProgramName, graduationYear,
      schoolId, paymentProof, photo,
    } = req.body || {};

    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const conn = await login();

    // 1) Check Lead by exact Email + Phone
    const lead = await findLeadByEmailPhone(conn, email, phone);

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

      // Not converted yet -> trigger your Apex via checkbox then poll
      await setLeadConvertFlag(conn, lead.Id);

      const triple = await pollConvertedTriple(conn, lead.Id);
      if (triple) {
        return res.json({
          success: true,
          source: 'lead-converted-now',
          ...triple
        });
      }

      // Fallback (async triggers): try to find Contact/Account/Opportunity by email
      const c = await conn.query(`
        SELECT Id, AccountId FROM Contact
        WHERE Email='${escSOQL(email)}' LIMIT 1
      `);

      let opportunityId = null;
      let accountId = c.records?.[0]?.AccountId || null;
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
        source: 'lead-convert-pending',
        accountId, contactId, opportunityId
      });
    }

    // 2) No lead exists -> create Person Account + Contact + Opp
    const created = await createDirect(conn, { firstName, lastName, email, phone });
    return res.json({ success: true, ...created });

  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || String(e) });
  }
}