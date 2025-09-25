// src/api/auth-register.js
// Register flow: if forceNew === true create a brand-new Person Account + Opportunity.
// Otherwise (e.g., from other entry points) we keep your existing "try-lead-convert" logic.

const jsforce = require('jsforce');

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

async function createPersonAccount(conn, { firstName, lastName, email, phoneE164 }) {
  const rtId = await ensurePersonAccountRecordType(conn);
  const acc = {
    FirstName: firstName,
    LastName: lastName || '—',
    PersonEmail: email,
    PersonMobilePhone: phoneE164
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
  // NOTE: This is permissive (email OR phone LIKE). We keep it only for non-forceNew flows.
  const phoneDigits = normIdnPhoneDigits(phoneE164);
  const patPlus62 = '+' + phoneDigits; // '+62xxxx'
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
    const { firstName, lastName, email, phone, forceNew } = req.body || {};
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
        phoneE164
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
          Is_Convert__c: true   // your Apex/Flow converts it
        });

        // 2) Poll until converted (give Apex time to run)
        const MAX_TRIES = 14;      // ~10 seconds total
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
        // Already converted; reuse converted records
        accountId     = lead.ConvertedAccountId || null;
        opportunityId = lead.ConvertedOpportunityId || null;
      }
    }

    // If conversion path didn’t give us an Account, create one
    if (!accountId) {
      accountId = await createPersonAccount(conn, { firstName, lastName, email, phoneE164 });
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