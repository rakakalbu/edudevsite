const jsforce = require('jsforce');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;
  const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const {
      opportunityId,
      accountId,
      masterSchoolId,     // optional (mode autocomplete)
      schoolName,         // display name (untuk review)
      graduationYear,     // required
      draftSchool,        // optional (mode manual)
      draftNpsn           // optional (mode manual)
    } = req.body || {};

    if (!opportunityId || !accountId || !schoolName || !graduationYear) {
      throw new Error('Data tidak lengkap');
    }

    await conn.login(SF_USERNAME, SF_PASSWORD);

    // Always update graduation year
    const oppUpd = { Id: opportunityId, Graduation_Year__c: graduationYear };

    if (masterSchoolId) {
      // === Mode AUTOCOMPLETE ===
      // 1) Update Account.Master_School__c
      await conn.sobject('Account').update({ Id: accountId, Master_School__c: masterSchoolId });

      // 2) Clear Draft fields in Opportunity
      oppUpd.Draft_Sekolah__c = null;
      oppUpd.Draft_NPSN__c = null;
    } else {
      // === Mode MANUAL ===
      const onlyDigits = String(draftNpsn || '').replace(/\D/g, '');
      if (!draftSchool || !onlyDigits) throw new Error('Nama sekolah/NPSN manual wajib diisi');

      // 1) Do NOT set Master_School__c (leave as-is)
      // 2) Set Draft fields in Opportunity
      oppUpd.Draft_Sekolah__c = draftSchool;
      oppUpd.Draft_NPSN__c = onlyDigits;
    }

    await conn.sobject('Opportunity').update(oppUpd);

    res.status(200).json({ success:true });
  } catch (err) {
    console.error('register-save-education ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Gagal menyimpan data pendidikan' });
  }
};
