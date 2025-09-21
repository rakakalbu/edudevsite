const jsforce = require('jsforce');
const MAX_SIZE = 1024 * 1024;
const ALLOWED = ['application/pdf','image/png','image/jpeg'];

function extFromMime(m){ if(m==='application/pdf') return 'pdf'; if(m==='image/png') return 'png'; if(m==='image/jpeg') return 'jpg'; return 'bin'; }
function safeTitle(prefix,id){ return `${prefix}-${id}-${new Date().toISOString().slice(0,10)}`; }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success:false, message:'Method not allowed' });
  const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD } = process.env;

  try {
    let oppId, accId, filename, mime, base64;
    const ctype = req.headers['content-type'] || '';

    if (ctype.includes('application/json')) {
      const body = await new Promise((resolve, reject) => { let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{ try{ resolve(JSON.parse(raw||'{}')); }catch(e){ reject(e);} }); });
      oppId=body.opportunityId; accId=body.accountId; filename=body.filename||'bukti'; mime=body.mime||'application/octet-stream'; base64=body.data;
      if(!oppId||!accId||!filename||!base64) throw new Error('Data tidak lengkap (JSON)');
    } else {
      return res.status(400).json({ success:false, message:'Unsupported Content-Type' });
    }

    const size=Buffer.from(base64,'base64').length; if(size>MAX_SIZE) throw new Error('Ukuran file maksimal 1MB');
    if(mime && !ALLOWED.includes(mime)) throw new Error('Format file harus PDF/PNG/JPG');

    const conn=new jsforce.Connection({ loginUrl:SF_LOGIN_URL }); await conn.login(SF_USERNAME,SF_PASSWORD);

    const title=safeTitle('BuktiBayar',oppId); const ext = (filename.split('.').pop()||extFromMime(mime)).toLowerCase();
    const cv = await conn.sobject('ContentVersion').create({ Title:title, PathOnClient:`${title}.${ext}`, VersionData:base64, FirstPublishLocationId:oppId });
    if(!cv.success) throw new Error(cv.errors?.join(', ') || 'Upload gagal');

    const q = await conn.query(`SELECT ContentDocumentId FROM ContentVersion WHERE Id='${cv.id}' LIMIT 1`);
    const docId=q.records?.[0]?.ContentDocumentId;
    if(docId){ await conn.sobject('ContentDocumentLink').create({ ContentDocumentId:docId, LinkedEntityId:accId, ShareType:'V' }); }

    await conn.sobject('Opportunity').update({ Id:oppId, Is_Booking_Fee_Paid__c:true, StageName:'Form Payment' });

    res.status(200).json({ success:true, contentVersionId: cv.id });
  } catch (err) {
    console.error('register-upload-proof ERR:', err);
    res.status(500).json({ success:false, message: err.message || 'Upload gagal' });
  }
};
