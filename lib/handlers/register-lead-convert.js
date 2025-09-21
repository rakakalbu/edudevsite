const jsforce = require('jsforce');

function digits(s){ return String(s||'').replace(/\D/g,''); }
function normalizePhone(raw){ let p=digits(raw||''); if(!p) return null; if(p.startsWith('0')) p=p.slice(1); if(!p.startsWith('62')) p='62'+p; return '+'+p; }
function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const { firstName, lastName, email, phone } = req.body || {};
    if(!firstName || !lastName || !email || !phone) throw new Error('Data tidak lengkap');

    await conn.login(SF_USERNAME, SF_PASSWORD);

    const phoneDigits = digits(normalizePhone(phone));
    const p1 = `%+${phoneDigits}%`;
    const p2 = `%${phoneDigits.startsWith('62') ? phoneDigits.slice(2) : phoneDigits}%`;
    const soqlLead =
      "SELECT Id, Email, Phone, Is_Convert__c, ConvertedOpportunityId " +
      "FROM Lead " +
      "WHERE Email = '" + escSOQL(email.toLowerCase()) + "' " +
      "AND (Phone LIKE '" + escSOQL(p1) + "' OR Phone LIKE '" + escSOQL(p2) + "') " +
      "ORDER BY CreatedDate DESC LIMIT 1";

    const leadRes = await conn.query(soqlLead);
    const lead = (leadRes.records || [])[0];

    async function getOppUniversityRT(){ const r=await conn.query("SELECT Id FROM RecordType WHERE SobjectType='Opportunity' AND Name='University' LIMIT 1"); return r.records?.[0]?.Id||null; }
    async function getPersonAcctRT(){ const r=await conn.query("SELECT Id FROM RecordType WHERE SobjectType='Account' AND IsPersonType=true LIMIT 1"); return r.records?.[0]?.Id||null; }

    if (lead) {
      await conn.sobject('Lead').update({ Id: lead.Id, Is_Convert__c: true }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
      if (lead.ConvertedOpportunityId) {
        const opp = await conn.sobject('Opportunity').retrieve(lead.ConvertedOpportunityId);
        return res.status(200).json({ success:true, opportunityId: opp.Id, accountId: opp.AccountId });
      }
      return res.status(200).json({ success:true, message:'Lead ditandai untuk konversi' });
    }

    const personRT = await getPersonAcctRT();
    const oppRT    = await getOppUniversityRT();

    const acc = await conn.sobject('Account').create({
      RecordTypeId: personRT || undefined,
      LastName: lastName,
      FirstName: firstName,
      PersonEmail: email.toLowerCase(),
      PersonMobilePhone: normalizePhone(phone)
    });
    if(!acc.success) throw new Error(acc.errors?.join(', ') || 'Gagal membuat Account');

    const closeDate = new Date(); closeDate.setDate(closeDate.getDate()+30);
    const opp = await conn.sobject('Opportunity').create({
      RecordTypeId: oppRT || undefined,
      AccountId: acc.id,
      Name: `${firstName} ${lastName}/REG`,
      StageName: 'Booking Form',
      CloseDate: closeDate.toISOString().slice(0,10)
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!opp.success) throw new Error(opp.errors?.join(', ') || 'Gagal membuat Opportunity');

    res.status(200).json({ success:true, opportunityId: opp.id, accountId: acc.id });
  } catch (err) {
    console.error('register-lead-convert ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Gagal memproses' });
  }
};
