// lib/handlers/register-status.js
// GET /api/register-status?opportunityId=006xxxxxxxxxxxx
// Returns:
// {
//   success, opportunityId, accountId, webStage, stageName,
//   person:{ firstName,lastName,email,phone },
//   reg: { campusName, intakeName, studyProgramName, bspName, bookingPrice },
//   sekolah: { mode, schoolName, draftNpsn, gradYear }
// }

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
    if (req.method !== 'GET') {
      return send(res, 405, { success: false, message: 'Method not allowed' });
    }

    const opportunityId = (req.query.opportunityId || req.query.opp || '').trim();
    if (!isSfId(opportunityId)) {
      return send(res, 400, { success: false, message: 'Invalid opportunityId' });
    }

    const conn = await login(process.env);

    // Pull Opportunity & related Account + selections saved on Opp
    const q = await conn.query(`
      SELECT Id, AccountId, StageName, Web_Stage__c,
             Campus__c, Campus__r.Name,
             Master_Intake__c, Master_Intake__r.Name,
             Study_Program__c, Study_Program__r.Name, Study_Program__r.Booking_Form_Price__c,
             Graduation_Year__c,
             Draft_School__c, Draft_NPSN__c,
             Master_School__c, Master_School__r.Name,
             Account.PersonEmail, Account.FirstName, Account.LastName, Account.PersonHomePhone
      FROM Opportunity
      WHERE Id = '${opportunityId}'
      LIMIT 1
    `);

    if (q.totalSize === 0) {
      return send(res, 404, { success: false, message: 'Opportunity not found' });
    }

    const o = q.records[0] || {};
    const webStage = Number(o.Web_Stage__c ?? 1) || 1;

    // Resolve "BSP" (active batch for the intake today) and the price from Study Program
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
      console.warn('register-status: master batch lookup failed:', e?.message || e);
    }

    const bookingPrice = (o.Study_Program__r && o.Study_Program__r.Booking_Form_Price__c != null)
      ? o.Study_Program__r.Booking_Form_Price__c
      : null;

    // Build school summary (either master school chosen, or manual draft filled)
    let sekolahMode = null, sekolahName = null, draftNpsn = null;
    if (o.Master_School__c) {
      sekolahMode = 'auto';
      sekolahName = (o.Master_School__r && o.Master_School__r.Name) || null;
    } else if (o.Draft_School__c) {
      sekolahMode = 'manual';
      sekolahName = o.Draft_School__c || null;
      draftNpsn   = o.Draft_NPSN__c || null;
    }

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
        phone:     o.Account?.PersonHomePhone || ''
      },
      reg: {
        campusName:        o.Campus__r?.Name || null,
        intakeName:        o.Master_Intake__r?.Name || null,
        studyProgramName:  o.Study_Program__r?.Name || null,
        bspName,
        bookingPrice
      },
      sekolah: {
        mode: sekolahMode,
        schoolName: sekolahName,
        draftNpsn,
        gradYear: o.Graduation_Year__c || null
      }
    });
  } catch (e) {
    console.error('register-status error:', e);
    return send(res, 500, { success: false, message: e?.message || String(e) });
  }
};