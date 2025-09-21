// src/api/register-options.js
// Wizard options: campuses, intakes, programs, masterBatch, bsp, sekolah, schools

const jsforce = require('jsforce');
const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

module.exports = async (req, res) => {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const { method, query, body } = req;

  const send = (code, obj) => res.status(code).json(obj);
  const ok   = (data) => send(200, { success: true, ...data });
  const fail = (code, msg, extra = {}) => send(code, { success: false, message: msg, ...extra });

  async function login() {
    if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
      throw new Error('ENV Salesforce belum lengkap (SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD)');
    }
    const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD);
    return conn;
  }

  try {
    // =================== GET ===================
    if (method === 'GET') {
      const { type } = query || {};
      const searchTerm = (query.term ?? query.t ?? '').trim();
      const campusId   = (query.campusId ?? '').trim();
      const intakeId   = (query.intakeId ?? '').trim();
      const dateStr    = (query.date ?? '').trim(); // for masterBatch
      if (!type) return fail(400, 'type wajib diisi');

      // ---------- CAMPUSES ----------
      if (type === 'campuses' || type === 'campus') {
        const conn = await login();
        try {
          const r = await conn.query(`
            SELECT Id, Name
            FROM Campus__c
            ${searchTerm ? `WHERE Name LIKE '%${esc(searchTerm)}%'` : ''}
            ORDER BY Name
            LIMIT 200
          `);
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
          return ok({ records: r.records.map(x => ({ Id: x.Id, Name: x.Name })) });
        } catch (e) {
          return ok({ records: [], errors: [String(e && e.message || e)] });
        }
      }

      // ---------- INTAKES ----------
      if (type === 'intakes' || type === 'intake') {
        const conn = await login();
        try {
          // per request: filter by choosen campus (Campus__r.Id) if provided
          const r = await conn.query(`
            SELECT Id, Name
            FROM Master_Intake__c
            ${campusId ? `WHERE Campus__r.Id = '${esc(campusId)}'` : ''}
            ORDER BY Name DESC
            LIMIT 200
          `);
          res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
          return ok({ records: r.records.map(x => ({ Id: x.Id, Name: x.Name })) });
        } catch (e) {
          // graceful fallback with dynamic years (so UI still works)
          const now = new Date(); const y = now.getFullYear();
          const fallback = [];
          for (let yr = y + 1; yr >= y - 5; yr--) {
            const name = `${yr}/${yr + 1}`;
            fallback.push({ Id: name, Name: name });
          }
          return ok({ records: fallback, fallback: 'dynamic-years', errors: [String(e && e.message || e)] });
        }
      }

      // ---------- PROGRAMS ----------
      // Implements: Query 4 + Query 5 (Faculty_Campus → SP_Faculty_Campus limited by intake)
      if (type === 'programs' || type === 'program') {
        if (!campusId) return fail(400, 'campusId wajib diisi');
        if (!intakeId) return fail(400, 'intakeId wajib diisi');
        const conn = await login();
        const errors = [];

        try {
          // Query 4: Faculty_Campus__c by Campus
          const fc = await conn.query(`
            SELECT Id, Faculty__r.Name
            FROM Faculty_Campus__c
            WHERE Campus__r.Id = '${esc(campusId)}'
            LIMIT 500
          `);
          const fcIds = (fc.records || []).map(r => r.Id);
          if (fcIds.length === 0) return ok({ records: [], source: 'no-faculty-campus' });

          const fcList = fcIds.map(id => `'${esc(id)}'`).join(',');

          // Query 5: SP_Faculty_Campus filtered by related Study_Program_Intake__c for chosen intake
          const spfc = await conn.query(`
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

          // 🔑 Normalize to {Id, Name}
          const rows = (spfc.records || []).map(r => ({
            Id: r.Study_Program__r?.Id || null,
            Name: r.Study_Program__r?.Name || ''
          })).filter(x => x.Id && x.Name);

          return ok({ records: rows, source: 'faculty+intake' });
        } catch (e) {
          errors.push(String(e && e.message || e));
          return ok({ records: [], source: 'error', errors });
        }
      }

      // ---------- (Hidden) MASTER BATCH for selected intake and date ----------
      if (type === 'masterBatch') {
        if (!intakeId) return fail(400, 'intakeId wajib diisi');
        if (!dateStr)  return fail(400, 'date wajib diisi (YYYY-MM-DD)');
        const conn = await login();

        try {
          const r = await conn.query(`
            SELECT Id, Name, Batch_Start_Date__c, Batch_End_Date__c
            FROM Master_Batches__c
            WHERE Intake__c = '${esc(intakeId)}'
              AND Batch_Start_Date__c <= ${esc(dateStr)}
              AND Batch_End_Date__c   >= ${esc(dateStr)}
            ORDER BY Batch_Start_Date__c DESC
            LIMIT 1
          `);
          const rec = r.records?.[0];
          if (!rec) return ok({ id: null, name: null });
          return ok({ id: rec.Id, name: rec.Name });
        } catch (e) {
          return fail(500, 'Gagal query Master_Batches__c', { error: String(e && e.message || e) });
        }
      }

      // ---------- BSP (Batch-Study-Program) ----------
      // given masterBatchId + studyProgramId, return the BSP (if you use such an object),
      // or simply echo back what was provided so the UI can save it.
      if (type === 'bsp') {
        const masterBatchId = (query.masterBatchId || '').trim();
        const studyProgramId = (query.studyProgramId || '').trim();
        if (!masterBatchId || !studyProgramId) {
          return fail(400, 'masterBatchId dan studyProgramId wajib diisi');
        }
        // If there is a real BSP object, you can look it up here. For now we just return them.
        return ok({ id: `${masterBatchId}::${studyProgramId}`, name: 'BSP', masterBatchId, studyProgramId });
      }

      // ---------- SEKOLAH (autocomplete) ----------
      if (type === 'sekolah') {
        const conn = await login();
        if (searchTerm.length < 2) return fail(400, 'Kata kunci terlalu pendek');

        const q = await conn.query(`
          SELECT Id, Name, NPSN__c
          FROM MasterSchool__c
          WHERE Name LIKE '%${esc(searchTerm)}%' OR NPSN__c LIKE '%${esc(searchTerm)}%'
          ORDER BY Name
          LIMIT 10
        `);
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return ok({ totalSize: q.totalSize, records: q.records });
      }

      // ---------- SCHOOLS (umum) ----------
      if (type === 'schools' || type === 'school') {
        const conn = await login();
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

        return ok({ records: rows || [], errors: errors.length ? errors : undefined });
      }

      return fail(400, 'Unknown GET type');
    }

    // =================== POST ===================
    if (method === 'POST') {
      const conn = await login();

      if (body?.action === 'saveReg') {
        const { opportunityId, campusId, intakeId, studyProgramId, bspId } = body || {};
        if (!opportunityId || !campusId || !intakeId || !studyProgramId) {
          return fail(400, 'Param kurang (opportunityId, campusId, intakeId, studyProgramId)');
        }

        await conn.sobject('Opportunity').update({
          Id: opportunityId,
          Campus__c: campusId,
          Master_Intake__c: intakeId,
          Study_Program__c: studyProgramId,
          // optionally store bspId if you have a field for it:
          // BSP__c: bspId || null
        });

        return ok({});
      }

      return fail(400, 'Unknown POST action');
    }

    return fail(405, 'Method not allowed');
  } catch (err) {
    return fail(500, err.message || 'Gagal memproses request');
  }
};