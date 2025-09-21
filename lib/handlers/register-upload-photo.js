const jsforce = require('jsforce');
const MAX_SIZE = 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg'];

function extFromMime(m) { return m === 'image/png' ? 'png' : 'jpg'; }
function safeTitle(prefix, id) { return `${prefix}-${id}-${new Date().toISOString().slice(0, 10)}`; }

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;

  try {
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('application/json')) {
      return res.status(400).json({ success: false, message: 'Unsupported Content-Type' });
    }

    // Parse request body
    const body = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); }
      });
    });

    const oppId = body.opportunityId;
    const accId = body.accountId;
    const filename = body.filename || 'pasfoto.jpg';
    const mime = body.mime || 'image/jpeg';
    const base64 = body.data;

    if (!oppId || !accId || !filename || !base64) {
      throw new Error('Data tidak lengkap (JSON)');
    }

    const size = Buffer.from(base64, 'base64').length;
    if (size > MAX_SIZE) throw new Error('Ukuran file maksimal 1MB');
    if (mime && !ALLOWED.includes(mime)) throw new Error('Format file harus PNG/JPG');

    // === Salesforce connection
    const conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    await conn.login(SF_USERNAME, SF_PASSWORD);

    // === Upload File to Salesforce
    const title = safeTitle('PasFoto', accId);
    const ext = (filename.split('.').pop() || extFromMime(mime)).toLowerCase();
    const cv = await conn.sobject('ContentVersion').create({
      Title: title,
      PathOnClient: `${title}.${ext}`,
      VersionData: base64,
      FirstPublishLocationId: oppId
    });
    if (!cv.success) throw new Error(cv.errors?.join(', ') || 'Gagal upload pas foto');

    const q = await conn.query(`
      SELECT ContentDocumentId
      FROM ContentVersion
      WHERE Id='${cv.id}'
      LIMIT 1
    `);
    const docId = q.records?.[0]?.ContentDocumentId;

    if (docId) {
      // Link file to Account
      await conn.sobject('ContentDocumentLink').create({
        ContentDocumentId: docId,
        LinkedEntityId: accId,
        ShareType: 'V'
      });

      // === Ensure Account_Document__c exists for Pas Foto 3x4
      const existing = await conn.query(`
        SELECT Id FROM Account_Document__c
        WHERE Account__c = '${accId}'
          AND Document_Type__c = 'Pas Foto 3x4'
          AND Application_Progress__c = '${oppId}'
        LIMIT 1
      `);

      let docRecId;
      if (existing.records.length) {
        // Update existing record
        docRecId = existing.records[0].Id;
        await conn.sobject('Account_Document__c').update({
          Id: docRecId,
          Verified__c: false,
          Document_Link__c: '/lightning/r/ContentDocument/' + docId + '/view',
          Name: 'Pas Foto 3x4'
        });
      } else {
        // Create new record
        const created = await conn.sobject('Account_Document__c').create({
          Account__c: accId,
          Application_Progress__c: oppId,
          Document_Type__c: 'Pas Foto 3x4',
          Verified__c: false,
          Document_Link__c: '/lightning/r/ContentDocument/' + docId + '/view',
          Name: 'Pas Foto 3x4'
        });
        docRecId = created.id;
      }
    }

    res.status(200).json({ success: true, contentVersionId: cv.id });
  } catch (err) {
    console.error('register-upload-photo ERR:', err);
    res.status(500).json({ success: false, message: err.message || 'Upload pas foto gagal' });
  }
};