/* public/js/register-wizard.js */

(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // === Utils
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').toLowerCase());
  const digits  = (s) => String(s || '').replace(/\D/g, '');
  const normalizePhone = (raw) => {
    let p = digits(raw || '');
    if (!p) return null;
    if (p.startsWith('0')) p = p.slice(1);
    if (!p.startsWith('62')) p = '62' + p;
    return '+' + p;
  };
  const debounce = (fn, ms=300) => { let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; };

  async function api(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); }
    catch {
      const t = await res.text().catch(()=> '');
      throw new Error(t?.slice(0,400) || 'Server mengembalikan respons non-JSON');
    }
    if (!res.ok || data?.success === false) throw new Error(data?.message || `Permintaan gagal (${res.status})`);
    return data;
  }
  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    let binary=''; const bytes=new Uint8Array(buf);
    for (let i=0;i<bytes.byteLength;i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  const rupiah = (n) => (n == null || isNaN(n)) ? 'Rp -' : 'Rp ' + Number(n).toLocaleString('id-ID');

  // Merge helper that ignores null/undefined/'' from source
  function mergeDefined(target = {}, source = {}) {
    const out = { ...target };
    for (const [k,v] of Object.entries(source)) {
      if (v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '')) out[k] = v;
    }
    return out;
  }

  // === Local state
  const K = (k) => `m7_reg_${k}`;
  const S = {
    get opp() { return localStorage.getItem(K('opp')) || ''; },
    set opp(v) { localStorage.setItem(K('opp'), v || ''); },
    get acc() { return localStorage.getItem(K('acc')) || ''; },
    set acc(v) { localStorage.setItem(K('acc'), v || ''); },
    set pemohon(o){ localStorage.setItem(K('pemohon'), JSON.stringify(o||{})); },
    get pemohon(){ try{ return JSON.parse(localStorage.getItem(K('pemohon'))||'{}'); }catch{ return {}; } },
    set reg(o){ localStorage.setItem(K('reg'), JSON.stringify(o||{})); },
    get reg(){ try{ return JSON.parse(localStorage.getItem(K('reg'))||'{}'); }catch{ return {}; } },
    set sekolah(o){ localStorage.setItem(K('sekolah'), JSON.stringify(o||{})); },
    get sekolah(){ try{ return JSON.parse(localStorage.getItem(K('sekolah'))||'{}'); }catch{ return {}; } },
  };

  // === Fresh-start helpers (ONLY place we touch global flow)
  function clearAllRegState() {
    try {
      Object.keys(localStorage).forEach(k => { if (k.startsWith('m7_reg_')) localStorage.removeItem(k); });
    } catch {}
  }
  function navigateToCleanRegister() {
    // one-shot guard to block resume on next load
    sessionStorage.setItem('m7_reg_skip_resume_once', '1');
    // hard clean URL: no id in path, no ?opp. Keep a marker so we can skip resume.
    location.assign('/register.html?fresh=1');
  }
  function shouldSkipResume() {
    const url = new URL(location.href);
    const byQuery = url.searchParams.get('fresh') === '1';
    const byFlag  = sessionStorage.getItem('m7_reg_skip_resume_once') === '1';
    if (byFlag) sessionStorage.removeItem('m7_reg_skip_resume_once');
    return byQuery || byFlag;
  }

  // === UI helpers
  function showWizardHeader(show){
    $('#wizardHeader').style.display = show ? '' : 'none';
    $('#progressSteps').style.display = show ? '' : 'none';
  }
  function updateProgress(currentStep) {
    $$('#progressSteps .step-item').forEach(li => {
      const step = Number(li.dataset.step);
      li.classList.toggle('is-active', step === currentStep);
      li.classList.toggle('is-complete', step < currentStep);
      if (step === currentStep) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }
  function setStep(n){
    $$('.form-step').forEach(s => s.style.display = (s.dataset.step===String(n))?'':'none');
    updateProgress(n);
    window.scrollTo({top:0,behavior:'smooth'});
  }
  const toastOk = (t) => Swal.fire({ icon:'success', title:'Berhasil', text:t, timer:1600, showConfirmButton:false });
  const showLoading = (t='Memproses…') => Swal.fire({ title:t, didOpen:()=>Swal.showLoading(), allowOutsideClick:false, showConfirmButton:false });
  const closeLoading = () => Swal.close();
  const showError = (m) => Swal.fire({ icon:'error', title:'Gagal', text:m||'Terjadi kesalahan' });

  // ========= VA (Step 3 auto-fill) =========
  const VA_INFO = { bank: 'BCA', number: '8888800123456789', name: 'Metro Seven Admission' };
  document.addEventListener('DOMContentLoaded', () => {
    $('#vaBank')   && ($('#vaBank').textContent   = VA_INFO.bank);
    $('#vaNumber') && ($('#vaNumber').textContent = VA_INFO.number);
  });

  // ======= Update Web_Stage__c helper =======
  async function updateStage(stageNum){
    try{
      if(!S.opp) return;
      await api('/api/salesforce-query', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ opportunityId: S.opp, webStage: stageNum })
      });
    }catch(e){
      console.warn('updateStage failed:', e?.message || e);
    }
  }

  // =========================
  // AUTH GATE
  // =========================
  function openWizardFromAuth(startStep=1){
    $('#authGate').style.display = 'none';
    showWizardHeader(true);
    setStep(startStep);
  }

  // Start NEW registration — hard reset + clean URL (prevents resume)
  $('#btnShowRegister')?.addEventListener('click', () => {
    clearAllRegState();
    navigateToCleanRegister();
  });

  $('#formLogin')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const email = $('#loginEmail').value.trim().toLowerCase();
    const password = $('#loginPassword').value;
    const msg = $('#msgLogin'); msg.style.display='none';
    if(!emailOk(email) || !password){ msg.textContent='Masukkan email dan kata sandi yang valid.'; msg.style.display='block'; return; }

    try{
      showLoading('Memverifikasi akun…');
      const j = await api('/api/auth-login', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email, password })
      });
      S.acc = j.accountId;
      S.opp = j.opportunityId;
      S.pemohon = { email, firstName: j.firstName || '', lastName: j.lastName || '', phone: j.phone || '' };
      $('#opptyIdLabel').textContent = S.opp;
      $('#accountIdLabel').textContent = S.acc;

      if (S.opp) {
        const target = `/register.html?opp=${encodeURIComponent(S.opp)}`;
        if (location.pathname + location.search !== target) history.replaceState(null, '', target);
      }

      closeLoading();
      toastOk('Masuk berhasil. Lanjut pilih program.');
      openWizardFromAuth(2);
      updateStage(2);
      loadStep2Options();
    }catch(err){
      closeLoading(); showError(err.message);
    }
  });

  // =========================
  // STEP 1 (REGISTER NEW)
  // =========================
  $('#formStep1').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const firstName=$('#firstName').value.trim();
    const lastName=$('#lastName').value.trim();
    const email=$('#email').value.trim().toLowerCase();
    const phone=normalizePhone($('#phone').value);
    const pass=$('#password').value;
    const pass2=$('#password2').value;
    const msg=$('#msgStep1'); msg.style.display='none';

    if(!firstName || !lastName || !emailOk(email) || !phone){
      msg.textContent='Lengkapi data dengan benar.'; msg.style.display='block'; return;
    }
    if(!pass || pass.length<6){ msg.textContent='Kata sandi minimal 6 karakter.'; msg.style.display='block'; return; }
    if(pass!==pass2){ msg.textContent='Ulangi kata sandi tidak cocok.'; msg.style.display='block'; return; }

    try{
      // absolute clean before creating a brand-new registration
      clearAllRegState();
      S.opp = ''; S.acc = '';

      showWizardHeader(true);
      showLoading('Mendaftarkan akun…');

      const j = await api('/api/auth-register',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        // pass a hint; harmless if server ignores it
        body: JSON.stringify({ firstName,lastName,email,phone,password:pass, forceNew:true })
      });

      S.opp=j.opportunityId; S.acc=j.accountId; S.pemohon={firstName,lastName,email,phone};
      $('#opptyIdLabel').textContent=j.opportunityId; $('#accountIdLabel').textContent=j.accountId;

      if (S.opp) {
        const target = `/register.html?opp=${encodeURIComponent(S.opp)}`;
        if (location.pathname + location.search !== target) history.replaceState(null, '', target);
      }

      closeLoading(); toastOk('Akun dibuat. Pilih program.');
      setStep(2);
      updateStage(2);
      loadStep2Options();
    }catch(err){
      closeLoading(); showError(err.message);
    }
  });

  // =========================
  // STEP 2 (Preferensi)
  // =========================
  const ROUTE = '/api/register-options';

  async function loadCampuses(){
    const wrap=$('#campusRadios'); wrap.innerHTML='<div class="note">Memuat…</div>';
    try{
      const j=await api(`${ROUTE}?type=campus`);
      const recs=j.records||[];
      if(!recs.length){ wrap.innerHTML='<div class="field-error">Data campus tidak tersedia.</div>'; return; }
      wrap.innerHTML='';
      recs.forEach((c,i)=>{
        const id=`camp_${c.Id}`;
        const label=document.createElement('label');
        label.className='radio-item';
        label.htmlFor=id;
        label.innerHTML=`
          <input type="radio" id="${id}" name="campus" value="${c.Id}" ${i===0?'checked':''}>
          <div><div class="radio-title">${c.Name}</div></div>`;
        wrap.appendChild(label);
      });
    }catch{
      wrap.innerHTML='<div class="field-error">Gagal memuat campus.</div>';
    }
  }

  async function loadIntakes(campusId){
    const sel=$('#intakeSelect'); sel.innerHTML='<option value="">Memuat…</option>';
    const j=await api(`${ROUTE}?type=intake&campusId=${encodeURIComponent(campusId)}`);
    const recs=j.records||[];
    sel.innerHTML='<option value="">Pilih tahun ajaran</option>';
    recs.forEach(x=> sel.innerHTML += `<option value="${x.Id}">${x.Name}</option>`);
  }

  async function loadPrograms(campusId,intakeId){
    const sel=$('#programSelect');
    sel.innerHTML='<option value="">Memuat…</option>';
    const params = new URLSearchParams({ type:'program', campusId, intakeId, date: new Date().toISOString().slice(0,10) }).toString();
    const j=await api(`${ROUTE}?${params}`);
    const recs=j.records||[];
    sel.innerHTML='<option value="">Pilih program</option>';
    recs.forEach(x=>{
      const id   = x.Id || x.StudyProgramId;
      const name = x.Name || x.StudyProgramName;
      if (id && name) sel.innerHTML += `<option value="${id}">${name}</option>`;
    });
  }

  async function resolvePricing(intakeId, studyProgramId){
    const today = new Date().toISOString().slice(0,10);
    const q = await api(`${ROUTE}?type=pricing&intakeId=${encodeURIComponent(intakeId)}&studyProgramId=${encodeURIComponent(studyProgramId)}&date=${today}`);
    if(!q || !q.bspId) throw new Error('Batch Study Program belum tersedia.');
    return { bspId: q.bspId, bspName: q.bspName, bookingPrice: q.bookingPrice ?? null };
  }

  async function loadStep2Options(){
    await loadCampuses();
    const campusId=$('input[name="campus"]:checked')?.value;
    if(campusId){
      await loadIntakes(campusId);
      const intakeId=$('#intakeSelect').value || '';
      if (intakeId) await loadPrograms(campusId,intakeId);
    }
  }

  $('#campusRadios')?.addEventListener('change', async (e)=>{
    if(e.target?.name==='campus') await loadIntakes(e.target.value);
  });

  $('#intakeSelect')?.addEventListener('change', async ()=>{
    const campusId=$('input[name="campus"]:checked')?.value||'';
    const intakeId=$('#intakeSelect').value||'';
    if(campusId&&intakeId) await loadPrograms(campusId,intakeId);
  });

  $('#btnBack2').addEventListener('click', ()=> setStep(1));

  $('#formStep2_Prefs').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const campusId=$('input[name="campus"]:checked')?.value||'';
    const intakeId=$('#intakeSelect').value;
    const programId=$('#programSelect').value;
    const msg=$('#msgStep2'); msg.style.display='none';
    if(!campusId||!intakeId||!programId){ msg.textContent='Pilih campus, tahun ajaran, dan program.'; msg.style.display='block'; return; }
    try{
      showLoading('Menyimpan pilihan program…');
      const { bspId, bspName, bookingPrice } = await resolvePricing(intakeId, programId);

      await api('/api/register-options',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'saveReg', opportunityId:S.opp, campusId, intakeId, studyProgramId:programId, bspId })
      });

      S.reg={ campusId,intakeId,programId,bspId,bspName,bookingPrice };
      $('#vaPrice') && ($('#vaPrice').textContent = rupiah(bookingPrice));
      closeLoading(); toastOk('Preferensi studi tersimpan. Lanjut ke pembayaran.');
      setStep(3);
      updateStage(3);
    }catch(err){ closeLoading(); showError(err.message); }
  });

  // =========================
  // STEP 3 (Pembayaran)
  // =========================
  $('#btnBack3').addEventListener('click', ()=> setStep(2));
  $('#formStep3_Payment').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const oppId=S.opp, accId=S.acc;
    const file=$('#proofFile').files[0];
    const msg=$('#msgStep3'); msg.style.display='none';
    if(!oppId){ showError('Opportunity belum tersedia.'); return; }
    if(!file){ msg.textContent='Pilih file bukti pembayaran.'; msg.style.display='block'; return; }
    if(file.size>1024*1024){ msg.textContent='Maksimal 1MB.'; msg.style.display='block'; return; }
    const allowed=['application/pdf','image/png','image/jpeg']; if(file.type && !allowed.includes(file.type)){ msg.textContent='Format harus PDF/PNG/JPG.'; msg.style.display='block'; return; }

    try{
      showLoading('Mengunggah bukti pembayaran…');
      const payload={ opportunityId:oppId, accountId:accId, filename:file.name, mime:file.type||'application/octet-stream', data:await fileToBase64(file) };
      await api('/api/register-upload-proof',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      closeLoading(); toastOk('Bukti pembayaran berhasil diupload.');
      setStep(4);
      updateStage(4);
      populateYears(); initStep4();
    }catch(err){ closeLoading(); showError(err.message); }
  });

  // =========================
  // STEP 4
  // =========================
  function populateYears(){ const sel=$('#gradYearSelect'); const now=new Date().getFullYear(); sel.innerHTML='<option value="">Pilih tahun</option>'; for(let y=now+5;y>=now-30;y--) sel.innerHTML+=`<option value="${y}">${y}</option>`; }
  $('#btnBack4').addEventListener('click', ()=> setStep(3));

  function initStep4(){
    const cbNotFound = $('#schoolNotFound');
    const autoWrap   = $('#schoolAutoWrap');
    const manualWrap = $('#schoolManualWrap');
    const input      = $('#schoolInput');
    const suggest    = $('#schoolSuggest');
    const hidId      = $('#schoolId');
    const mName      = $('#schoolManualName');
    const mNpsn      = $('#schoolManualNpsn');

    const setManualMode = (manual) => {
      manualWrap.style.display = manual ? '' : 'none';
      autoWrap?.querySelector?.('.suggest-box') && (autoWrap.querySelector('.suggest-box').style.display = manual ? 'none' : '');
      if (manual) {
        mName.disabled = false; mName.setAttribute('required','');
        mNpsn.disabled = false;
        input.dataset.chosenId = ''; input.dataset.chosenName = '';
        hidId.value = '';
      } else {
        mName.disabled = true; mName.removeAttribute('required');
        mNpsn.disabled = true;
        mName.value=''; mNpsn.value='';
      }
    };
    cbNotFound?.addEventListener('change', ()=> setManualMode(cbNotFound.checked));
    setManualMode(cbNotFound.checked);

    const onType = debounce(async () => {
      const term = (input.value || '').trim();
      hidId.value = '';
      input.dataset.chosenId = '';
      input.dataset.chosenName = '';

      if (term.length < 2){ suggest.innerHTML=''; suggest.style.display='none'; return; }
      try{
        const j = await api(`/api/register-options?type=sekolah&term=${encodeURIComponent(term)}`);
        const items = j.records || [];
        if (!items.length){ suggest.innerHTML=''; suggest.style.display='none'; return; }
        suggest.innerHTML = items.map(it => {
          const npsn = it.NPSN__c ? `<span class="muted">• NPSN ${it.NPSN__c}</span>` : '';
          return `<li class="suggest-item" data-id="${it.Id}" data-name="${(it.Name||'').replace(/"/g,'&quot;')}" data-npsn="${it.NPSN__c||''}">${it.Name} ${npsn}</li>`;
        }).join('');
        suggest.style.display='block';
      }catch{
        suggest.innerHTML=''; suggest.style.display='none';
      }
    }, 300);
    input?.addEventListener('input', onType);
    input?.addEventListener('focus', onType);
    document.addEventListener('click', (e)=>{ if (!suggest.contains(e.target) && e.target !== input) suggest.style.display='none'; });

    suggest?.addEventListener('click', (e)=>{
      const li = e.target.closest('.suggest-item'); if(!li) return;
      input.value = li.dataset.name || '';
      hidId.value = li.dataset.id || '';
      input.dataset.chosenId = li.dataset.id || '';
      input.dataset.chosenName = li.dataset.name || '';
      suggest.style.display='none';
    });

    const form = $('#formStep4');

    if (!form.dataset.boundSubmit) {
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        suggest.style.display='none';

        const oppId=S.opp, accId=S.acc;
        const gradYear=$('#gradYearSelect').value;
        const photo=$('#photoFile').files[0];
        const manual = cbNotFound.checked;
        const msg=$('#msgStep4'); msg.style.display='none';

        if(!gradYear){ msg.textContent='Pilih tahun lulus.'; msg.style.display='block'; return; }
        if(!photo){ msg.textContent='Pilih pas foto.'; msg.style.display='block'; return; }
        if(photo.size>1024*1024){
          const mb=(photo.size/1024/1024).toFixed(2);
          msg.textContent=`Ukuran pas foto maksimal 1MB (file Anda ${mb}MB).`;
          msg.style.display='block'; return;
        }

        let payload = { opportunityId: oppId, accountId: accId, graduationYear: gradYear };
        let sMode   = 'auto';
        let schoolName = '';

        if (manual) {
          const name    = (mName.value || '').trim();
          const npsnRaw = (mNpsn.value || '').trim();
          const npsn    = digits(npsnRaw);

          if (!name) { msg.textContent='Isi nama sekolah manual.'; msg.style.display='block'; return; }
          if (npsnRaw && !/^\d{8}$/.test(npsn)) { msg.textContent='Jika diisi, NPSN harus 8 digit angka.'; msg.style.display='block'; return; }

          payload.draftSchool = name;
          payload.schoolName  = name;
          if (npsn) payload.draftNpsn = npsn;
          sMode='manual'; schoolName=name;
        } else {
          let schoolId  = (hidId.value || '').trim();
          let nameTyped = (input.value || '').trim();

          if (!schoolId && input.dataset.chosenId) {
            schoolId  = input.dataset.chosenId;
            nameTyped = input.dataset.chosenName || nameTyped;
          }

          const idOk = /^[A-Za-z0-9]{15,18}$/.test(schoolId);

          if (idOk) {
            payload.masterSchoolId = schoolId;
            payload.schoolName = nameTyped;
            sMode='auto'; schoolName=nameTyped;
          } else if (nameTyped.length >= 2) {
            payload.draftSchool = nameTyped;
            payload.schoolName  = nameTyped;
            sMode='manual'; schoolName=nameTyped;
          } else {
            msg.textContent='Pilih sekolah dari daftar autocomplete atau centang "Sekolah tidak ditemukan" untuk input manual.';
            msg.style.display='block';
            input?.focus();
            return;
          }
        }

        try{
          showLoading('Menyimpan data sekolah & pas foto…');
          await api('/api/register-save-educ',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
          const payload2={ opportunityId:oppId, accountId:accId, filename:photo.name, mime:photo.type||'image/jpeg', data:await fileToBase64(photo) };
          await api('/api/register-upload-photo',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload2) });
          S.sekolah={ mode: sMode, schoolName, draftNpsn: payload.draftNpsn||null, gradYear, photoName:photo.name };
          closeLoading(); toastOk('Data sekolah & pas foto tersimpan.');
          setStep(5);
          updateStage(5);
          buildReview();
        }catch(err){ closeLoading(); showError(err.message); }
      });
      form.dataset.boundSubmit = '1';
    }

    if (!form.dataset.boundDirectBtn) {
      const primaryBtn = form.querySelector('.actions .submit-btn');
      if (primaryBtn) {
        primaryBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
        });
      }
      form.dataset.boundDirectBtn = '1';
    }

    if (!form.dataset.boundClickShim) {
      form.addEventListener('click', (ev) => {
        const backBtn = $('#btnBack4');
        if (backBtn && (ev.target === backBtn || backBtn.contains(ev.target))) return;

        const a = ev.target.closest('a');
        if (!a) return;
        const looksSubmit = a.classList.contains('submit-btn') || a.classList.contains('btn-primary');
        if (looksSubmit) {
          ev.preventDefault();
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
        }
      });
      form.dataset.boundClickShim = '1';
    }
  }

  // =========================
  // STEP 5 (Finalize)
  // =========================
  $('#btnBack5').addEventListener('click', ()=> setStep(4));
  function buildReview(){
    const p=S.pemohon||{}, r=S.reg||{}, s=S.sekolah||{};

    const npsnSuffix = s?.draftNpsn ? ` (NPSN: ${s.draftNpsn})` : '';
    const sekolahLine = s?.mode==='manual'
      ? `${s.schoolName || '-'}${npsnSuffix}`
      : `${s.schoolName || '-'}`;

    $('#reviewBox').innerHTML = `
      <div class="review-section">
        <h4>Data Pemohon</h4>
        <div><b>Nama:</b> ${(p.firstName||'-')} ${(p.lastName||'')}</div>
        <div><b>Email:</b> ${p.email||'-'}</div>
        <div><b>Phone:</b> ${p.phone||'-'}</div>
      </div>
      <div class="review-section">
        <h4>Preferensi Studi</h4>
        <div><b>BSP:</b> ${r?.bspName||'-'}</div>
        <div><b>Harga Form:</b> ${r?.bookingPrice!=null?('Rp '+Number(r.bookingPrice).toLocaleString('id-ID')):'-'}</div>
      </div>
      <div class="review-section">
        <h4>Data Sekolah</h4>
        <div><b>Sekolah Asal:</b> ${sekolahLine}</div>
        <div><b>Tahun Lulus:</b> ${s?.gradYear ?? '-'}</div>
        <div><b>Pas Foto:</b> ${s?.photoName ?? '-'}</div>
      </div>`;
  }

  function disableSubmitFinal() {
    const btn = $('#btnSubmitFinal');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Sudah Dikirim';
    btn.classList.add('btn-disabled');
  }

  $('#btnSubmitFinal').addEventListener('click', async ()=>{
    try{
      showLoading('Menyelesaikan registrasi…');
      await api('/api/register-finalize',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ opportunityId:S.opp, accountId:S.acc })
      });
      closeLoading();

      disableSubmitFinal();

      Swal.fire({
        icon:'success',
        title:'Registrasi Berhasil',
        text:'Terima kasih. Registrasi Anda telah selesai.',
        confirmButtonText:'Selesai'
      }).then(()=> location.href='thankyou.html');
    }catch(err){
      closeLoading(); showError(err.message);
    }
  });

  // =========================
  // DEEP LINK BOOT
  // =========================
  function extractOppIdFromUrl() {
    const params = new URLSearchParams(location.search || '');
    const fromQS = (params.get('opp') || '').trim();

    const raw = (location.pathname || '').replace(/^\/+|\/+$/g, '');
    const parts = raw ? raw.split('/') : [];

    const looksLikeSfId = s => /^[A-Za-z0-9]{15,18}$/.test(s || '');

    if (parts.length >= 2 && parts[0].toLowerCase() === 'register' && looksLikeSfId(parts[1])) {
      return parts[1];
    }
    if (parts.length === 1 && looksLikeSfId(parts[0])) {
      return parts[0];
    }
    if (looksLikeSfId(fromQS)) return fromQS;

    return '';
  }

  async function bootFromDeepLink() {
    // NEW: allow users to explicitly skip resume (fresh start)
    if (shouldSkipResume()) return false;

    const oppId = extractOppIdFromUrl();
    if (!oppId) return false;

    try {
      Swal.close();
      Swal.fire({ title:'Menyiapkan formulir…', didOpen:()=>Swal.showLoading(), allowOutsideClick:false, showConfirmButton:false });

      const j = await api(`/api/register-status?opportunityId=${encodeURIComponent(oppId)}`);

      // Hydrate local state (do NOT overwrite with nulls)
      S.opp = oppId;
      S.acc = j.accountId || '';
      S.pemohon = mergeDefined(S.pemohon, {
        firstName: j.person?.firstName,
        lastName : j.person?.lastName,
        email    : j.person?.email,
        phone    : j.person?.phone || j.person?.mobilePhone
      });

      if (j.reg) {
        S.reg = mergeDefined(S.reg, j.reg);
        if (S.reg.bookingPrice != null && $('#vaPrice')) {
          $('#vaPrice').textContent = rupiah(S.reg.bookingPrice);
        }
      }
      if (j.sekolah) {
        S.sekolah = mergeDefined(S.sekolah, j.sekolah);
      }

      const target = `/register.html?opp=${encodeURIComponent(oppId)}`;
      if (location.pathname + location.search !== target) {
        history.replaceState(null, '', target);
      }

      $('#opptyIdLabel').textContent = S.opp;
      $('#accountIdLabel').textContent = S.acc;

      const stage = Math.min(5, Math.max(1, Number(j.webStage || 1)));
      $('#authGate').style.display = 'none';
      showWizardHeader(true);

      if (stage <= 2) {
        await loadStep2Options();
      } else if (stage === 3) {
        // price already hydrated
      } else if (stage >= 4) {
        populateYears();
        initStep4();
      }
      if (stage === 5) {
        buildReview();
        if (j.isSubmitted || Number(j.webStage) === 6) {
          disableSubmitFinal();
        }
      }

      setStep(stage);
      Swal.close();
      return true;
    } catch (e) {
      console.warn('Deep-link resume failed:', e?.message || e);
      Swal.close();
      return false;
    }
  }

  // =========================
  // init
  // =========================
  document.addEventListener('DOMContentLoaded', async ()=>{
    showWizardHeader(false);
    $$('.form-step').forEach(s => s.style.display='none');

    const resumed = await bootFromDeepLink();
    if (!resumed) {
      $('#authGate').style.display = '';
    }
  });
})();