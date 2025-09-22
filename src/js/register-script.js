// public/register-script.js

// ========= Helpers =========
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).toLowerCase());
const digits  = (s) => String(s||'').replace(/\D/g,'');
const isSfId  = (v) => /^[a-zA-Z0-9]{15,18}$/.test(String(v||''));

function updateProgress(currentStep) {
  $$('#progressSteps .step-item').forEach(li => {
    const step = Number(li.dataset.step);
    li.classList.toggle('is-active', step === currentStep);
    li.classList.toggle('is-complete', step < currentStep);
    if (step === currentStep) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
}
function goToStep(n){
  $$('.form-step').forEach(sec => sec.hidden = sec.getAttribute('data-step') !== String(n));
  updateProgress(n);
  window.scrollTo({top:0,behavior:'smooth'});
}
window.goToStep = goToStep;

// ========= VA (untuk Step 2) =========
const VA_INFO = { bank: 'BCA', number: '8888800123456789', name: 'Metro Seven Admission' };
document.addEventListener('DOMContentLoaded', () => {
  $('#vaBank')   && ($('#vaBank').textContent   = VA_INFO.bank);
  $('#vaNumber') && ($('#vaNumber').textContent = VA_INFO.number);
  updateProgress(1);
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const sel = document.querySelector(btn.dataset.copy);
  if (!sel) return;
  try {
    await navigator.clipboard.writeText((sel.textContent || '').trim());
    const prev = btn.textContent; btn.textContent = 'Tersalin';
    setTimeout(() => (btn.textContent = prev), 1200);
  } catch { alert('Gagal menyalin.'); }
});

// ========= STEP 1: Data Pemohon =========
$('#nextBtn1')?.addEventListener('click', () => {
  const firstName = $('#firstName')?.value.trim();
  const email = $('#email')?.value.trim();
  const phone = $('#phone')?.value.trim();
  if (!firstName) return alert('Nama depan wajib.');
  if (!emailOk(email)) return alert('Format email tidak valid.');
  if (!phone) return alert('No. HP wajib.');
  goToStep(2);
});

// ========= STEP 2: Bukti Pembayaran =========
const MAX_PROOF = 5 * 1024 * 1024;
const ALLOWED_PROOF = ['image/jpeg','image/png','application/pdf'];
let paymentProofDataURL = null, paymentProofFileName = null;

const proofInput = $('#paymentProof'), proofErr = $('#paymentProofError');
const proofPrev  = $('#paymentProofPreview'), proofImg = $('#paymentProofImg'), proofMeta = $('#paymentProofMeta');
const nextBtn2   = $('#nextBtn2');

if (proofInput) {
  proofInput.addEventListener('change', async (e) => {
    proofErr.textContent = ''; proofPrev.style.display = 'none';
    paymentProofDataURL = null; paymentProofFileName = null; nextBtn2.disabled = true;

    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!ALLOWED_PROOF.includes(file.type)) { proofErr.textContent = 'File harus JPG/PNG atau PDF.'; return; }
    if (file.size > MAX_PROOF) { proofErr.textContent = 'Ukuran maksimal 5 MB.'; return; }

    paymentProofFileName = file.name || 'bukti-pembayaran';
    proofPrev.style.display = 'flex';
    proofMeta.textContent = `${paymentProofFileName} • ${(file.size/1024/1024).toFixed(2)} MB`;

    const fr = new FileReader();
    fr.onload = () => {
      paymentProofDataURL = fr.result;
      if (file.type.startsWith('image/')) { proofImg.src = fr.result; proofImg.style.display='block'; }
      else { proofImg.style.display='none'; }
    };
    fr.readAsDataURL(file);

    nextBtn2.disabled = false;
    window.paymentProofDataURL = paymentProofDataURL;
    window.paymentProofFileName = paymentProofFileName;
  });

  $('#prevBtn2')?.addEventListener('click', () => goToStep(1));
  nextBtn2?.addEventListener('click', () => goToStep(3));
}

// ========= Helpers umum =========
function setSelectOptions(selectEl, items, placeholder = '— Pilih —') {
  selectEl.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = placeholder; selectEl.appendChild(ph);
  (items || []).forEach(it => {
    const opt = document.createElement('option');
    opt.value = it.Id ?? it;
    opt.textContent = it.Name ?? it;
    selectEl.appendChild(opt);
  });
}
function getSelectedText(selectEl) {
  const i = selectEl.selectedIndex;
  return i > -1 ? selectEl.options[i].textContent : '';
}

// ========= STEP 3: Campus → Intake → Program =========
let campusLoaded = false;

async function loadCampuses() {
  const container = $('#campusRadios');
  if (!container || campusLoaded) return;
  campusLoaded = true;

  try {
    const r = await fetch(`/api/salesforce-query?type=campus`);
    const j = await r.json();
    const recs = j.records || [];

    if (!recs.length) { container.innerHTML = `<div class="note">Data campus tidak tersedia.</div>`; return; }
    container.innerHTML = '';
    recs.forEach((c, idx) => {
      const id = `camp_${c.Id}`;
      const label = document.createElement('label');
      label.className = 'radio-item'; label.htmlFor = id;
      label.innerHTML = `
        <input id="${id}" type="radio" name="campusOption" value="${c.Id}" ${idx===0?'checked':''}>
        <div><div class="radio-title">${c.Name}</div></div>
      `;
      container.appendChild(label);
    });

    const checked = container.querySelector('input[name="campusOption"]:checked');
    if (checked) {
      $('#campusId').value = checked.value;
      $('#campusName').value = checked.closest('label').querySelector('.radio-title').textContent;

      await loadIntakes(checked.value);
      const currentIntake = $('#intakeSelect').value || '';
      await loadPrograms(checked.value, currentIntake);
    }

    container.addEventListener('change', async (e) => {
      if (e.target && e.target.name === 'campusOption') {
        const campusId = e.target.value;
        $('#campusId').value = campusId;
        $('#campusName').value = e.target.closest('label').querySelector('.radio-title').textContent;

        setSelectOptions($('#intakeSelect'), [], '— Memuat Tahun Ajaran… —');
        $('#intakeSelect').disabled = true;
        setSelectOptions($('#studyProgramSelect'), [], '— Memuat Study Program… —');
        $('#studyProgramSelect').disabled = true;

        await loadIntakes(campusId);
        const currentIntake = $('#intakeSelect').value || '';
        await loadPrograms(campusId, currentIntake);
      }
    });

  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="field-error">Gagal memuat data Campus.</div>`;
  }
}

async function loadIntakes(campusId) {
  const sel = $('#intakeSelect');
  try {
    sel.disabled = true;
    const r = await fetch(`/api/salesforce-query?type=intake&campusId=${encodeURIComponent(campusId)}`);
    const j = await r.json();
    const items = j.records || [];
    setSelectOptions(sel, items, '— Pilih Tahun Ajaran —');
    sel.disabled = false;
  } catch (e) {
    console.error(e);
    setSelectOptions(sel, [], '— Pilih Tahun Ajaran —');
    sel.disabled = false;
  }
}

async function loadPrograms(campusId, intakeId) {
  const sel = $('#studyProgramSelect');
  if (!campusId) {
    setSelectOptions(sel, [], '— Pilih Campus dahulu —');
    sel.disabled = true; return;
  }
  if (!intakeId) {
    setSelectOptions(sel, [], '— Pilih Tahun Ajaran dahulu —');
    sel.disabled = true; return;
  }
  try {
    sel.disabled = true;
    const params = new URLSearchParams({ type:'program', campusId, intakeId, date: new Date().toISOString().slice(0,10) }).toString();
    const r = await fetch(`/api/salesforce-query?${params}`);
    const j = await r.json();
    const items = j.records || [];
    if (!items.length) {
      setSelectOptions(sel, [], '— Program belum tersedia untuk kombinasi Campus/Intake ini —');
      sel.disabled = true;
    } else {
      setSelectOptions(sel, items, '— Pilih Study Program —');
      sel.disabled = false;
    }
  } catch (e) {
    console.error(e);
    setSelectOptions(sel, [], '— Gagal memuat Study Program —');
    sel.disabled = true;
  }
}

// Tahun lulus: 2025 s/d current + 5
function populateGradYear() {
  const sel = $('#gradYear'); if (!sel) return;
  const current = new Date().getFullYear();
  const start = 2025;
  const end   = current + 5;
  const years = [];
  for (let y = end; y >= start; y--) years.push(String(y));
  setSelectOptions(sel, years, '— Pilih Tahun Lulus —');
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadCampuses();
  populateGradYear();
});

$('#intakeSelect')?.addEventListener('change', async () => {
  const campusId = $('#campusId').value || '';
  const intakeId = $('#intakeSelect').value || '';
  await loadPrograms(campusId, intakeId);
});

$('#prevBtn3')?.addEventListener('click', () => goToStep(2));
$('#nextBtn3')?.addEventListener('click', () => {
  if (!$('#campusId')?.value) return alert('Pilih Campus.');
  if (!$('#studyProgramSelect')?.value) return alert('Pilih Study Program.');
  goToStep(4);
});

// ========= STEP 4: Sekolah + Pas Foto =========
const toggleSchoolManual = $('#schoolManualToggle');
const otherSchoolBox = $('#otherSchoolContainer');
toggleSchoolManual?.addEventListener('change', e => { otherSchoolBox.style.display = e.target.checked ? 'block' : 'none'; });

const schoolSearch = $('#schoolSearch');
const schoolSug = $('#schoolSuggestions');
const schoolIdHidden = $('#schoolId');

let schoolTimer;
schoolSearch?.addEventListener('input', () => {
  const term = (schoolSearch.value || '').trim();
  schoolIdHidden.value = '';
  if (term.length < 2) { schoolSug.hidden = true; schoolSug.innerHTML = ''; return; }
  clearTimeout(schoolTimer);
  schoolTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/salesforce-query?type=sekolah&term=${encodeURIComponent(term)}`);
      const j = await r.json();
      const items = j.records || [];
      schoolSug.innerHTML = '';
      items.forEach(it => {
        const li = document.createElement('li');
        li.innerHTML = `${it.Name} ${it.NPSN__c ? `<span class="muted">• NPSN ${it.NPSN__c}</span>` : ''}`;
        li.addEventListener('click', () => {
          schoolSearch.value = it.Name;
          schoolIdHidden.value = it.Id;
          schoolSug.hidden = true; schoolSug.innerHTML = '';
        });
        schoolSug.appendChild(li);
      });
      schoolSug.hidden = items.length === 0;
    } catch (e) { schoolSug.hidden = true; schoolSug.innerHTML = ''; }
  }, 300);
});

