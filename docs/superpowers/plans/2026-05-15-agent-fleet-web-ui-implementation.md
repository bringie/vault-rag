# Agent Fleet Web UI Implementation Plan

**Goal:** Build the single-page split-pane web UI for agent-fleet (sub-project #2).

**Spec:** `docs/superpowers/specs/2026-05-15-agent-fleet-web-ui-design.md`

## Tasks

1. Vendor xterm.js + addon-fit (download to `agent-fleet/web/`)
2. `scripts/lib/fleet-static.js` — static file server hook + test
3. Wire static handler into `fleet-routes.dispatchHttp` (before auth check for GET /fleet/ and /fleet/static/*)
4. `agent-fleet/web/index.html` — split-pane skeleton
5. `agent-fleet/web/app.css` — layout (CSS grid) + dark theme + mobile media query
6. `agent-fleet/web/app.js` — auth, polling, WS viewer, xterm init, spawn form
7. Manual smoke against local rag-api + browser

## Task 1: Vendor xterm.js

```bash
mkdir -p agent-fleet/web
cd agent-fleet/web
curl -fsSL -o xterm.min.js     https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js
curl -fsSL -o xterm.min.css    https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css
curl -fsSL -o xterm-fit.min.js https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js
ls -la *.min.*
git add agent-fleet/web/xterm.min.js agent-fleet/web/xterm.min.css agent-fleet/web/xterm-fit.min.js
git commit -m "feat(agent-fleet-web): vendor xterm.js v5.5 + fit addon"
```

## Task 2: fleet-static.js

Create `scripts/lib/fleet-static.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WEB_DIR = path.resolve(__dirname, '..', '..', 'agent-fleet', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serve(req, res) {
  let rel;
  if (req.url === '/fleet/' || req.url === '/fleet') {
    rel = 'index.html';
  } else if (req.url.startsWith('/fleet/static/')) {
    rel = req.url.slice('/fleet/static/'.length);
  } else {
    return false;
  }
  // sanitise
  if (rel.includes('..') || rel.startsWith('/')) {
    res.writeHead(400); res.end('bad path'); return true;
  }
  const abs = path.join(WEB_DIR, rel);
  if (!abs.startsWith(WEB_DIR)) { res.writeHead(400); res.end('bad path'); return true; }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) { res.writeHead(404); res.end('not found'); return true; }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache' });
    fs.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404); res.end('not found');
  }
  return true;
}

module.exports = { serve, WEB_DIR };
```

Test `scripts/lib/fleet-static.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fleetStatic = require('./fleet-static');

async function startServer() {
  const server = http.createServer((req, res) => {
    if (fleetStatic.serve(req, res)) return;
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}

async function getRaw(server, path) {
  const port = server.address().port;
  return new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
  });
}

test('serves /fleet/ as index.html', async () => {
  fs.mkdirSync(path.join(fleetStatic.WEB_DIR), { recursive: true });
  fs.writeFileSync(path.join(fleetStatic.WEB_DIR, 'index.html'), '<html>ok</html>');
  const s = await startServer();
  const r = await getRaw(s, '/fleet/');
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith('text/html'));
  assert.ok(r.body.toString().includes('<html>'));
  s.close();
});

test('serves /fleet/static/file.js', async () => {
  fs.writeFileSync(path.join(fleetStatic.WEB_DIR, 'app.js'), 'console.log(1)');
  const s = await startServer();
  const r = await getRaw(s, '/fleet/static/app.js');
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith('application/javascript'));
  s.close();
});

test('rejects path traversal', async () => {
  const s = await startServer();
  const r = await getRaw(s, '/fleet/static/../../etc/passwd');
  assert.equal(r.status, 400);
  s.close();
});
```

Run: `cd scripts && node --test lib/fleet-static.test.js`

## Task 3: Wire static into fleet-routes

In `fleet-routes.js`, modify `dispatchHttp`:

```js
const fleetStatic = require('./fleet-static');

function dispatchHttp(req, res, ctx) {
  const method = req.method;
  const path = req.url.split('?')[0];

  // Static + index served before auth (page is public; APIs still gated)
  if (method === 'GET' && (path === '/fleet/' || path === '/fleet' || path.startsWith('/fleet/static/'))) {
    if (fleetStatic.serve(req, res)) return;
  }
  // healthz before auth
  if (method === 'GET' && path === '/fleet/healthz') {
    return send(res, 200, { ok: true });
  }
  if (!checkAuth(req, ctx.token)) return send(res, 401, { error: 'unauthorized' });
  // ... rest unchanged
```

Test that `curl http://localhost:15679/fleet/` returns HTML once index.html is written.

## Task 4: index.html

`agent-fleet/web/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agent-fleet</title>
  <link rel="stylesheet" href="/fleet/static/xterm.min.css">
  <link rel="stylesheet" href="/fleet/static/app.css">
</head>
<body>
  <div id="auth-prompt" hidden>
    <h2>token</h2>
    <input id="token-input" type="password" placeholder="VAULT_RAG_API_TOKEN">
    <button id="token-save">save</button>
  </div>
  <div id="app" hidden>
    <header>
      <strong>agent-fleet</strong>
      <span id="summary">…</span>
      <button id="reload">⟳</button>
      <button id="logout">logout</button>
    </header>
    <main>
      <aside id="sidebar">
        <section><h3>hosts</h3><ul id="hosts"></ul></section>
        <section><h3>sessions</h3><ul id="sessions"></ul></section>
        <section id="spawn">
          <h3>spawn</h3>
          <select id="spawn-host"></select>
          <input id="spawn-args" placeholder="--print 'hi'">
          <button id="spawn-btn">spawn</button>
        </section>
      </aside>
      <section id="viewer">
        <div id="vheader"><span id="vtitle">no session selected</span>
          <button id="vkill" disabled>kill</button>
        </div>
        <div id="term"></div>
      </section>
    </main>
  </div>
  <script src="/fleet/static/xterm.min.js"></script>
  <script src="/fleet/static/xterm-fit.min.js"></script>
  <script src="/fleet/static/app.js"></script>
</body>
</html>
```

## Task 5: app.css

`agent-fleet/web/app.css`:

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-monospace, monospace; background: #0e0e10; color: #ddd; }
#app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
header { display: flex; gap: 1em; padding: .5em 1em; background: #18181b; border-bottom: 1px solid #333; align-items: center; }
header button { background: #333; color: #eee; border: 0; padding: .3em .8em; cursor: pointer; border-radius: 3px; }
main { display: grid; grid-template-columns: 280px 1fr; overflow: hidden; }
#sidebar { padding: 1em; border-right: 1px solid #333; overflow-y: auto; }
#sidebar h3 { margin: 1em 0 .5em; font-size: .8em; color: #888; text-transform: uppercase; }
#sidebar ul { list-style: none; padding: 0; margin: 0; }
#sidebar li { padding: .3em .5em; cursor: pointer; border-radius: 3px; font-size: .9em; }
#sidebar li:hover { background: #222; }
#sidebar li.active { background: #2a4365; }
#sidebar li .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%; margin-right: .4em; }
#sidebar li .dot.on { background: #4ade80; }
#sidebar li .dot.off { background: #555; }
#spawn input, #spawn select { width: 100%; padding: .3em; margin-bottom: .3em; background: #222; color: #ddd; border: 1px solid #333; }
#spawn button { width: 100%; padding: .4em; background: #2a4365; color: #fff; border: 0; cursor: pointer; }
#viewer { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
#vheader { padding: .5em 1em; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
#vkill { background: #c53030; color: #fff; border: 0; padding: .3em .8em; cursor: pointer; }
#term { padding: .5em; overflow: hidden; }
.session-exited #term { opacity: .5; }
#auth-prompt { padding: 4em; text-align: center; }
#auth-prompt input { width: 24em; padding: .5em; background: #222; color: #ddd; border: 1px solid #333; }
@media (max-width: 768px) {
  main { grid-template-columns: 1fr; }
  #sidebar { position: fixed; inset: 3em 0 auto 0; background: #18181b; z-index: 10; max-height: 50vh; display: none; }
  #sidebar.open { display: block; }
}
```

## Task 6: app.js

`agent-fleet/web/app.js`:

```js
'use strict';
(() => {
  const state = {
    token: null,
    hosts: [],
    sessions: [],
    selected: null,
    ws: null,
    term: null,
    fit: null,
    pollTimer: null,
    backoff: 1000,
  };

  // --- Auth ---
  function readToken() {
    const frag = location.hash.match(/token=([^&]+)/);
    if (frag) {
      localStorage.fleetToken = decodeURIComponent(frag[1]);
      history.replaceState(null, '', location.pathname);
    }
    state.token = localStorage.fleetToken || null;
  }
  function showAuth() {
    document.getElementById('auth-prompt').hidden = false;
    document.getElementById('app').hidden = true;
    document.getElementById('token-save').onclick = () => {
      const v = document.getElementById('token-input').value.trim();
      if (v) { localStorage.fleetToken = v; location.reload(); }
    };
  }
  function showApp() {
    document.getElementById('auth-prompt').hidden = true;
    document.getElementById('app').hidden = false;
    document.getElementById('logout').onclick = () => { localStorage.removeItem('fleetToken'); location.reload(); };
  }

  // --- API ---
  async function api(method, path, body) {
    const r = await fetch('/api/fleet' + path, {
      method, headers: {
        'authorization': 'Bearer ' + state.token,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { localStorage.removeItem('fleetToken'); location.reload(); throw new Error('auth'); }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    if (r.status === 204) return null;
    return r.json();
  }

  // --- Render ---
  function render() {
    document.getElementById('summary').textContent =
      `${state.hosts.length} hosts · ${state.sessions.filter(s => s.status === 'running').length} active`;
    const hostsUl = document.getElementById('hosts');
    hostsUl.innerHTML = state.hosts.map(h => {
      const n = state.sessions.filter(s => s.host_id === h.id && s.status === 'running').length;
      return `<li data-host="${h.id}"><span class="dot ${h.status === 'online' ? 'on' : 'off'}"></span>${escapeHtml(h.name)} (${n})</li>`;
    }).join('');
    const sessUl = document.getElementById('sessions');
    sessUl.innerHTML = state.sessions.slice(0, 30).map(s => {
      const host = state.hosts.find(h => h.id === s.host_id);
      const icon = s.status === 'running' ? '▶' : s.status === 'exited' ? '◇' : s.status === 'killed' ? '✕' : '·';
      const active = s.id === state.selected ? ' class="active"' : '';
      return `<li data-session="${s.id}"${active}>${icon} ${s.id.slice(0,8)}… ${escapeHtml(host?.name || '?')}</li>`;
    }).join('');
    const hostSel = document.getElementById('spawn-host');
    const cur = hostSel.value;
    hostSel.innerHTML = state.hosts.map(h => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join('');
    if (cur && [...hostSel.options].some(o => o.value === cur)) hostSel.value = cur;

    sessUl.querySelectorAll('li').forEach(li => {
      li.onclick = () => attachSession(li.dataset.session);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // --- Polling ---
  async function refresh() {
    try {
      const [hosts, sessions] = await Promise.all([api('GET', '/hosts'), api('GET', '/sessions')]);
      state.hosts = hosts;
      state.sessions = sessions;
      render();
    } catch (e) { console.error('refresh', e); }
  }
  function startPolling() {
    refresh();
    state.pollTimer = setInterval(refresh, 5000);
  }

  // --- Terminal + WS ---
  function attachSession(id) {
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    if (state.term) { state.term.dispose(); state.term = null; }
    state.selected = id;
    render();
    document.getElementById('vtitle').textContent = `attaching ${id.slice(0,8)}…`;
    document.getElementById('vkill').disabled = false;
    document.getElementById('vkill').onclick = () => api('POST', `/sessions/${id}/kill`, {});

    const term = new Terminal({ cursorBlink: true, theme: { background: '#0e0e10' } });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById('term'));
    state.term = term; state.fit = fit;
    setTimeout(() => fit.fit(), 50);
    new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe(document.getElementById('term'));

    connectWs(id);

    term.onData(d => {
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'input', data: d }));
      }
    });
  }
  function connectWs(id) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/fleet/ws?role=viewer&session_id=${id}`;
    // Bearer in header isn't possible via browser WS; pass via subprotocol or query (existing server reads header).
    // Workaround: temporary cookie? For MVP, pass token via Sec-WebSocket-Protocol.
    const ws = new WebSocket(url, ['bearer.' + state.token]);
    state.ws = ws;
    ws.onmessage = (e) => {
      let f;
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.type === 'hello') {
        document.getElementById('vtitle').textContent = `${id.slice(0,8)}… on ${shortHostName(f.host_id)} · ${f.status}`;
      } else if (f.type === 'backfill') {
        state.term.write(atob(f.data));
      } else if (f.type === 'pty_data') {
        state.term.write(atob(f.data));
      } else if (f.type === 'session_exit') {
        document.getElementById('viewer').classList.add('session-exited');
        state.term.write(`\r\n\x1b[33m[session exited code=${f.exit_code}]\x1b[0m\r\n`);
      }
    };
    ws.onclose = () => {
      if (state.selected === id) {
        setTimeout(() => connectWs(id), Math.min(state.backoff *= 2, 8000));
      } else { state.backoff = 1000; }
    };
    ws.onopen = () => { state.backoff = 1000; };
  }
  function shortHostName(host_id) {
    const h = state.hosts.find(x => x.id === host_id);
    return h ? h.name : host_id.slice(0,8);
  }

  // --- Spawn form ---
  document.getElementById('spawn-btn').onclick = async () => {
    const host_id = document.getElementById('spawn-host').value;
    const argsStr = document.getElementById('spawn-args').value.trim();
    const args = argsStr ? argsStr.match(/(?:[^\s']+|'[^']*')+/g).map(s => s.replace(/^'|'$/g, '')) : [];
    try {
      const r = await api('POST', '/sessions', { host_id, cwd: '/tmp', args });
      await refresh();
      attachSession(r.session_id);
    } catch (e) { alert('spawn failed: ' + e.message); }
  };
  document.getElementById('reload').onclick = refresh;

  // --- Boot ---
  readToken();
  if (!state.token) showAuth();
  else { showApp(); startPolling(); }
})();
```

## Task 6.5: Hub-side fix for WS token via subprotocol

Browser WebSocket API can't set arbitrary headers. We pass `Sec-WebSocket-Protocol: bearer.<token>`. Hub needs to accept this.

Modify `attachUpgrade` (and `attach`) in `fleet-routes.js`:

```js
const auth = req.headers.authorization || '';
// Browser fallback: token in Sec-WebSocket-Protocol = "bearer.<token>"
let effectiveAuth = auth;
const proto = req.headers['sec-websocket-protocol'] || '';
const bearerProto = proto.split(',').map(s => s.trim()).find(s => s.startsWith('bearer.'));
if (!effectiveAuth && bearerProto) effectiveAuth = `Bearer ${bearerProto.slice('bearer.'.length)}`;
// Echo back the subprotocol so the handshake completes
const acceptProto = bearerProto ? { protocol: bearerProto } : undefined;
wss.handleUpgrade(req, sock, head, (ws) => {
  const ctx = ...;
  if (effectiveAuth !== `Bearer ${ctx.token}`) return ws.close(4001, 'unauthorized');
  ...
}, acceptProto);
```

(Note: `ws` library's `handleUpgrade` doesn't accept a `protocol` callback directly — instead use `wss.options.handleProtocols` OR manually set the `Sec-WebSocket-Protocol` response header by overriding `wss.shouldHandle`. Simpler path: configure `WebSocketServer({ handleProtocols: () => ... })`.)

## Task 7: Smoke

1. Start fleet-test-pg (already running)
2. Start rag-api locally with test token (as in fleet-e2e.sh)
3. Open browser `http://localhost:15679/fleet/#token=test-token`
4. Confirm: auth flows, hosts list shows, spawn session, terminal attaches
