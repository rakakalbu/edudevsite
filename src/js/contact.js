// src/js/contact.js
(function () {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').toLowerCase());
  const digits  = (s) => String(s || '').replace(/\D/g, '');

  // Small API helper for consistent error handling
  async function api(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); }
    catch {
      const t = await res.text().catch(()=> '');
      throw new Error(t?.slice(0, 400) || 'Server returned non-JSON');
    }
    if (!res.ok || data?.success === false) {
      throw new Error(data?.message || `HTTP ${res.status}`);
    }
    return data;
  }

  // ===== Campus radios =====
  async function loadCampuses() {
    const wrap  = $('#campusRadios');
    const errEl = $('#campusError');
    if (!wrap) return;

    wrap.innerHTML = '<div class="note">Memuat daftar campus…</div>';
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    try {
      // Primary
      let j = await api('/api/register-options?type=campus');
      let recs = (j.records || []).filter(r => r && r.Id && r.Name);

      // One-time fallback to alias if empty
      if (!recs.length) {
        try {
          const j2 = await api('/api/register-options?type=campuses');
          recs = (j2.records || []).filter(r => r && r.Id && r.Name);
          if (j2.errors) console.warn('Campus API warnings (fallback):', j2.errors);
        } catch (e2) {
          // keep original error flow below
          console.warn('Fallback campuses call failed:', e2);
        }
      }

      if (!recs.length) {
        wrap.innerHTML = '<div class="field-error">Data campus tidak tersedia.</div>';
        if (j.errors) console.warn('Campus API warnings:', j.errors);
        return;
      }

      // Render radios
      wrap.innerHTML = '';
      recs.forEach((c, i) => {
        const id = `camp_${String(c.Id).replace(/[^A-Za-z0-9]/g, '')}`;
        const label = document.createElement('label');
        label.className = 'radio-item';
        label.htmlFor = id;
        label.innerHTML = `
          <input type="radio" id="${id}" name="campus" value="${c.Id}" ${i===0 ? 'checked' : ''}>
          <div>
            <div class="radio-title">${c.Name}</div>
          </div>
        `;
        wrap.appendChild(label);
      });
    } catch (e) {
      console.error('Campus load failed:', e);
      wrap.innerHTML = '<div class="field-error">Data campus tidak tersedia.</div>';
      if (errEl) { errEl.textContent = `Gagal memuat campus: ${e.message}`; errEl.style.display = 'block'; }
    }
  }

  function normalizePhone(raw) {
    let p = digits(raw || '');
    if (!p) return null;
    if (p.startsWith('0')) p = p.slice(1);
    if (!p.startsWith('62')) p = '62' + p;
    return '+' + p;
  }

  // ===== SweetAlert helper =====
  function confirmSubmitPreview(data) {
    const html = `
      <div style="text-align:left">
        <div><strong>Nama:</strong> ${data.firstName} ${data.lastName || ''}</div>
        <div><strong>Email:</strong> ${data.email}</div>
        <div><strong>Phone:</strong> ${data.phone}</div>
        <div><strong>Campus:</strong> ${data.campusName || '(terpilih)'}</div>
        <div><strong>Jurusan (opsional):</strong> ${data.description || '-'}</div>
      </div>
    `;
    return Swal.fire({
      title: 'Kirim data ini?',
      html,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Ya, kirim',
      cancelButtonText: 'Periksa lagi',
      focusConfirm: false
    });
  }

  function showLoading(title='Mengirim…') {
    Swal.fire({
      title,
      didOpen: () => Swal.showLoading(),
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false
    });
  }

  function showError(msg) {
    Swal.fire({ icon: 'error', title: 'Gagal', text: msg || 'Terjadi kesalahan.' });
  }

  async function submitContact(e) {
    e.preventDefault();

    // Ambil nilai dari "nama field custom" supaya tidak ditangkap autofill Chrome
    const first = $('#first_name')?.value.trim();
    const last  = $('#last_name')?.value.trim() || '';
    const email = $('#email')?.value.trim();
    const rawPhone = $('#phone')?.value;
    const campusId = $('input[name="campus"]:checked')?.value || '';
    const major = $('#major_interest')?.value.trim() || '';

    const phone = normalizePhone(rawPhone);

    // Validasi
    let err = '';
    if (!first) err = 'First name wajib diisi.';
    else if (!emailOk(email)) err = 'Format email tidak valid.';
    else if (!phone) err = 'Phone wajib diisi.';
    else if (!campusId) err = 'Pilih salah satu campus.';

    const msgBox = $('#contactMsg');
    if (err) {
      msgBox.textContent = err;
      msgBox.style.display = 'block';
      msgBox.style.color = '#e11d48';
      return;
    } else {
      msgBox.style.display = 'none';
    }

    // Tampilkan konfirmasi
    // (ambil nama kampus dari label yang terpilih)
    let campusName = '';
    const selected = $('input[name="campus"]:checked');
    if (selected) {
      const label = selected.closest('label');
      campusName = label ? (label.querySelector('.radio-title')?.textContent || '') : '';
    }

    const payload = {
      firstName: first,
      lastName : last,
      email,
      phone,                // sudah +62-normalized
      campusId,
      description: major || null,
      campusName            // hanya untuk preview
    };

    const confirm = await confirmSubmitPreview(payload);
    if (!confirm.isConfirmed) return;

    try {
      showLoading();

      const j = await api('/api/webtolead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // Sukses
      Swal.close();
      location.href = 'thankyou.html';
    } catch (e2) {
      Swal.close();
      showError(e2.message);
      const msgBox2 = $('#contactMsg');
      msgBox2.style.display = 'block';
      msgBox2.textContent = e2.message || 'Gagal mengirim.';
    }
  }

  // Matikan autofill agresif di Chromium
  function hardenAutocomplete() {
    // setAttribute ulang setelah load (beberapa browser override)
    ['first_name','last_name','email','phone','major_interest'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('spellcheck', 'false');
      }
    });
    const form = $('#contactForm');
    form?.setAttribute('autocomplete', 'off');
  }

  document.addEventListener('DOMContentLoaded', () => {
    hardenAutocomplete();
    loadCampuses();
    $('#contactForm')?.addEventListener('submit', submitContact);
  });
})();