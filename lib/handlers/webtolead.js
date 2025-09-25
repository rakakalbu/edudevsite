// /api/webtolead.js
const jsforce = require('jsforce');

function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
function normalizeIdnPhone(raw){
  let p = onlyDigits(raw || '');
  if (!p) return '';
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return '+' + p;
}
function escSOQL(v=''){ return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success:false, message:'Method not allowed' });
  }

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    return res.status(500).json({ success:false, message:'Salesforce env incomplete' });
  }

  try {
    const { firstName, lastName='', email, phone, campusId=null, description=null } = req.body || {};
    if (!firstName || !email || !phone) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
    }

    const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));

    // IMPORTANT: Do NOT set Company -> keeps it blank for Person Account conversion later.
    const payload = {
      FirstName   : firstName,
      LastName    : lastName || '-',     // Lead requires LastName
      Email       : String(email || '').toLowerCase(),
      Phone       : normalizeIdnPhone(phone),
      LeadSource  : 'Web',
      // OPTIONAL fields (kept as-is if you already had them mapped)
      ...(campusId   ? { Campus__c: campusId } : {}),
      ...(description? { Description: description } : {}),
    };

    const r = await conn.sobject('Lead').create(payload, {
      headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }
    });

    if (!r.success) {
      throw new Error((r.errors && r.errors.join(', ')) || 'Lead create failed');
    }

    return res.status(200).json({ success:true, id:r.id });
  } catch (e) {
    console.error('webtolead ERR:', e);
    return res.status(500).json({ success:false, message: e?.message || 'Failed' });
  }
};