// src/api/auth-register.js
// Registers a user by converting an existing Lead (by email/phone) if present,
// otherwise creating a Person Account, then ensuring an Opportunity exists.

const jsforce = require('jsforce');

/* ============== Utilities ============== */
function need(v, name) {
  if (!v) throw new Error(`${name} is required`);
  return v;
}
function escSOQL(v = '') {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}
// Normalize to Indonesian/E.164-ish digits for comparison
function normIdnPhoneDigits(v) {
  let d = onlyDigits(v);
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('62')) d = '62' + d;
  return d;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function pickConvertedLeadStatus(conn) {
  const r = await conn.query(`
    SELECT MasterLabel
    FROM LeadStatus
    WHERE IsConverted = true
    ORDER BY SortOrder ASC
    LIMIT 1
  `);
  const s = r.records?.[0]?.MasterLabel;
  if (!s) throw new Error('No converted LeadStatus available in org');
  return s;
}

async function findMatchingLead(conn, email, phoneNorm) {
  const phoneDigits = normIdnPhoneDigits(phoneNorm);
  const patPlus62 = '+' + phoneDigits; // '+62xxxxxxxxxx'
  const patLocal  = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, IsConverted,
           ConvertedAccountId, ConvertedContactId
    FROM Lead
    WHERE (Email = '${escSOQL(email)}'
       OR  Phone LIKE '%${escSOQL(patPlus62)}%'
       OR  Phone LIKE '%${escSOQL(patLocal)}%')
    ORDER BY CreatedDate DESC
    LIMIT 50
  `;
  const q = await conn.query(soql);
  return q.records?.[0] || null; // newest match
}

async function ensurePersonAccountRecordType(conn) {
  // try to find any Person Account RT
  const r = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType = 'Account' AND IsPersonType = true
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}

async function ensureOppRecordType(conn) {
  // Prefer a "University" record type if present
  const r = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType = 'Opportunity' AND DeveloperName = 'University'
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}

async function createPersonAccount(conn, { firstName, lastName, email, phoneNorm }) {
  const rtId = await ensurePersonAccountRecordType(conn); // can be null; org default may work
  const acc = {
    FirstName: firstName,
    LastName: lastName || '—',
    PersonEmail: email,
    PersonMobilePhone: phoneNorm,
  };
  if (rtId) acc.RecordTypeId = rtId;

  const res = await conn.sobject('Account').create(acc);
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Account');
  }
  return res.id;
}

async function convertLead(conn, leadId) {
  const convertedStatus = await pickConvertedLeadStatus(conn);
  const payload = [{
    leadId,
    convertedStatus,
    doNotCreateOpportunity: true
  }];
  const r = await conn.sobject('Lead').convert(payload);
  const row = Array.isArray(r) ? r[0] : r;
  if (!row?.success) {
    throw new Error((row?.errors && row.errors.join(', ')) || 'Lead convert failed');
  }
  return {
    accountId: row.accountId || row.accountId || null,
    contactId: row.contactId || null
  };
}

async function ensureOpportunity(conn, accountId, nameHint) {
  // Reuse an open "registration" style opportunity if you want; for now just create a fresh one.
  const rtId = await ensureOppRecordType(conn);
  const ins = {
    Name: nameHint || `Registration - ${todayISO()}`,
    AccountId: accountId,
    StageName: 'Prospecting',
    CloseDate: todayISO()
  };
  if (rtId) ins.RecordTypeId = rtId;

  const res = await conn.sobject('Opportunity').create(ins);
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
    const { firstName, lastName, email, phone, password } = req.body || {};
    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const phoneNorm = '+' + normIdnPhoneDigits(phone);

    const conn = await login();

    let accountId = null;
    let contactId = null;

    // 1) Try to find + convert an existing Lead
    const lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneNorm);
    if (lead) {
      if (lead.IsConverted) {
        accountId = lead.ConvertedAccountId || null;
        contactId = lead.ConvertedContactId || null;
      } else {
        const out = await convertLead(conn, lead.Id);
        accountId = out.accountId;
        contactId = out.contactId;
      }
    }

    // 2) If no account yet, create a Person Account
    if (!accountId) {
      accountId = await createPersonAccount(conn, { firstName, lastName, email, phoneNorm });
    }

    // 3) Ensure an Opportunity for this Account
    const oppName = `Admission - ${firstName} ${lastName || ''}`.trim();
    const opportunityId = await ensureOpportunity(conn, accountId, oppName);

    // 4) (Optional) store password hash or raw in a custom field on Account/Contact
    // TODO: if you need this, set e.g. Password__c or Hashed_Password__c here with an update.

    return res.status(200).json({
      success: true,
      accountId,
      opportunityId,
      firstName,
      lastName: lastName || '',
      phone: phoneNorm
    });
  } catch (err) {
    console.error('auth-register ERR:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Registration failed' });
  }
};