// /api/auth-register.js
// Register flow that prefers converting an existing Lead by toggling Is_Convert__c.
// If no Lead or conversion doesn't complete in time, create Person Account + Opportunity.

const jsforce = require('jsforce');

function need(v, name) { if (!v) throw new Error(`${name} is required`); return v; }
function escSOQL(v='') { return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }
function normIdnPhoneDigits(v) {
  let d = onlyDigits(v);
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('62')) d = '62' + d;
  return d;
}
function todayISO() { return new Date().toISOString().slice(0,10); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

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
  const patPlus62 = '+' + phoneDigits; // '+62xxxx'
  const patLocal  = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, Company,
           IsConverted, Is_Convert__c,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE (Email = '${escSOQL(email)}'
       OR  Phone LIKE '%${escSOQL(patPlus62)}%'
       OR  Phone LIKE '%${escSOQL(patLocal)}%')
    ORDER BY CreatedDate DESC
    LIMIT 50
  `;
  const q = await conn.query(soql);
  return q.records?.[0] || null;
}

async function refetchLead(conn, id) {
  const soql = `
    SELECT Id, IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE Id = '${escSOQL(id)}'
    LIMIT 1
  `;
  const q = await conn.query(soql);
  return q.records?.[0] || null;
}

async function ensurePersonAccountRecordType(conn) {
  const r = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType = 'Account' AND IsPersonType = true
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}

async function ensureOppRecordType(conn) {
  const r = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType = 'Opportunity' AND DeveloperName = 'University'
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}

async function createPersonAccount(conn, { firstName, lastName, email, phoneE164, passwordHash }) {
  const rtId = await ensurePersonAccountRecordType(conn);
  const acc = {
    FirstName: firstName,
    LastName : lastName || '—',
    PersonEmail: email,
    // Put the number into the "Phone" column on Person Account
    PersonHomePhone: phoneE164,
    // Write hashed password to your Account field (adjust API name if needed)
    Password__c: passwordHash || null
  };
  if (rtId) acc.RecordTypeId = rtId;

  const res = await conn.sobject('Account').create(acc);
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Account');
  }
  return res.id;
}

async function ensureOpportunity(conn, accountId, nameHint) {
  const rtId = await ensureOppRecordType(conn);
  const ins = {
    Name      : nameHint || `Admission - ${todayISO()}`,
    AccountId : accountId,
    StageName : 'Booking Form',        // <— you requested this
    CloseDate : todayISO()
  };
  if (rtId) ins.RecordTypeId = rtId;

  const res = await conn.sobject('Opportunity').create(ins);
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Opportunity');
  }
  return res.id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success:false, message:'Method not allowed' });
  }

  try {
    const { firstName, lastName, email, phone, password } = req.body || {};
    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    // password is already hashed by your client – we just forward it
    const passwordHash = password || null;

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    let accountId = null;
    let opportunityId = null;

    // Try to find/convert an existing Lead first
    let lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        // Update the lead (sync values), CLEAR Company for Person Account conversion,
        // copy hashed password to Lead so your Apex mapping can transfer it to Account
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName || null,
          Email    : email,
          Phone    : phoneE164,
          Company  : null,               // <— force Person Account on convert
          Password__c: passwordHash,     // <— your Apex/Field Mapping should copy this to Account
          Is_Convert__c: true            // <— trigger your Apex conversion
        }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });

        // Poll briefly for conversion to finish
        const MAX_TRIES = 14;
        const DELAY_MS  = 700;
        for (let i = 0; i < MAX_TRIES; i++) {
          await wait(DELAY_MS);
          lead = await refetchLead(conn, lead.Id);
          if (lead?.IsConverted) break;
        }

        if (lead?.IsConverted) {
          accountId     = lead.ConvertedAccountId || null;
          opportunityId = lead.ConvertedOpportunityId || null;
        }
      } else {
        // already converted
        accountId     = lead.ConvertedAccountId || null;
        opportunityId = lead.ConvertedOpportunityId || null;
      }
    }

    // If we still don't have records (no lead found or conversion not finished), create directly
    if (!accountId) {
      accountId = await createPersonAccount(conn, {
        firstName, lastName, email,
        phoneE164,
        passwordHash
      });
    }
    if (!opportunityId) {
      const oppName = `Admission - ${firstName} ${lastName || ''}`.trim();
      opportunityId = await ensureOpportunity(conn, accountId, oppName);
    }

    return res.status(200).json({
      success: true,
      accountId,
      opportunityId,
      firstName,
      lastName: lastName || '',
      phone: phoneE164
    });
  } catch (err) {
    console.error('auth-register ERR:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Registration failed' });
  }
};