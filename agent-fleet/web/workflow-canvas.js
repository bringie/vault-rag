'use strict';
// workflow-canvas: SVG renderer for workflow DAGs.
// Shared by editor and run viewer. Global: window.WorkflowCanvas.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NODE_W = 160, NODE_H = 60, GRID = 20;

  function el(tag, attrs = {}, parent = null) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  function snap(v) { return Math.round(v / GRID) * GRID; }

  function tt(k, vars) { return window.fleetI18n ? window.fleetI18n.t(k, vars) : k; }
  function nodeLabel(node) {
    if (node.type === 'claude') {
      const t = node.target || {};
      const target = t.group ? `gr:${t.group}` : t.host_name ? t.host_name : t.capability ? `cap:${t.capability}` : '?';
      return `${node.id} → ${target}`;
    }
    if (node.type === 'branch')       return tt('workflows.node.if_prefix', { cond: (node.condition || '').slice(0, 22) });
    if (node.type === 'delay')        return tt('workflows.node.wait_seconds', { sec: node.seconds || 0 });
    if (node.type === 'transform')    return `${node.id}: transform`;
    if (node.type === 'http_request') return `${node.id}: http ${(node.method || 'GET').toUpperCase()}`;
    if (node.type === 'notify')       return `${node.id}: notify`;
    if (node.type === 'set_variable') return `${node.id}: set ${node.key || '?'}`;
    if (node.type === 'fan_out')      return `${node.id}: fan_out → ${(node.targets || []).length}`;
    if (node.type === 'aggregate')    return `${node.id}: ${node.op || 'concat'}`;
    return node.id;
  }

  function portPos(node) {
    return {
      in:  { x: node.position.x,             y: node.position.y + NODE_H / 2 },
      out: { x: node.position.x + NODE_W,    y: node.position.y + NODE_H / 2 },
    };
  }

  function edgePath(from, to) {
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    return `M ${from.x},${from.y} C ${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
  }

  // Module-level singleton tracker — auto-destroy prior canvas to prevent keydown
  // listener accumulation when callers (editor/viewer) navigate without calling destroy()
  // explicitly. vt-0080.
  let _activeCanvas = null;

  function create({ mount, definition, interactive = false, onSelect, onDefinitionChange, statusByNode = {} }) {
    if (_activeCanvas) { try { _activeCanvas.destroy(); } catch {} _activeCanvas = null; }
    mount.innerHTML = '';
    const svg = el('svg', { class: 'wf-canvas', width: '100%', height: '100%', viewBox: '0 0 1600 1000' }, mount);
    const defs = el('defs', {}, svg);
    const marker = el('marker', {
      id: 'wf-arrow', markerWidth: 10, markerHeight: 10, refX: 9, refY: 5, orient: 'auto',
    }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6b7a8a' }, marker);

    const gGrid  = el('g', { class: 'wf-grid' }, svg);
    const gEdges = el('g', { class: 'wf-edges' }, svg);
    const gNodes = el('g', { class: 'wf-nodes' }, svg);

    for (let x = 0; x < 1600; x += GRID) {
      for (let y = 0; y < 1000; y += GRID) {
        el('circle', { cx: x, cy: y, r: 0.5, fill: '#2a3441' }, gGrid);
      }
    }

    let def = JSON.parse(JSON.stringify(definition || { start: null, nodes: [], edges: [] }));
    let selectedId = null;
    let connectFrom = null;     // node id whose out-port is "armed"
    let cursorPt = null;        // last svg-space mouse coords for ghost line
    let ghostPath = null;       // <path> element for the ghost edge

    function render() {
      gNodes.innerHTML = '';
      gEdges.innerHTML = '';
      for (const e of def.edges) {
        const a = def.nodes.find(n => n.id === e.from);
        const b = def.nodes.find(n => n.id === e.to);
        if (!a || !b) continue;
        const p1 = portPos(a).out, p2 = portPos(b).in;
        el('path', {
          d: edgePath(p1, p2),
          fill: 'none',
          stroke: e.label === 'then' ? '#3ec47a' : e.label === 'else' ? '#e6594b' : '#6b7a8a',
          'stroke-width': 2,
          'marker-end': 'url(#wf-arrow)',
        }, gEdges);
      }
      for (const n of def.nodes) {
        const g = el('g', {
          class: `wf-node wf-node-${n.type}`,
          transform: `translate(${n.position.x}, ${n.position.y})`,
        }, gNodes);
        const status = statusByNode[n.id] || 'idle';
        const fill = status === 'running' ? '#2a4a7a' :
                     status === 'done'    ? '#1f5f3a' :
                     status === 'failed'  ? '#7a2a2a' :
                                            '#2a3441';
        const stroke = n.id === selectedId ? '#7ad1ff' :
                       n.type === 'claude'        ? '#5985b8' :
                       n.type === 'branch'        ? '#c08a3a' :
                       n.type === 'fan_out'       ? '#7a5fb8' :
                       n.type === 'aggregate'     ? '#5fb8a3' :
                       n.type === 'http_request'  ? '#b8a05f' :
                       n.type === 'notify'        ? '#b87a5f' :
                       n.type === 'transform'     ? '#9ab85f' :
                       n.type === 'set_variable'  ? '#5fb8b3' :
                       '#6b7a8a';
        el('rect', {
          x: 0, y: 0, width: NODE_W, height: NODE_H,
          rx: n.type === 'delay' ? 12 : 4,
          fill, stroke, 'stroke-width': n.id === selectedId ? 3 : 1.5,
        }, g);
        const text = el('text', {
          x: NODE_W / 2, y: NODE_H / 2 + 4,
          'text-anchor': 'middle', fill: '#e6ebf2', 'font-size': 12,
        }, g);
        text.textContent = nodeLabel(n);
        if (status === 'running') {
          const pulse = el('circle', { cx: NODE_W - 10, cy: 10, r: 4, fill: '#7ad1ff' }, g);
          el('animate', { attributeName: 'opacity', from: 1, to: 0.2, dur: '0.8s', repeatCount: 'indefinite' }, pulse);
        }
        if (interactive) {
          const portIn = el('circle', {
            cx: 0, cy: NODE_H / 2, r: 7,
            fill: connectFrom && connectFrom !== n.id ? '#f0e060' : '#7ad1ff',
            stroke: '#0a0a0c', 'stroke-width': 1,
            class: 'wf-port wf-port-in', 'data-node': n.id,
          }, g);
          const portOut = el('circle', {
            cx: NODE_W, cy: NODE_H / 2, r: 7,
            fill: connectFrom === n.id ? '#f0e060' : '#7ad1ff',
            stroke: '#0a0a0c', 'stroke-width': 1,
            class: 'wf-port wf-port-out', 'data-node': n.id,
          }, g);
          portOut.addEventListener('mousedown', (ev) => {
            ev.stopPropagation();
            connectFrom = n.id;
            cursorPt = clientToSvg(ev);
            render();
          });
          portIn.addEventListener('mousedown', (ev) => {
            ev.stopPropagation();
            if (connectFrom && connectFrom !== n.id) {
              // Strip any existing edge from same source to avoid dupes
              def.edges = def.edges.filter(e => !(e.from === connectFrom && e.to === n.id));
              def.edges.push({ from: connectFrom, to: n.id });
              connectFrom = null; cursorPt = null;
              ghostPath = null; // gEdges was rebuilt in render()
              notifyChange();
              render();
            }
          });
          attachNodeDrag(g, n);
        } else {
          g.addEventListener('click', () => { selectedId = n.id; render(); onSelect && onSelect(n); });
        }
      }
    }

    // Per-node drag state shared by all node draggers (only one node drags at a time).
    let dragNode = null, dragOff = { x: 0, y: 0 };

    function attachNodeDrag(g, n) {
      g.addEventListener('mousedown', (ev) => {
        const target = ev.target;
        // Ports handled by their own listeners; don't start a drag from them.
        if (target.classList && (target.classList.contains('wf-port-in') || target.classList.contains('wf-port-out'))) return;
        dragNode = n;
        const pt = clientToSvg(ev);
        dragOff.x = pt.x - n.position.x;
        dragOff.y = pt.y - n.position.y;
        selectedId = n.id;
        onSelect && onSelect(n);
        render();
        ev.stopPropagation();
      });
    }

    function clientToSvg(ev) {
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }

    function notifyChange() {
      onDefinitionChange && onDefinitionChange(JSON.parse(JSON.stringify(def)));
    }

    // Single global listeners for the canvas (one set, regardless of node count).
    svg.addEventListener('mousemove', (ev) => {
      if (dragNode) {
        const pt = clientToSvg(ev);
        dragNode.position.x = snap(pt.x - dragOff.x);
        dragNode.position.y = snap(pt.y - dragOff.y);
        render();
      } else if (connectFrom) {
        cursorPt = clientToSvg(ev);
        drawGhost();
      }
    });
    svg.addEventListener('mouseup', () => {
      if (dragNode) { dragNode = null; notifyChange(); }
    });

    function drawGhost() {
      if (ghostPath && ghostPath.parentNode) ghostPath.parentNode.removeChild(ghostPath);
      ghostPath = null;
      if (!connectFrom || !cursorPt) return;
      const src = def.nodes.find(n => n.id === connectFrom);
      if (!src) return;
      const p1 = portPos(src).out;
      ghostPath = el('path', {
        d: edgePath(p1, cursorPt),
        fill: 'none', stroke: '#f0e060', 'stroke-width': 2,
        'stroke-dasharray': '4,3',
        'pointer-events': 'none',
      }, gEdges);
    }

    svg.addEventListener('click', (ev) => {
      if (ev.target === svg || ev.target.parentNode === gGrid) {
        if (connectFrom) {
          // Cancel pending connection
          connectFrom = null; cursorPt = null;
          if (ghostPath && ghostPath.parentNode) ghostPath.parentNode.removeChild(ghostPath);
          ghostPath = null;
          render();
          return;
        }
        selectedId = null;
        onSelect && onSelect(null);
        render();
      }
    });

    const keyHandler = (ev) => {
      if (!interactive) return;
      if (ev.target && ['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName)) return;
      if (ev.key === 'Escape' && connectFrom) {
        connectFrom = null; cursorPt = null;
        if (ghostPath && ghostPath.parentNode) ghostPath.parentNode.removeChild(ghostPath);
        ghostPath = null;
        render();
        return;
      }
      if (ev.key !== 'Delete' || !selectedId) return;
      def.nodes = def.nodes.filter(n => n.id !== selectedId);
      def.edges = def.edges.filter(e => e.from !== selectedId && e.to !== selectedId);
      if (def.start === selectedId) def.start = (def.nodes[0] && def.nodes[0].id) || null;
      selectedId = null;
      notifyChange();
      render();
    };
    document.addEventListener('keydown', keyHandler);

    render();

    const api = {
      addNode(node) {
        def.nodes.push(node);
        if (!def.start) def.start = node.id;
        notifyChange();
        render();
      },
      setStatus(map) { statusByNode = map; render(); },
      setNodeStatus(id, status) { statusByNode[id] = status; render(); },
      getDefinition() { return JSON.parse(JSON.stringify(def)); },
      replaceDefinition(d) { def = JSON.parse(JSON.stringify(d)); render(); },
      destroy() {
        document.removeEventListener('keydown', keyHandler);
        if (_activeCanvas === api) _activeCanvas = null;
      },
    };
    _activeCanvas = api;
    return api;
  }

  window.WorkflowCanvas = { create };
})();
