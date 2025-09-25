// src/api/auth-register.js
// Register flow that prefers converting an existing Lead into a **Person Account**
// and also ensures a new Opportunity is created with Stage "Booking Form".
// If no matching Lead exists, we create a Person Account + Opportunity ourselves.

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
  // match by email OR by phone (+62… or local)
  const phoneDigits = normIdnPhoneDigits(phoneE164);
  const patPlus62 = '+' + phoneDigits;                  // '+62xxxx'
  const patLocal  = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

  const soql = `
    SELECT Id, FirstName, LastName, Email, Phone, IsConverted,
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

async function getConvertedStatus(conn) {
  const r = await conn.query(`SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1`);
  return r.records?.[0]?.MasterLabel || 'Converted';
}

async function createPersonAccount(conn, { firstName, lastName, email, phoneE164 }) {
  const rtId = await ensurePersonAccountRecordType(conn);
  const acc = {
    FirstName: firstName,
    LastName : lastName || '—',
    PersonEmail: email,
    // Put the phone on BOTH places; you asked for Account.Phone specifically
    Phone: phoneE164,
    PersonMobilePhone: phoneE164
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
    Name: nameHint || `Admission - ${todayISO()}`,
    AccountId: accountId,
    StageName: 'Booking Form',         // <= as requested
    CloseDate: todayISO()
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

async function convertLeadToPersonWithOpp(conn, { leadId, firstName, lastName, phoneE164 }) {
  const accountRT  = await ensurePersonAccountRecordType(conn);
  const oppRT      = await ensureOppRecordType(conn);
  const convStatus = await getConvertedStatus(conn);

  const oppName = `${(firstName || '').trim()} ${(lastName || '').trim()}`.trim() || 'Admission';
  const convRes = await conn.sobject('Lead').convert({
    leadId: leadId,
    convertedStatus: convStatus,
    // Ask Salesforce to create a **Person Account**:
    accountRecordTypeId: accountRT || undefined,
    // Also ask it to create an Opportunity:
    doNotCreateOpportunity: false,
    opportunityName: `${oppName}/REG`,
    opportunityRecordTypeId: oppRT || undefined
  });

  if (!convRes || !convRes.success) {
    throw new Error(convRes?.errors?.join(', ') || 'Lead convert failed');
  }

  const { accountId, opportunityId } = convRes;

  // Make sure fields look how you want:
  if (accountId) {
    await conn.sobject('Account').update({
      Id: accountId,
      Phone: phoneE164,
      PersonMobilePhone: phoneE164
    }).catch(()=>{});
  }

  if (opportunityId) {
    await conn.sobject('Opportunity').update({
      Id: opportunityId,
      StageName: 'Booking Form',
      CloseDate: todayISO()
    }).catch(()=>{});
  }

  return convRes; // includes accountId/contactId/opportunityId
}

/* ============== Handler ============== */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { firstName, lastName, email, phone /* password */ } = req.body || {};
    need(firstName, 'firstName');
    need(email, 'email');
    need(phone, 'phone');

    const phoneE164 = '+' + normIdnPhoneDigits(phone);
    const conn = await login();

    // Try to find a matching Lead
    const lead = await findMatchingLead(conn, email.toLowerCase().trim(), phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        // Direct **Person Account** conversion (no Apex toggle)
        const r = await convertLeadToPersonWithOpp(conn, {
          leadId: lead.Id, firstName, lastName, phoneE164
        });

        return res.status(200).json({
          success: true,
          accountId: r.accountId || null,
          opportunityId: r.opportunityId || null,
          firstName,
          lastName: lastName || '',
          phone: phoneE164
        });
      } else {
        // Already converted; reuse converted records
        let opportunityId = lead.ConvertedOpportunityId || null;
        const accountId = lead.ConvertedAccountId || null;

        // If there’s no opportunity (rare), ensure one and put it in "Booking Form"
        if (!opportunityId && accountId) {
          const oppName = `${(firstName || '').trim()} ${(lastName || '').trim()}`.trim() || 'Admission';
          opportunityId = await ensureOpportunity(conn, accountId, `${oppName}/REG`);
        } else if (opportunityId) {
          await conn.sobject('Opportunity').update({
            Id: opportunityId,
            StageName: 'Booking Form',
            CloseDate: todayISO()
          }).catch(()=>{});
        }

        // Ensure Account.Phone is set how you prefer
        if (accountId) {
          await conn.sobject('Account').update({
            Id: accountId,
            Phone: phoneE164,
            PersonMobilePhone: phoneE164
          }).catch(()=>{});
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
    }

    // No lead → create **Person Account** + Opportunity
    const accountId = await createPersonAccount(conn, { firstName, lastName, email, phoneE164 });
    const oppName   = `${(firstName || '').trim()} ${(lastName || '').trim()}`.trim() || 'Admission';
    const opportunityId = await ensureOpportunity(conn, accountId, `${oppName}/REG`);

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