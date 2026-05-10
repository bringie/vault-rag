const fs = require('node:fs/promises');
const path = require('node:path');
const client = require('prom-client');

const TEXTFILE_DIR = process.env.PROM_TEXTFILE_DIR || '/var/lib/node_exporter/textfile_collector';
const FILE = path.join(TEXTFILE_DIR, 'inbox_classifier.prom');

const reg = new client.Registry();

const processed = new client.Counter({
  name: 'inbox_classifier_processed_total',
  help: 'Files processed by the inbox classifier',
  labelNames: ['status'],
  registers: [reg],
});

const skipped = new client.Counter({
  name: 'inbox_classifier_skipped_total',
  help: 'Files skipped by rule (current-context, type=index, _-prefix, _deadletter)',
  registers: [reg],
});

const confidence = new client.Histogram({
  name: 'inbox_classifier_confidence',
  help: 'Confidence reported by Haiku',
  buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [reg],
});

const duration = new client.Histogram({
  name: 'inbox_classifier_duration_seconds',
  help: 'End-to-end classify duration per file',
  buckets: [1, 5, 10, 30, 60],
  registers: [reg],
});

async function flush() {
  try {
    await fs.mkdir(TEXTFILE_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.writeFile(tmp, await reg.metrics(), 'utf8');
    await fs.rename(tmp, FILE);
  } catch (e) {
    console.error(`[metrics] flush failed: ${e.message}`);
  }
}

module.exports = { processed, skipped, confidence, duration, flush };
