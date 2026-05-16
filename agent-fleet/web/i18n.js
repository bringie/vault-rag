'use strict';
// i18n hybrid: HTML uses data-i18n attrs, JS uses t(key, vars).
// Fallback: dict (current lang) → dictBase (en) → key string.
(function () {
  const VALID = ['en', 'ru', 'es'];
  const state = { lang: 'en', dict: {}, dictBase: {} };

  async function fetchDict(lang) {
    const res = await fetch(`/fleet/static/i18n/${lang}.json`);
    if (!res.ok) throw new Error('' + res.status);
    return await res.json();
  }

  async function loadLang(lang) {
    if (!VALID.includes(lang)) lang = 'en';
    if (!Object.keys(state.dictBase).length) {
      try { state.dictBase = await fetchDict('en'); }
      catch (e) { console.warn(`[i18n] base en load failed: ${e.message}`); }
    }
    if (lang === 'en') {
      state.dict = state.dictBase;
    } else {
      try { state.dict = await fetchDict(lang); }
      catch (e) {
        console.warn(`[i18n] load ${lang} failed: ${e.message}; using en`);
        state.dict = state.dictBase;
      }
    }
    state.lang = lang;
    localStorage.fleetLang = lang;
    document.documentElement.setAttribute('data-lang', lang);
    applyI18n();
    // Notify dynamic renderers (inspector, run viewer, etc.) to redraw.
    window.dispatchEvent(new CustomEvent('fleet-langchange', { detail: { lang } }));
  }

  function t(key, vars) {
    let s = state.dict[key] || state.dictBase[key] || key;
    if (vars) for (const k in vars) s = s.replace(`{${k}}`, String(vars[k]));
    return s;
  }

  function applyI18n(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.dataset.i18n;
      if (k) el.textContent = t(k);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const k = el.dataset.i18nPlaceholder;
      if (k) el.placeholder = t(k);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const k = el.dataset.i18nTitle;
      if (k) el.title = t(k);
    });
  }

  function wireSwitcher() {
    const sel = document.getElementById('lang-select');
    if (!sel) return;
    sel.value = state.lang;
    sel.addEventListener('change', () => loadLang(sel.value));
  }

  window.fleetI18n = { t, loadLang, applyI18n, current: () => state.lang, wireSwitcher };
})();
