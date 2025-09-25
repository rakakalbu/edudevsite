// /api/register-lead-convert.js
const jsforce = require('jsforce');

function digits(s){ return String(s||'').replace(/\D/g,''); }
function normalizePhone(raw){ let p=digits(raw||''); if(!p) return null; if(p.startsWith('0')) p=p.slice(1); if(!p.startsWith('62')) p='62'+p; return '+'+p; }
function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

async function login() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function getPersonRT(conn){
  const r=await conn.query(`SELECT Id FROM RecordType WHERE SobjectType='Account' AND IsPersonType=true LIMIT 1`);
  return r.records?.[0]?.Id || null;
}
async function getOppRT(conn){
  const r=await conn.query(`SELECT Id FROM RecordType WHERE SobjectType='Opportunity' AND DeveloperName='University' LIMIT 1`);
  return r.records?.[0]?.Id || null;
}
async function getConvertedStatus(conn){
  const r = await conn.query(`SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1`);
  return r.records?.[0]?.MasterLabel || 'Converted';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });

  try {
    const conn = await login();

    const { firstName, lastName, email, phone } = req.body || {};
    if(!firstName || !lastName || !email || !phone) throw new Error('Data tidak lengkap');

    const phoneE164 = normalizePhone(phone);
    const phoneDigits = digits(phoneE164);
    const p1 = `%+${phoneDigits}%`;
    const p2 = `%${phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits}%`;

    const soqlLead =
      "SELECT Id, FirstName, LastName, Email, Phone, IsConverted, ConvertedAccountId, ConvertedOpportunityId " +
      "FROM Lead " +
      "WHERE Email = '" + escSOQL(email.toLowerCase()) + "' " +
      "OR (Phone LIKE '" + escSOQL(p1) + "' OR Phone LIKE '" + escSOQL(p2) + "') " +
      "ORDER BY CreatedDate DESC LIMIT 1";

    const leadRes = await conn.query(soqlLead);
    const lead = (leadRes.records || [])[0];

    const personRT = await getPersonRT(conn);
    const oppRT    = await getOppRT(conn);
    const convStat = await getConvertedStatus(conn);

    if (lead && !lead.IsConverted) {
      const oppName = `${firstName} ${lastName}`.trim() || 'Admission';
      const convArr = await conn.requestPost('/sobjects/Lead/convert', [{
        leadId: lead.Id,
        convertedStatus: convStat,
        accountRecordTypeId: personRT || undefined,
        doNotCreateOpportunity: false,
        opportunityName: `${oppName}/REG`,
        opportunityRecordTypeId: oppRT || undefined
      }]);

      const conv = Array.isArray(convArr) ? convArr[0] : convArr;
      if (!conv || !conv.success) {
        const msg = (conv?.errors || []).map(e => e.message || e).join(', ') || 'Lead convert failed';
        throw new Error(msg);
      }

      if (conv.accountId) {
        await conn.sobject('Account').update({ Id: conv.accountId, Phone: phoneE164, PersonMobilePhone: phoneE164 }).catch(()=>{});
      }
      if (conv.opportunityId) {
        await conn.sobject('Opportunity').update({ Id: conv.opportunityId, StageName: 'Booking Form', CloseDate: new Date().toISOString().slice(0,10) }).catch(()=>{});
      }

      return res.status(200).json({ success:true, accountId: conv.accountId, opportunityId: conv.opportunityId });
    }

    if (lead && lead.IsConverted) {
      if (lead.ConvertedAccountId) {
        await conn.sobject('Account').update({ Id: lead.ConvertedAccountId, Phone: phoneE164, PersonMobilePhone: phoneE164 }).catch(()=>{});
      }
      if (lead.ConvertedOpportunityId) {
        await conn.sobject('Opportunity').update({ Id: lead.ConvertedOpportunityId, StageName: 'Booking Form', CloseDate: new Date().toISOString().slice(0,10) }).catch(()=>{});
      }
      return res.status(200).json({ success:true, accountId: lead.ConvertedAccountId || null, opportunityId: lead.ConvertedOpportunityId || null });
    }

    // Fallback: create Person Account + Opp (kept for compatibility)
    const acc = await conn.sobject('Account').create({
      RecordTypeId: personRT || undefined,
      FirstName: firstName,
      LastName : lastName,
      PersonEmail: email.toLowerCase(),
      Phone: phoneE164,
      PersonMobilePhone: phoneE164
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!acc.success) throw new Error(acc.errors?.join(', ') || 'Gagal membuat Account');

    const opp = await conn.sobject('Opportunity').create({
      RecordTypeId: oppRT || undefined,
      AccountId: acc.id,
      Name: `${firstName} ${lastName}/REG`.trim(),
      StageName: 'Booking Form',
      CloseDate: new Date().toISOString().slice(0,10)
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!opp.success) throw new Error(opp.errors?.join(', ') || 'Gagal membuat Opportunity');

    res.status(200).json({ success:true, opportunityId: opp.id, accountId: acc.id });
  } catch (err) {
    console.error('register-lead-convert ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Gagal memproses' });
  }
};