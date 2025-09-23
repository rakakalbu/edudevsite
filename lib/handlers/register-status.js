// lib/handlers/register-status.js
// GET /api/register-status?opportunityId=006xxxxxxxxxxxx
// Returns: { success, opportunityId, accountId, webStage, stageName, person: {...} }

const jsforce = require('jsforce');

function isSfId(id) {
  return /^[a-zA-Z0-9]{15,18}$/.test(String(id || ''));
}

function send(res, code, obj) {
  res.status(code).json(obj);
}

async function login(env) {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env || process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce env incomplete (SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD)');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return send(res, 405, { success: false, message: 'Method not allowed' });

    const opportunityId = (req.query.opportunityId || req.query.opp || '').trim();
    if (!isSfId(opportunityId)) {
      return send(res, 400, { success: false, message: 'Invalid opportunityId' });
    }

    const conn = await login(process.env);

    // Pull Opportunity & related Account (Person Account)
    const q = await conn.query(`
      SELECT Id, AccountId, StageName, Web_Stage__c,
             Account.PersonEmail, Account.FirstName, Account.LastName, Account.PersonHomePhone
      FROM Opportunity
      WHERE Id = '${opportunityId}'
      LIMIT 1
    `);

    if (q.totalSize === 0) return send(res, 404, { success: false, message: 'Opportunity not found' });

    const o = q.records[0] || {};
    const webStage = Number(o.Web_Stage__c ?? 1) || 1;

    return send(res, 200, {
      success: true,
      opportunityId: o.Id,
      accountId: o.AccountId || null,
      webStage,
      stageName: o.StageName || null,
      person: {
        firstName: o.Account?.FirstName || '',
        lastName:  o.Account?.LastName || '',
        email:     o.Account?.PersonEmail || '',
        phone:     o.Account?.PersonHomePhone || ''
      }
    });
  } catch (e) {
    console.error('register-status error:', e);
    return send(res, 500, { success: false, message: e?.message || String(e) });
  }
};