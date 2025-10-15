// Fullscreen burger menu (stagger), smooth scroll, to-top, form demo, and carousel
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ===== Burger Overlay Menu ===== */
  const burger = $("#burgerBtn");
  const mega = $("#megaMenu");
  const backdrop = $("#megaBackdrop");

  const openMenu = () => {
    burger.classList.add("is-active");
    mega.classList.add("open");
    mega.setAttribute("aria-hidden", "false");
    burger.setAttribute("aria-expanded", "true");
    // focus first link for a11y
    const first = mega.querySelector(".mega__link");
    first && first.focus();
  };
  const closeMenu = () => {
    burger.classList.remove("is-active");
    mega.classList.remove("open");
    mega.setAttribute("aria-hidden", "true");
    burger.setAttribute("aria-expanded", "false");
    burger.focus();
  };

  burger?.addEventListener("click", () => {
    mega.classList.contains("open") ? closeMenu() : openMenu();
  });
  backdrop?.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mega.classList.contains("open")) closeMenu();
  });
  // Close when click any link
  $$(".mega__link").forEach((a) =>
    a.addEventListener("click", () => closeMenu())
  );

  /* ===== Smooth scroll for internal links ===== */
  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (!id || id === "#") return;
      const el = $(id);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.pushState({}, "", id);
      }
    });
  });

  /* ===== Back to top ===== */
  const toTop = $("#toTop");
  const onScroll = () => {
    window.scrollY > 600
      ? toTop.classList.add("show")
      : toTop.classList.remove("show");
  };
  window.addEventListener("scroll", onScroll);
  toTop?.addEventListener("click", () =>
    window.scrollTo({ top: 0, behavior: "smooth" })
  );

  /* ===== Form (demo) ===== */
  const form = $("#contactLite");
  const msg = $("#formMsg");
  const normalizePhone = (el) => {
    const digits = el.value.trim().replace(/[^\d]/g, "");
    if (!digits) return "";
    if (digits.startsWith("62")) return `+${digits}`;
    if (digits.startsWith("0")) return `+62${digits.slice(1)}`;
    return `+62${digits}`;
  };
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    msg.textContent = "";

    const first = $("#firstName").value.trim();
    const last = $("#lastName").value.trim();
    const email = $("#email").value.trim();
    const phone = normalizePhone($("#phone"));
    const campus = (form.querySelector('input[name="campus"]:checked') || {})
      .value;
    const major = $("#major").value.trim();
    const consent = $("#consent").checked;

    const errors = [];
    if (!first) errors.push("First name wajib diisi.");
    if (!email || !validEmail(email)) errors.push("Email tidak valid.");
    if (!campus) errors.push("Pilih jenjang.");
    if (!consent) errors.push("Centang persetujuan.");
    if (!phone || phone.replace(/\D/g, "").length < 11)
      errors.push("Nomor HP terlalu pendek.");

    if (errors.length) {
      msg.textContent = errors.join(" ");
      msg.style.color = "#c53030";
      return;
    }

    const preview = [
      `Nama: ${first} ${last}`.trim(),
      `Email: ${email}`,
      `Phone: ${phone}`,
      `Jenjang: ${campus}`,
      major ? `Minat: ${major}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    msg.style.color = "#0C7A59";
    msg.textContent = `Terkirim (demo): ${preview}`;
    form.reset();
    msg.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  /* ===== Simple Carousel (auto + controls + swipe) ===== */
  const viewport = $("#carouselViewport");
  const slides = $$(".slide", viewport);
  const prev = $("#prevSlide");
  const next = $("#nextSlide");
  const dotsWrap = $("#carouselDots");

  if (viewport && slides.length) {
    let index = 0,
      timer;

    slides.forEach((_, i) => {
      const b = document.createElement("button");
      b.setAttribute("aria-label", `Slide ${i + 1}`);
      b.addEventListener("click", () => go(i, true));
      dotsWrap.appendChild(b);
    });

    const setActive = () => {
      viewport.style.transform = `translateX(${-index * 100}%)`;
      const dots = $$("#carouselDots button");
      dots.forEach((d, i) =>
        d.setAttribute("aria-current", i === index ? "true" : "false")
      );
    };

    const go = (i, user = false) => {
      index = (i + slides.length) % slides.length;
      setActive();
      if (user) restart();
    };

    const nextFn = () => go(index + 1);
    const prevFn = () => go(index - 1);

    next?.addEventListener("click", () => nextFn());
    prev?.addEventListener("click", () => prevFn());

    const start = () => {
      timer = setInterval(nextFn, 5000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
    };
    const restart = () => {
      stop();
      start();
    };

    viewport.addEventListener("mouseenter", stop);
    viewport.addEventListener("mouseleave", start);
    viewport.addEventListener("focusin", stop);
    viewport.addEventListener("focusout", start);

    let startX = 0,
      dx = 0;
    viewport.addEventListener(
      "touchstart",
      (e) => {
        startX = e.touches[0].clientX;
        stop();
      },
      { passive: true }
    );
    viewport.addEventListener(
      "touchmove",
      (e) => {
        dx = e.touches[0].clientX - startX;
      },
      { passive: true }
    );
    viewport.addEventListener("touchend", () => {
      if (Math.abs(dx) > 50) dx < 0 ? nextFn() : prevFn();
      dx = 0;
      start();
    });

    setActive();
    start();
  }
})();
