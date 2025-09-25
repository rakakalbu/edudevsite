// lib/handlers/register-status.js
// GET /api/register-status?opportunityId=006xxxxxxxxxxxx

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
  // FULL query (includes everything we need; note: Master School comes from Account.*)
  const full = `
    SELECT Id, AccountId, StageName, Web_Stage__c,
           Campus__c, Campus__r.Name,
           Master_Intake__c, Master_Intake__r.Name,
           Study_Program__c, Study_Program__r.Name, Study_Program__r.Booking_Form_Price__c,
           Graduation_Year__c,
           Draft_Sekolah__c, Draft_NPSN__c,
           Account.FirstName, Account.LastName,
           Account.PersonEmail, Account.PersonMobilePhone, Account.PersonHomePhone,
           Account.Master_School__c, Account.Master_School__r.Name
    FROM Opportunity
    WHERE Id = '${oppId}'
    LIMIT 1
  `;

  // MINIMAL query (still includes Account.* master school so we can display it)
  const minimal = `
    SELECT Id, AccountId, StageName, Web_Stage__c,
           Campus__c, Campus__r.Name,
           Master_Intake__c, Master_Intake__r.Name,
           Study_Program__c, Study_Program__r.Name, Study_Program__r.Booking_Form_Price__c,
           Graduation_Year__c,
           Draft_Sekolah__c, Draft_NPSN__c,
           Account.FirstName, Account.LastName,
           Account.PersonEmail, Account.PersonMobilePhone, Account.PersonHomePhone,
           Account.Master_School__c, Account.Master_School__r.Name
    FROM Opportunity
    WHERE Id = '${oppId}'
    LIMIT 1
  `;

  try {
    return { record: (await conn.query(full)).records?.[0] || null, mode: 'full' };
  } catch (e) {
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

    // Active batch (BSP) label for current intake
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
    } catch {}

    const bookingPrice = o.Study_Program__r?.Booking_Form_Price__c ?? null;

    // ----- School & Graduation Year -----
    const gradYear = o.Graduation_Year__c ?? null;

    // Prefer Account.Master_School__c when webStage == 6 (already submitted).
    // Otherwise decide based on what’s present now.
    const accMasterId   = o.Account?.Master_School__c || null;
    const accMasterName = o.Account?.Master_School__r?.Name || null;

    let sekolahMode = null, sekolahName = null, draftNpsn = null;

    if (webStage === 6) {
      if (accMasterId) {
        sekolahMode = 'auto';
        sekolahName = accMasterName;
      } else if (o.Draft_Sekolah__c) {
        sekolahMode = 'manual';
        sekolahName = o.Draft_Sekolah__c || null;
        draftNpsn   = o.Draft_NPSN__c || null;
      }
    } else {
      if (accMasterId) {
        sekolahMode = 'auto';
        sekolahName = accMasterName;
      } else if (o.Draft_Sekolah__c) {
        sekolahMode = 'manual';
        sekolahName = o.Draft_Sekolah__c || null;
        draftNpsn   = o.Draft_NPSN__c || null;
      }
    }

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
        phone,
        mobilePhone: mobile || null,
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
      isSubmitted: Number(webStage) === 6
    });
  } catch (e) {
    console.error('register-status error:', e);
    return send(res, 500, { success: false, message: e?.message || String(e) });
  }
};