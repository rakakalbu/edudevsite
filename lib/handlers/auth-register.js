// src/api/auth-register.js
// Register flow that prefers converting an existing Lead by toggling Is_Convert__c
// (your Apex/Flow performs the conversion). If no matching Lead exists or the
// conversion hasn't finished quickly, we create a Person Account + Opportunity.
// Also enforces Opportunity stage "Booking Form" and maps phone to Account.Phone.

const jsforce = require('jsforce');

/* ============== Utilities ============== */
function need(v, name) { if (!v) throw new Error(`${name} is required`); return v; }
function escSOQL(v='') { return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function digits(v='')  { return String(v||'').replace(/\D/g,''); }
function normIdnPhoneDigits(v) {
  let d = digits(v);
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('62')) d = '62' + d;
  return d;
}
const wait = (ms) => new Promise(r=>setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0,10);

async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function findMatchingLead(conn, email, phoneE164) {
  const phoneDigits = normIdnPhoneDigits(phoneE164);
  const patPlus62 = '+' + phoneDigits;
  const patLocal  = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, IsConverted,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE (Email = '${escSOQL((email||'').toLowerCase())}'
       OR  Phone LIKE '%${escSOQL(patPlus62)}%'
       OR  Phone LIKE '%${escSOQL(patLocal)}%')
    ORDER BY CreatedDate DESC
    LIMIT 50
  `;
  const q = await conn.query(soql);
  return q.records?.[0] || null;
}
async function refetchLead(conn, id) {
  const q = await conn.query(`
    SELECT Id, IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead WHERE Id='${escSOQL(id)}' LIMIT 1
  `);
  return q.records?.[0] || null;
}
async function ensurePersonAccountRecordType(conn) {
  const r = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Account' AND IsPersonType=true LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}
async function ensureOppRecordType(conn) {
  const r = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Opportunity' AND (DeveloperName='University' OR Name='University')
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}
async function createPersonAccount(conn, { firstName, lastName, email, phoneE164 }) {
  const rtId = await ensurePersonAccountRecordType(conn);
  const acc = {
    RecordTypeId: rtId || undefined,
    FirstName: firstName,
    LastName : lastName || '—',
    PersonEmail: email,
    // map to both fields as requested
    Phone: phoneE164,
    PersonMobilePhone: phoneE164
  };
  const res = await conn.sobject('Account').create(acc, {
    headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }
  });
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Account');
  }
  return res.id;
}
async function ensureOpportunity(conn, accountId, nameHint) {
  const rtId = await ensureOppRecordType(conn);
  const ins = {
    Name: nameHint || `Admission - ${todayISO()}`,
    AccountId: accountId,
    StageName: 'Booking Form',
    CloseDate: todayISO(),
    RecordTypeId: rtId || undefined
  };
  const res = await conn.sobject('Opportunity').create(ins, {
    headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }
  });
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Opportunity');
  }
  return res.id;
}

/* ============== Handler ============== */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { firstName, lastName = '', email, phone /* password */ } = req.body || {};
    need(firstName, 'firstName'); need(email, 'email'); need(phone, 'phone');

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    // 1) Try matching LEAD
    let lead = await findMatchingLead(conn, email, phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        // Update latest fields & trigger your Apex/Flow
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName || null,
          Email    : email,
          Phone    : phoneE164,
          Is_Convert__c: true
        }, { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } });

        // Poll briefly for conversion
        const MAX_TRIES = 14;   // ~10 seconds total
        const DELAY_MS  = 700;
        for (let i=0;i<MAX_TRIES;i++) {
          await wait(DELAY_MS);
          lead = await refetchLead(conn, lead.Id);
          if (lead?.IsConverted) break;
        }
      }

      // If converted now (or already converted earlier)
      if (lead?.IsConverted) {
        const accountId     = lead.ConvertedAccountId || null;
        let opportunityId   = lead.ConvertedOpportunityId || null;

        // Make sure Account phone is mapped as you want
        if (accountId) {
          await conn.sobject('Account').update({
            Id: accountId,
            Phone: phoneE164,
            PersonMobilePhone: phoneE164
          }).catch(()=>{});
        }

        // Ensure a Booking Form opportunity exists / is staged correctly
        if (!opportunityId && accountId) {
          const oppName = `${firstName} ${lastName}`.trim() || 'Admission';
          opportunityId = await ensureOpportunity(conn, accountId, `${oppName}/REG`);
        } else if (opportunityId) {
          await conn.sobject('Opportunity').update({
            Id: opportunityId,
            StageName: 'Booking Form',
            CloseDate: todayISO()
          }).catch(()=>{});
        }

        return res.status(200).json({
          success: true,
          accountId,
          opportunityId,
          firstName,
          lastName,
          phone: phoneE164
        });
      }

      // Apex hasn’t finished within our small window — don’t block user.
      // Fall back to safe creation so the flow continues.
    }

    // 2) No lead or conversion not finished → Create Person Account + Opportunity
    const accountId = await createPersonAccount(conn, { firstName, lastName, email, phoneE164 });
    const oppName   = `${firstName} ${lastName}`.trim() || 'Admission';
    const opportunityId = await ensureOpportunity(conn, accountId, `${oppName}/REG`);

    return res.status(200).json({
      success: true,
      accountId,
      opportunityId,
      firstName,
      lastName,
      phone: phoneE164
    });
  } catch (err) {
    console.error('auth-register ERR:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Registration failed' });
  }
};