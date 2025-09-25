const jsforce = require('jsforce');
const crypto  = require('crypto');

function need(v, name) { if (!v) throw new Error(`${name} is required`); return v; }
function escSOQL(v='') { return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

// Return digits w/ country code (62) and useful variants for exact matching
function normIdnPhoneDigits(v) {
  let d = onlyDigits(v);
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);        // 08123 -> 8123
  if (!d.startsWith('62')) d = '62' + d;        // 8123 -> 628123
  return d;                                     // e.g. 628123456789
}
function phoneVariantsForEquality(e164) {
  const d62   = normIdnPhoneDigits(e164);       // 628123456789
  const local = d62.slice(2);                   // 8123456789
  const plus  = '+' + d62;                      // +628123456789
  const zero  = '0' + local;                    // 08123456789
  // Unique list (some orgs store with or without plus)
  return Array.from(new Set([plus, d62, zero, local]));
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

// ===== Lead matching (email exact OR phone exact across normalized variants) =====
async function findMatchingLead(conn, email, phoneE164) {
  const variants = phoneVariantsForEquality(phoneE164).map(escSOQL);
  const phoneIn  = variants.map(v => `'${v}'`).join(','); // safe even if one variant

  const emailEsc = escSOQL(email);
  // NOTE: Lead has Phone and MobilePhone; we check both with equality (no LIKE).
  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, Company,
           IsConverted, Is_Convert__c,
           ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
    FROM Lead
    WHERE Email = '${emailEsc}'
       OR Phone IN (${phoneIn})
       OR MobilePhone IN (${phoneIn})
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
    // set both to cover different org field usages
    PersonMobilePhone: phoneE164,
    PersonHomePhone  : phoneE164,
    Phone            : phoneE164,
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
    StageName : 'Booking Form',
    CloseDate : todayISO()
  };
  if (rtId) ins.RecordTypeId = rtId;

  const res = await conn.sobject('Opportunity').create(ins);
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
    const passwordPlain = password || '';
    const passwordHash  = toPasswordHash(passwordPlain);

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    let accountId = null;
    let opportunityId = null;

    // Lead-first path (conversion via Is_Convert__c) with exact equality matching
    let lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName || null,
          Email    : email,
          Phone    : phoneE164,
          MobilePhone: phoneE164,
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

          if (accountId) {
            // also persist password + phone on the Person Account
            const upd = { Id: accountId, Password__c: passwordHash, PersonMobilePhone: phoneE164, Phone: phoneE164 };
            await conn.sobject('Account').update(upd).catch(()=>{});
          }
        }
      } else {
        // Already converted
        accountId     = lead.ConvertedAccountId || null;
        opportunityId = lead.ConvertedOpportunityId || null;

        if (accountId) {
          const upd = { Id: accountId, Password__c: passwordHash, PersonMobilePhone: phoneE164, Phone: phoneE164 };
          await conn.sobject('Account').update(upd).catch(()=>{});
        }
      }
    }

    // Fallback: create Person Account + Opportunity
    if (!accountId) {
      accountId = await createPersonAccount(conn, {
        firstName, lastName, email, phoneE164, passwordHash
      });
    }
    if (!opportunityId) {
      const oppName = `Admission - ${firstName} ${lastName || ''}`.trim();
      opportunityId = await ensureOpportunity(conn, accountId, oppName);
    }

    // 🔔 Send plaintext to the external API (fire-and-forget)
    provisionExternalLogin(email, passwordPlain).catch(()=>{});

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