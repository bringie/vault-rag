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

async function getRaw(server, urlPath) {
  const port = server.address().port;
  return new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
  });
}

test('serves /fleet/ as index.html', async () => {
  const s = await startServer();
  const r = await getRaw(s, '/fleet/');
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith('text/html'));
  assert.ok(r.body.toString().includes('<html'));
  s.close();
});

test('serves /fleet/static/app.css', async () => {
  const s = await startServer();
  const r = await getRaw(s, '/fleet/static/app.css');
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith('text/css'));
  s.close();
});

test('rejects "/.." prefix in static path', async () => {
  // Use raw HTTP to bypass client normalisation
  const s = await startServer();
  const port = s.address().port;
  const r = await new Promise(resolve => {
    const sock = require('node:net').connect(port, '127.0.0.1', () => {
      sock.write('GET /fleet/static/..%2fapp.css HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    const chunks = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
  // either 400 (caught by sanitise) or 404 (file truly missing) — but NOT 200
  assert.ok(!r.startsWith('HTTP/1.1 200'), `unexpected 200 on traversal: ${r.slice(0,60)}`);
  s.close();
});

test('returns 404 for missing file', async () => {
  const s = await startServer();
  const r = await getRaw(s, '/fleet/static/nonexistent.foo');
  assert.equal(r.status, 404);
  s.close();
});
