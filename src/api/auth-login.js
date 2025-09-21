// api/auth-login.js
const jsforce = require('jsforce');
const crypto = require('crypto');

function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const { email, password } = req.body || {};
    if(!email || !password) throw new Error('Email & password wajib diisi');

    await conn.login(SF_USERNAME, SF_PASSWORD);

    // 1) Find Account by PersonEmail
    const r = await conn.query(`
      SELECT Id, FirstName, LastName, PersonMobilePhone, Password__c
      FROM Account
      WHERE IsPersonAccount = true
      AND PersonEmail = '${escSOQL(String(email).toLowerCase())}'
      LIMIT 1
    `);
    const acc = r.records?.[0];
    if (!acc) return res.status(401).json({ success:false, message:'Akun tidak ditemukan' });

    // 2) Compare SHA-256 hash
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (hash !== acc.Password__c) return res.status(401).json({ success:false, message:'Kata sandi salah' });

    // 3) Create a NEW Opportunity for this session/registration
    const rtOpp = await conn.query("SELECT Id FROM RecordType WHERE SobjectType='Opportunity' AND Name='University' LIMIT 1");
    const oppRT = rtOpp.records?.[0]?.Id || undefined;

    const closeDate = new Date(); closeDate.setDate(closeDate.getDate()+30);
    const opp = await conn.sobject('Opportunity').create({
      RecordTypeId: oppRT,
      AccountId: acc.Id,
      Name: `${acc.FirstName || ''} ${acc.LastName || ''}/REG`.trim(),
      StageName: 'Booking Form',
      CloseDate: closeDate.toISOString().slice(0,10)
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });
    if(!opp.success) throw new Error(opp.errors?.join(', ') || 'Gagal membuat Opportunity');

    return res.status(200).json({
      success:true,
      accountId: acc.Id,
      opportunityId: opp.id,
      firstName: acc.FirstName || '',
      lastName: acc.LastName || '',
      phone: acc.PersonMobilePhone || ''
    });
  } catch (err) {
    console.error('auth-login ERR:', err);
    return res.status(500).json({ success:false, message: err.message || 'Gagal memproses login' });
  }
};