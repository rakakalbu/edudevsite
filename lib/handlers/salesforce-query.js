const jsforce = require('jsforce');

module.exports = async (req, res) => {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;

  const bad = (code, message, extra = {}) => res.status(code).json({ success: false, message, ...extra });
  const ok  = (data) => res.status(200).json({ success: true, ...data });
  const esc = (s) => String(s || '').replace(/'/g, "\\'");

  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    return bad(500, 'ENV Salesforce belum lengkap', { hint: 'Set SF_LOGIN_URL,SF_USERNAME,SF_PASSWORD' });
  }

  let conn;
  try {
    conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD);
  } catch (e) {
    console.error('SF login error:', e);
    return bad(500, 'Gagal login ke Salesforce', { error: String((e && e.message) || e) });
  }

  try {
    const { type, term = '', campusId = '', intakeId = '', date = '' } = req.query || {};
    if (!type) return bad(400, 'type wajib diisi');

    // ===== CAMPUS =====
    if (type === 'campus') {
      try {
        const q = await conn.query(`
          SELECT Id, Name
          FROM Campus__c
          ${term ? `WHERE Name LIKE '%${esc(term)}%'` : ''}
          ORDER BY Name
          LIMIT 200
        `);
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return ok({ records: q.records.map(r => ({ Id: r.Id, Name: r.Name })) });
      } catch (e) {
        const msg = String((e && e.message) || e);
        const needFallback = /INVALID_TYPE|sObject type .* is not supported|No such column/i.test(msg);
        if (!needFallback) {
          console.error('Campus query error:', e);
          return bad(500, 'Gagal query Campus', { error: msg });
        }

        // Fallback distinct pseudo-campus dari Account.Master_School__c
        try {
          const q = await conn.query(`
            SELECT Master_School__c
            FROM Account
            WHERE Master_School__c != null
              ${term ? `AND Master_School__c LIKE '%${esc(term)}%'` : ''}
            GROUP BY Master_School__c
            ORDER BY Master_School__c
            LIMIT 200
          `);
          const rows = (q.records || []).map(r => ({
            Id: r.Master_School__c,
            Name: r.Master_School__c
          }));
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
          return ok({ records: rows, fallback: 'Account.Master_School__c' });
        } catch (e2) {
          console.error('Campus fallback error:', e2);
          return bad(500, 'Gagal query fallback Campus', { error: String((e2 && e2.message) || e2) });
        }
      }
    }

    // ===== INTAKE =====
    // (Tetap sederhana; filter by term. Jika perlu filter by campus, bisa ditambah.)
    if (type === 'intake') {
      const q = await conn.query(`
        SELECT Id, Name, Academic_Year__c
        FROM Master_Intake__c
        ${term ? `WHERE Name LIKE '%${esc(term)}%'` : ''}
        ORDER BY Name DESC
        LIMIT 200
      `);
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return ok({
        records: q.records.map(r => ({
          Id: r.Id, Name: r.Name, Academic_Year__c: r.Academic_Year__c
        }))
      });
    }

    // ===== STUDY PROGRAM (by Campus AND Intake) =====
    // Implements your Query 4 + 5, with Query 3 (Batch) resolved "hidden" when intakeId+date provided.
    if (type === 'program') {
      if (!campusId) return bad(400, 'campusId wajib diisi');
      // intakeId optional in legacy path, but needed for the full logic you requested.

      try {
        // Query 4: Faculty_Campus__c by Campus
        const qFC = await conn.query(`
          SELECT Id, Faculty__r.Name
          FROM Faculty_Campus__c
          WHERE Campus__c = '${esc(campusId)}'
          LIMIT 500
        `);
        const facultyCampusIds = (qFC.records || []).map(r => r.Id);

        // If no intakeId provided, fallback to the simple legacy behavior (by campus only)
        if (!intakeId || facultyCampusIds.length === 0) {
          // Legacy fallback: Study_Program__c by Campus__c
          const qLegacy = await conn.query(`
            SELECT Id, Name, Campus__c
            FROM Study_Program__c
            WHERE Campus__c = '${esc(campusId)}'
            ${term ? `AND Name LIKE '%${esc(term)}%'` : ''}
            ORDER BY Name
            LIMIT 200
          `);
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
          return ok({
            records: qLegacy.records.map(r => ({ Id: r.Id, Name: r.Name, Campus__c: r.Campus__c })),
            source: 'legacy-by-campus'
          });
        }

        // Query 5: Study_Program_Faculty_Campus__c filtered by Faculty_Campus__c AND linked Study_Program_Intake__c for chosen intake
        const fcList = facultyCampusIds.map(id => `'${esc(id)}'`).join(',');
        const qSPFC = await conn.query(`
          SELECT Id, Study_Program__r.Id, Study_Program__r.Name
          FROM Study_Program_Faculty_Campus__c
          WHERE Faculty_Campus__c IN (${fcList})
            AND Id IN (
              SELECT Study_Program_Faculty_Campus__c
              FROM Study_Program_Intake__c
              WHERE Master_Intake__c = '${esc(intakeId)}'
            )
          ORDER BY Study_Program__r.Name
          LIMIT 500
        `);

        // Normalize: UI expects each item to have { Id, Name }
        const items = (qSPFC.records || []).map(r => ({
          Id: r.Study_Program__r?.Id || null,
          Name: r.Study_Program__r?.Name || ''
        })).filter(x => x.Id && x.Name);

        // (Hidden) Query 3: resolve Master_Batches__c if intakeId + date provided
        let batchId = null;
        const dateStr = (date || '').trim();
        if (dateStr) {
          const qBatch = await conn.query(`
            SELECT Id
            FROM Master_Batches__c
            WHERE Intake__c = '${esc(intakeId)}'
              AND Batch_Start_Date__c <= ${esc(dateStr)}
              AND Batch_End_Date__c   >= ${esc(dateStr)}
            LIMIT 1
          `);
          batchId = qBatch.records?.[0]?.Id || null;
        }

        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return ok({ records: items, batchId, source: 'faculty+intake' });
      } catch (e) {
        const msg = String((e && e.message) || e);
        console.error('Program query error:', e);
        return bad(500, 'Gagal query Study Program', { error: msg });
      }
    }

    return bad(400, `type tidak dikenali: ${type}`);
  } catch (e) {
    console.error('salesforce-query fatal:', e);
    return bad(500, 'Gagal memproses query', { error: String((e && e.message) || e) });
  }
};