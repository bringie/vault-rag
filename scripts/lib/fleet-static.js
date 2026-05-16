'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WEB_DIR = path.resolve(__dirname, '..', '..', 'agent-fleet', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2': 'font/woff2',
};

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

module.exports = { serve, WEB_DIR };
