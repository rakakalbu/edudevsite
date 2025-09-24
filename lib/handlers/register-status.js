// lib/handlers/register-status.js
// GET /api/register-status?opportunityId=006xxxxxxxxxxxx
// Returns enough data to hydrate the wizard even if some custom fields
// don't exist in the org (fallback query path).

const jsforce = require('jsforce');

const isSfId = id => /^[a-zA-Z0-9]{15,18}$/.test(String(id || ''));

function send(res, code, obj) { res.status(code).json(obj); }

async function login(env) {
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = env || process.env;
  if (!SF_LOGIN_URL || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce env incomplete (SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD)');
  }
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));
  return conn;
}

async function queryWithFallback(conn, oppId) {
  // FULL query (includes custom school + graduation fields)
  const full = `
    SELECT Id, AccountId, StageName, Web_Stage__c,
           Campus__c, Campus__r.Name,
           Master_Intake__c, Master_Intake__r.Name,
           Study_Program__c, Study_Program__r.Name, Study_Program__r.Booking_Form_Price__c,
           Graduation_Year__c,
           Draft_Sekolah__c, Draft_NPSN__c,
           Master_School__c, Master_School__r.Name,
           Account.PersonEmail, Account.FirstName, Account.LastName,
           Account.PersonMobilePhone, Account.PersonHomePhone
    FROM Opportunity
    WHERE Id = '${oppId}'
    LIMIT 1
  `;

  // MINIMAL query (no risky custom fields)
  const minimal = `
    SELECT Id, AccountId, StageName, Web_Stage__c,
           Campus__c, Campus__r.Name,
           Master_Intake__c, Master_Intake__r.Name,
           Study_Program__c, Study_Program__r.Name, Study_Program__r.Booking_Form_Price__c,
           Account.PersonEmail, Account.FirstName, Account.LastName,
           Account.PersonMobilePhone, Account.PersonHomePhone
    FROM Opportunity
    WHERE Id = '${oppId}'
    LIMIT 1
  `;

  try {
    return { record: (await conn.query(full)).records?.[0] || null, mode: 'full' };
  } catch (e) {
    // Fall back gracefully
    const rec = (await conn.query(minimal)).records?.[0] || null;
    return { record: rec, mode: 'minimal', warn: String(e?.message || e) };
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return send(res, 405, { success: false, message: 'Method not allowed' });

    const opportunityId = (req.query.opportunityId || req.query.opp || '').trim();
    if (!isSfId(opportunityId)) {
      return send(res, 400, { success: false, message: 'Invalid opportunityId' });
    }

    const conn = await login(process.env);
    const { record: o, mode, warn } = await queryWithFallback(conn, opportunityId);

    if (!o) return send(res, 404, { success: false, message: 'Opportunity not found' });

    const webStage = Number(o.Web_Stage__c ?? 1) || 1;

    // Active batch (BSP) label for current intake; safe even if intake missing
    let bspName = null;
    try {
      if (o.Master_Intake__c) {
        const today = new Date().toISOString().slice(0, 10);
        const r = await conn.query(`
          SELECT Id, Name
          FROM Master_Batches__c
          WHERE Intake__c = '${o.Master_Intake__c}'
            AND Batch_Start_Date__c <= ${today}
            AND Batch_End_Date__c   >= ${today}
          LIMIT 1
        `);
        bspName = r.records?.[0]?.Name || null;
      }
    } catch (e) {
      // non-fatal
    }

    const bookingPrice = o.Study_Program__r?.Booking_Form_Price__c ?? null;

    // School block (only present in 'full' mode)
    let sekolahMode = null, sekolahName = null, draftNpsn = null, gradYear = null;
    if (mode === 'full') {
      if (o.Master_School__c) {
        sekolahMode = 'auto';
        sekolahName = o.Master_School__r?.Name || null;
      } else if (o.Draft_Sekolah__c) {
        sekolahMode = 'manual';
        sekolahName = o.Draft_Sekolah__c || null;
        draftNpsn   = o.Draft_NPSN__c || null;
      }
      gradYear = o.Graduation_Year__c || null;
    }

    // Prefer PersonMobilePhone, fallback to PersonHomePhone
    const mobile = o.Account?.PersonMobilePhone || '';
    const home   = o.Account?.PersonHomePhone || '';
    const phone  = mobile || home || '';

    return send(res, 200, {
      success: true,
      opportunityId: o.Id,
      accountId: o.AccountId || null,
      webStage,
      stageName: o.StageName || null,
      person: {
        firstName: o.Account?.FirstName || '',
        lastName:  o.Account?.LastName  || '',
        email:     o.Account?.PersonEmail || '',
        phone,                         // unified best-effort phone
        mobilePhone: mobile || null,   // exposed separately in case the FE wants it
        homePhone:   home   || null
      },
      reg: {
        campusName:       o.Campus__r?.Name || null,
        intakeName:       o.Master_Intake__r?.Name || null,
        studyProgramName: o.Study_Program__r?.Name || null,
        bspName,
        bookingPrice
      },
      sekolah: {
        mode: sekolahMode,
        schoolName: sekolahName,
        draftNpsn,
        gradYear
      },
      _mode: mode,
      _warning: warn || null,
      // optional flag you can use client-side to disable the final submit
      isSubmitted: Number(webStage) === 6
    });
  } catch (e) {
    console.error('register-status error:', e);
    return send(res, 500, { success: false, message: e?.message || String(e) });
  }
};