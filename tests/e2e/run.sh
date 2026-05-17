#!/usr/bin/env bash
# vt-0332: post-deploy verification entrypoint. The sub-agent calls
# this; it sources .env so tokens are picked up, runs the suite, and
# emits a compact pass/fail summary to stdout.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

# Load tokens from .env without exporting everything.
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

MODE="${1:-full}"     # full | smoke | rest
case "$MODE" in
  full)  ARGS=() ;;
  smoke) ARGS=(--grep @smoke) ;;
  rest)  ARGS=(specs/rest.spec.js) ;;
  *) echo "usage: $0 [full|smoke|rest]" >&2; exit 64 ;;
esac

# Headless run, JSON reporter writes last-run.json.
node_modules/.bin/playwright test "${ARGS[@]}" || rc=$?

# The JSON reporter writes regardless of pass/fail; surface the
# concise summary even on partial pass.
if [ -f last-run.json ]; then
  node -e "
    const j = require('./last-run.json');
    const passed = j.stats?.expected ?? 0;
    const failed = j.stats?.unexpected ?? 0;
    const skipped = j.stats?.skipped ?? 0;
    const flaky = j.stats?.flaky ?? 0;
    const duration = j.stats?.duration ?? 0;
    console.log(\`\\n--- summary: passed=\${passed} failed=\${failed} skipped=\${skipped} flaky=\${flaky} duration=\${Math.round(duration/1000)}s ---\`);
    if (failed > 0) {
      const fails = [];
      (function walk(suite) {
        for (const s of suite.suites || []) walk(s);
        for (const sp of suite.specs || []) {
          for (const t of sp.tests || []) {
            const r = (t.results || [])[0];
            if (r && r.status !== 'passed' && r.status !== 'skipped') {
              fails.push({ title: sp.title, error: (r.errors?.[0]?.message || r.error?.message || '').slice(0, 300) });
            }
          }
        }
      })(j);
      for (const f of fails) console.log('FAIL  ' + f.title + '\\n      ' + (f.error || '').replace(/\\n/g, ' '));
    }
  "
fi

exit "${rc:-0}"
