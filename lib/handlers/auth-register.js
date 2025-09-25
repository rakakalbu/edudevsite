// lib/handlers/auth-register.js
// POST /api/auth-register  { firstName, lastName, email, phone, password }
// - Tries to reuse/convert a matching Lead (email first, then phone on UNCONVERTED leads only)
// - If a converted lead is found by phone but email differs, we IGNORE it and create a fresh PA+Opp
// - Creates Person Account + Opportunity when no suitable Lead exists
// - Avoids duplicate Opportunity creation when Apex conversion already made one
// - Stores sha256(password) to Account.Password__c and fire-and-forget to your external login service

const jsforce = require('jsforce');
const crypto  = require('crypto');

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

/** Detect if a string is already hashed (bcrypt or sha256 hex) */
function looksHashed(s) {
  return typeof s === 'string'
    && (/^\$2[aby]\$/.test(s) || /^[a-f0-9]{64}$/i.test(s));
}
/** Hash to SHA-256 hex iff not already hashed */
function toPasswordHash(s) {
  if (!s) return null;
  if (looksHashed(s)) return s;
  return crypto.createHash('sha256').update(String(s)).digest('hex');
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

/**
 * STRONGER matching:
 * 1) Look for exact email (converted or not).
 * 2) If none, look for phone match **ONLY on UNCONVERTED leads** so we can convert them safely.
 * We explicitly *ignore* phone-only matches that are already converted (likely another person).
 */
async function findMatchingLead(conn, email, phoneE164) {
  const phoneDigits = normIdnPhoneDigits(phoneE164);
  const patPlus62 = '+' + phoneDigits;
  const patLocal  = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

  // Pass 1: exact email
  const soqlEmail = `
    SELECT Id, FirstName, LastName, Email, Phone, Company,
           IsConverted, Is_Convert__c,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE Email = '${escSOQL(email)}'
    ORDER BY CreatedDate DESC
    LIMIT 50
  `;
  const q1 = await conn.query(soqlEmail);
  if (q1.totalSize > 0) return q1.records[0];

  // Pass 2: phone match, but ONLY on UNCONVERTED leads
  const soqlPhoneUnconverted = `
    SELECT Id, FirstName, LastName, Email, Phone, Company,
           IsConverted, Is_Convert__c,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE IsConverted = false
      AND (
            Phone LIKE '%${escSOQL(patPlus62)}%'
         OR Phone LIKE '%${escSOQL(patLocal)}%'
      )
    ORDER BY CreatedDate DESC
    LIMIT 50
  `;
  const q2 = await conn.query(soqlPhoneUnconverted);
  return q2.records?.[0] || null;
}

async function refetchLead(conn, id) {
  const soql = `
    SELECT Id, Email, Phone, IsConverted,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
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
    // Write to both common phone slots to ensure it shows in your layout
    PersonMobilePhone: phoneE164,
    PersonHomePhone  : phoneE164,
    Phone            : phoneE164,
    Password__c      : passwordHash || null
  };
  if (rtId) acc.RecordTypeId = rtId;

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
    Name      : nameHint || `Admission - ${todayISO()}`,
    AccountId : accountId,
    StageName : 'Booking Form',
    CloseDate : todayISO()
  };
  if (rtId) ins.RecordTypeId = rtId;

  const res = await conn.sobject('Opportunity').create(ins, {
    headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }
  });
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Opportunity');
  }
  return res.id;
}

/** POST email+PLAINTEXT password to your external login service (non-blocking). */
async function provisionExternalLogin(email, passwordPlain) {
  try {
    if (!email || !passwordPlain) return;
    await fetch('https://salesforceedupakcage.vercel.app/api/register', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ email, password: passwordPlain })
    }).catch(() => {});
  } catch (e) {
    console.warn('External login provisioning failed:', e?.message || e);
  }
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

    // Hash for Salesforce storage; keep plaintext for the external API
    const emailNorm     = String(email || '').trim().toLowerCase();
    const passwordPlain = password || '';
    const passwordHash  = toPasswordHash(passwordPlain);

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    let accountId = null;
    let opportunityId = null;

    // STRICT lead-first path
    let lead = await findMatchingLead(conn, emailNorm, phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        // Update with the latest data & trigger your Apex conversion
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName || null,
          Email    : emailNorm,
          Phone    : phoneE164,
          Company  : null,               // force Person Account on convert
          Password__c: passwordHash,     // hashed in Lead
          Is_Convert__c: true
        }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });

        // Wait for conversion by Apex
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

          if (accountId && passwordHash) {
            await conn.sobject('Account').update({
              Id: accountId,
              Password__c: passwordHash,
              PersonMobilePhone: phoneE164,
              PersonHomePhone  : phoneE164,
              Phone            : phoneE164
            }).catch(()=>{});
          }
        }
      } else {
        // Lead is already converted.
        // Reuse ONLY if email matches exactly; otherwise treat as unrelated.
        const sameEmail = String(lead.Email || '').toLowerCase() === emailNorm;
        if (sameEmail) {
          accountId     = lead.ConvertedAccountId || null;
          opportunityId = lead.ConvertedOpportunityId || null;

          if (accountId && passwordHash) {
            await conn.sobject('Account').update({
              Id: accountId,
              Password__c: passwordHash,
              PersonMobilePhone: phoneE164,
              PersonHomePhone  : phoneE164,
              Phone            : phoneE164
            }).catch(()=>{});
          }
        } else {
          // Ignore phone-only match to an already-converted lead
          lead = null;
        }
      }
    }

    // Fallback: create Person Account + Opportunity
    if (!accountId) {
      accountId = await createPersonAccount(conn, {
        firstName, lastName, email: emailNorm, phoneE164, passwordHash
      });
    }
    if (!opportunityId) {
      const oppName = `Admission - ${firstName} ${lastName || ''}`.trim();
      opportunityId = await ensureOpportunity(conn, accountId, oppName);
    }

    // Send plaintext to the external API (fire-and-forget)
    provisionExternalLogin(emailNorm, passwordPlain).catch(()=>{});

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