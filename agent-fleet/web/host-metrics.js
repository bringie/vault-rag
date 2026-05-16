'use strict';
// host-metrics: sparklines + tabs for host detail panel.
(function () {
  function token() { return localStorage.fleetToken || ''; }
  let activeWs = null;
  let activeHost = null;

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function hb(b) {
    if (b == null) return '—';
    if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GiB';
    if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MiB';
    if (b > 1024)      return (b / 1024).toFixed(1) + ' KiB';
    return b + ' B';
  }
  function bps(n) {
    if (n == null) return '—';
    if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB/s';
    if (n > 1e3) return (n / 1e3).toFixed(1) + ' KB/s';
    return n + ' B/s';
  }

  const cpuBuf = []; const ramBuf = [];
  const MAX = 360;

  async function api(path) {
    const res = await fetch('/fleet' + path, { headers: { authorization: 'Bearer ' + token() } });
    if (!res.ok) throw new Error('' + res.status);
    return res.json();
  }

  async function startHostMetrics(hostId) {
    if (activeHost === hostId && activeWs && activeWs.readyState <= 1) return;
    stopHostMetrics();
    activeHost = hostId;
    cpuBuf.length = 0; ramBuf.length = 0;
    try {
      const rows = await api(`/hosts/${hostId}/metrics?since=1h`);
      for (const r of rows) {
        cpuBuf.push(r.cpu_pct == null ? null : r.cpu_pct);
        if (r.ram_total_bytes) ramBuf.push(100 * r.ram_used_bytes / r.ram_total_bytes);
        else                   ramBuf.push(null);
      }
      while (cpuBuf.length > MAX) cpuBuf.shift();
      while (ramBuf.length > MAX) ramBuf.shift();
      renderSparklines();
    } catch (e) { /* host may have no data yet */ }

    try {
      const inv = await api(`/hosts/${hostId}/inventory`);
      renderTabs(inv);
    } catch {}

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/fleet/ws?role=metrics_viewer&host_id=${hostId}`;
    // vt-0136: prefer signed ticket; fall back to legacy bearer.<token> on
    // pre-vt-0136 servers.
    let subProto = [`bearer.${token()}`];
    try {
      const r = await fetch('/api/fleet/auth/ws-ticket', {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'metrics_viewer' }),
      });
      if (r.ok) {
        const j = await r.json();
        if (j.ticket) subProto = [`ticket.${j.ticket}`];
      }
    } catch {}
    activeWs = new WebSocket(url, subProto);
    activeWs.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (f.type === 'metrics') {
        renderLive(f);
        cpuBuf.push(f.cpu_pct == null ? null : f.cpu_pct);
        if (f.ram_total_bytes) ramBuf.push(100 * f.ram_used_bytes / f.ram_total_bytes);
        else                   ramBuf.push(null);
        while (cpuBuf.length > MAX) cpuBuf.shift();
        while (ramBuf.length > MAX) ramBuf.shift();
        renderSparklines();
      } else if (f.type === 'inventory') {
        renderTabs(f);
      }
    };
    activeWs.onerror = () => {};
  }

  function stopHostMetrics() {
    if (activeWs) { try { activeWs.close(); } catch {} activeWs = null; }
    activeHost = null;
  }

  function renderLive(m) {
    const ramPct = m.ram_total_bytes ? Math.round(100 * m.ram_used_bytes / m.ram_total_bytes) : null;
    const live = document.getElementById('hm-live');
    if (!live) return;
    live.innerHTML = `
      <span>CPU <strong>${m.cpu_pct == null ? '—' : m.cpu_pct.toFixed(1) + '%'}</strong></span>
      <span>RAM <strong>${ramPct == null ? '—' : ramPct + '%'}</strong> (${hb(m.ram_used_bytes)}/${hb(m.ram_total_bytes)})</span>
      ${m.net ? `<span>NET ↓${bps(m.net.rx_bps)} ↑${bps(m.net.tx_bps)}</span>` : ''}
      ${m.error ? `<span style="color:var(--warn)">⚠ ${esc(m.error)}</span>` : ''}
    `;
    renderDisk(m.disk);
  }

  function renderDisk(disk) {
    const el = document.getElementById('hm-disk');
    if (!el || !disk) return;
    el.innerHTML = '<table class="hm-disk-table"><thead><tr><th>mount</th><th>used / size</th><th></th></tr></thead><tbody>'
      + disk.map(d => {
          const pct = d.size_bytes ? Math.round(100 * d.used_bytes / d.size_bytes) : 0;
          return `<tr><td>${esc(d.mount)}</td><td>${hb(d.used_bytes)} / ${hb(d.size_bytes)}</td>
                  <td><div class="hm-bar"><div style="width:${pct}%"></div></div></td></tr>`;
        }).join('')
      + '</tbody></table>';
  }

  function renderSparklines() {
    drawSpark('hm-cpu-svg', cpuBuf, 100);
    drawSpark('hm-ram-svg', ramBuf, 100);
  }

  function drawSpark(id, buf, scaleMax) {
    const svg = document.getElementById(id);
    if (!svg) return;
    const W = 360, H = 60;
    if (!buf.length) { svg.innerHTML = ''; return; }
    const pts = buf.map((v, i) => {
      if (v == null) return null;
      const x = W * i / (MAX - 1);
      const y = H - (Math.min(scaleMax, Math.max(0, v)) / scaleMax) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const segments = [];
    let cur = [];
    for (const p of pts) {
      if (p) cur.push(p);
      else if (cur.length) { segments.push(cur); cur = []; }
    }
    if (cur.length) segments.push(cur);
    svg.innerHTML = segments.map(s =>
      `<polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${s.join(' ')}"/>`).join('');
  }

  function renderTabs(inv) {
    const tabContent = document.getElementById('hm-tab-content');
    if (!tabContent) return;
    document.querySelectorAll('.hm-tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.hm-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        renderTabBody(t.dataset.tab, inv);
      };
    });
    const active = document.querySelector('.hm-tab.active')?.dataset.tab || 'skills';
    renderTabBody(active, inv);
  }

  function renderTabBody(tab, inv) {
    const el = document.getElementById('hm-tab-content');
    if (tab === 'skills') {
      const sk = (inv.skills || []);
      el.innerHTML = sk.length
        ? '<table class="hm-tab-table"><thead><tr><th>plugin</th><th>version</th><th>skill</th></tr></thead><tbody>'
          + sk.map(s => `<tr><td>${esc(s.plugin)}</td><td>${esc(s.version)}</td><td>${esc(s.name)}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p style="color:var(--text-dim)">no skills detected</p>';
    } else if (tab === 'mcp') {
      const mc = (inv.mcp_servers || []);
      el.innerHTML = mc.length
        ? '<table class="hm-tab-table"><thead><tr><th>name</th><th>enabled</th><th>command</th></tr></thead><tbody>'
          + mc.map(s => `<tr><td>${esc(s.name)}</td>
            <td>${s.enabled ? '<span style="color:var(--ok)">✓</span>' : '<span style="color:var(--danger)">✗</span>'}</td>
            <td>${esc(s.command || '')}</td></tr>`).join('')
          + '</tbody></table>'
        : '<p style="color:var(--text-dim)">no MCP servers configured</p>';
    } else if (tab === 'settings') {
      el.innerHTML = `<details><summary>show settings JSON (whitelisted fields only)</summary>
        <pre style="background:var(--bg); padding:.7em; overflow:auto">${esc(JSON.stringify(inv.settings || {}, null, 2))}</pre>
        <p style="color:var(--text-dim); font-size:11px">claude_version: ${esc(inv.claude_version || '—')}</p>
        </details>`;
    }
  }

  window.startHostMetrics = startHostMetrics;
  window.stopHostMetrics = stopHostMetrics;
})();
