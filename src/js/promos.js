(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // elements
  const grid       = $("#grid");
  const qEl        = $("#q");
  const statusEl   = $("#status");
  const categoryEl = $("#category");
  const shareBtn   = $("#share");
  const msgEl      = $("#msg");
  const prevBtn    = $("#prev");
  const nextBtn    = $("#next");
  const pageInfo   = $("#pageInfo");
  const submitBtn  = $("#interest_submit");

  // featured
  const featWrap  = $("#featured");
  const featTrack = $("#featTrack");
  const featDots  = $("#featDots");
  const featPrev  = $("#featPrev");
  const featNext  = $("#featNext");

  // ===== (Opsional) Auto-compact jika viewport pendek =====
  function applyCompactByViewport(){
    if (!featWrap) return;
    const shouldCompact = (window.innerHeight < 750);
    featWrap.classList.toggle('is-compact', shouldCompact || featWrap.classList.contains('is-compact'));
  }
  applyCompactByViewport();
  window.addEventListener('resize', () => {
    // jangan override kalau user sudah pasang is-compact manual
    if (featWrap && !featWrap.dataset.locked) applyCompactByViewport();
  });

  // ===== Konstanta gambar =====
  const IMG_PLACEHOLDER = 'https://placehold.co/640x360?text=Promo';
  const IMG_FALLBACK    = 'https://placehold.co/640x360?text=Promo';

  // ===== Cache URL public link per Campaign =====
  const imageUrlCache = new Map();

  // ===== State =====
  let state = { q:"", status:"active", category:"all", page:1, limit:12, total:0 };

  // Hydrate from URL
  try {
    const usp = new URLSearchParams(location.search);
    if (usp.has('q')) state.q = qEl.value = usp.get('q') || "";
    if (usp.has('status')) state.status = statusEl.value = usp.get('status') || "active";
    if (usp.has('category')) state.category = categoryEl.value = usp.get('category') || "all";
    if (usp.has('page')) state.page = Math.max(1, parseInt(usp.get('page')||'1',10));
  } catch {}

  // ===== Utils =====
  const rupiah  = v => v==null ? null : new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(v);
  const fmtDate = d => d ? new Date(d).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}) : null;

  function setUrlFromState(){
    const usp = new URLSearchParams({
      ...(state.q ? {q:state.q} : {}),
      status: state.status,
      ...(state.category && state.category !== 'all' ? {category: state.category} : {}),
      page: String(state.page)
    });
    history.replaceState(null, "", `${location.pathname}?${usp.toString()}`);
  }
  function copyCurrentUrl(){
    navigator.clipboard.writeText(location.href)
      .then(() => Swal.fire({icon:'success', title:'Tautan disalin', text:'Filter saat ini siap dibagikan.'}))
      .catch(() => Swal.fire({icon:'error', title:'Gagal menyalin'}));
  }

  // ===== Validation =====
  function validateEmailStrict(email) {
    const e = String(email || '').trim();
    const basic = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!basic.test(e)) return 'Format email tidak valid.';
    if (e.includes('..')) return 'Email tidak boleh mengandung dua titik berurutan.';
    const [_, domain] = e.split('@');
    if (!domain || domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-') || domain.endsWith('-')) return 'Domain email tidak valid.';
    if (!domain.includes('.')) return 'Domain email tidak valid.';
    const tld = domain.split('.').pop();
    if (!tld || tld.length < 2) return 'TLD domain terlalu pendek.';
    const disposable = new Set(['mailinator.com','yopmail.com','10minutemail.com','guerrillamail.com','temp-mail.org','tempmail.com','trashmail.com','sharklasers.com']);
    if (disposable.has(domain.toLowerCase())) return 'Gunakan email aktif (bukan email sementara/disposable).';
    return null;
  }
  function setFieldState(input, msgEl, msg){
    if (msg){
      input.classList.add('error');
      msgEl.textContent = msg;
      msgEl.hidden = false;
    }else{
      input.classList.remove('error');
      msgEl.hidden = true;
      msgEl.textContent = '';
    }
  }
  function validateName(value, label){
    const v = String(value||'').trim();
    if (v.length < 2) return `${label} minimal 2 karakter.`;
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/.test(v)) return `${label} hanya huruf/karakter nama.`;
    return null;
  }
  function validatePhoneLocal(value){
    const s = String(value||'').replace(/\D/g,'');
    if (!s) return null; // opsional
    if (s.startsWith('0')) return 'Tulis tanpa 0 di depan (gunakan format 812…).';
    if (s.length < 9 || s.length > 13) return 'No. HP 9–13 digit.';
    return null;
  }

  // ======= Image resolver (Field URL -> fallback API) =======
  async function fetchPromoImageUrl(campaignId){
    if (imageUrlCache.has(campaignId)) return imageUrlCache.get(campaignId);
    try {
      const url = new URL('/api/promo-image', location.origin);
      url.searchParams.set('campaignId', campaignId);
      url.searchParams.set('format', 'url');

      const r = await fetch(url.toString(), { headers:{'Accept':'application/json'}, cache:'no-store' });
      const j = await r.json();
      if (!r.ok || !j.success || !j.url) throw new Error(j.message || 'No image URL');
      imageUrlCache.set(campaignId, j.url);
      return j.url;
    } catch (e) {
      imageUrlCache.set(campaignId, null); // cache negatif
      return null;
    }
  }
  function applyImgFallback(img){
    img.onerror = null;
    img.src = IMG_FALLBACK;
  }
  async function resolveImageWithFallback(holder){
    const id  = holder.dataset.campaign;
    const img = holder.querySelector('img');
    if (!id || !img) return;
    if (img.dataset.resolved === '1') return;

    const fieldUrl = img.dataset.sfPublic || img.getAttribute('data-sf-public') || null;

    if (fieldUrl) {
      let triedFallback = false;
      img.onerror = async () => {
        if (triedFallback) { applyImgFallback(img); return; }
        triedFallback = true;
        const url2 = await fetchPromoImageUrl(id);
        img.onerror = () => applyImgFallback(img);
        img.src = url2 || IMG_FALLBACK;
      };
      img.src = fieldUrl;
      img.dataset.resolved = '1';
      return;
    }

    const url = await fetchPromoImageUrl(id);
    img.onerror = () => applyImgFallback(img);
    img.src = url || IMG_FALLBACK;
    img.dataset.resolved = '1';
  }
  const ioImg = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        resolveImageWithFallback(en.target);
        ioImg.unobserve(en.target);
      }
    });
  }, { root: null, rootMargin: '200px', threshold: 0.01 });

  function wireImageResolver(scope=document){
    scope.querySelectorAll('.card[data-campaign], .slide[data-campaign]').forEach(el => {
      const img = el.querySelector('img');
      if (img && !img.getAttribute('src')) img.src = IMG_PLACEHOLDER;
      ioImg.observe(el);
    });
  }

  // ===== Featured Carousel =====
  let slides = [];
  let current = 0;
  let autoTimer = null;
  const AUTO_INTERVAL = 5000;

  function buildSlide(rec){
    const sfUrl = rec.promoImageUrl || rec.imageUrl || '';
    const dateStr = [fmtDate(rec.startDate), fmtDate(rec.endDate)].filter(Boolean).join(' — ');
    const priceStr = rec.price!=null ? rupiah(rec.price) : '';
    const discountStr = rec.discountPercent!=null ? `${rec.discountPercent}% OFF` : '';

    return `
    <div class="slide" data-campaign="${rec.id}" role="option" aria-label="${rec.name}" tabindex="0">
      <img src="${IMG_PLACEHOLDER}" alt="${rec.name}" loading="lazy" decoding="async" width="1280" height="720"
           data-sf-public="${sfUrl}">
      <div class="badges-left">
        ${discountStr ? `<span class="badge badge-sale">${discountStr}</span>` : ''}
        ${rec.category ? `<span class="badge badge-cat">${rec.category}</span>` : ''}
      </div>
      <div class="badges-right">
        <span class="badge badge-quota" data-quota-for="${rec.id}" hidden aria-live="polite">Kuota: …</span>
      </div>
      <div class="content">
        <h3 class="title">${rec.name}</h3>
        <div class="meta">${[dateStr, rec.category].filter(Boolean).join(' • ')}</div>
        <div class="meta">${[priceStr].filter(Boolean).join(' · ')}</div>
        <div class="actions">
          <button class="btn btn-primary" type="button" data-register data-campaign="${rec.id}" data-name="${rec.name}">
            Daftar Promo
          </button>
        </div>
      </div>
    </div>`;
  }

  async function loadFeatured(){
    try{
      console.log('load featured')
      const r = await fetch(`/api/campaigns?status=active&page=1&limit=12`, { cache:'no-store' });
      console.log('fetch campaign status active', r.json())
      const j = await r.json();
      if (!r.ok) {
        console.log('fetch error', j.message)
        throw new Error(j.message || 'Gagal ambil featured')
      };
      
      const recs = (j.records || []).slice(0, 8);
      if (!recs.length) { featWrap.hidden = true; return; }
      console.log('recs', recs)

      slides = recs;
      featTrack.innerHTML = recs.map(buildSlide).join('');
      featDots.innerHTML  = recs.map((_,i)=>`<button class="dot ${i===0?'active':''}" data-i="${i}" aria-label="Slide ${i+1}"></button>`).join('');
      featWrap.hidden = false;

      wireImageResolver(featTrack);
      recs.forEach(it => observeQuotaForId(it.id));

      featPrev.onclick = ()=> go(current-1);
      featNext.onclick = ()=> go(current+1);
      featDots.onclick = (e)=>{ const t = e.target.closest('.dot'); if(!t) return; go(Number(t.dataset.i)); };

      featTrack.addEventListener('keydown', (e)=>{
        if (e.key === 'ArrowLeft') go(current-1);
        if (e.key === 'ArrowRight') go(current+1);
      });

      startAuto();
      featTrack.addEventListener('mouseenter', stopAuto);
      featTrack.addEventListener('mouseleave', startAuto);
      enableDrag(featTrack);
    }catch(e){ console.warn('featured error', e.message); featWrap.hidden = true; }
  }
  function go(n){
    if (!slides.length) return;
    current = (n + slides.length) % slides.length;
    featTrack.style.transform = `translateX(-${current*100}%)`;
    $$('.dot', featDots).forEach((d,i)=> d.classList.toggle('active', i===current));
    restartAuto();
  }
  function startAuto(){ stopAuto(); autoTimer = setInterval(()=> go(current+1), AUTO_INTERVAL); }
  function stopAuto(){ if (autoTimer) clearInterval(autoTimer); autoTimer = null; }
  function restartAuto(){ startAuto(); }
  function enableDrag(track){
    let startX=0, delta=0, dragging=false;
    const onDown=(x)=>{ dragging=true; startX=x; delta=0; track.style.transition='none'; };
    const onMove=(x)=>{ if(!dragging) return; delta = x-startX; track.style.transform = `translateX(${ -current*100 + (delta/track.clientWidth)*100 }%)`; };
    const onUp=()=>{ if(!dragging) return; track.style.transition='transform .35s ease';
      if (Math.abs(delta) > track.clientWidth*0.2) go(delta<0?current+1:current-1); else go(current);
      dragging=false; delta=0;
    };
    track.addEventListener('mousedown', e=>onDown(e.clientX));
    window.addEventListener('mousemove', e=>onMove(e.clientX));
    window.addEventListener('mouseup', onUp);
    track.addEventListener('touchstart', e=>onDown(e.touches[0].clientX), {passive:true});
    window.addEventListener('touchmove', e=>onMove(e.touches[0].clientX), {passive:true});
    window.addEventListener('touchend', onUp);
  }

  // ===== Grid list =====
  function priceBlock(price, discountPercent){
    if (price == null) return '';
    if (discountPercent == null) return `<span class="price price-final">${rupiah(price)}</span>`;
    const final = Math.max(0, Math.round(price * (100 - discountPercent) / 100));
    const hemat = price - final;
    return `
      <span class="price"><s>${rupiah(price)}</s> <span class="price-final">${rupiah(final)}</span></span>
      <span class="status">Hemat ${rupiah(hemat)}</span>
    `;
  }

  function card(record){
    const { id, name, description, startDate, endDate, status, category, price, discountPercent } = record;
    const dateStr   = [fmtDate(startDate), fmtDate(endDate)].filter(Boolean).join(' — ');
    const plainDesc = (description || '').replace(/<[^>]+>/g,'');
    const desc      = plainDesc.length > 160 ? (plainDesc.slice(0,160) + '…') : plainDesc;
    const sfUrl     = record.promoImageUrl || record.imageUrl || '';

    return `
    <article class="card" data-campaign="${id}">
      <div class="thumb">
        <img src="${IMG_PLACEHOLDER}" alt="${name}" loading="lazy" decoding="async" width="640" height="360"
             data-sf-public="${sfUrl}">
        <div class="badges-left">
          ${discountPercent!=null ? `<span class="badge badge-sale">${discountPercent}% OFF</span>` : ''}
          ${category ? `<span class="badge badge-cat">${category}</span>` : ''}
        </div>
        <div class="badges-right">
          <span class="badge badge-quota" data-quota-for="${id}" hidden aria-live="polite">Kuota: …</span>
        </div>
      </div>
      <div class="card-body">
        <h3 class="title">${name}</h3>
        ${dateStr ? `<div class="meta">${dateStr}</div>` : ''}
        <p class="desc">${desc || ''}</p>
        <div class="cta">
          <div class="pricing">
            ${priceBlock(price, discountPercent)}
            ${status && status.toLowerCase() !== 'planned'
              ? `<span class="status ${'st-'+status.toLowerCase().replace(/\s+/g,'-')}">${status}</span>` : ''}
          </div>
          <div class="actions">
            <button class="btn btn-primary" type="button" data-register data-campaign="${id}" data-name="${name}">
              Daftar Promo
            </button>
          </div>
        </div>
      </div>
    </article>`;
  }

  // Abortable list fetch
  let listAbort;
  async function load(){
    console.log('test load');
    setUrlFromState();
    msgEl.textContent = "Memuat promo…";
    grid.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
                      <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    prevBtn.disabled = true; nextBtn.disabled = true;

    const params = new URLSearchParams({
      q: state.q, status: state.status,
      ...(state.category && state.category !== 'all' ? { category: state.category } : {}),
      page: String(state.page), limit: String(state.limit)
    });

    try {
      listAbort?.abort(); listAbort = new AbortController();
      const r = await fetch(`/api/campaigns?${params}`, { signal:listAbort.signal, cache:'no-store' });
      const j = await r.json();
      console.log('test fetch campaign', r.json())
      if (!r.ok) 
        {
          console.log(j.message)
          throw new Error(j.message || "Gagal mengambil data");
        }

      state.total = j.total || 0;
      const items = j.records || [];
      grid.innerHTML = items.length
        ? items.map(card).join("")
        : `<div class="empty">Belum ada promo untuk filter ini.
             <div class="tips">Coba ubah kata kunci, ganti status/kategori, atau
               <button id="resetFilters" class="btn" type="button">Reset filter</button>
             </div>
           </div>`;

      console.log('items', items);
      if (!items.length) {
        const btnReset = $("#resetFilters");
        if (btnReset) btnReset.onclick = () => {
          qEl.value=''; statusEl.value='active'; categoryEl.value='all';
          state = { q:"", status:"active", category:"all", page:1, limit:12, total:0 };
          load();
        };
      }

      const maxPage = Math.max(1, Math.ceil(state.total / state.limit));
      pageInfo.textContent = `Halaman ${state.page} dari ${maxPage}`;
      prevBtn.disabled = state.page <= 1;
      nextBtn.disabled = state.page >= maxPage || !j.hasMore;

      msgEl.textContent = "";

      // kuota & gambar dinamis
      items.forEach(it => observeQuotaForId(it.id));
      wireImageResolver(grid);
      console.log('finish load')

    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error(e);
      msgEl.textContent = e.message || "Terjadi kesalahan memuat promo.";
      grid.innerHTML = `<div class="empty">Gagal memuat data.</div>`;
    }
  }

  // IntersectionObserver for quota
  const visibleIds = new Set();
  const io = new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      const el = e.target;
      if (e.isIntersecting) {
        visibleIds.add(el.dataset.campaign);
        updateQuota(el.dataset.campaign);
      } else {
        visibleIds.delete(el.dataset.campaign);
      }
    });
  }, { root:null, rootMargin:'0px', threshold:0.1 });

  function observeQuotaForId(id){
    const el = document.querySelector(`.card[data-campaign="${id}"]`) ||
               document.querySelector(`.slide[data-campaign="${id}"]`);
    if (el) io.observe(el);
  }

  setInterval(()=>{ visibleIds.forEach(id => updateQuota(id)); }, 30000);

  // === Kuota ===
  async function updateQuota(campaignId){
    const badge = document.querySelector(`[data-quota-for="${campaignId}"]`);
    const holder= document.querySelector(`.card[data-campaign="${campaignId}"]`) || document.querySelector(`.slide[data-campaign="${campaignId}"]`);
    const btn   = holder?.querySelector('[data-register]');
    if (!badge) return;

    try {
      const r = await fetch(`/api/campaign-stats?campaignId=${encodeURIComponent(campaignId)}`, { cache:'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || "Gagal ambil kuota");

      let text;
      if (j.quota != null) {
        const used = j.used || 0;
        const rem  = (j.remaining != null) ? j.remaining : Math.max(0, j.quota - used);
        text = rem > 0 ? `Sisa: ${rem} (${used}/${j.quota})` : `Kuota penuh (${used}/${j.quota})`;
        if (rem <= 0) {
          btn?.setAttribute('disabled','disabled'); btn?.classList.add('is-disabled');
          if (btn) btn.textContent = 'Kuota Penuh';
        } else {
          btn?.removeAttribute('disabled'); btn?.classList.remove('is-disabled');
          if (btn) btn.textContent = 'Daftar Promo';
        }
      } else {
        const used = j.used || 0;
        text = `Pendaftar: ${used}`;
        btn?.removeAttribute('disabled'); btn?.classList.remove('is-disabled');
        if (btn) btn.textContent = 'Daftar Promo';
      }

      badge.textContent = text;
      badge.hidden = false;

    } catch (e) {
      console.warn('quota error', e.message);
    }
  }

  // filters & paging
  let t;
  qEl.addEventListener('input', ()=>{
    clearTimeout(t);
    t = setTimeout(()=>{ state.q = qEl.value.trim(); state.page = 1; load(); }, 300);
  });
  statusEl.addEventListener('change',   ()=>{ state.status   = statusEl.value;   state.page=1; load(); });
  categoryEl.addEventListener('change', ()=>{ state.category = categoryEl.value; state.page=1; load(); });
  prevBtn.addEventListener('click',     ()=>{ if (state.page>1){ state.page--; load(); }});
  nextBtn.addEventListener('click',     ()=>{ state.page++; load(); });
  shareBtn.addEventListener('click',    copyCurrentUrl);

  // modal daftar promo
  let lastFocus = null;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-register]');
    if (!btn) return;
    lastFocus = btn;
    openRegisterModal({ campaignId: btn.dataset.campaign, campaignName: btn.dataset.name });
  });

  function openRegisterModal({ campaignId, campaignName }){
    const m = $('#interestModal');
    m.querySelector('[data-campaign-name]').textContent = campaignName || 'Campaign';
    m.querySelector('#interest_campaignId').value = campaignId;
    m.classList.add('show');
    trapFocus(m);
    $('#interest_firstName').focus();
    stopAuto();
  }

  $('#interest_close').addEventListener('click', closeModal);
  function closeModal(){
    const m = $('#interestModal');
    m.classList.remove('show');
    releaseFocus();
    if (lastFocus) lastFocus.focus();
    startAuto();
  }

  document.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape' && $('#interestModal').classList.contains('show')) closeModal();
  });

  $('#interest_phone').addEventListener('input', (e)=>{
    e.target.value = e.target.value.replace(/\D/g,'');
  });

  // realtime validation binding
  const firstNameEl = document.getElementById('interest_firstName');
  const lastNameEl  = document.getElementById('interest_lastName');
  const emailEl     = document.getElementById('interest_email');
  const phoneEl     = document.getElementById('interest_phone');

  const fnMsg = document.getElementById('firstName_msg');
  const lnMsg = document.getElementById('lastName_msg');
  const emMsg = document.getElementById('email_error');
  const phMsg = document.getElementById('phone_msg');

  function validateForm(){
    const e1 = validateName(firstNameEl.value,'Nama depan');
    const e2 = validateName(lastNameEl.value ,'Nama belakang');
    const e3 = validateEmailStrict(emailEl.value);
    const e4 = validatePhoneLocal(phoneEl.value);

    setFieldState(firstNameEl, fnMsg, e1);
    setFieldState(lastNameEl , lnMsg, e2);
    setFieldState(emailEl    , emMsg, e3);
    setFieldState(phoneEl    , phMsg, e4);

    const ok = !e1 && !e2 && !e3 && !e4;
    submitBtn.disabled = !ok;
    return ok;
  }
  [firstNameEl, lastNameEl, emailEl, phoneEl].forEach(el=> el.addEventListener('input', validateForm));

  // submit
  document.getElementById('interest_form').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if (!validateForm()){
      Swal.fire({icon:'warning', title:'Lengkapi data', text:'Periksa kembali kolom yang bertanda merah.'});
      return;
    }

    const firstName = $('#interest_firstName').value.trim();
    const lastName  = $('#interest_lastName').value.trim();
    const email     = $('#interest_email').value.trim();
    const company   = $('#interest_company').value.trim();
    const phoneRaw  = $('#interest_phone').value.trim();
    const campaignId= $('#interest_campaignId').value;

    let s = phoneRaw.replace(/\D/g,'');
    if (s.startsWith('0')) s = s.slice(1);
    const phone = s ? `+62${s}` : null;

    const payload = {
      firstName, lastName, email, phone, company, campaignId,
      leadSource:'Promo Page', leadStatus:'New', campaignMemberStatus:'Responded'
    };

    try {
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');
      submitBtn.textContent = 'Mengirim…';

      const r = await fetch('/api/lead-interest', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await r.json() : { message: await r.text() };
      if (!r.ok) throw new Error(data.message || 'Gagal menyimpan pendaftaran');

      if (data.alreadyRegistered) {
        await Swal.fire({icon:'info', title:'Anda sudah terdaftar', text:'Data Anda sudah tercatat pada promo ini.'});
      } else {
        await Swal.fire({icon:'success', title:'Pendaftaran berhasil', text:'Terima kasih! Pendaftaran promo Anda diterima.'});
      }

      updateQuota(campaignId);
      closeModal();
      $('#interest_form').reset();
      validateForm();

    } catch (e) {
      console.error(e);
      Swal.fire({icon:'error', title:'Gagal', text: e.message || 'Terjadi kesalahan. Coba lagi.'});
    } finally {
      submitBtn.classList.remove('is-loading');
      submitBtn.textContent = 'Kirim';
      submitBtn.disabled = !validateForm();
    }
  });

  // focus trap modal
  let focusTrapRemovers = [];
  function trapFocus(container){
    const focusable = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
    function handler(e){
      if (!container.classList.contains('show')) return;
      const nodes = Array.from(container.querySelectorAll(focusable)).filter(el=>!el.disabled && el.offsetParent!==null);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length-1];
      if (e.key === 'Tab'){
        if (e.shiftKey && document.activeElement === first){ last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last){ first.focus(); e.preventDefault(); }
      }
    }
    document.addEventListener('keydown', handler);
    focusTrapRemovers.push(()=>document.removeEventListener('keydown', handler));
  }
  function releaseFocus(){ focusTrapRemovers.forEach(fn=>fn()); focusTrapRemovers=[]; }

  // init
  (async function init(){
    try{
      console.log('init');
      const r = await fetch('/api/campaign-categories', { cache:'no-store' });
      console.log('fetch campaign category', r.json());
      const j = await r.json();
      if (r.ok && Array.isArray(j.values)){
        const opts = ['<option value="all">Semua Kategori</option>']
          .concat(j.values.map(v => `<option value="${String(v.value).replace(/"/g,'&quot;')}">${v.label}</option>`));
        categoryEl.innerHTML = opts.join('');
        categoryEl.value = state.category;
      }
    }catch(e){ console.warn('Gagal memuat kategori', e.message); }
    await loadFeatured();
    await load();
    validateForm(); // initial state tombol
  })();
})();