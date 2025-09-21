// api/auth-register.js
const jsforce = require('jsforce');
const crypto = require('crypto');

function digits(s){ return String(s||'').replace(/\D/g,''); }
function normalizePhone(raw){ let p=digits(raw||''); if(!p) return null; if(p.startsWith('0')) p=p.slice(1); if(!p.startsWith('62')) p='62'+p; return '+'+p; }
function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const { firstName, lastName, email, phone, password } = req.body || {};
    if(!firstName || !lastName || !email || !phone || !password) throw new Error('Data tidak lengkap');

    await conn.login(SF_USERNAME, SF_PASSWORD);

    // 1) Enforce email uniqueness on Account (PersonEmail)
    const qAcc = await conn.query(`
      SELECT Id FROM Account
      WHERE IsPersonAccount = true
      AND PersonEmail = '${escSOQL(email.toLowerCase())}'
      LIMIT 1
    `);
    if (qAcc.totalSize > 0) {
      return res.status(400).json({ success:false, message:'Email sudah terdaftar. Gunakan email lain atau masuk.' });
    }

    // 2) Resolve RecordTypes
    const rtAcc = await conn.query("SELECT Id FROM RecordType WHERE SobjectType='Account' AND IsPersonType=true LIMIT 1");
    const accRT = rtAcc.records?.[0]?.Id || undefined;

    const rtOpp = await conn.query("SELECT Id FROM RecordType WHERE SobjectType='Opportunity' AND Name='University' LIMIT 1");
    const oppRT = rtOpp.records?.[0]?.Id || undefined;

    // 3) Create Account (Person)
    const acc = await conn.sobject('Account').create({
      RecordTypeId: accRT,
      FirstName: firstName,
      LastName: lastName || '-',
      PersonEmail: email.toLowerCase(),
      PersonMobilePhone: normalizePhone(phone),
      Password__c: crypto.createHash('sha256').update(password).digest('hex')
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!acc.success) throw new Error(acc.errors?.join(', ') || 'Gagal membuat Account');

    // 4) Create Opportunity (fresh) for this registration
    const closeDate = new Date(); closeDate.setDate(closeDate.getDate()+30);
    const opp = await conn.sobject('Opportunity').create({
      RecordTypeId: oppRT,
      AccountId: acc.id,
      Name: `${firstName} ${lastName}/REG`,
      StageName: 'Booking Form',
      CloseDate: closeDate.toISOString().slice(0,10)
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!opp.success) throw new Error(opp.errors?.join(', ') || 'Gagal membuat Opportunity');

    return res.status(200).json({ success:true, accountId: acc.id, opportunityId: opp.id });
  } catch (err) {
    console.error('auth-register ERR:', err);
    return res.status(500).json({ success:false, message: err.message || 'Gagal memproses pendaftaran' });
  }
};