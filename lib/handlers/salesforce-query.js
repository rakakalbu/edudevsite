// lib/handlers/salesforce-query.js
// POST /api/salesforce-query { opportunityId, webStage:number } -> updates Opportunity.Web_Stage__c
// GET  /api/salesforce-query?type=campus|intake|program&term=...&campusId=... -> lookup helpers (from promo site)

const jsforce = require('jsforce');

function esc(s) { return String(s || '').replace(/'/g, "\\'"); }
function send(res, code, obj) { res.status(code).json(obj); }

async function loginSF() {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    const err = new Error('ENV Salesforce belum lengkap (SF_LOGIN_URL,SF_USERNAME,SF_PASSWORD)');
    err.code = 'ENV_MISSING';
    throw err;
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  // Keep existing behavior: append token if provided
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function handlePost(req, res) {
  // === Preserve your original POST behavior ===
  const { opportunityId, webStage } = req.body || {};
  if (!opportunityId) return send(res, 400, { success: false, message: 'opportunityId required' });
  if (typeof webStage !== 'number') return send(res, 400, { success: false, message: 'webStage (number) required' });

  try {
    const conn = await loginSF();
    await conn.sobject('Opportunity').update({ Id: opportunityId, Web_Stage__c: webStage });
    return send(res, 200, { success: true });
  } catch (e) {
    console.error('update-stage error:', e);
    return send(res, 500, { success: false, message: String((e && e.message) || e) });
  }
}

async function handleGet(req, res) {
  // === New GET features from the promo repo ===
  // Supports ?type=campus|intake|program&term=&campusId=
  const { type, term = '', campusId = '' } = req.query || {};
  if (!type) return send(res, 400, { success: false, message: 'type wajib diisi' });

  let conn;
  try {
    conn = await loginSF();
  } catch (e) {
    console.error('SF login error:', e);
    return send(res, 500, {
      success: false,
      message: e.code === 'ENV_MISSING' ? e.message : 'Gagal login ke Salesforce',
      error: String((e && e.message) || e)
    });
  }

  try {
    // ===== CAMPUS =====
    if (type === 'campus') {
      try {
        // Try real Campus__c first
        const q = await conn.query(`
          SELECT Id, Name
          FROM Campus__c
          WHERE Name LIKE '%${esc(term)}%'
          ORDER BY Name
          LIMIT 200
        `);
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return send(res, 200, {
          success: true,
          records: q.records.map(r => ({ Id: r.Id, Name: r.Name }))
        });
      } catch (e) {
        // Fallback to distinct Account.Master_School__c
        const msg = String((e && e.message) || e);
        const needFallback = /INVALID_TYPE|sObject type .* is not supported|No such column/i.test(msg);
        if (!needFallback) {
          console.error('Campus query error:', e);
          return send(res, 500, { success: false, message: 'Gagal query Campus', error: msg });
        }
        try {
          const q2 = await conn.query(`
            SELECT Master_School__c
            FROM Account
            WHERE Master_School__c != null
              AND Master_School__c LIKE '%${esc(term)}%'
            GROUP BY Master_School__c
            ORDER BY Master_School__c
            LIMIT 200
          `);
          const rows = (q2.records || []).map(r => ({
            Id: r.Master_School__c, // use the name as value
            Name: r.Master_School__c
          }));
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
          return send(res, 200, { success: true, records: rows, fallback: 'Account.Master_School__c' });
        } catch (e2) {
          console.error('Campus fallback error:', e2);
          return send(res, 500, { success: false, message: 'Gagal query fallback Campus', error: String((e2 && e2.message) || e2) });
        }
      }
    }

    // ===== INTAKE =====
    if (type === 'intake') {
      const q = await conn.query(`
        SELECT Id, Name, Academic_Year__c
        FROM Master_Intake__c
        WHERE Name LIKE '%${esc(term)}%'
        ORDER BY Name DESC
        LIMIT 200
      `);
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return send(res, 200, {
        success: true,
        records: q.records.map(r => ({
          Id: r.Id, Name: r.Name, Academic_Year__c: r.Academic_Year__c
        }))
      });
    }

    // ===== STUDY PROGRAM by CAMPUS =====
    if (type === 'program') {
      if (!campusId) {
        return send(res, 400, { success: false, message: 'campusId wajib diisi' });
      }
      try {
        const q = await conn.query(`
          SELECT Id, Name, Campus__c
          FROM Study_Program__c
          WHERE Campus__c = '${esc(campusId)}'
            AND Name LIKE '%${esc(term)}%'
          ORDER BY Name
          LIMIT 200
        `);
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return send(res, 200, {
          success: true,
          records: q.records.map(r => ({ Id: r.Id, Name: r.Name, Campus__c: r.Campus__c }))
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        console.error('Program query error:', e);
        return send(res, 500, { success: false, message: 'Gagal query Study Program', error: msg });
      }
    }

    // Unknown type
    return send(res, 400, { success: false, message: `type tidak dikenali: ${type}` });
  } catch (e) {
    console.error('salesforce-query fatal:', e);
    return send(res, 500, { success: false, message: 'Gagal memproses query', error: String((e && e.message) || e) });
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'GET')  return await handleGet(req, res);
    // keep existing POST contract; allow GET for new features
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  } catch (e) {
    console.error('salesforce-query top-level error:', e);
    return res.status(500).json({ success: false, message: String((e && e.message) || e) });
  }
};