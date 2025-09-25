// /api/register-lead-convert.js
// Used by your “register” flow that may run separately to ensure Lead → Person Account + Opportunity.
// It uses your Apex/Flow toggle (Is_Convert__c) and falls back to direct creation when needed.

const jsforce = require('jsforce');

function digits(s){ return String(s||'').replace(/\D/g,''); }
function normalizePhone(raw){
  let p = digits(raw||'');
  if(!p) return null;
  if(p.startsWith('0')) p = p.slice(1);
  if(!p.startsWith('62')) p = '62'+p;
  return '+'+p;
}
function variants(phoneE164){
  const d62 = digits(phoneE164).replace(/^0/,'').replace(/^((?!62).*)$/,'62$1');
  const local = d62.slice(2);
  return Array.from(new Set(['+'+d62, d62, '0'+local, local]));
}
function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
const wait = (ms) => new Promise(r=>setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0,10);

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
  const r=await conn.query(`SELECT Id FROM RecordType WHERE SobjectType='Opportunity' AND (DeveloperName='University' OR Name='University') LIMIT 1`);
  return r.records?.[0]?.Id || null;
}
async function ensureOpp(conn, accountId, name){
  const oppRT = await getOppRT(conn);
  const res = await conn.sobject('Opportunity').create({
    AccountId: accountId,
    Name: name || `Admission - ${todayISO()}`,
    StageName: 'Booking Form',
    CloseDate: todayISO(),
    RecordTypeId: oppRT || undefined
  }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
  if(!res.success) throw new Error(res.errors?.join(', ') || 'Gagal membuat Opportunity');
  return res.id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });

  try {
    const conn = await login();

    const { firstName, lastName, email, phone } = req.body || {};
    if(!firstName || !lastName || !email || !phone) throw new Error('Data tidak lengkap');

    const phoneE164 = normalizePhone(phone);
    const phones    = variants(phoneE164).map(escSOQL);
    const phoneIn   = phones.map(v=>`'${v}'`).join(',');

    // Find lead by email or phone (EXACT equality across normalized variants)
    const soqlLead =
      "SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, IsConverted, ConvertedAccountId, ConvertedOpportunityId " +
      "FROM Lead " +
      "WHERE Email = '" + escSOQL(email.toLowerCase()) + "' " +
      (phoneIn ? "OR Phone IN (" + phoneIn + ") OR MobilePhone IN (" + phoneIn + ") " : '') +
      "ORDER BY CreatedDate DESC LIMIT 1";

    let lead = (await conn.query(soqlLead)).records?.[0];

    if (lead && !lead.IsConverted) {
      // Trigger your Apex/Flow
      await conn.sobject('Lead').update({
        Id: lead.Id,
        FirstName: firstName,
        LastName : lastName,
        Email    : email.toLowerCase(),
        Phone    : phoneE164,
        MobilePhone: phoneE164,
        Is_Convert__c: true
      }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });

      // Poll briefly
      const MAX=14, SLEEP=700;
      for (let i=0;i<MAX;i++){ await wait(SLEEP); const r=await conn.query(`SELECT Id,IsConverted,ConvertedAccountId,ConvertedOpportunityId FROM Lead WHERE Id='${lead.Id}' LIMIT 1`); lead=r.records?.[0]; if(lead?.IsConverted) break; }
    }

    if (lead && lead.IsConverted) {
      const accountId = lead.ConvertedAccountId || null;
      let opportunityId = lead.ConvertedOpportunityId || null;

      if (accountId) {
        await conn.sobject('Account').update({ Id: accountId, Phone: phoneE164, PersonMobilePhone: phoneE164 }).catch(()=>{});
      }
      if (!opportunityId && accountId) {
        const oppName = `${firstName} ${lastName}`.trim() || 'Admission';
        opportunityId = await ensureOpp(conn, accountId, `${oppName}/REG`);
      } else if (opportunityId) {
        await conn.sobject('Opportunity').update({ Id: opportunityId, StageName: 'Booking Form', CloseDate: todayISO() }).catch(()=>{});
      }

      return res.status(200).json({ success:true, accountId, opportunityId });
    }

    // Fallback: create Person Account + Opportunity
    const personRT = await getPersonRT(conn);
    const acc = await conn.sobject('Account').create({
      RecordTypeId: personRT || undefined,
      FirstName: firstName,
      LastName : lastName,
      PersonEmail: email.toLowerCase(),
      Phone: phoneE164,
      PersonMobilePhone: phoneE164
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!acc.success) throw new Error(acc.errors?.join(', ') || 'Gagal membuat Account');

    const oppName = `${firstName} ${lastName}`.trim() || 'Admission';
    const oppId = await ensureOpp(conn, acc.id, `${oppName}/REG`);

    return res.status(200).json({ success:true, accountId: acc.id, opportunityId: oppId });
  } catch (err) {
    console.error('register-lead-convert ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Gagal memproses' });
  }
};