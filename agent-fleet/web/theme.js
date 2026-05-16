'use strict';
// theme: switch between 5 themes via [data-theme] on <html> + localStorage.
(function () {
  const VALID = ['dark', 'light', 'solarized', 'nord', 'hi-contrast'];

  function applyTheme(name) {
    if (!VALID.includes(name)) name = 'dark';
    document.documentElement.setAttribute('data-theme', name);
    localStorage.fleetTheme = name;
    if (window.term && window.term.options) {
      const style = getComputedStyle(document.documentElement);
      const v = (k) => style.getPropertyValue(k).trim();
      window.term.options.theme = {
        background: v('--term-bg'), foreground: v('--term-fg'),
        black: v('--term-black'), red: v('--term-red'), green: v('--term-green'), yellow: v('--term-yellow'),
        blue: v('--term-blue'), magenta: v('--term-magenta'), cyan: v('--term-cyan'), white: v('--term-white'),
        brightBlack: v('--term-br-black'), brightRed: v('--term-br-red'), brightGreen: v('--term-br-green'),
        brightYellow: v('--term-br-yellow'), brightBlue: v('--term-br-blue'),
        brightMagenta: v('--term-br-magenta'), brightCyan: v('--term-br-cyan'), brightWhite: v('--term-br-white'),
      };
    }
  }

  function wireSwitcher() {
    const sel = document.getElementById('theme-select');
    if (!sel) return;
    sel.value = localStorage.fleetTheme || 'dark';
    sel.addEventListener('change', () => applyTheme(sel.value));
  }

  // Apply immediately on script load so no FOUC
  applyTheme(localStorage.fleetTheme || 'dark');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSwitcher);
  } else { wireSwitcher(); }

  window.fleetTheme = { apply: applyTheme, valid: VALID };
})();
