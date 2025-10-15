// ========= helpers =========
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// ========= burger menu (fixed overlay) =========
(() => {
  const toggle = $(".nav-toggle");
  const menu = $("#navMenu");
  if (!toggle || !menu) return;

  const close = () => {
    menu.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    document.documentElement.style.removeProperty("--freeze");
    document.body.style.overflow = "auto";
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    document.documentElement.style.setProperty(
      "--freeze",
      open ? "hidden" : "auto"
    );
    document.body.style.overflow = open ? "var(--freeze)" : "auto";
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && !toggle.contains(e.target)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();

// ========= HERO gallery strip (auto-scroll infinite) =========
(() => {
  const strip = $(".strip");
  if (!strip) return;

  const viewport = strip.parentElement;
  let offset = 0;
  let paused = false;

  // duplicate a few children for seamless loop
  Array.from(strip.children)
    .slice(0, 3)
    .forEach((n) => strip.appendChild(n.cloneNode(true)));

  const step = () => {
    if (!paused) {
      offset -= 0.3;
      strip.style.transform = `translateX(${offset}px)`;

      const first = strip.firstElementChild;
      if (first) {
        const firstRect = first.getBoundingClientRect();
        const viewRect = viewport.getBoundingClientRect();
        if (firstRect.right < viewRect.left) {
          strip.appendChild(first);
          offset += firstRect.width + 12; // 12 = gap
          strip.style.transform = `translateX(${offset}px)`;
        }
      }
    }
    requestAnimationFrame(step);
  };

  strip.addEventListener("mouseenter", () => (paused = true));
  strip.addEventListener("mouseleave", () => (paused = false));

  requestAnimationFrame(step);
})();

// ========= stats counter on scroll =========
(() => {
  const counters = $$(".stat-num");
  if (!counters.length) return;

  const animate = (el) => {
    const target = Number(el.getAttribute("data-count") || "0");
    const dur = 900;
    const start = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      const val = Math.floor(target * (1 - Math.pow(1 - p, 3)));
      el.textContent = val.toLocaleString("id-ID");
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          animate(e.target);
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.4 }
  );

  counters.forEach((c) => io.observe(c));
})();

// ========= initiatives modal =========
(() => {
  const modal = $("#initModal");
  const title = $("#modalTitle");
  const desc = $("#modalDesc");
  const photos = $("#modalPhotos");
  const closeBtn = modal?.querySelector(".modal-close");
  if (!modal || !title || !desc || !photos) return;

  const openModal = (card) => {
    title.textContent = card.dataset.title || "Program";
    desc.textContent = card.dataset.desc || "";
    photos.innerHTML = "";

    const list = (card.dataset.photos || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    list.slice(0, 6).forEach((src) => {
      const img = new Image();
      img.loading = "lazy";
      img.src = src;
      img.alt = `Foto ${title.textContent}`;
      photos.appendChild(img);
    });

    modal.showModal();
  };

  $$(".init-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      const isBtn = e.target.closest?.(".link-more");
      if (isBtn || e.currentTarget === card) openModal(card);
    });
    card.addEventListener("keypress", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openModal(card);
      }
    });
  });

  closeBtn?.addEventListener("click", () => modal.close());
  modal.addEventListener("click", (e) => {
    const rect = modal.querySelector(".modal-body")?.getBoundingClientRect();
    if (!rect) return;
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) modal.close();
  });
})();

// ========= gallery carousel =========
(() => {
  const track = $(".car-track");
  const btnPrev = $(".car-btn.prev");
  const btnNext = $(".car-btn.next");
  if (!track || !btnPrev || !btnNext) return;

  let index = 0;
  const items = $$(".car-item", track);

  const update = () => {
    track.style.transform = `translateX(${-index * 100}%)`;
  };

  btnPrev.addEventListener("click", () => {
    index = (index - 1 + items.length) % items.length;
    update();
  });
  btnNext.addEventListener("click", () => {
    index = (index + 1) % items.length;
    update();
  });

  // swipe
  let startX = 0,
    dx = 0;
  track.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
      dx = 0;
    },
    { passive: true }
  );
  track.addEventListener(
    "touchmove",
    (e) => {
      dx = e.touches[0].clientX - startX;
    },
    { passive: true }
  );
  track.addEventListener("touchend", () => {
    if (dx > 40) btnPrev.click();
    else if (dx < -40) btnNext.click();
  });

  update(); // tampilkan slide pertama
})();

// ========= footer year =========
(() => {
  const y = document.getElementById("y");
  if (y) y.textContent = String(new Date().getFullYear());
})();
