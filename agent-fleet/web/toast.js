'use strict';
// vt-0190: in-app notifications. Replaces alert() — non-blocking, styled,
// mobile-friendly, screen-reader announced via aria-live.
//
//   toast('saved')                           // info
//   toast.error('reveal failed: ' + err)
//   toast.warn('host went offline')
//   toast.success('secret rotated')
//   toast('undo me?', { action: { label: 'undo', onClick: () => ... }, ttlMs: 8000 })

(function () {
  let container = null;
  function ensure() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.id = 'toast-stack';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);
    return container;
  }
  function emit(message, opts = {}) {
    const { kind = 'info', ttlMs = 5000, action = null } = opts;
    const root = ensure();
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = String(message);
    el.appendChild(msg);
    if (action && action.label) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.onclick = () => {
        try { action.onClick?.(); } finally { dismiss(); }
      };
      el.appendChild(btn);
    }
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'dismiss');
    close.textContent = '×';
    close.onclick = dismiss;
    el.appendChild(close);
    root.appendChild(el);
    let timer = ttlMs > 0 ? setTimeout(dismiss, ttlMs) : null;
    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      el.classList.add('toast-leave');
      setTimeout(() => el.remove(), 200);
    }
    return { dismiss };
  }
  const toast = (msg, opts) => emit(msg, opts);
  toast.info    = (m, o) => emit(m, { ...(o || {}), kind: 'info' });
  toast.success = (m, o) => emit(m, { ...(o || {}), kind: 'success' });
  toast.warn    = (m, o) => emit(m, { ...(o || {}), kind: 'warn' });
  toast.error   = (m, o) => emit(m, { ...(o || {}), kind: 'error', ttlMs: 8000 });
  window.toast = toast;
})();

// vt-0190: confirmDialog + inputDialog — replace native confirm()/prompt().
// Returns a Promise resolving to {confirmed:bool, value?:string}.
//
//   const ok = await confirmDialog({ title:'Delete?', message:'…', danger:true });
//   const val = await inputDialog({ title:'Secret name', placeholder:'GH_TOKEN' });
//   const val = await inputDialog({ title:'Secret value', masked:true });

(function () {
  function basicDialog({ title, body, buttons }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'app-dialog-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const frame = document.createElement('div');
      frame.className = 'app-dialog-frame';
      if (title) {
        const h = document.createElement('div');
        h.className = 'app-dialog-title';
        h.textContent = title;
        frame.appendChild(h);
      }
      const bodyEl = document.createElement('div');
      bodyEl.className = 'app-dialog-body';
      bodyEl.appendChild(body);
      frame.appendChild(bodyEl);
      const btnRow = document.createElement('div');
      btnRow.className = 'app-dialog-buttons';
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.className = b.danger ? 'btn-danger' : (b.primary ? 'btn-primary' : 'btn-ghost');
        btn.textContent = b.label;
        btn.onclick = () => { cleanup(); resolve(b.value); };
        btnRow.appendChild(btn);
      }
      frame.appendChild(btnRow);
      overlay.appendChild(frame);
      function cleanup() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { cleanup(); resolve(buttons.find(b => b.cancel)?.value ?? null); }
        if (ev.key === 'Enter' && ev.target.tagName !== 'TEXTAREA') {
          const primary = buttons.find(b => b.primary);
          if (primary) { cleanup(); resolve(primary.value); }
        }
      }
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      // Focus first interactive child of body (input/textarea), else primary button.
      const focusable = bodyEl.querySelector('input,textarea') || btnRow.querySelector('.btn-primary, .btn-danger');
      focusable?.focus();
    });
  }
  window.confirmDialog = async function ({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
    const body = document.createElement('div');
    body.textContent = message;
    const choice = await basicDialog({
      title, body,
      buttons: [
        { label: cancelLabel, value: false, cancel: true },
        { label: confirmLabel, value: true, danger, primary: !danger },
      ],
    });
    return !!choice;
  };
  window.inputDialog = async function ({ title = 'Input', message = '', placeholder = '', initialValue = '', masked = false, confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
    const body = document.createElement('div');
    if (message) {
      const p = document.createElement('div');
      p.className = 'app-dialog-msg';
      p.textContent = message;
      body.appendChild(p);
    }
    const inp = document.createElement('input');
    inp.type = masked ? 'password' : 'text';
    inp.placeholder = placeholder || '';
    inp.value = initialValue || '';
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    inp.className = 'app-dialog-input';
    body.appendChild(inp);
    const choice = await basicDialog({
      title, body,
      buttons: [
        { label: cancelLabel, value: null, cancel: true },
        { label: confirmLabel, value: '__OK__', primary: true },
      ],
    });
    return choice === '__OK__' ? inp.value : null;
  };
})();
