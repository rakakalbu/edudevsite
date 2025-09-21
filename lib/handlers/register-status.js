const jsforce = require('jsforce');
const digits = (s) => String(s||'').replace(/\D/g,'');
function escSOQL(v){ return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ success:false, message:'Method not allowed' });
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const { email, phone } = req.query || {};
    if(!email || !phone) throw new Error('Param kurang');

    await conn.login(SF_USERNAME, SF_PASSWORD);

    const pd = digits(phone);
    const p1 = `%+${pd}%`;
    const p2 = `%${pd.startsWith('62') ? pd.slice(2) : pd}%`;

    const soql =
      "SELECT Id, ConvertedOpportunityId FROM Lead " +
      "WHERE Email = '" + escSOQL(String(email).toLowerCase()) + "' " +
      "AND (Phone LIKE '" + escSOQL(p1) + "' OR Phone LIKE '" + escSOQL(p2) + "') " +
      "ORDER BY LastModifiedDate DESC LIMIT 1";

    const r = await conn.query(soql);
    const lead = (r.records || [])[0];

    if (lead?.ConvertedOpportunityId) {
      const opp = await conn.sobject('Opportunity').retrieve(lead.ConvertedOpportunityId);
      return res.status(200).json({ success:true, opportunityId: opp.Id, accountId: opp.AccountId });
    }
    res.status(200).json({ success:true, opportunityId: null });
  } catch (err) {
    console.error('register-status ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Status check failed' });
  }
};
