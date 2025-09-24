// lib/handlers/auth-login.js
// POST /api/auth-login  { email, password }
// - Verifies Account (Person Account) by email + sha256(password) = Account.Password__c
// - ALWAYS creates a NEW Opportunity (RecordType = "University", StageName = "Booking Form")
// - Returns { success, accountId, opportunityId, firstName, lastName, phone }

const jsforce = require('jsforce');
const crypto  = require('crypto');

function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function sha256(s){ return crypto.createHash('sha256').update(String(s||''), 'utf8').digest('hex'); }

async function loginSF(env){
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env || process.env;
  if(!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD){
    throw new Error('ENV Salesforce belum lengkap (SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD)');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function getOppRecordTypeId(conn){
  // Prefer "University" by DeveloperName or Name; fallback to first available
  const q = await conn.query(`
    SELECT Id, Name, DeveloperName
    FROM RecordType
    WHERE SobjectType = 'Opportunity'
      AND (DeveloperName = 'University' OR Name = 'University')
    LIMIT 1
  `);
  if (q.totalSize > 0) return q.records[0].Id;

  const q2 = await conn.query(`
    SELECT Id
    FROM RecordType
    WHERE SobjectType = 'Opportunity'
    LIMIT 1
  `);
  return q2.records?.[0]?.Id || null;
}

module.exports = async (req, res) => {
  try{
    if (req.method !== 'POST') {
      return res.status(405).json({ success:false, message:'Method not allowed' });
    }

    const emailRaw = (req.body?.email || '').trim().toLowerCase();
    const passRaw  = String(req.body?.password || '');

    if (!emailRaw || !passRaw) {
      return res.status(400).json({ success:false, message:'Email dan kata sandi wajib diisi' });
    }

    const conn = await loginSF(process.env);

    // 1) Find Person Account by email
    const qAcc = await conn.query(`
      SELECT Id, FirstName, LastName, PersonEmail, PersonMobilePhone, PersonHomePhone, Password__c
      FROM Account
      WHERE IsPersonAccount = true
        AND PersonEmail = '${escSOQL(emailRaw)}'
      LIMIT 1
    `);
    if (qAcc.totalSize === 0) {
      return res.status(401).json({ success:false, message:'Email atau kata sandi salah' });
    }
    const acc = qAcc.records[0];

    // 2) Verify password (sha256)
    const inputHash = sha256(passRaw);
    const stored    = String(acc.Password__c || '');
    if (!stored || stored.toLowerCase() !== inputHash.toLowerCase()) {
      return res.status(401).json({ success:false, message:'Email atau kata sandi salah' });
    }

    // 3) ALWAYS create a NEW Opportunity
    const oppRT = await getOppRecordTypeId(conn);
    const closeDate = new Date(); closeDate.setDate(closeDate.getDate() + 30);

    // Make the name unique to avoid duplicate-name confusion
    const ts = new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14); // YYYYMMDDHHMMSS
    const fullName = `${acc.FirstName || ''} ${acc.LastName || ''}`.trim() || (acc.PersonEmail || 'REG');
    const oppName  = `${fullName}/REG/${ts}`;

    const oppRes = await conn.sobject('Opportunity').create({
      RecordTypeId: oppRT || undefined,
      AccountId: acc.Id,
      Name: oppName,
      StageName: 'Booking Form',
      CloseDate: closeDate.toISOString().slice(0,10),
      // Optionally set Web_Stage__c to 2 so Step 2 loads even if front-end update fails
      Web_Stage__c: 2
    }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} });

    if (!oppRes.success) {
      throw new Error(oppRes.errors?.join(', ') || 'Gagal membuat Opportunity');
    }

    // 4) Return new IDs + basic person info for the wizard
    return res.status(200).json({
      success: true,
      accountId: acc.Id,
      opportunityId: oppRes.id,
      firstName: acc.FirstName || '',
      lastName : acc.LastName  || '',
      phone    : acc.PersonMobilePhone || acc.PersonHomePhone || ''
    });

  }catch(err){
    console.error('auth-login ERR:', err);
    return res.status(500).json({ success:false, message: err?.message || 'Gagal memproses login' });
  }
};