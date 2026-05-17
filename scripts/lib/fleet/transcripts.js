'use strict';
// vt-0287 slice 7: transcript read paths. Pure read off
// fleet_events (kind=pty_out). .txt strips ANSI for human view;
// .bin emits raw bytes for xterm replay in the archive viewer.
//
// Routes:
//   GET /fleet/sessions/:id/transcript.txt
//   GET /fleet/sessions/:id/transcript.bin

// vt-0353: stripAnsi moved to _shared.js (shared with dispatch.js).
const { SID_RE, send, stripAnsi } = require('./_shared');

function register({ fleetDb }) {
  return [
    {
      method: 'GET',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})/transcript\\.txt$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const rows = await fleetDb.readTranscript(ctx.db, m[1], { sinceSeq: 0, kind: 'pty_out' });
          const raw = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0))).toString('utf8');
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(stripAnsi(raw));
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
    {
      // vt-0117: raw transcript bytes — for xterm replay in the archive viewer.
      // No stripping; full ANSI/escape stream so TUIs render correctly.
      method: 'GET',
      pattern: new RegExp(`^/fleet/sessions/(${SID_RE})/transcript\\.bin$`, 'i'),
      async handler(req, res, ctx, m) {
        try {
          const rows = await fleetDb.readTranscript(ctx.db, m[1], { sinceSeq: 0, kind: 'pty_out' });
          const buf = Buffer.concat(rows.map(r => r.payload || Buffer.alloc(0)));
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
          res.end(buf);
        } catch (e) { send(res, 500, { error: e.message }); }
      },
    },
  ];
}

module.exports = { register };