$('#prevBtn4')?.addEventListener('click', () => goToStep(3));

// Pas Foto
const MAX_PHOTO = 1 * 1024 * 1024;
const ALLOWED_PHOTO = ['image/jpeg','image/png'];
let photoDataURL = null, photoFileName = null;

const photoIn  = $('#photo'), photoErr = $('#photoError'), photoPrev = $('#photoPreview');

photoIn?.addEventListener('change', e => {
  photoErr.textContent = ''; photoPrev.style.display='none';
  photoDataURL = null; photoFileName = null;

  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!ALLOWED_PHOTO.includes(file.type)) { photoErr.textContent = 'Tipe harus JPG/PNG.'; return; }
  if (file.size > MAX_PHOTO) { photoErr.textContent = 'Ukuran maksimal 1 MB.'; return; }

  const fr = new FileReader();
  fr.onload = () => {
    photoDataURL = fr.result; photoFileName = file.name || 'pas-foto-3x4.jpg';
    photoPrev.src = fr.result; photoPrev.style.display='block';
    window.photoDataURL = photoDataURL; window.photoFileName = photoFileName;
  };
  fr.readAsDataURL(file);
});

$('#nextBtn4')?.addEventListener('click', () => {
  if (!toggleSchoolManual?.checked && !isSfId($('#schoolId')?.value)) {
    alert('Pilih sekolah dari daftar (bukan ketik manual).'); return;
  }
  if (!photoDataURL) { photoErr.textContent = 'Unggah pas foto 3×4 terlebih dahulu.'; return; }

  $('#sumName').textContent = `${$('#firstName').value} ${$('#lastName').value || ''}`.trim();
  $('#sumEmail').textContent = $('#email').value;
  $('#sumPhone').textContent = `+62${digits($('#phone').value)}`.replace('++','+');
  $('#sumCampus').textContent = $('#campusName').value || '-';
  $('#sumIntake').textContent = getSelectedText($('#intakeSelect')) || '-';
  $('#sumStudyProgram').textContent = getSelectedText($('#studyProgramSelect')) || '-';
  $('#sumGradYear').textContent = getSelectedText($('#gradYear')) || '-';
  const schoolManual = $('#schoolManualToggle')?.checked;
  $('#sumSchool').textContent = schoolManual ? ($('#schoolNameManual').value || '-') : ($('#schoolSearch').value || '-');

  goToStep(5);
});

