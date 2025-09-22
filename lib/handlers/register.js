import jsforce from 'jsforce';

function req(v, name) {
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function login() {
  const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL });
  await conn.login(
    process.env.SF_USERNAME,
    process.env.SF_PASSWORD + process.env.SF_TOKEN
  );
  return conn;
}

async function getOppRT(conn) {
  // Kamu minta pakai RT "University" (ID: 012gL000002NZITQA4) – kita cek lalu fallback cari by name.
  const hard = '012gL000002NZITQA4';
  try {
    const rt = await conn.sobject('RecordType').retrieve(hard);
    if (rt && rt.SobjectType === 'Opportunity') return hard;
  } catch {}
  const r = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Opportunity' AND (DeveloperName='University' OR Name='University')
    LIMIT 1
  `);
  return r.records?.[0]?.Id || hard;
}

async function ensurePersonRT(conn) {
  const r = await conn.query(`
    SELECT Id FROM RecordType
    WHERE SobjectType='Account' AND IsPersonType=true LIMIT 1
  `);
  return r.records?.[0]?.Id;
}

async function createDirect(conn, { firstName, lastName, email, phone }) {
  const personRT = await ensurePersonRT(conn);

  // 1) Person Account
  const accRes = await conn.sobject('Account').create({
    RecordTypeId: personRT,
    FirstName: firstName,
    LastName: lastName || '-',
    PersonEmail: email,
    PersonHomePhone: phone
  });

  // 2) Contact (auto) – ambil dari query
  const c = await conn.query(
    `SELECT Id FROM Contact WHERE AccountId='${accRes.id}' LIMIT 1`
  );

  // 3) Opportunity (RT University), Name: "FirstName LastName/REG"
  const oppRes = await conn.sobject('Opportunity').create({
    Name: `${firstName || ''} ${lastName || ''}/REG`.trim(),
    AccountId: accRes.id,
    StageName: 'Prospecting',
    CloseDate: new Date().toISOString().slice(0, 10),
    RecordTypeId: await getOppRT(conn)
  });

  return {
    accountId: accRes.id,
    contactId: c.records?.[0]?.Id || null,
    opportunityId: oppRes.id
  };
}

async function pollConvertedTriple(conn, leadId, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const l = await conn.sobject('Lead').retrieve(leadId);
    if (l.IsConverted) {
      return {
        accountId: l.ConvertedAccountId,
        contactId: l.ConvertedContactId,
        opportunityId: l.ConvertedOpportunityId
      };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null; // biar kita fallback cari manual
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).end();

    const { firstName, lastName = '', email, phone } = req.body || {};
    req && req; // silence lint
    req(email, 'email'); req(phone, 'phone'); req(firstName, 'firstName');

    const conn = await login();

    // Cek Lead by email+phone (exact)
    const qLead = await conn.query(`
      SELECT Id, IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId
      FROM Lead
      WHERE Email='${email.replace(/'/g, "\\'")}'
        AND Phone='${phone.replace(/'/g, "\\'")}'
      LIMIT 1
    `);

    if (qLead.totalSize > 0) {
      const lead = qLead.records[0];

      // Kalau SUDAH converted → langsung kirim triple
      if (lead.IsConverted) {
        return res.json({
          status: 'ok',
          source: 'lead-converted',
          accountId: lead.ConvertedAccountId,
          contactId: lead.ConvertedContactId,
          opportunityId: lead.ConvertedOpportunityId
        });
      }

      // Belum converted → triger Apex auto-convert via flag Is_Convert__c
      // (gunakan salah satu nama field sesuai org kamu)
      try { await conn.sobject('Lead').update({ Id: lead.Id, Is_Convert__c: true }); }
      catch { await conn.sobject('Lead').update({ Id: lead.Id, Is_Convert__c__c: true }).catch(()=>{}); }

      // Tunggu sampai converted (polling ringan)
      const triple = await pollConvertedTriple(conn, lead.Id);
      if (triple) {
        return res.json({ status: 'ok', source: 'lead-converted-now', ...triple });
      }

      // Fallback (kalau trigger async): cari Contact/Account/Opportunity by email
      const c = await conn.query(`SELECT Id, AccountId FROM Contact WHERE Email='${email.replace(/'/g, "\\'")}' LIMIT 1`);
      let opportunityId = null;
      if (c.totalSize > 0) {
        const o = await conn.query(`
          SELECT Id FROM Opportunity
          WHERE AccountId='${c.records[0].AccountId}'
          ORDER BY CreatedDate DESC LIMIT 1
        `);
        opportunityId = o.records?.[0]?.Id || null;
      }
      return res.json({
        status: 'ok',
        source: 'lead-convert-pending',
        accountId: c.records?.[0]?.AccountId || null,
        contactId: c.records?.[0]?.Id || null,
        opportunityId
      });
    }

    // Lead tidak ada → langsung create Person Account + Contact + Opportunity
    const created = await createDirect(conn, { firstName, lastName, email, phone });
    res.json({ status: 'ok', source: 'direct-create', ...created });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message || String(e) });
  }
}
