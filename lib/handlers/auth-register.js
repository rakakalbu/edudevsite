// src/api/auth-register.js
// Step 1 (forceNew=true): always create a brand-new Person Account + Opportunity,
// store hashed password on Account.Password__c, and set BOTH Phone and PersonMobilePhone.
// Non-forceNew path keeps the lead-convert behavior for other entry points.

const jsforce = require('jsforce');
const crypto  = require('crypto');

/* ============== Utilities ============== */
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
const sha256hex = (s='') => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
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

async function accountByEmail(conn, email) {
  const q = await conn.query(`
    SELECT Id
    FROM Account
    WHERE IsPersonAccount = true AND PersonEmail = '${escSOQL(email)}'
    LIMIT 1
  `);
  return q.records?.[0]?.Id || null;
}

async function createPersonAccount(conn, { firstName, lastName, email, phoneE164, passwordPlain }) {
  const rtId  = await ensurePersonAccountRecordType(conn);
  const hash  = passwordPlain ? sha256hex(passwordPlain) : null;

  // Populate BOTH Phone and PersonMobilePhone so "Phone" shows in the header
  // while existing logic that uses PersonMobilePhone still works.
  const acc = {
    FirstName: firstName,
    LastName : lastName || '—',
    PersonEmail: email,
    Phone: phoneE164,              // <-- business/primary phone on Account
    PersonMobilePhone: phoneE164,  // <-- keep mobile too, for your lookups/UI
  };

  // Store the hashed password in your custom field (adjust API name if different)
  if (hash) acc.Password__c = hash;

  if (rtId) acc.RecordTypeId = rtId;

  const res = await conn.sobject('Account').create(acc);
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Account');
  }

  // OPTIONAL: also set on Contact if you keep a mirrored field there
  // try {
  //   const c = await conn.query(`SELECT Id FROM Contact WHERE AccountId='${res.id}' LIMIT 1`);
  //   if (hash && c.records?.[0]?.Id) {
  //     await conn.sobject('Contact').update({ Id: c.records[0].Id, Password__c: hash });
  //   }
  // } catch {}

  return res.id;
}

async function ensureOpportunity(conn, accountId, nameHint) {
  const rtId = await ensureOppRecordType(conn);
  const ins = {
    Name: nameHint || `Admission - ${todayISO()}`,
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

/* ===== Lead-based helpers (kept for non-forceNew flows) ===== */
async function findMatchingLead(conn, email, phoneE164) {
  const phoneDigits = normIdnPhoneDigits(phoneE164);
  const patPlus62 = '+' + phoneDigits;
  const patLocal  = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, IsConverted, Is_Convert__c,
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
    SELECT Id, IsConverted, Is_Convert__c,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE Id = '${escSOQL(id)}'
    LIMIT 1
  `;
  const q = await conn.query(soql);
  return q.records?.[0] || null;
}

/* ============== Handler ============== */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { firstName, lastName, email, phone, password, forceNew } = req.body || {};
    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    /* ===== Path A: ALWAYS create new (Step 1) ===== */
    if (forceNew === true) {
      // Enforce unique email on Person Accounts for registration
      const existingAccId = await accountByEmail(conn, email.toLowerCase().trim());
      if (existingAccId) {
        return res
          .status(400)
          .json({ success: false, message: 'Email sudah terdaftar. Gunakan email lain atau silakan masuk.' });
      }

      const accountId = await createPersonAccount(conn, {
        firstName,
        lastName,
        email,
        phoneE164,
        passwordPlain: password || null
      });

      const opportunityId = await ensureOpportunity(
        conn,
        accountId,
        `Admission - ${firstName} ${lastName || ''}`.trim()
      );

      return res.status(200).json({
        success: true,
        accountId,
        opportunityId,
        firstName,
        lastName: lastName || '',
        phone: phoneE164
      });
    }

    /* ===== Path B: legacy behavior (only when NOT forceNew) ===== */
    let accountId = null;
    let opportunityId = null;

    // 1) Try to find a matching Lead
    let lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        // Update the lead (sync latest values & trigger conversion)
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName: lastName || null,
          Email: email,
          Phone: phoneE164,
          Is_Convert__c: true
        });

        // Poll until converted
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
        accountId     = lead.ConvertedAccountId || null;
        opportunityId = lead.ConvertedOpportunityId || null;
      }
    }

    // If conversion path didn’t give us an Account, create one (also write phone & password)
    if (!accountId) {
      accountId = await createPersonAccount(conn, {
        firstName,
        lastName,
        email,
        phoneE164,
        passwordPlain: password || null
      });
    }

    // Ensure an Opportunity
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