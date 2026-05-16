'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WEB_DIR = path.resolve(__dirname, '..', '..', 'agent-fleet', 'web');
const DIST_DIR = process.env.VAULT_RAG_FLEET_DIST_DIR
  || path.resolve(__dirname, '..', '..', 'agent-fleet', 'daemon', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2': 'font/woff2',
  '.sh':   'text/x-shellscript; charset=utf-8',
  '.tar':  'application/x-tar',
  '.gz':   'application/gzip',
  '.deb':  'application/vnd.debian.binary-package',
  '.rpm':  'application/x-rpm',
};

// vt-0098 / vt-0099: serve daemon install artifacts to fresh hosts.
// Allowlist: filename must match the build.sh output naming so we don't
// expose anything else from dist/.
const DOWNLOAD_NAME_RE = /^(agent-fleet-daemon(\.tar\.gz|_\d+\.\d+\.\d+_amd64\.deb|-\d+\.\d+\.\d+-\d+\.noarch\.rpm))$/;
const SCRIPT_REDIRECT = {
  '/fleet/install.sh':       'linux-install.sh',
  '/fleet/install-macos.sh': 'macos-install.sh',
};

function serveDownload(req, res) {
  const url = req.url.split('?')[0];
  let rel = null;
  if (SCRIPT_REDIRECT[url]) rel = SCRIPT_REDIRECT[url];
  else if (url.startsWith('/fleet/download/')) rel = url.slice('/fleet/download/'.length);
  if (!rel) return false;
  if (rel.includes('/') || rel.includes('..')) {
    res.writeHead(400); res.end('bad path'); return true;
  }
  // Install scripts come from the packaging dir (not dist), but operators
  // expect them at the same path. Serve them transparently.
  let abs;
  if (rel === 'linux-install.sh') {
    abs = path.resolve(__dirname, '..', '..', 'agent-fleet', 'daemon', 'packaging', 'linux', 'install.sh');
  } else if (rel === 'macos-install.sh') {
    abs = path.resolve(__dirname, '..', '..', 'agent-fleet', 'daemon', 'packaging', 'macos', 'install.sh');
  } else {
    if (!DOWNLOAD_NAME_RE.test(rel)) {
      res.writeHead(404); res.end('not allowed'); return true;
    }
    abs = path.join(DIST_DIR, rel);
  }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) { res.writeHead(404); res.end('not found'); return true; }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'content-disposition': `inline; filename="${path.basename(abs)}"`,
      'cache-control': 'public, max-age=300',
    });
    fs.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404); res.end('not found');
  }
  return true;
}

function serve(req, res) {
  let rel;
  if (req.url === '/fleet/' || req.url === '/fleet') {
    rel = 'index.html';
  } else if (req.url.startsWith('/fleet/static/')) {
    rel = req.url.slice('/fleet/static/'.length).split('?')[0];
  } else {
    return false;
  }
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

module.exports = { serve, serveDownload, WEB_DIR, DIST_DIR };
