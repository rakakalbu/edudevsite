// register-upload-photo.js
const jsforce = require('jsforce');

const MAX_SIZE = 1024 * 1024;
const ALLOWED  = ['image/png', 'image/jpeg'];

function extFromMime(m) { return m === 'image/png' ? 'png' : 'jpg'; }

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;

  try {
    // --- Basic content-type guard
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('application/json')) {
      return res.status(400).json({ success: false, message: 'Unsupported Content-Type' });
    }

    // --- Parse body (raw, to avoid body parsers changing base64)
    const body = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); }
        catch (e) { reject(e); }
      });
    });

    const oppId    = body.opportunityId;
    const accId    = body.accountId;
    const filename = (body.filename || 'pas-foto.jpg').trim();
    const mime     = (body.mime || 'image/jpeg').toLowerCase();
    const base64   = body.data; // should NOT include "data:*;base64,"

    if (!oppId || !accId || !filename || !base64) {
      throw new Error('Data tidak lengkap (opportunityId, accountId, filename, data)');
    }

    const size = Buffer.from(base64, 'base64').length;
    if (size > MAX_SIZE) throw new Error('Ukuran file maksimal 1MB');
    if (!ALLOWED.includes(mime)) throw new Error('Format file harus PNG/JPG');

    // --- Salesforce login
    const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD);

    // --- Fetch Opportunity name for display/renaming
    const opp = await conn.sobject('Opportunity').retrieve(oppId);
    const oppName = opp?.Name || '';

    // --- Create ContentVersion (publish to Opportunity so it shows there as well)
    const ext = (filename.split('.').pop() || extFromMime(mime)).toLowerCase();
    const cvCreate = await conn.sobject('ContentVersion').create({
      Title: `Pas Foto 3x4_${oppName || 'Tanpa Nama'}`,
      PathOnClient: `Pas Foto 3x4_${oppName || 'Tanpa Nama'}.${ext}`,
      VersionData: base64,
      FirstPublishLocationId: oppId
    });
    if (!cvCreate.success) {
      throw new Error(cvCreate.errors?.join(', ') || 'Gagal membuat ContentVersion');
    }

    // --- Get ContentDocumentId from the version we just created
    const cvRow = await conn.query(`
      SELECT ContentDocumentId
      FROM ContentVersion
      WHERE Id = '${cvCreate.id}'
      LIMIT 1
    `);
    const contentDocumentId = cvRow.records?.[0]?.ContentDocumentId;
    if (!contentDocumentId) throw new Error('Tidak menemukan ContentDocumentId');

    // (Optional) Keep a link to the Account too (handy for users browsing files at the Account)
    await conn.sobject('ContentDocumentLink').create({
      ContentDocumentId: contentDocumentId,
      LinkedEntityId: accId,
      ShareType: 'V',
      Visibility: 'AllUsers'
    }).catch(() => { /* ignore if already linked */ });

    // --- Ensure there is an Account_Document__c for this type & progress
    // Try exact match first (by Opp); fallback to legacy null-opp record.
    const existing = await conn.query(`
      SELECT Id, Name
      FROM Account_Document__c
      WHERE Account__c = '${accId}'
        AND Document_Type__c = 'Pas Foto 3x4'
        AND (Application_Progress__c = '${oppId}' OR Application_Progress__c = NULL)
      ORDER BY Application_Progress__c NULLS LAST
      LIMIT 1
    `);

    let docRecId;
    if (existing.totalSize > 0) {
      docRecId = existing.records[0].Id;
    } else {
      const created = await conn.sobject('Account_Document__c').create({
        Account__c: accId,
        Application_Progress__c: oppId,
        Document_Type__c: 'Pas Foto 3x4',
        Verified__c: false,
        Name: `Pas Foto 3x4 ${oppName || ''}`.trim()
      });
      if (!created.success) throw new Error(created.errors?.join(', ') || 'Gagal membuat Account_Document__c');
      docRecId = created.id;
    }

    // --- Link the file to the Account_Document__c (THIS makes LWC show "Uploaded")
    await conn.sobject('ContentDocumentLink').create({
      ContentDocumentId: contentDocumentId,
      LinkedEntityId: docRecId,
      ShareType: 'V',
      Visibility: 'AllUsers'
    }).catch(() => { /* ignore if duplicate */ });

    // --- Rename ContentDocument and latest ContentVersion (for consistent titles)
    const newTitle = `Pas Foto 3x4_${oppName || 'Tanpa Nama'}`;
    await conn.sobject('ContentDocument').update({ Id: contentDocumentId, Title: newTitle });
    const latestCv = await conn.query(`
      SELECT Id
      FROM ContentVersion
      WHERE ContentDocumentId='${contentDocumentId}'
      ORDER BY VersionNumber DESC
      LIMIT 1
    `);
    if (latestCv.totalSize) {
      await conn.sobject('ContentVersion').update({ Id: latestCv.records[0].Id, Title: newTitle });
    }

    // --- Update the Account_Document__c link fields
    await conn.sobject('Account_Document__c').update({
      Id: docRecId,
      Verified__c: false,
      Document_Link__c: `/lightning/r/ContentDocument/${contentDocumentId}/view`,
      Name: `Pas Foto 3x4 ${oppName || ''}`.trim()
    });

    return res.status(200).json({
      success: true,
      contentDocumentId,
      accountDocumentId: docRecId
    });
  } catch (err) {
    console.error('register-upload-photo ERR:', err);
    return res.status(500).json({ success: false, message: err.message || 'Upload pas foto gagal' });
  }
};