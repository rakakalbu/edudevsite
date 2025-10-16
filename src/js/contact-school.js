(function () {
  const $ = (s, r=document) => r.querySelector(s);
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').toLowerCase());
  const digits = (s) => String(s||'').replace(/\D/g,'');

  function normalizePhone(raw){
    let p = digits(raw||'');
    if (!p) return null;
    if (p.startsWith('0')) p = p.slice(1);
    if (!p.startsWith('62')) p = '62' + p;
    return '+' + p;
  }

  async function api(url, opts){
    const res = await fetch(url, opts);
    let data=null;
    try { data = await res.json(); }
    catch { throw new Error('Server returned invalid response'); }
    if(!res.ok || data?.success===false){
      throw new Error(data?.message || `HTTP ${res.status}`);
    }
    return data;
  }

  function showLoading(title='Mengirim…'){
    Swal.fire({
      title,
      didOpen: ()=>Swal.showLoading(),
      allowOutsideClick:false,
      allowEscapeKey:false,
      showConfirmButton:false
    });
  }
  function showError(msg){
    Swal.fire({ icon:'error', title:'Gagal', text: msg || 'Terjadi kesalahan.' });
  }

  function confirmPreview(data){
    const html = `
      <div style="text-align:left">
        <div><strong>Nama:</strong> ${data.firstName} ${data.lastName || ''}</div>
        <div><strong>Email:</strong> ${data.email}</div>
        <div><strong>Phone:</strong> ${data.phone}</div>
        <div><strong>Jenjang:</strong> ${data.educationLevel}</div>
        <div><strong>Sekolah Metro:</strong> ${data.metroSchoolName || '-'}</div>
        <div><strong>Minat khusus:</strong> ${data.description || '-'}</div>
      </div>`;
    return Swal.fire({
      title:'Kirim data ini?',
      html,
      icon:'question',
      showCancelButton:true,
      confirmButtonText:'Ya, kirim',
      cancelButtonText:'Periksa lagi'
    });
  }

  async function submitForm(e){
    e.preventDefault();
    const firstName = $('#firstName')?.value.trim();
    const lastName = $('#lastName')?.value.trim() || '';
    const email = $('#email')?.value.trim();
    const rawPhone = $('#phone')?.value;
    const educationLevel = document.querySelector('input[name="campus"]:checked')?.value;
    const description = $('#major')?.value.trim() || '';
    const consent = $('#consent')?.checked;
    const metroSchoolSelect = $('#metroSchoolSelect');
    const metroSchoolId = metroSchoolSelect?.value || null;
    const metroSchoolName = metroSchoolSelect?.dataset.name || '';

    const phone = normalizePhone(rawPhone);
    const msg = $('#formMsg');

    let err = '';
    if(!firstName) err='First name wajib diisi.';
    else if(!emailOk(email)) err='Format email tidak valid.';
    else if(!phone) err='Phone wajib diisi.';
    else if(!educationLevel) err='Pilih jenjang yang diminati.';
    else if(!consent) err='Harap centang persetujuan.';

    if(err){
      msg.textContent = err;
      msg.style.color = '#e11d48';
      return;
    } else msg.textContent='';

    const payload = {
      firstName,
      lastName,
      email,
      phone,
      educationLevel,
      description,
      metroSchoolId,   // dynamic value instead of static
      metroSchoolName, // for confirmation modal
    };

    const confirm = await confirmPreview(payload);
    if(!confirm.isConfirmed) return;

    try{
        showLoading();
        await api('/api/webtolead_school', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        Swal.close();
        Swal.fire({
            icon:'success',
            title:'Terima kasih!',
            text:'Data Anda telah dikirim. Kami akan segera menghubungi Anda.',
        }).then(()=>location.href='thankyou.html');
        }catch(e2){
        Swal.close();
        showError(e2.message);
        msg.textContent = e2.message || 'Gagal mengirim.';
        msg.style.color = '#e11d48';
        }
    }

 // ⬇️ Load the school list dynamically from Salesforce
    async function loadMetroSchools() {
    const list = document.querySelector('#metroSchoolList');
    const hiddenInput = document.querySelector('#metroSchoolSelect');
    if (!list) return;

    list.innerHTML = '<p>Loading data sekolah...</p>';

    try {
        const res = await fetch('/api/register-options-school?type=metroschool');
        const json = await res.json();

        if (json?.success && json.records?.length) {
        list.innerHTML = '';
        json.records.forEach((school) => {
            const div = document.createElement('div');
            div.className = 'metro-school-card';
            div.dataset.id = school.Id;
            div.dataset.name = school.Name;
            div.innerHTML = `
            <img src="https://picsum.photos/200?random=${encodeURIComponent(school.Id)}" alt="${school.Name}">
            <div class="metro-school-card-name">${school.Name}</div>
            `;
            div.addEventListener('click', () => {
            // remove previous selection
            list.querySelectorAll('.metro-school-card').forEach(c => c.classList.remove('selected'));
            // mark selected
            div.classList.add('selected');
            hiddenInput.value = school.Id;
            hiddenInput.dataset.name = school.Name;
            });
            list.appendChild(div);
        });
        } else {
        list.innerHTML = '<p>Tidak ada data sekolah</p>';
        }
    } catch (err) {
        console.error('Gagal memuat daftar sekolah:', err);
        list.innerHTML = '<p>Gagal memuat data sekolah</p>';
        }
    }

  document.addEventListener('DOMContentLoaded', ()=>{
    const form = $('#contactLite');
    form?.addEventListener('submit', submitForm);

    // 🔹 Load school options once the page loads
    loadMetroSchools();
  });
})();