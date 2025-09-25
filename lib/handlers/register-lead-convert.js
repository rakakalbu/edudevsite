// /api/register-lead-convert.js
// Used by the “register” flow variant that converts an existing Lead when appropriate.
// FIX: do NOT attach to a converted Lead found by phone-only. Email must match for reuse.
// Otherwise, create a brand-new Person Account + Opportunity.

const jsforce = require('jsforce');

function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
function normalizeIdnPhone(raw){
  let p = onlyDigits(raw || '');
  if (!p) return '';
  if (p.startsWith('0')) p = p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return '+' + p;
}
function normDigitsE164(raw){
  let d = onlyDigits(raw || '');
  if (!d) return '';
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('62')) d = '62' + d;
  return d;
}
function escSOQL(v=''){ return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
const wait = (ms)=> new Promise(r=>setTimeout(r,ms));
const todayISO = ()=> new Date().toISOString().slice(0,10);

async function login(env){
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env || process.env;
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

async function findLeadSmart(conn, email, phoneE164){
  const digits = normDigitsE164(phoneE164);
  const patPlus = '+' + digits;
  const patLocal = digits.startsWith('62') ? digits.slice(2) : digits;

  // 1) exact email
  const q1 = await conn.query(`
    SELECT Id, FirstName, LastName, Email, Phone, IsConverted,
           ConvertedAccountId, ConvertedOpportunityId
    FROM Lead
    WHERE Email = '${escSOQL(email)}'
    ORDER BY CreatedDate DESC
    LIMIT 1
  `);
  if (q1.totalSize > 0) return q1.records[0];

  // 2) phone match but ONLY unconverted leads (so we can convert)
  const q2 = await conn.query(`
    SELECT Id, FirstName, LastName, Email, Phone, IsConverted,
           ConvertedAccountId, ConvertedOpportunityId
    FROM Lead
    WHERE IsConverted = false
      AND (Phone LIKE '%${escSOQL(patPlus)}%' OR Phone LIKE '%${escSOQL(patLocal)}%')
    ORDER BY CreatedDate DESC
    LIMIT 1
  `);
  return q2.records?.[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success:false, message:'Method not allowed' });
  }

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    return res.status(500).json({ success:false, message:'Salesforce env incomplete' });
  }

  try {
    const { firstName, lastName='', email, phone } = req.body || {};
    if (!firstName || !email || !phone) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
    }

    const conn = await login(process.env);
    const phoneE164 = normalizeIdnPhone(phone);
    const emailNorm = String(email || '').toLowerCase();

    // Smart find (email first, then phone on unconverted)
    let lead = await findLeadSmart(conn, emailNorm, phoneE164);

    if (lead) {
      if (!lead.IsConverted) {
        // trigger your Apex/Flow via flag
        await conn.sobject('Lead').update({
          Id: lead.Id,
          FirstName: firstName,
          LastName : lastName || '-',
          Email    : emailNorm,
          Phone    : phoneE164,
          Is_Convert__c: true
        }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });

        // Poll briefly
        const MAX=14, SLEEP=700;
        for (let i=0;i<MAX;i++){
          await wait(SLEEP);
          const r=await conn.query(`SELECT Id,IsConverted,ConvertedAccountId,ConvertedOpportunityId FROM Lead WHERE Id='${lead.Id}' LIMIT 1`);
          lead=r.records?.[0];
          if(lead?.IsConverted) break;
        }
      }

      if (lead && lead.IsConverted) {
        // Reuse ONLY if email matches; otherwise ignore (treat as new)
        const sameEmail = String(lead.Email || '').toLowerCase() === emailNorm;
        if (sameEmail) {
          const accountId = lead.ConvertedAccountId || null;
          let opportunityId = lead.ConvertedOpportunityId || null;

          if (accountId) {
            await conn.sobject('Account').update({
              Id: accountId,
              Phone: phoneE164,
              PersonMobilePhone: phoneE164
            }).catch(()=>{});
          }
          if (!opportunityId && accountId) {
            const oppName = `${firstName} ${lastName}`.trim() || 'Admission';
            opportunityId = await ensureOpp(conn, accountId, `${oppName}/REG`);
          }
          // ADD: ensure the converted/reused Opportunity uses the "University" Record Type
          try {
            const uniRT = await getOppRT(conn);           // already defined above
            if (opportunityId && uniRT) {
              await conn.sobject('Opportunity').update({
                Id: opportunityId,
                RecordTypeId: uniRT
              }).catch(()=>{});
            }
          } catch (_) {}

          return res.status(200).json({ success:true, accountId, opportunityId });
        }
        // else fall-through to fresh creation
      }
    }

    // Fresh creation
    const personRT = await getPersonRT(conn);
    const acc = await conn.sobject('Account').create({
      RecordTypeId: personRT || undefined,
      FirstName: firstName,
      LastName : lastName || '-',
      PersonEmail: emailNorm,
      Phone: phoneE164,
      PersonMobilePhone: phoneE164
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!acc.success) throw new Error(acc.errors?.join(', ') || 'Gagal membuat Account');

    const oppName = `${firstName} ${lastName}`.trim() || 'Admission';
    const oppId = await ensureOpp(conn, acc.id, `${oppName}/REG`);

    return res.status(200).json({ success:true, accountId: acc.id, opportunityId: oppId });
  } catch (e) {
    console.error('register-lead-convert ERR:', e);
    return res.status(500).json({ success:false, message: e?.message || 'Failed' });
  }
};