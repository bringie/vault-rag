'use strict';

// vault-lib: shared helpers for vault-indexer + rag-api PUT route.
// Pure functions where possible; pg client is injected.

const yaml = require('js-yaml');

const OLLAMA_URL   = process.env.OLLAMA_HOST || 'http://vault-rag-ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const CHUNK_TARGET = parseInt(process.env.VAULT_RAG_CHUNK_TARGET || '1500', 10);
const BATCH_EMBED  = 32;
const BATCH_SLEEP  = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const vec   = (arr) => '[' + arr.join(',') + ']';

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { fm: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { fm: {}, body: text };
  try {
    const fm = yaml.load(text.slice(4, end)) || {};
    return { fm, body: text.slice(end + 5) };
  } catch {
    return { fm: {}, body: text };
  }
}

function serializeFrontmatter(fm, body) {
  if (!fm || !Object.keys(fm).length) return body;
  const dumped = yaml.dump(fm, { lineWidth: -1, sortKeys: false, noRefs: true }).trimEnd();
  return `---\n${dumped}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

function mergeFrontmatter(base, patch) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (Array.isArray(v) && Array.isArray(out[k])) {
      out[k] = [...new Set([...out[k], ...v])];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function chunk(text) {
  const sections = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (/^#{1,2} /.test(line) && cur.length) {
      sections.push(cur.join('\n').trim());
      cur = [line];
    } else cur.push(line);
  }
  if (cur.length) sections.push(cur.join('\n').trim());

  const out = [];
  for (const s of sections.filter(Boolean)) {
    if (s.length <= CHUNK_TARGET) { out.push(s); continue; }
    let buf = '';
    for (const p of s.split(/\n{2,}/)) {
      if ((buf + '\n\n' + p).length > CHUNK_TARGET && buf) {
        out.push(buf); buf = p;
      } else buf = buf ? buf + '\n\n' + p : p;
    }
    if (buf) out.push(buf);
  }
  return out;
}

function extractBacklinks(text) {
  const set = new Set();
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) set.add(m[1].trim());
  return [...set];
}

function extractTags(fm, text) {
  const tags = new Set();
  if (Array.isArray(fm.tags)) fm.tags.forEach(t => tags.add(String(t)));
  for (const m of text.matchAll(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g)) tags.add(m[1]);
  return [...tags];
}

async function embedBatch(texts, attempt = 0) {
  if (!texts.length) return [];
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, input: texts }),
  });
  if (!r.ok) {
    if (attempt < 3) {
      const wait = 1000 * Math.pow(2, attempt);
      console.warn(`[vault-lib] ollama ${r.status}, retry in ${wait}ms`);
      await sleep(wait);
      return embedBatch(texts, attempt + 1);
    }
    throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  }
  const j = await r.json();
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) {
    throw new Error(`Ollama batch shape: got ${j.embeddings?.length}, want ${texts.length}`);
  }
  return j.embeddings;
}

async function embed(texts /* type ignored */) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_EMBED) {
    const slice = texts.slice(i, i + BATCH_EMBED);
    const embs = await embedBatch(slice);
    out.push(...embs);
    if (BATCH_SLEEP && i + BATCH_EMBED < texts.length) await sleep(BATCH_SLEEP);
  }
  return out;
}

async function upsertFile(pg, vaultRelPath, body, fm) {
  const chunks = chunk(body);
  if (!chunks.length) {
    await pg.query('DELETE FROM chunks    WHERE path=$1', [vaultRelPath]);
    await pg.query('DELETE FROM backlinks WHERE source=$1', [vaultRelPath]);
    return { chunks: 0, links: 0 };
  }
  const embs  = await embed(chunks);
  const tags  = extractTags(fm, body);
  const links = extractBacklinks(body);

  await pg.query('BEGIN');
  try {
    await pg.query('DELETE FROM chunks    WHERE path=$1', [vaultRelPath]);
    await pg.query('DELETE FROM backlinks WHERE source=$1', [vaultRelPath]);
    for (let i = 0; i < chunks.length; i++) {
      await pg.query(
        `INSERT INTO chunks (path, idx, text, emb, tags, fm) VALUES ($1,$2,$3,$4,$5,$6)`,
        [vaultRelPath, i, chunks[i], vec(embs[i]), tags, fm]
      );
    }
    for (const tgt of links) {
      await pg.query(
        'INSERT INTO backlinks (source, target) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [vaultRelPath, tgt]
      );
    }
    await pg.query('COMMIT');
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch {}
    throw e;
  }
  return { chunks: chunks.length, links: links.length };
}

async function deleteFile(pg, vaultRelPath) {
  await pg.query('BEGIN');
  try {
    await pg.query('DELETE FROM chunks    WHERE path=$1', [vaultRelPath]);
    await pg.query('DELETE FROM backlinks WHERE source=$1', [vaultRelPath]);
    await pg.query('COMMIT');
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch {}
    throw e;
  }
}

module.exports = {
  CHUNK_TARGET,
  parseFrontmatter,
  serializeFrontmatter,
  mergeFrontmatter,
  chunk,
  extractBacklinks,
  extractTags,
  embed,
  vec,
  sleep,
  upsertFile,
  deleteFile,
};
