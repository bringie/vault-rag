'use strict';
// vt-0316: vault graph view. Force-directed layout on a <canvas>, no
// external dependencies. ~150 LoC of physics + drag/zoom.
//
// API: window.openVaultGraph(rootPath?) — loads /api/notes/graph and
// runs the simulation. Subsequent calls re-render in the same canvas.
//
// Algorithm: classic Fruchterman-Reingold spring/repulsion with a
// fixed simulation step (60 ticks) — converges fast enough for ≤500
// nodes which is the API cap.

(function () {
  const API = '/api';
  let _canvas, _ctx;
  let _nodes = [];
  let _edges = [];
  let _adj = new Map();         // node id → Set of neighbour ids (for hover)
  let _running = false;
  let _camera = { x: 0, y: 0, zoom: 1 };
  let _hoverId = null;
  let _drag = null;

  function token() { return localStorage.fleetToken || ''; }

  async function fetchGraph(rootPath, depth) {
    const params = new URLSearchParams();
    if (rootPath) params.set('path', rootPath);
    if (depth) params.set('depth', String(depth));
    const url = `${API}/notes/graph${params.toString() ? '?' + params : ''}`;
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + token() } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function initLayout(nodes) {
    const w = _canvas.width;
    const h = _canvas.height;
    // Spread nodes in a phyllotactic spiral so the simulation starts
    // from a non-pathological state (random can collide; spiral is
    // O(N) and looks fine).
    const golden = Math.PI * (3 - Math.sqrt(5));
    return nodes.map((n, i) => ({
      id: n.id,
      label: n.label,
      group: n.group,
      x: w / 2 + 6 * Math.sqrt(i) * Math.cos(i * golden),
      y: h / 2 + 6 * Math.sqrt(i) * Math.sin(i * golden),
      vx: 0, vy: 0,
      degree: 0,
    }));
  }

  function tick(nodes, edges) {
    // Fruchterman-Reingold with a soft "centre" pull.
    const W = _canvas.width, H = _canvas.height;
    const area = W * H;
    const k = Math.sqrt(area / Math.max(1, nodes.length)) * 0.5;
    const cx = W / 2, cy = H / 2;

    // Repulsion (O(N²) — fine for ≤500 nodes)
    for (const a of nodes) {
      let fx = 0, fy = 0;
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx*dx + dy*dy + 1;
        const d = Math.sqrt(d2);
        const f = (k * k) / d2;
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }
      // Centre pull (stops disconnected components flying to infinity)
      fx += (cx - a.x) * 0.001;
      fy += (cy - a.y) * 0.001;
      a.vx = (a.vx + fx) * 0.85;
      a.vy = (a.vy + fy) * 0.85;
    }
    // Attraction along edges
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    for (const e of edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx*dx + dy*dy) + 1;
      const f = (d * d) / k;
      const ux = dx / d;
      const uy = dy / d;
      a.vx += ux * f * 0.0005;
      a.vy += uy * f * 0.0005;
      b.vx -= ux * f * 0.0005;
      b.vy -= uy * f * 0.0005;
    }
    // Integrate
    for (const a of nodes) {
      if (a === _drag) continue;
      a.x += Math.max(-15, Math.min(15, a.vx));
      a.y += Math.max(-15, Math.min(15, a.vy));
    }
  }

  function project(n) {
    return {
      x: (n.x - _camera.x) * _camera.zoom + _canvas.width / 2,
      y: (n.y - _camera.y) * _camera.zoom + _canvas.height / 2,
    };
  }
  function unproject(px, py) {
    return {
      x: (px - _canvas.width / 2) / _camera.zoom + _camera.x,
      y: (py - _canvas.height / 2) / _camera.zoom + _camera.y,
    };
  }

  function colorForGroup(group) {
    // Stable hash → hue. Avoids loading a palette library; consistent
    // colour per top-level folder is enough for personal/team scope.
    let h = 0;
    for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
  }

  function render() {
    const W = _canvas.width, H = _canvas.height;
    _ctx.fillStyle = getComputedStyle(_canvas).backgroundColor || '#0a0a0a';
    _ctx.fillRect(0, 0, W, H);
    // Edges first (under nodes)
    _ctx.strokeStyle = 'rgba(255,255,255,.12)';
    _ctx.lineWidth = 1;
    const nodeById = new Map(_nodes.map(n => [n.id, n]));
    for (const e of _edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const pa = project(a);
      const pb = project(b);
      _ctx.beginPath();
      _ctx.moveTo(pa.x, pa.y);
      _ctx.lineTo(pb.x, pb.y);
      _ctx.stroke();
    }
    // Highlight hover edges
    if (_hoverId) {
      _ctx.strokeStyle = 'rgba(102,204,255,.65)';
      _ctx.lineWidth = 1.5;
      for (const e of _edges) {
        if (e.source === _hoverId || e.target === _hoverId) {
          const a = nodeById.get(e.source);
          const b = nodeById.get(e.target);
          if (!a || !b) continue;
          const pa = project(a); const pb = project(b);
          _ctx.beginPath();
          _ctx.moveTo(pa.x, pa.y);
          _ctx.lineTo(pb.x, pb.y);
          _ctx.stroke();
        }
      }
    }
    // Nodes
    for (const n of _nodes) {
      const p = project(n);
      const r = Math.max(3, Math.min(10, 3 + (n.degree || 0)));
      _ctx.fillStyle = colorForGroup(n.group);
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      _ctx.fill();
      if (n.id === _hoverId) {
        _ctx.strokeStyle = '#fff';
        _ctx.lineWidth = 2;
        _ctx.stroke();
      }
    }
    // Hover label
    if (_hoverId) {
      const n = nodeById.get(_hoverId);
      if (n) {
        const p = project(n);
        const text = n.id;  // full path for context
        _ctx.font = '12px monospace';
        _ctx.fillStyle = 'rgba(0,0,0,.8)';
        const w = _ctx.measureText(text).width + 12;
        _ctx.fillRect(p.x + 12, p.y - 22, w, 18);
        _ctx.fillStyle = '#fff';
        _ctx.fillText(text, p.x + 18, p.y - 8);
      }
    }
  }

  function pickNode(px, py) {
    const pos = unproject(px, py);
    let best = null, bestDist = Infinity;
    for (const n of _nodes) {
      const dx = n.x - pos.x;
      const dy = n.y - pos.y;
      const d = dx*dx + dy*dy;
      if (d < bestDist) { bestDist = d; best = n; }
    }
    // Tolerance ~12px in screen space
    const tolWorld = 12 / _camera.zoom;
    return best && bestDist <= tolWorld * tolWorld ? best : null;
  }

  function attachInput() {
    let pan = null;
    _canvas.onmousedown = (ev) => {
      const rect = _canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const n = pickNode(px, py);
      if (n) {
        _drag = n;
        pan = null;
      } else {
        pan = { x: ev.clientX, y: ev.clientY, cx: _camera.x, cy: _camera.y };
      }
    };
    _canvas.onmousemove = (ev) => {
      const rect = _canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      if (_drag) {
        const pos = unproject(px, py);
        _drag.x = pos.x; _drag.y = pos.y; _drag.vx = 0; _drag.vy = 0;
      } else if (pan) {
        const dx = (ev.clientX - pan.x) / _camera.zoom;
        const dy = (ev.clientY - pan.y) / _camera.zoom;
        _camera.x = pan.cx - dx;
        _camera.y = pan.cy - dy;
      } else {
        const n = pickNode(px, py);
        _hoverId = n ? n.id : null;
      }
    };
    _canvas.onmouseup = () => { _drag = null; pan = null; };
    _canvas.onmouseleave = () => { _drag = null; pan = null; _hoverId = null; };
    _canvas.onwheel = (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      _camera.zoom = Math.max(0.1, Math.min(5, _camera.zoom * factor));
    };
    _canvas.ondblclick = (ev) => {
      const rect = _canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const n = pickNode(px, py);
      // Double-click on a node → open it in the notes tree (existing flow).
      if (n && typeof window.openVaultNote === 'function') {
        window.openVaultNote(n.id);
      }
    };
  }

  function loop() {
    if (!_running) return;
    tick(_nodes, _edges);
    render();
    requestAnimationFrame(loop);
  }

  function fitCanvas() {
    const pane = document.getElementById('vault-graph-pane');
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    _canvas.width = Math.max(200, rect.width);
    _canvas.height = Math.max(200, rect.height - 50);  // toolbar
  }

  async function openVaultGraph(rootPath) {
    _canvas = document.getElementById('vault-graph-canvas');
    if (!_canvas) return;
    _ctx = _canvas.getContext('2d');
    fitCanvas();
    if (typeof rootPath === 'string') {
      const el = document.getElementById('vault-graph-root');
      if (el) el.value = rootPath;
    }
    const root = (document.getElementById('vault-graph-root')?.value || '').trim();
    const depth = parseInt(document.getElementById('vault-graph-depth')?.value || '2', 10);
    const stats = document.getElementById('vault-graph-stats');
    if (stats) stats.textContent = 'loading…';
    let data;
    try {
      data = await fetchGraph(root, depth);
    } catch (e) {
      if (stats) stats.textContent = `error: ${e.message}`;
      return;
    }
    _nodes = initLayout(data.nodes);
    _edges = data.edges;
    _adj = new Map();
    for (const n of _nodes) _adj.set(n.id, new Set());
    for (const e of _edges) {
      _adj.get(e.source)?.add(e.target);
      _adj.get(e.target)?.add(e.source);
    }
    for (const n of _nodes) n.degree = _adj.get(n.id)?.size || 0;
    _camera = { x: _canvas.width / 2, y: _canvas.height / 2, zoom: 1 };
    if (stats) {
      stats.textContent = `${data.node_count} notes · ${data.edge_count} links` +
        (data.truncated ? ' · truncated' : '');
    }
    if (!_running) {
      _running = true;
      attachInput();
      requestAnimationFrame(loop);
    }
  }

  // Stop the simulation when the user leaves the graph tab. The
  // notes/secrets tabs hide #vault-graph-pane via .hidden, so we
  // check visibility periodically.
  setInterval(() => {
    const pane = document.getElementById('vault-graph-pane');
    if (!pane) return;
    const visible = !pane.hidden;
    if (!visible) {
      _running = false;
    } else if (visible && !_running && _nodes.length) {
      _running = true;
      requestAnimationFrame(loop);
    }
  }, 1000);

  window.addEventListener('resize', () => {
    if (_canvas) fitCanvas();
  });

  window.openVaultGraph = openVaultGraph;
})();
