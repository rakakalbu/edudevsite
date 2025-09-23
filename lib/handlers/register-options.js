// /api/register-options.js
// Wizard options: campuses, intakes, programs, masterBatch, bsp, pricing, sekolah, schools
const jsforce = require('jsforce');

const esc = (v) =>
  String(v || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

const CACHE_SECS = 60;

// Reuse connection
let _conn = null;
let _lastLoginAt = 0;

async function getConn(env) {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env || process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('ENV Salesforce belum lengkap (SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD)');
  }
  const MAX_AGE_MS = 20 * 60 * 1000;
  if (_conn && _conn.accessToken && Date.now() - _lastLoginAt < MAX_AGE_MS) return _conn;

  const c = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await c.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  _conn = c;
  _lastLoginAt = Date.now();
  return _conn;
}

const send = (res, code, obj) => res.status(code).json(obj);
const ok   = (res, data) => send(res, 200, { success: true, ...data });
const fail = (res, code, msg, extra = {}) => send(res, code, { success: false, message: msg, ...extra });

function setCache(res, seconds = CACHE_SECS) {
  res.setHeader('Cache-Control', `s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`);
}

module.exports = async (req, res) => {
  try {
    const { method, query, body } = req;

    // =================== GET ===================
    if (method === 'GET') {
      const type       = (query?.type || '').toLowerCase();
      const searchTerm = (query.term ?? query.t ?? '').trim();
      const campusId   = (query.campusId ?? '').trim();
      const intakeId   = (query.intakeId ?? '').trim();
      const dateStr    = (query.date ?? '').trim();
      const studyProg  = (query.studyProgramId ?? '').trim();

      if (!type) return fail(res, 400, 'type wajib diisi');

      // ---------- CAMPUSES ----------
      if (type === 'campuses' || type === 'campus') {
        const conn = await getConn(process.env);
        setCache(res, CACHE_SECS);

        const errors = [];
        try {
          const q = await conn.query(`
            SELECT Id, Name
            FROM Campus__c
            ${searchTerm ? `WHERE Name LIKE '%${esc(searchTerm)}%'` : ''}
            ORDER BY Name
            LIMIT 200
          `);
          return ok(res, {
            records: (q.records || []).map(r => ({ Id: r.Id, Name: r.Name })),
            source: 'Campus__c'
          });
        } catch (e1) { errors.push('Campus__c: ' + (e1?.message || String(e1))); }

        try {
          const q = await conn.query(`
            SELECT Campus__c, Campus__r.Name
            FROM Faculty_Campus__c
            WHERE Campus__c != null
              ${searchTerm ? `AND Campus__r.Name LIKE '%${esc(searchTerm)}%'` : ''}
            LIMIT 1000
          `);
          const map = new Map();
          (q.records || []).forEach(r => {
            const id = r.Campus__c;
            const nm = r.Campus__r && r.Campus__r.Name;
            if (id && nm && !map.has(id)) map.set(id, { Id: id, Name: nm });
          });
          const rows = Array.from(map.values());
          if (rows.length) return ok(res, { records: rows, source: 'Faculty_Campus__c', errors });
        } catch (e2) { errors.push('Faculty_Campus__c: ' + (e2?.message || String(e2))); }

        try {
          const q = await conn.query(`
            SELECT Master_School__c, Master_School__r.Name
            FROM Account
            WHERE Master_School__c != null
              ${searchTerm ? `AND Master_School__r.Name LIKE '%${esc(searchTerm)}%'` : ''}
            LIMIT 2000
          `);
          const map = new Map();
          (q.records || []).forEach(r => {
            const id = r.Master_School__c;
            const nm = r.Master_School__r && r.Master_School__r.Name;
            if (id && nm && !map.has(id)) map.set(id, { Id: id, Name: nm });
          });
          return ok(res, { records: Array.from(map.values()), source: 'Account.Master_School__c', errors });
        } catch (e3) {
          errors.push('Account.Master_School__c: ' + (e3?.message || String(e3)));
          return ok(res, { records: [], source: 'none', errors });
        }
      }

      // ---------- INTAKES ----------
      if (type === 'intakes' || type === 'intake') {
        const conn = await getConn(process.env);
        setCache(res, CACHE_SECS);

        try {
          const q = await conn.query(`
            SELECT Id, Name
            FROM Master_Intake__c
            ${campusId ? `WHERE Campus__r.Id = '${esc(campusId)}'` : ''}
            ORDER BY Name DESC
            LIMIT 200
          `);
          return ok(res, { records: (q.records || []).map(r => ({ Id: r.Id, Name: r.Name })) });
        } catch (e) {
          const now = new Date(); const y = now.getFullYear();
          const fallback = [];
          for (let yr = y + 1; yr >= y - 5; yr--) fallback.push({ Id: `${yr}/${yr+1}`, Name: `${yr}/${yr+1}` });
          return ok(res, { records: fallback, fallback: 'dynamic-years', errors: [String(e?.message || e)] });
        }
      }

      // ---------- PROGRAMS ----------
      if (type === 'programs' || type === 'program') {
        if (!campusId) return fail(res, 400, 'campusId wajib diisi');
        if (!intakeId) return fail(res, 400, 'intakeId wajib diisi');
        const conn = await getConn(process.env);
        setCache(res, CACHE_SECS);

        try {
          const qFC = await conn.query(`
            SELECT Id
            FROM Faculty_Campus__c
            WHERE Campus__r.Id = '${esc(campusId)}'
            LIMIT 500
          `);
          const fcIds = (qFC.records || []).map(r => r.Id);
          if (!fcIds.length) return ok(res, { records: [], source: 'no-faculty-campus' });

          const fcList = fcIds.map(id => `'${esc(id)}'`).join(',');

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

          const rows = (qSPFC.records || [])
            .map(r => ({ Id: r.Study_Program__r?.Id || null, Name: r.Study_Program__r?.Name || '' }))
            .filter(x => x.Id && x.Name);

          return ok(res, { records: rows, source: 'faculty+intake' });
        } catch (e) {
          return ok(res, { records: [], source: 'error', errors: [String(e?.message || e)] });
        }
      }

      // ---------- MASTER BATCH ----------
      if (type === 'masterbatch') {
        if (!intakeId) return fail(res, 400, 'intakeId wajib diisi');
        const when = dateStr || new Date().toISOString().slice(0, 10);
        const conn = await getConn(process.env);
        setCache(res, CACHE_SECS);

        try {
          const r = await conn.query(`
            SELECT Id, Name, Batch_Start_Date__c, Batch_End_Date__c
            FROM Master_Batches__c
            WHERE Intake__c = '${esc(intakeId)}'
              AND Batch_Start_Date__c <= ${esc(when)}
              AND Batch_End_Date__c   >= ${esc(when)}
            ORDER BY Batch_Start_Date__c DESC
            LIMIT 1
          `);
          const rec = r.records?.[0];
          return ok(res, { id: rec?.Id || null, name: rec?.Name || null });
        } catch (e) {
          return fail(res, 500, 'Gagal query Master_Batches__c', { error: String(e?.message || e) });
        }
      }

      // ---------- BSP / PRICING ----------
      if (type === 'bsp') {
        const masterBatchId = (query.masterBatchId || '').trim();
        const studyProgramId = (query.studyProgramId || '').trim();
        if (!masterBatchId || !studyProgramId) {
          return fail(res, 400, 'masterBatchId dan studyProgramId wajib diisi');
        }
        return ok(res, { id: `${masterBatchId}::${studyProgramId}`, name: 'BSP', masterBatchId, studyProgramId });
      }

      if (type === 'pricing') {
        if (!intakeId || !studyProg) return fail(res, 400, 'intakeId & studyProgramId wajib diisi');
        const when = dateStr || new Date().toISOString().slice(0, 10);
        const conn = await getConn(process.env);
        setCache(res, 30);

        const qBatch = await conn.query(`
          SELECT Id, Name
          FROM Master_Batches__c
          WHERE Intake__c = '${esc(intakeId)}'
            AND Batch_Start_Date__c <= ${esc(when)}
            AND Batch_End_Date__c   >= ${esc(when)}
          LIMIT 1
        `);
        const batchId = qBatch.records?.[0]?.Id || null;
        const batchName = qBatch.records?.[0]?.Name || null;
        if (!batchId) return ok(res, { bspId: null, bspName: null, bookingPrice: null });

        const qBSP = await conn.query(`
          SELECT Id, Name, Booking_Form_Price__c
          FROM Batch_Study_Program__c
          WHERE Batch__c='${esc(batchId)}' AND Study_Program__c='${esc(studyProg)}'
          LIMIT 1
        `);
        const bspId = qBSP.records?.[0]?.Id || null;
        const bspName = qBSP.records?.[0]?.Name || batchName || null;
        const bookingPrice = qBSP.records?.[0]?.Booking_Form_Price__c ?? null;

        return ok(res, { bspId, bspName, bookingPrice });
      }

      // ---------- SEKOLAH ----------
      if (type === 'sekolah') {
        if ((searchTerm || '').length < 2) return fail(res, 400, 'Kata kunci terlalu pendek');
        const conn = await getConn(process.env);
        setCache(res, CACHE_SECS);

        const q = await conn.query(`
          SELECT Id, Name, NPSN__c
          FROM MasterSchool__c
          WHERE Name LIKE '%${esc(searchTerm)}%' OR NPSN__c LIKE '%${esc(searchTerm)}%'
          ORDER BY Name
          LIMIT 10
        `);
        return ok(res, { totalSize: q.totalSize, records: q.records });
      }

      if (type === 'schools' || type === 'school') {
        const conn = await getConn(process.env);
        setCache(res, CACHE_SECS);

        const errors = [];
        let rows = null;

        try {
          const r1 = await conn.query(`
            SELECT Id, Name, NPSN__c
            FROM MasterSchool__c
            WHERE ${searchTerm ? `(Name LIKE '%${esc(searchTerm)}%' OR NPSN__c LIKE '%${esc(searchTerm)}%')` : `Name != null`}
            ORDER BY Name
            LIMIT 50
          `);
          if (r1.totalSize > 0) rows = r1.records.map(x => ({ Id: x.Id, Name: x.Name, NPSN: x.NPSN__c || null }));
        } catch (e) { errors.push('MasterSchool__c: ' + (e.message || String(e))); }

        if (!rows || rows.length === 0) {
          try {
            const r2 = await conn.query(`
              SELECT Id, Name, NPSN__c
              FROM Master_School__c
              WHERE ${searchTerm ? `(Name LIKE '%${esc(searchTerm)}%' OR NPSN__c LIKE '%${esc(searchTerm)}%')` : `Name != null`}
              ORDER BY Name
              LIMIT 50
            `);
            if (r2.totalSize > 0) rows = r2.records.map(x => ({ Id: x.Id, Name: x.Name, NPSN: x.NPSN__c || null }));
          } catch (e) { errors.push('Master_School__c: ' + (e.message || String(e))); }
        }

        if (!rows || rows.length === 0) {
          try {
            const r3 = await conn.query(`
              SELECT Master_School__c, Master_School__r.Name
              FROM Account
              WHERE Master_School__c != null
                ${searchTerm ? `AND (Master_School__r.Name LIKE '%${esc(searchTerm)}%' OR Name LIKE '%${esc(searchTerm)}%')` : ''}
              ORDER BY Master_School__r.Name
              LIMIT 500
            `);
            const map = new Map();
            (r3.records || []).forEach(x => {
              const id = x.Master_School__c;
              const nm = x.Master_School__r && x.Master_School__r.Name;
              if (id && nm && !map.has(id)) map.set(id, { Id: id, Name: nm, NPSN: null });
            });
            rows = Array.from(map.values());
          } catch (e) { errors.push('Account.Master_School__c: ' + (e.message || String(e))); }
        }

        return ok(res, { records: rows || [], errors: errors.length ? errors : undefined });
      }

      return fail(res, 400, 'Unknown GET type');
    }

    // =================== POST ===================
    if (method === 'POST') {
      const conn = await getConn(process.env);

      if (body?.action === 'saveReg') {
        const { opportunityId, campusId, intakeId, studyProgramId, bspId } = body || {};
        if (!opportunityId || !campusId || !intakeId || !studyProgramId) {
          return fail(res, 400, 'Param kurang (opportunityId, campusId, intakeId, studyProgramId)');
        }

        await conn.sobject('Opportunity').update({
          Id: opportunityId,
          Campus__c: campusId,
          Master_Intake__c: intakeId,
          Study_Program__c: studyProgramId,
          // BSP__c: bspId || null // uncomment if exists in your org
        });

        return ok(res, {});
      }

      return fail(res, 400, 'Unknown POST action');
    }

    return fail(res, 405, 'Method not allowed');
  } catch (err) {
    return fail(res, 500, err?.message || 'Gagal memproses request');
  }
};