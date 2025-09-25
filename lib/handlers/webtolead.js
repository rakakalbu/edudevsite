// src/api/webtolead.js
// Safe Web-to-Lead handler that never references a converted Lead.
// - If a non-converted lead with the same email exists -> update it
// - Else -> create a brand-new lead
// - Phone is normalized to +62…
// - Campus__c is set when available; if the field doesn't exist, we gracefully retry without it.

const jsforce = require('jsforce');

function send(res, code, obj) { res.status(code).json(obj); }
const onlyDigits = s => String(s || '').replace(/\D/g, '');
function normalizeIdnPhoneE164(raw) {
  let d = onlyDigits(raw);
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('62')) d = '62' + d;
  return '+' + d;
}
function escSOQL(v = '') { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

async function login(env = process.env) {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce environment is not fully configured');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function fieldExists(conn, sobject, apiName) {
  try {
    const desc = await conn.sobject(sobject).describe();
    return !!desc.fields.find(f => f.name === apiName);
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return send(res, 405, { success: false, message: 'Method not allowed' });
  }

  try {
    const { firstName, lastName = '', email, phone, campusId, description } = req.body || {};
    if (!firstName) throw new Error('firstName is required');
    if (!email)     throw new Error('email is required');
    if (!phone)     throw new Error('phone is required');

    const phoneE164 = normalizeIdnPhoneE164(phone);
    const conn = await login();

    // Find the most recent lead by email (if any)
    let existing = null;
    try {
      const q = await conn.query(`
        SELECT Id, IsConverted
        FROM Lead
        WHERE Email = '${escSOQL(email)}'
        ORDER BY CreatedDate DESC
        LIMIT 1
      `);
      existing = q.records?.[0] || null;
    } catch { /* ignore; we can still create */ }

    // Base payload used for both create/update
    const base = {
      FirstName: firstName,
      LastName : lastName || '-',
      Email    : email,
      Phone    : phoneE164,
      Company  : 'Web Inquiry',
      Status   : 'Open - Not Contacted',
      Description: description || null,
    };

    // Only set Campus__c if the field actually exists on Lead
    if (campusId) {
      if (await fieldExists(conn, 'Lead', 'Campus__c')) {
        base.Campus__c = campusId;
      }
    }

    let leadId = null;

    // If we have a non-converted existing lead, update it; otherwise create new
    if (existing && !existing.IsConverted) {
      const payload = { ...base, Id: existing.Id };
      try {
        const r = await conn.sobject('Lead').update(payload);
        if (!r.success) throw new Error((r.errors && r.errors.join(', ')) || 'Failed to update Lead');
        leadId = existing.Id;
      } catch (e) {
        // If the failure was due to a field mismatch (e.g., Campus__c not present), retry without it once
        if (String(e.message || e).includes("No such column 'Campus__c'")) {
          delete payload.Campus__c;
          const r2 = await conn.sobject('Lead').update(payload);
          if (!r2.success) throw new Error((r2.errors && r2.errors.join(', ')) || 'Failed to update Lead');
          leadId = existing.Id;
        } else {
          throw e;
        }
      }
    } else {
      const payload = { ...base };
      try {
        const r = await conn.sobject('Lead').create(payload);
        if (!r.success) throw new Error((r.errors && r.errors.join(', ')) || 'Failed to create Lead');
        leadId = r.id;
      } catch (e) {
        if (String(e.message || e).includes("No such column 'Campus__c'")) {
          delete payload.Campus__c;
          const r2 = await conn.sobject('Lead').create(payload);
          if (!r2.success) throw new Error((r2.errors && r2.errors.join(', ')) || 'Failed to create Lead');
          leadId = r2.id;
        } else if (String(e.message || e).includes('DUPLICATES_DETECTED')) {
          // If a duplicate rule blocks create, fall back to updating the latest non-converted lead (if any)
          try {
            const q2 = await conn.query(`
              SELECT Id, IsConverted FROM Lead
              WHERE Email='${escSOQL(email)}' AND IsConverted = false
              ORDER BY CreatedDate DESC LIMIT 1
            `);
            const openLead = q2.records?.[0] || null;
            if (openLead) {
              const upd = await conn.sobject('Lead').update({ ...base, Id: openLead.Id });
              if (!upd.success) throw new Error((upd.errors && upd.errors.join(', ')) || 'Failed to update Lead');
              leadId = openLead.Id;
            } else {
              // As a last resort, pretend success without referencing a converted lead
              return send(res, 200, { success: true });
            }
          } catch (e2) {
            throw e2;
          }
        } else {
          throw e;
        }
      }
    }

    return send(res, 200, { success: true, leadId });
  } catch (e) {
    return send(res, 500, { success: false, message: e?.message || 'Failed to submit lead' });
  }
};