// ========= STEP 5: Submit =========
$('#prevBtn5')?.addEventListener('click', () => goToStep(4));

$('#submitBtn')?.addEventListener('click', async (e)=>{
  e.preventDefault();
  if (!$('#agreeTerms')?.checked) { $('#agreeError').textContent = 'Harus menyetujui kebijakan.'; return; }
  $('#agreeError').textContent = '';

  try {
    $('#submitBtn').disabled = true; $('#submitBtn').textContent = 'Mengirim…';

    // normalisasi +62
    let ph = digits($('#phone').value || '');
    if (ph.startsWith('0')) ph = ph.slice(1);
    if (!ph.startsWith('62')) ph = `62${ph}`;
    const phoneNorm = `+${ph}`;

    const payload = {
      firstName: $('#firstName').value.trim(),
      lastName : $('#lastName').value.trim() || '-',
      email    : $('#email').value.trim(),
      phone    : phoneNorm,

      campusId       : $('#campusId').value || null,
      campusName     : $('#campusName').value || null,
      masterIntakeId : $('#intakeSelect').value || null,
      intakeName     : getSelectedText($('#intakeSelect')) || null,
      studyProgramId : $('#studyProgramSelect').value || null,
      studyProgramName : getSelectedText($('#studyProgramSelect')) || null,
      graduationYear : $('#gradYear').value || null,
      schoolId       : ($('#schoolId')?.value && isSfId($('#schoolId').value)) ? $('#schoolId').value : null,

      paymentProof: window.paymentProofDataURL ? {
        dataUrl: window.paymentProofDataURL,
        fileName: window.paymentProofFileName || 'bukti-pembayaran'
      } : null,

      // FIXED: send the actual image dataUrl (was wrongly sending filename before)
      photo: window.photoDataURL ? {
        dataUrl: window.photoDataURL,
        fileName: window.photoFileName || 'pas-foto-3x4.jpg'
      } : null,
    };

    const r = await fetch('/api/register', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(j.message || 'Gagal submit pendaftaran');

    // Store the triple for the next page to "fill the opportunity"
    sessionStorage.setItem('regTriple', JSON.stringify({
      accountId: j.accountId || null,
      contactId: j.contactId || null,
      opportunityId: j.opportunityId || null,
      source: j.source || null
    }));

    location.href = 'thankyou.html';
  } catch (err) {
    alert(err.message || 'Terjadi kesalahan.');
  } finally {
    $('#submitBtn').disabled = false; $('#submitBtn').textContent = 'Kirim';
  }
});