// src/api/webtolead.js
const jsforce = require('jsforce');

/** Utilities */
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function normalizePhone(raw) {
  let p = digits(raw || '');
  if (!p) return null;
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return '+' + p;
}
function sameSfId(a, b) {
  if (!a || !b) return false;
  return String(a).substring(0, 15).toUpperCase() === String(b).substring(0, 15).toUpperCase();
}
/** External ID: UNIQUE per campus */
function makeExternalId(email, phone, campusId) {
  const e = String(email || '').trim().toLowerCase();
  const d = digits(phone || '');
  const c = String(campusId || '').substring(0, 15).toUpperCase();
  return `${e}|${d}|${c}`.slice(0, 255);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const body = req.body || {};
    const firstName   = (body.firstName || '').trim();
    const lastName    = (body.lastName || '').trim();
    const email       = (body.email || '').trim().toLowerCase();
    const phoneNorm   = normalizePhone(body.phone);
    const campusId    = (body.campusId || '').trim();
    const description = (body.description || '') || null;

    // Basic validation
    if (!firstName) throw new Error('First name wajib diisi.');
    if (!email)     throw new Error('Email wajib diisi.');
    if (!phoneNorm) throw new Error('Phone wajib diisi.');
    if (!campusId)  throw new Error('Campus wajib dipilih.');

    const externalId = makeExternalId(email, phoneNorm, campusId);

    await conn.login(SF_USERNAME, SF_PASSWORD);

    // Cari lead existing (Email ATAU Phone) — lintas kampus
    const phoneDigits = digits(phoneNorm);
    const patPlus62   = '+' + phoneDigits;                         // +62xxxx
    const patLocal    = phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits;

    const soql = `
      SELECT Id, FirstName, LastName, Email, Phone, Campus__c, Description
      FROM Lead
      WHERE (Email = '${email}'
        OR Phone LIKE '%${patPlus62}%'
        OR Phone LIKE '%${patLocal}%'
      )
      ORDER BY CreatedDate DESC
      LIMIT 200
    `;
    const q = await conn.query(soql);
    const recs = q.records || [];

    const sameCampus = recs.find(r => sameSfId(r.Campus__c, campusId));
    const anyMatch   = recs.length > 0;

    // Header: izinkan save walau ada duplicate match
    const dupHeader = { headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } };

    async function updateLead(targetId) {
      const upd = {
        Id: targetId,
        FirstName: firstName,
        LastName: lastName || null,
        Email: email,
        Phone: phoneNorm,
        Description: description,
        LeadSource: 'Web',
        Status: 'New',
        External_ID__c: externalId,
        Campus__c: campusId
      };
      await conn.sobject('Lead').update(upd, dupHeader);
      return { action: 'updated', leadId: targetId };
    }

    async function createLead() {
      const ins = {
        FirstName: firstName,
        LastName: lastName || null,
        Email: email,
        Phone: phoneNorm,
        Description: description,
        LeadSource: 'Web',
        Status: 'New',
        External_ID__c: externalId,
        Campus__c: campusId
      };
      const result = await conn.sobject('Lead').create(ins, dupHeader);
      if (!result.success) {
        throw new Error((result.errors && result.errors.join(', ')) || 'Gagal membuat Lead.');
      }
      return { action: 'created', leadId: result.id };
    }

    let outcome;
    if (sameCampus) {
      // Kampus sama → update/replace jika ada perubahan
      const needUpdate =
        (sameCampus.Email || '').toLowerCase() !== email ||
        (digits(sameCampus.Phone) !== digits(phoneNorm)) ||
        (sameCampus.FirstName || '') !== firstName ||
        (sameCampus.LastName || '') !== (lastName || '') ||
        !sameSfId(sameCampus.Campus__c, campusId) ||
        (description && description !== (sameCampus.Description || ''));

      outcome = needUpdate ? await updateLead(sameCampus.Id) : { action: 'skipped', leadId: sameCampus.Id };
    } else if (anyMatch) {
      // Ada match identitas tapi kampus berbeda → buat record baru
      outcome = await createLead();
    } else {
      // Tidak ada match sama sekali → buat record baru
      outcome = await createLead();
    }

    return res.status(200).json({ success: true, ...outcome });
  } catch (error) {
    console.error('WebToLead Error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Gagal memproses form.' });
  }
};
