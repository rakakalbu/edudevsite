// api/webtolead_school.js
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
  if (req.method !== 'POST')
    return res.status(405).json({ success:false, message:'Method not allowed' });

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD)
    return res.status(500).json({ success:false, message:'Salesforce env incomplete' });

  try {
    const {
      firstName,
      lastName='',
      email,
      phone,
      educationLevel,
      masterSchoolId,
      description=null
    } = req.body || {};

    if (!firstName || !email || !phone || !educationLevel)
      return res.status(400).json({ success:false, message:'Missing required fields' });

    const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));

    // 🔎 Find RecordTypeId for "School"
    const rt = await conn.query(
      `SELECT Id FROM RecordType WHERE SObjectType='Lead' AND DeveloperName='School' LIMIT 1`
    );
    const recordTypeId = rt.records?.[0]?.Id;
    if (!recordTypeId)
      throw new Error('RecordType "School" not found in Lead object.');

    const payload = {
      RecordTypeId: recordTypeId,
      FirstName   : firstName,
      LastName    : lastName || '-',
      Email       : String(email || '').toLowerCase(),
      Phone       : normalizeIdnPhone(phone),
      LeadSource  : 'Web - Metro Mini School',
      Education_Level__c: educationLevel,
      ...(masterSchoolId ? { Master_Metro_School__c: masterSchoolId } : {}),
      ...(description ? { Description: description } : {})
    };

    const result = await conn.sobject('Lead').create(payload, {
      headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }
    });

    if (!result.success)
      throw new Error((result.errors && result.errors.join(', ')) || 'Lead create failed');

    return res.status(200).json({ success:true, id: result.id });
  } catch (e) {
    console.error('webtolead_school ERR:', e);
    return res.status(500).json({ success:false, message: e?.message || 'Failed' });
  }
};