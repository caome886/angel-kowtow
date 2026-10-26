(() => {
  "use strict";

  const API = "https://abacus.jasoncameron.dev";
  const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.local)$/i.test(location.hostname) || location.protocol === "file:";
  const NAMESPACE = IS_LOCAL ? "xiaotianshi-kowtow-dev" : "xiaotianshi-kowtow-shrine";
  const CACHE_KEY = "angel-kowtow-cache-v1";
  const SOUND_KEY = "angel-kowtow-sound";
  const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const COUNT_FORMAT = new Intl.NumberFormat("zh-CN");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const stage = document.getElementById("stage");
  const avatar = document.getElementById("avatar");
  const halo = document.querySelector(".halo");
  const impact = document.getElementById("impact");
  const particles = document.getElementById("particles");
  const ripples = document.getElementById("ripples");
  const tapChip = document.getElementById("tapChip");
  const totalEl = document.getElementById("total");
  const todayEl = document.getElementById("today");
  const scopeEl = document.getElementById("scope");
  const totalNoteEl = document.getElementById("totalNote");
  const todayDateEl = document.getElementById("todayDate");
  const soundBtn = document.getElementById("soundBtn");

  const state = {
    total: 0,
    today: 0,
    day: dayKey(),
    scope: "sync"
  };

  let soundOn = true;
  let audioContext = null;
  let lastSync = 0;
  let lastKnockAt = 0;
  let hasKnocked = false;

  function dayKey(date = new Date()) {
    const parts = {};
    for (const part of DAY_FORMAT.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return `${parts.year}${parts.month}${parts.day}`;
  }

  function dayLabel(date = new Date()) {
    const parts = {};
    for (const part of DAY_FORMAT.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return `${Number(parts.month)}.${String(parts.day).padStart(2, "0")}`;
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw);
      state.total = safeNumber(cached.total);
      state.day = typeof cached.day === "string" ? cached.day : state.day;
      state.today = state.day === dayKey() ? safeNumber(cached.today) : 0;
      if (cached.scope === "global" || cached.scope === "local") state.scope = cached.scope;
    } catch {
      /* A broken cache should never stop the page. */
    }
  }

  function saveCache() {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          total: state.total,
          today: state.today,
          day: state.day,
          scope: state.scope === "sync" ? "local" : state.scope
        })
      );
    } catch {
      /* Private browsing can reject storage; counters still work for this visit. */
    }
  }

  function formatCount(value) {
    const number = safeNumber(value);
    if (number < 1_000_000) return COUNT_FORMAT.format(number);
    if (number < 100_000_000) {
      const tenThousands = number / 10_000;
      return `${tenThousands.toFixed(tenThousands < 100 ? 1 : 0).replace(/\.0$/, "")}万`;
    }
    const hundredMillions = number / 100_000_000;
    return `${hundredMillions.toFixed(1).replace(/\.0$/, "")}亿`;
  }

  function setScope(scope) {
    if (state.scope === scope) return;
    state.scope = scope;
    updateScopeUI();
    saveCache();
  }

  function updateScopeUI() {
    const labels = {
      global: "全世界",
      local: "本机",
      sync: "连接中"
    };
    scopeEl.classList.toggle("is-local", state.scope !== "global");
    scopeEl.innerHTML = `<i></i>${labels[state.scope] || labels.local}`;

    if (state.scope === "global") {
      totalNoteEl.textContent = "和所有来访的人一起磕";
      scopeEl.title = "累计求数与所有来访者共享";
    } else if (state.scope === "local") {
      totalNoteEl.textContent = "网络未连接，先记在本机";
      scopeEl.title = "暂时无法连接祈愿所，数字先存在本机";
    } else {
      totalNoteEl.textContent = "正在连接祈愿所…";
      scopeEl.title = "正在同步";
    }
  }

  function render(animate = false) {
    const totalText = formatCount(state.total);
    const todayText = formatCount(state.today);

    if (totalEl.textContent !== totalText) {
      totalEl.textContent = totalText;
      if (animate) bump(totalEl);
    }
    if (todayEl.textContent !== todayText) {
      todayEl.textContent = todayText;
      if (animate) bump(todayEl);
    }
    todayDateEl.textContent = dayLabel();
    updateScopeUI();
  }

  function bump(el) {
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }

  function rolloverDay() {
    const currentDay = dayKey();
    if (currentDay === state.day) return false;
    state.day = currentDay;
    state.today = 0;
    render(false);
    saveCache();
    syncCounters();
    return true;
  }

  function fetchWithTimeout(url, timeout = 6500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" }
    }).finally(() => clearTimeout(timer));
  }

  async function apiGet(key) {
    const response = await fetchWithTimeout(`${API}/get/${NAMESPACE}/${key}`);
    if (response.status === 404) return 0;
    if (!response.ok) throw new Error(`Counter get failed: ${response.status}`);
    const data = await response.json();
    return safeNumber(data.value);
  }

  async function apiHit(key) {
    const response = await fetchWithTimeout(`${API}/hit/${NAMESPACE}/${key}`);
    if (!response.ok) throw new Error(`Counter hit failed: ${response.status}`);
    const data = await response.json();
    return safeNumber(data.value);
  }

  async function syncCounters() {
    if (!navigator.onLine) {
      setScope("local");
      return;
    }

    const requestedDay = state.day;
    const [totalResult, todayResult] = await Promise.allSettled([
      apiGet("all"),
      apiGet(`day-${requestedDay}`)
    ]);

    if (totalResult.status === "fulfilled") {
      state.total = Math.max(state.total, totalResult.value);
      setScope("global");
    } else {
      setScope("local");
    }

    if (todayResult.status === "fulfilled" && state.day === requestedDay) {
      state.today = Math.max(state.today, todayResult.value);
    }

    lastSync = Date.now();
    saveCache();
    render(false);
  }

  async function syncTotalOnly() {
    if (!navigator.onLine) return;
    try {
      const value = await apiHit("all");
      state.total = Math.max(state.total, value);
      setScope("global");
      saveCache();
      render(true);
    } catch {
      setScope("local");
    }
  }

  async function syncTodayOnly(day) {
    if (!navigator.onLine) return;
    try {
      const value = await apiHit(`day-${day}`);
      if (state.day !== day) return;
      state.today = Math.max(state.today, value);
      saveCache();
      render(true);
    } catch {
      /* The total counter already communicates connection trouble. */
    }
  }

  function knock() {
    const now = performance.now();
    if (now - lastKnockAt < 60) return;
    lastKnockAt = now;

    if (rolloverDay()) {
      /* The new day has been prepared before adding this tap. */
    }

    state.total += 1;
    state.today += 1;
    saveCache();
    render(true);

    bow();
    makeRipples();
    makeParticles();
    playKnock();
    vibrate();

    if (!hasKnocked) {
      hasKnocked = true;
      tapChip.classList.add("is-used");
    }

    if (navigator.onLine) {
      const tappedDay = state.day;
      syncTotalOnly();
      syncTodayOnly(tappedDay);
    } else {
      setScope("local");
    }
  }

  function bow() {
    if (reduceMotion.matches || typeof avatar.animate !== "function") return;

    if (typeof avatar.getAnimations === "function") {
      avatar.getAnimations().forEach((animation) => animation.cancel());
    }
    avatar.animate(
      [
        { transform: "translateY(0) rotate(0deg) scale(1)" },
        { transform: "translateY(-7px) rotate(-2.2deg) scale(1.012)", offset: 0.2 },
        { transform: "translateY(13px) rotate(7.5deg) scale(0.964)", offset: 0.5 },
        { transform: "translateY(7px) rotate(3.2deg) scale(0.984)", offset: 0.7 },
        { transform: "translateY(0) rotate(0deg) scale(1)" }
      ],
      {
        duration: 620,
        easing: "cubic-bezier(.2,.72,.28,1)"
      }
    );

    if (halo && typeof halo.animate === "function") {
      if (typeof halo.getAnimations === "function") {
        halo.getAnimations().forEach((animation) => animation.cancel());
      }
      halo.animate(
        [
          { opacity: 0.8, transform: "translate(-50%, -51%) scale(0.98)" },
          { opacity: 1, transform: "translate(-50%, -51%) scale(1.06)", offset: 0.42 },
          { opacity: 0.8, transform: "translate(-50%, -51%) scale(0.98)" }
        ],
        { duration: 620, easing: "ease-out" }
      );
    }

    impact.classList.remove("go");
    void impact.offsetWidth;
    impact.classList.add("go");
  }

  function makeRipples() {
    if (reduceMotion.matches) return;
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripples.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 760);
  }

  function makeParticles() {
    if (reduceMotion.matches) return;

    const glyphs = ["♡", "✦", "+1", "愿", "✧", "♡"];
    const colors = ["#dd8ba4", "#b9a8dd", "#e4b876", "#e79ab0", "#a99bd2"];

    for (let index = 0; index < 7; index += 1) {
      const particle = document.createElement("span");
      const glyph = glyphs[Math.floor(Math.random() * glyphs.length)];
      particle.className = "particle";
      particle.textContent = glyph;
      particle.style.left = `${46 + Math.random() * 10}%`;
      particle.style.top = `${30 + Math.random() * 14}%`;
      particle.style.fontSize = `${11 + Math.random() * 10}px`;
      particle.style.color = colors[Math.floor(Math.random() * colors.length)];
      particle.style.setProperty("--dx", `${(Math.random() - 0.5) * 150}px`);
      particle.style.setProperty("--dy", `${-45 - Math.random() * 105}px`);
      particle.style.setProperty("--rot", `${(Math.random() - 0.5) * 90}deg`);
      particle.style.setProperty("--scale", `${0.8 + Math.random() * 0.55}`);
      particle.style.animationDelay = `${Math.random() * 70}ms`;
      particles.appendChild(particle);
      window.setTimeout(() => particle.remove(), 1150);
    }
  }

  function vibrate() {
    if (typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(9);
      } catch {
        /* Some browsers expose vibrate but refuse it. */
      }
    }
  }

  function ensureAudio() {
    if (!soundOn) return null;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume();
    return audioContext;
  }

  function playKnock() {
    if (!soundOn) return;
    const context = ensureAudio();
    if (!context) return;

    const now = context.currentTime;
    const thump = context.createOscillator();
    const thumpGain = context.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(148, now);
    thump.frequency.exponentialRampToValueAtTime(54, now + 0.17);
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.17, now + 0.008);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.21);
    thump.connect(thumpGain);
    thumpGain.connect(context.destination);
    thump.start(now);
    thump.stop(now + 0.23);

    const bell = context.createOscillator();
    const bellGain = context.createGain();
    bell.type = "triangle";
    bell.frequency.setValueAtTime(1046, now + 0.04);
    bellGain.gain.setValueAtTime(0.0001, now + 0.04);
    bellGain.gain.exponentialRampToValueAtTime(0.022, now + 0.055);
    bellGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    bell.connect(bellGain);
    bellGain.connect(context.destination);
    bell.start(now + 0.04);
    bell.stop(now + 0.35);
  }

  function setSound(on) {
    soundOn = on;
    document.body.classList.toggle("sound-off", !on);
    soundBtn.setAttribute("aria-pressed", String(on));
    soundBtn.setAttribute("aria-label", on ? "关闭音效" : "打开音效");
    try {
      localStorage.setItem(SOUND_KEY, on ? "on" : "off");
    } catch {
      /* Ignore storage failures. */
    }
    if (on) playKnock();
  }

  function initSound() {
    try {
      soundOn = localStorage.getItem(SOUND_KEY) !== "off";
    } catch {
      soundOn = true;
    }
    document.body.classList.toggle("sound-off", !soundOn);
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.setAttribute("aria-label", soundOn ? "关闭音效" : "打开音效");
  }

  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    knock();
  });

  stage.addEventListener("click", (event) => {
    /* Keyboard and assistive-technology activation arrives as a detail-0 click. */
    if (event.detail === 0) knock();
  });

  stage.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter" || event.key === "Spacebar") {
      event.preventDefault();
      knock();
    }
  });

  soundBtn.addEventListener("click", () => setSound(!soundOn));

  window.addEventListener("offline", () => setScope("local"));
  window.addEventListener("online", () => {
    setScope("sync");
    syncCounters();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    rolloverDay();
    if (Date.now() - lastSync > 60_000) syncCounters();
  });

  window.setInterval(rolloverDay, 30_000);

  loadCache();
  initSound();
  render(false);
  syncCounters();
})();
