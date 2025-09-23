// lib/handlers/salesforce-query.js
// POST /api/salesforce-query  { opportunityId, webStage:number }  -> updates Opportunity.Web_Stage__c

const jsforce = require('jsforce');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;

  try {
    const { opportunityId, webStage } = req.body || {};
    if (!opportunityId) return res.status(400).json({ success:false, message:'opportunityId required' });
    if (typeof webStage !== 'number') return res.status(400).json({ success:false, message:'webStage (number) required' });

    const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));

    await conn.sobject('Opportunity').update({ Id: opportunityId, Web_Stage__c: webStage });

    return res.status(200).json({ success:true });
  } catch (e) {
    console.error('update-stage error:', e);
    return res.status(500).json({ success:false, message: String(e && e.message || e) });
  }
};