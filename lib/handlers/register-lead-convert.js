// src/api/register-lead-convert.js
// Safe "lead → convert or create" endpoint.
// - Never updates a converted Lead
// - Triggers conversion via Is_Convert__c and polls briefly
// - Reuses converted Account/Opportunity when available
// - Falls back to new Person Account + Opportunity if conversion isn't ready
// - Populates both Account.Phone and PersonMobilePhone
// - StageName for new Opps starts at "Booking Form"

const jsforce = require('jsforce');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/\D/g, '');
function normalizePhone(raw) {
  let p = digits(raw || '');
  if (!p) return null;
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return '+' + p;
}
function escSOQL(v) { return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function getOppUniversityRT(conn) {
  const r = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType='Opportunity' AND (DeveloperName='University' OR Name='University')
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}
async function getPersonAcctRT(conn) {
  const r = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType='Account' AND IsPersonType=true
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}

async function createPersonAccAndOpp(conn, { firstName, lastName, email, phoneE164 }) {
  const personRT = await getPersonAcctRT(conn);
  const oppRT    = await getOppUniversityRT(conn);

  // Person Account: populate BOTH Phone and PersonMobilePhone
  const accRes = await conn.sobject('Account').create({
    RecordTypeId: personRT || undefined,
    FirstName: firstName,
    LastName : lastName,
    PersonEmail: (email || '').toLowerCase(),
    Phone: phoneE164,
    PersonMobilePhone: phoneE164
  }, { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } });
  if (!accRes.success) {
    throw new Error((accRes.errors && accRes.errors.join(', ')) || 'Gagal membuat Account');
  }

  const closeDate = new Date(); closeDate.setDate(closeDate.getDate() + 30);
  const oppRes = await conn.sobject('Opportunity').create({
    RecordTypeId: oppRT || undefined,
    AccountId: accRes.id,
    Name: `${firstName || ''} ${lastName || ''}/REG`.trim(),
    StageName: 'Booking Form',
    CloseDate: closeDate.toISOString().slice(0, 10)
  }, { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } });
  if (!oppRes.success) {
    throw new Error((oppRes.errors && oppRes.errors.join(', ')) || 'Gagal membuat Opportunity');
  }

  return { accountId: accRes.id, opportunityId: oppRes.id };
}

async function refetchLead(conn, id) {
  const q = await conn.query(`
    SELECT Id, IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE Id='${escSOQL(id)}'
    LIMIT 1
  `);
  return q.records?.[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { firstName, lastName, email, phone } = req.body || {};
    if (!firstName || !lastName || !email || !phone) {
      throw new Error('Data tidak lengkap');
    }

    const phoneE164 = normalizePhone(phone);
    const conn = await login();

    // Find most recent lead by email or phone (permissive like your original)
    const phoneDigits = digits(phoneE164 || '');
    const likePlus62  = `%+${phoneDigits}%`;
    const likeLocal   = `%${phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits}%`;

    const soqlLead = `
      SELECT Id, Email, Phone, IsConverted, Is_Convert__c,
             ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
      FROM Lead
      WHERE Email = '${escSOQL(email.toLowerCase())}'
         OR Phone LIKE '${escSOQL(likePlus62)}'
         OR Phone LIKE '${escSOQL(likeLocal)}'
      ORDER BY CreatedDate DESC
      LIMIT 1
    `;
    const leadRes = await conn.query(soqlLead);
    const lead = (leadRes.records || [])[0] || null;

    // Helper to resolve an Opportunity for a given Account if ConvertedOpportunityId is blank.
    async function resolveOrCreateOppForAccount(accountId) {
      if (!accountId) return null;
      // Try to reuse the newest opp on that account
      const q = await conn.query(`
        SELECT Id FROM Opportunity
        WHERE AccountId='${escSOQL(accountId)}'
        ORDER BY CreatedDate DESC
        LIMIT 1
      `);
      const existingOpp = q.records?.[0]?.Id || null;
      if (existingOpp) return existingOpp;

      // Otherwise create one
      const oppRT = await getOppUniversityRT(conn);
      const closeDate = new Date(); closeDate.setDate(closeDate.getDate() + 30);
      const ins = await conn.sobject('Opportunity').create({
        RecordTypeId: oppRT || undefined,
        AccountId: accountId,
        Name: `${firstName || ''} ${lastName || ''}/REG`.trim(),
        StageName: 'Booking Form',
        CloseDate: closeDate.toISOString().slice(0, 10)
      });
      if (!ins.success) throw new Error((ins.errors && ins.errors.join(', ')) || 'Gagal membuat Opportunity');
      return ins.id;
    }

    if (lead) {
      // === If already converted, DO NOT update it ===
      if (lead.IsConverted) {
        // Use the converted opp if present; otherwise resolve via account
        let oppId = lead.ConvertedOpportunityId || null;
        let accId = lead.ConvertedAccountId || null;

        if (!oppId && accId) oppId = await resolveOrCreateOppForAccount(accId);

        if (!accId && oppId) {
          // fetch account for opp (shouldn't happen often)
          try {
            const o = await conn.sobject('Opportunity').retrieve(oppId);
            accId = o?.AccountId || null;
          } catch {}
        }

        if (oppId) {
          return res.status(200).json({ success: true, opportunityId: oppId, accountId: accId || null });
        }

        // As a last resort: create fresh
        const created = await createPersonAccAndOpp(conn, { firstName, lastName, email, phoneE164 });
        return res.status(200).json({ success: true, ...created });
      }

      // === Not yet converted: update fields & trigger conversion ===
      await conn.sobject('Lead').update(
        {
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName,
          Email    : email.toLowerCase(),
          Phone    : phoneE164,
          Is_Convert__c: true
        },
        { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } }
      );

      // Poll briefly for conversion to finish
      const MAX_TRIES = 12; // ~8–10 seconds
      for (let i = 0; i < MAX_TRIES; i++) {
        await sleep(700);
        const fresh = await refetchLead(conn, lead.Id);
        if (fresh?.IsConverted) {
          let oppId = fresh.ConvertedOpportunityId || null;
          let accId = fresh.ConvertedAccountId || null;

          if (!oppId && accId) oppId = await resolveOrCreateOppForAccount(accId);
          return res.status(200).json({ success: true, opportunityId: oppId || null, accountId: accId || null });
        }
      }

      // Conversion didn’t finish in time – create safe fallback so the user can continue
      const created = await createPersonAccAndOpp(conn, { firstName, lastName, email, phoneE164 });
      return res.status(200).json({ success: true, ...created });
    }

    // === No matching lead – create brand-new Person Account + Opportunity ===
    const created = await createPersonAccAndOpp(conn, { firstName, lastName, email, phoneE164 });
    return res.status(200).json({ success: true, ...created });

  } catch (err) {
    console.error('register-lead-convert ERR:', err);
    return res.status(500).json({ success: false, message: err.message || 'Gagal memproses' });
  }
};