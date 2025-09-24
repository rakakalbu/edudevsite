// lib/handlers/auth-login.js
const jsforce = require('jsforce');
const crypto = require('crypto');

function esc(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

async function login(env) {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env || process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce env incomplete (SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD)');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function getOppRT(conn) {
  const r = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Opportunity' AND (DeveloperName='University' OR Name='University')
    LIMIT 1
  `);
  return r.records?.[0]?.Id || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });

  const { email, password } = req.body || {};
  try {
    if (!email || !password) throw new Error('Email & password required');

    const conn = await login(process.env);
    const hash = crypto.createHash('sha256').update(password).digest('hex');

    // Person Account by email + password hash
    const qA = await conn.query(`
      SELECT Id, FirstName, LastName, PersonHomePhone
      FROM Account
      WHERE IsPersonAccount = true
        AND PersonEmail = '${esc(String(email).toLowerCase())}'
        AND Password__c = '${esc(hash)}'
      LIMIT 1
    `);
    if (qA.totalSize === 0) return res.status(401).json({ success:false, message:'Email/kata sandi salah' });

    const acc = qA.records[0];

    // Find most recent Opportunity for this Account
    const qO = await conn.query(`
      SELECT Id
      FROM Opportunity
      WHERE AccountId='${acc.Id}'
      ORDER BY CreatedDate DESC
      LIMIT 1
    `);

    let oppId = qO.records?.[0]?.Id || null;

    // If none, create one (rare)
    if (!oppId) {
      const closeDate = new Date(); closeDate.setDate(closeDate.getDate()+30);
      oppId = (await conn.sobject('Opportunity').create({
        Name: `${acc.FirstName || ''} ${acc.LastName || ''}/REG`.trim(),
        AccountId: acc.Id,
        StageName: 'Booking Form',
        CloseDate: closeDate.toISOString().slice(0,10),
        RecordTypeId: await getOppRT(conn)
      }, { headers:{'Sforce-Duplicate-Rule-Header':'allowSave=true'} })).id;
    }

    return res.status(200).json({
      success:true,
      accountId: acc.Id,
      opportunityId: oppId,
      firstName: acc.FirstName || '',
      lastName : acc.LastName  || '',
      phone    : acc.PersonHomePhone || ''
    });
  } catch (e) {
    console.error('auth-login error:', e);
    return res.status(500).json({ success:false, message: e?.message || 'Login gagal' });
  }
};