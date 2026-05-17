'use strict';
// vt-0287 slice 7: transcript read paths. Pure read off
// fleet_events (kind=pty_out). .txt strips ANSI for human view;
// .bin emits raw bytes for xterm replay in the archive viewer.
//
// Routes:
//   GET /fleet/sessions/:id/transcript.txt
//   GET /fleet/sessions/:id/transcript.bin

const { SID_RE, send } = require('./_shared');

// Strip both CSI sequences (\x1b[...) — including private-prefix variants like
// \x1b[?2004h — and 2-byte ESC sequences (\x1b7, \x1b8, \x1b], etc.), and OSC
// strings. Also flattens TUI cursor-control noise that survives ANSI removal:
//   - bare \r (cursor-to-col-0) → drop, otherwise renders as newline in <pre>
//   - \b (backspace) → drop
//   - BEL → drop
// Result: readable for archive transcript view. For full TUI fidelity use
// xterm replay (see vt-0116 follow-up).
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ...BEL or ...ST
    .replace(/\x1b\[[\d;?<>]*[A-Za-z]/g, '')              // CSI ...final
    .replace(/\x1b[()][\x20-\x7e]/g, '')                  // charset designate
    .replace(/\x1b[78=>cDEHMNOPVZ\\]/g, '')               // simple 2-byte ESC
    .replace(/\r\n/g, '\n')                               // CRLF → LF
    .replace(/\r/g, '')                                   // lone CR drop
    .replace(/[\x07\x08]/g, '');                          // BEL + BS drop
}

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

module.exports = { register, stripAnsi };
