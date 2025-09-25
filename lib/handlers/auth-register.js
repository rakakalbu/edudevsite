// lib/handlers/auth-register.js
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

/** names: case/space-insensitive compare */
function canonName(first, last) {
  return String(`${first || ''} ${last || ''}`).replace(/\s+/g,' ').trim().toLowerCase();
}
function namesMatch(aFirst, aLast, bFirst, bLast) {
  return canonName(aFirst, aLast) === canonName(bFirst, bLast);
}

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

async function findMatchingLead(conn, email, phoneE164) {
  const phoneDigits = normIdnPhoneDigits(phoneE164);
  const patPlus62 = '+' + phoneDigits;
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
    SELECT Id, FirstName, LastName, IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
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
    WHERE SobjectType = 'Opportunity' AND (DeveloperName = 'University' OR Name = 'University')
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
    PersonHomePhone: phoneE164,
    Password__c: passwordHash || null
  };
  if (rtId) acc.RecordTypeId = rtId;

  const res = await conn.sobject('Account').create(acc, {
    headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } // allow same email/phone for parent/guardian scenarios
  });
  if (!res.success) {
    throw new Error((res.errors && res.errors.join(', ')) || 'Failed to create Account');
  }
  return res.id;
}

async function ensureOpportunity(conn, accountId, nameHint) {
  const rtId = await ensureOppRecordType(conn);

  // unique name to avoid duplicate-name collisions
  const ts   = new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
  const name = (nameHint && nameHint.trim()) ? `${nameHint}/REG/${ts}` : `Admission - ${todayISO()}/REG/${ts}`;

  const ins = {
    Name      : name,
    AccountId : accountId,
    StageName : 'Booking Form',
    CloseDate : todayISO()
  };
  if (rtId) ins.RecordTypeId = rtId;

  const res = await conn.sobject('Opportunity').create(ins, {
    headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'}
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

    const passwordPlain = password || '';
    const passwordHash  = toPasswordHash(passwordPlain);

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    let accountId = null;
    let opportunityId = null;

    // Try to find a lead — but only reuse/convert it if it's the same person (name match).
    let lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneE164);
    let canReuseLead = false;

    if (lead) {
      canReuseLead = namesMatch(lead.FirstName, lead.LastName, firstName, lastName);

      if (canReuseLead && !lead.IsConverted) {
        // Convert via Apex flag; DO NOT overwrite Lead names (avoid corrupting someone else's Lead)
        await conn.sobject('Lead').update({
          Id: lead.Id,
          Email: email,
          Phone: phoneE164,
          Is_Convert__c: true
        }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });

        const MAX_TRIES = 14;
        const DELAY_MS  = 700;
        for (let i = 0; i < MAX_TRIES; i++) {
          await wait(DELAY_MS);
          lead = await refetchLead(conn, lead.Id);
          if (lead?.IsConverted) break;
        }
      }

      if (canReuseLead && lead?.IsConverted) {
        accountId = lead.ConvertedAccountId || null;
        if (accountId && passwordHash) {
          await conn.sobject('Account').update({ Id: accountId, Password__c: passwordHash }).catch(()=>{});
        }
        // always a new Opportunity for this session
        if (accountId) {
          const oppName = `Admission - ${firstName} ${lastName || ''}`.trim();
          opportunityId = await ensureOpportunity(conn, accountId, oppName);
        }
      }
      // if names don't match, we will ignore the lead and create a fresh Account below.
    }

    // Fresh Account + fresh Opportunity path
    if (!accountId) {
      accountId = await createPersonAccount(conn, {
        firstName, lastName, email, phoneE164, passwordHash
      });
    }
    if (!opportunityId) {
      const oppName = `Admission - ${firstName} ${lastName || ''}`.trim();
      opportunityId = await ensureOpportunity(conn, accountId, oppName);
    }

    // fire-and-forget external provisioning
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