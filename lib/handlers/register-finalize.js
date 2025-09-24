// api/register-finalize.js
const jsforce = require('jsforce');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const { opportunityId, accountId } = req.body || {};
    if (!opportunityId || !accountId) throw new Error('Param kurang');

    // login with token if available
    await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));

    // Update both StageName and Web_Stage__c
    await conn.sobject('Opportunity').update({
      Id: opportunityId,
      StageName: 'Registration',
      Web_Stage__c: 6
    });

    // OPTIONAL: If you want to update Account fields from latest entries, you can do it here.

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('register-finalize ERR:', err);
    res.status(500).json({ success: false, message: err.message || 'Finalize failed' });
  }
};