'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

let prevNet = null;
let prevNetTs = null;

function clampCpu(pct) {
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

async function getCpuPct() {
  if (fs.existsSync('/proc/stat')) {
    const sample = () => {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
      const [, ...vals] = line.split(/\s+/).map(Number);
      const idle = vals[3];  // idle only — iowait unreliable
      const total = vals.reduce((a, b) => a + b, 0);
      return { idle, total };
    };
    const a = sample();
    await new Promise(r => setTimeout(r, 200));
    const b = sample();
    const idleDiff = b.idle - a.idle;
    const totalDiff = b.total - a.total;
    if (!totalDiff) return 0;
    return clampCpu(100 * (1 - idleDiff / totalDiff));
  }
  // macOS / fallback
  const sample = () => {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) {
      for (const k in c.times) { total += c.times[k]; if (k === 'idle') idle += c.times[k]; }
    }
    return { idle, total };
  };
  const a = sample();
  await new Promise(r => setTimeout(r, 200));
  const b = sample();
  const idleDiff = b.idle - a.idle;
  const totalDiff = b.total - a.total;
  if (!totalDiff) return 0;
  return clampCpu(100 * (1 - idleDiff / totalDiff));
}

function getRamUsed() {
  if (fs.existsSync('/proc/meminfo')) {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = /MemTotal:\s+(\d+)/.exec(meminfo);
    const availMatch = /MemAvailable:\s+(\d+)/.exec(meminfo);
    if (totalMatch && availMatch) {
      const total = parseInt(totalMatch[1], 10) * 1024;
      const avail = parseInt(availMatch[1], 10) * 1024;
      return total - avail;
    }
  }
  return os.totalmem() - os.freemem();
}

function getDisk() {
  try {
    const out = execSync('df -kP', { encoding: 'utf8', timeout: 2000 });
    return out.trim().split('\n').slice(1).map(line => {
      const parts = line.split(/\s+/);
      const mount = parts[parts.length - 1];
      return {
        mount,
        size_bytes: +parts[1] * 1024,
        used_bytes: +parts[2] * 1024,
        avail_bytes: +parts[3] * 1024,
      };
    }).filter(d => d.mount && !d.mount.startsWith('/snap/') && !d.mount.startsWith('/dev')
      && !['/proc','/sys','/run','/run/lock'].some(p => d.mount.startsWith(p))
      && !d.mount.startsWith('/var/lib/docker/')
      && !d.mount.startsWith('/var/lib/containerd/'));
  } catch { return []; }
}

function getNet() {
  if (!fs.existsSync('/proc/net/dev')) return null;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0, tx = 0;
    for (const line of lines) {
      const m = line.trim().match(/^([^:]+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (!m) continue;
      if (m[1] === 'lo' || m[1].startsWith('docker') || m[1].startsWith('veth') || m[1].startsWith('br-')) continue;
      rx += Number(m[2]); tx += Number(m[3]);
    }
    const now = Date.now();
    if (!prevNet) { prevNet = { rx, tx }; prevNetTs = now; return null; }
    const dt = (now - prevNetTs) / 1000;
    const result = dt > 0 ? { rx_bps: Math.round((rx - prevNet.rx) / dt), tx_bps: Math.round((tx - prevNet.tx) / dt) } : null;
    prevNet = { rx, tx }; prevNetTs = now;
    return result;
  } catch { return null; }
}

async function collectMetrics() {
  const ts = new Date().toISOString();
  try {
    return {
      ts,
      cpu_pct: await getCpuPct(),
      ram_used_bytes: getRamUsed(),
      ram_total_bytes: os.totalmem(),
      disk: getDisk(),
      net: getNet(),
    };
  } catch (e) {
    return { ts, cpu_pct: null, ram_used_bytes: null, ram_total_bytes: os.totalmem(), disk: [], net: null, error: e.message };
  }
}

module.exports = { collectMetrics, _internals: { clampCpu, getCpuPct, getRamUsed, getDisk, getNet } };
