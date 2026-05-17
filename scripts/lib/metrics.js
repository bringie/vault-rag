'use strict';
// vt-0211: minimal Prometheus exposition format writer. No prom-client
// dependency — Node's `http` + a few Maps. Trade-offs:
//   • Only counter / gauge / simple histogram (sum + count + few buckets).
//   • No native_p99 — caller can compute from buckets in Grafana.
//   • Single-process: rebuilds on each scrape. Fine for the hub which
//     handles tens of req/s, not thousands.
//
// API:
//   const m = require('./metrics');
//   m.counter('rag_api_requests_total', 'HTTP requests', ['method','status'])
//    .inc({method:'GET', status:'200'});
//   m.gauge('rag_api_active_ws_clients', 'WS connections').set(n);
//   m.histogram('rag_api_request_duration_ms', 'Request duration', ['path'],
//               [10, 50, 100, 250, 500, 1000, 5000])
//    .observe({path:'/api/get'}, ms);
//   m.exposition()  → 'metrics text/plain; version=0.0.4'

const _counters   = new Map();
const _gauges     = new Map();
const _histograms = new Map();

function _labelKey(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map(k => `${k}="${String(labels[k]).replace(/[\\"\n]/g, '\\$&')}"`).join(',');
}

function counter(name, help, labelNames = []) {
  if (!_counters.has(name)) _counters.set(name, { help, labelNames, vals: new Map() });
  const c = _counters.get(name);
  return {
    inc(labels, delta = 1) {
      const k = _labelKey(labels);
      c.vals.set(k, (c.vals.get(k) || 0) + delta);
    },
  };
}

function gauge(name, help, labelNames = []) {
  if (!_gauges.has(name)) _gauges.set(name, { help, labelNames, vals: new Map() });
  const g = _gauges.get(name);
  return {
    set(labelsOrValue, value) {
      if (typeof labelsOrValue === 'number') { g.vals.set('', labelsOrValue); return; }
      g.vals.set(_labelKey(labelsOrValue), value);
    },
    inc(labels, delta = 1) {
      const k = _labelKey(labels);
      g.vals.set(k, (g.vals.get(k) || 0) + delta);
    },
    dec(labels, delta = 1) { this.inc(labels, -delta); },
  };
}

function histogram(name, help, labelNames = [], buckets = [10, 50, 100, 250, 500, 1000, 5000]) {
  if (!_histograms.has(name)) {
    _histograms.set(name, { help, labelNames, buckets, vals: new Map() });
  }
  const h = _histograms.get(name);
  return {
    observe(labels, value) {
      const k = _labelKey(labels);
      let rec = h.vals.get(k);
      if (!rec) { rec = { sum: 0, count: 0, bucketCounts: new Array(buckets.length + 1).fill(0) }; h.vals.set(k, rec); }
      rec.sum += value;
      rec.count += 1;
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]) rec.bucketCounts[i] += 1;
      }
      rec.bucketCounts[buckets.length] += 1;  // +Inf bucket
    },
  };
}

function exposition() {
  const lines = [];
  for (const [name, c] of _counters) {
    lines.push(`# HELP ${name} ${c.help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const [labels, v] of c.vals) {
      lines.push(`${name}${labels ? '{' + labels + '}' : ''} ${v}`);
    }
  }
  for (const [name, g] of _gauges) {
    lines.push(`# HELP ${name} ${g.help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const [labels, v] of g.vals) {
      lines.push(`${name}${labels ? '{' + labels + '}' : ''} ${v}`);
    }
  }
  for (const [name, h] of _histograms) {
    lines.push(`# HELP ${name} ${h.help}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const [labels, rec] of h.vals) {
      const lblPrefix = labels ? labels + ',' : '';
      for (let i = 0; i < h.buckets.length; i++) {
        lines.push(`${name}_bucket{${lblPrefix}le="${h.buckets[i]}"} ${rec.bucketCounts[i]}`);
      }
      lines.push(`${name}_bucket{${lblPrefix}le="+Inf"} ${rec.bucketCounts[h.buckets.length]}`);
      lines.push(`${name}_sum${labels ? '{' + labels + '}' : ''} ${rec.sum}`);
      lines.push(`${name}_count${labels ? '{' + labels + '}' : ''} ${rec.count}`);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { counter, gauge, histogram, exposition };
