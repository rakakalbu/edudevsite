const jsforce = require('jsforce');

module.exports = async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ success:false, message:'Method not allowed' });

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const {
      opportunityId,
      accountId,
      masterSchoolId,     // optional (autocomplete mode)
      schoolName,         // display name (for review)
      graduationYear,     // required
      draftSchool,        // optional (manual mode)
      draftNpsn           // optional (manual mode)
    } = req.body || {};

    if (!opportunityId || !accountId || !schoolName || !graduationYear) {
      throw new Error('Data tidak lengkap');
    }

    await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ''));

    // Always update graduation year
    const oppUpd = { Id: opportunityId, Graduation_Year__c: graduationYear };

    if (masterSchoolId) {
      // === AUTOCOMPLETE mode ===
      await conn.sobject('Account').update({
        Id: accountId,
        Master_School__c: masterSchoolId
      });

      oppUpd.Draft_Sekolah__c = null;
      oppUpd.Draft_NPSN__c = null;
    } else {
      // === MANUAL mode ===
      if (!draftSchool) {
        throw new Error('Nama sekolah wajib diisi');
      }

      oppUpd.Draft_Sekolah__c = draftSchool;

      const onlyDigits = String(draftNpsn || '').replace(/\D/g, '');
      oppUpd.Draft_NPSN__c = onlyDigits || null; // explicitly clear if not provided
    }

    await conn.sobject('Opportunity').update(oppUpd);

    res.status(200).json({ success:true });
  } catch (err) {
    console.error('register-save-education ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Gagal menyimpan data pendidikan' });
  }
};