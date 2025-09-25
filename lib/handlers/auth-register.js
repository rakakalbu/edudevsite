// src/api/auth-register.js
// Step 1: prefer converting an existing Lead (email/phone match).
// If no suitable Lead, create a new Person Account + Opportunity.
// Ensures Opp starts at "Booking Form"; sets BOTH Account.Phone and PersonMobilePhone;
// stores hashed password in Account.Password__c.

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

async function findMatchingLead(conn, email, phoneE164) {
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

async function createPersonAccount(conn, { firstName, lastName, email, phoneE164, passwordPlain }) {
  const rtId = await ensurePersonAccountRecordType(conn);
  const acc = {
    FirstName: firstName,
    LastName : lastName || '—',
    PersonEmail: email,
    Phone: phoneE164,
    PersonMobilePhone: phoneE164
  };
  if (passwordPlain) acc.Password__c = sha256hex(passwordPlain);
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
    StageName: 'Booking Form',
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
    const { firstName, lastName, email, phone, password, forceNew } = req.body || {};
    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    // ===== Path A: Convert when possible (default behavior) =====
    if (!forceNew) {
      let accountId = null;
      let opportunityId = null;

      // Find a matching lead
      let lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneE164);

      if (lead) {
        if (lead.IsConverted) {
          // Reuse converted records; resolve opp if missing
          accountId     = lead.ConvertedAccountId || null;
          opportunityId = lead.ConvertedOpportunityId || null;

          if (!opportunityId && accountId) {
            const q = await conn.query(`
              SELECT Id FROM Opportunity
              WHERE AccountId='${escSOQL(accountId)}'
              ORDER BY CreatedDate DESC
              LIMIT 1
            `);
            opportunityId = q.records?.[0]?.Id || null;
          }

          // Ensure key Account fields are set (Phone/Password)
          if (accountId) {
            const upd = {
              Id: accountId,
              Phone: phoneE164,
              PersonMobilePhone: phoneE164
            };
            if (password) upd.Password__c = sha256hex(password);
            await conn.sobject('Account').update(upd).catch(()=>{});
          }

          if (!opportunityId && accountId) {
            opportunityId = await ensureOpportunity(conn, accountId, `Admission - ${firstName} ${lastName || ''}`.trim());
          }

          return res.status(200).json({ success: true, accountId, opportunityId, firstName, lastName: lastName || '', phone: phoneE164 });
        }

        // Not converted yet → update fields & trigger conversion
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName || null,
          Email    : email,
          Phone    : phoneE164,
          Is_Convert__c: true
        });

        // Poll for conversion
        const MAX_TRIES = 14; // ~10s
        for (let i = 0; i < MAX_TRIES; i++) {
          await wait(700);
          lead = await refetchLead(conn, lead.Id);
          if (lead?.IsConverted) break;
        }

        if (lead?.IsConverted) {
          accountId     = lead.ConvertedAccountId || null;
          opportunityId = lead.ConvertedOpportunityId || null;

          // Post-conversion: ensure Account carries phone & hashed password
          if (accountId) {
            const upd = {
              Id: accountId,
              Phone: phoneE164,
              PersonMobilePhone: phoneE164
            };
            if (password) upd.Password__c = sha256hex(password);
            await conn.sobject('Account').update(upd).catch(()=>{});
          }

          if (!opportunityId && accountId) {
            opportunityId = await ensureOpportunity(conn, accountId, `Admission - ${firstName} ${lastName || ''}`.trim());
          }

          return res.status(200).json({
            success: true,
            accountId,
            opportunityId,
            firstName,
            lastName: lastName || '',
            phone: phoneE164
          });
        }
        // If conversion didn’t finish → fall through to safe create below
      }

      // No lead found (or conversion not ready): create new
      const accId = await createPersonAccount(conn, { firstName, lastName, email, phoneE164, passwordPlain: password || null });
      const oppId = await ensureOpportunity(conn, accId, `Admission - ${firstName} ${lastName || ''}`.trim());
      return res.status(200).json({ success: true, accountId: accId, opportunityId: oppId, firstName, lastName: lastName || '', phone: phoneE164 });
    }

    // ===== Path B: Explicit force new (kept for compatibility) =====
    const accId = await createPersonAccount(conn, { firstName, lastName, email, phoneE164, passwordPlain: password || null });
    const oppId = await ensureOpportunity(conn, accId, `Admission - ${firstName} ${lastName || ''}`.trim());
    return res.status(200).json({ success: true, accountId: accId, opportunityId: oppId, firstName, lastName: lastName || '', phone: phoneE164 });

  } catch (err) {
    console.error('auth-register ERR:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Registration failed' });
  }
};