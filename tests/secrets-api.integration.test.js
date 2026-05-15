const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const http = require('http');
const assert = require('assert');

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-int-'));
  const bare = `${root}/origin.git`;
  execSync(`git init --bare -b master ${bare} -q`);
  const clone = `${root}/clone`;
  execSync(`git clone ${bare} ${clone} -q 2>/dev/null`);
  execSync(`cd ${clone} && git config user.email t@t && git config user.name t`);
  execSync(`age-keygen -o ${root}/age.key 2>/dev/null`);
  const pub = execSync(
    `grep '^# public key:' ${root}/age.key | cut -d: -f2 | tr -d ' '`,
  )
    .toString()
    .trim();
  fs.mkdirSync(`${clone}/obsidian-vault/secrets`, { recursive: true });
  fs.writeFileSync(`${clone}/obsidian-vault/secrets/recipients`, `${pub}\n`);
  execSync(
    `echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${clone}/obsidian-vault/secrets/recipients -o ${clone}/obsidian-vault/secrets/vault.age`,
  );
  execSync(
    `cd ${clone} && git add . && git commit -q -m init && git push -q origin HEAD:master`,
  );
  return { root, clone, ageKey: `${root}/age.key` };
}

function callApi(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          authorization: 'Bearer T',
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () =>
          resolve({ code: res.statusCode, body: JSON.parse(buf || '{}') }),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  const t = setupRepo();
  const PORT = 5700 + Math.floor(Math.random() * 100);
  const api = spawn('node', ['scripts/rag-api.js'], {
    env: {
      ...process.env,
      RAG_PORT: String(PORT),
      VAULT_RAG_API_TOKEN: 'T',
      VAULT_AGE_KEY_PATH: t.ageKey,
      VAULT_REPO_PATH: t.clone,
      VAULT_AGE_PATH: `${t.clone}/obsidian-vault/secrets/vault.age`,
      VAULT_RECIPIENTS_PATH: `${t.clone}/obsidian-vault/secrets/recipients`,
      VAULT_SECRETS_SKIP_PG: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await new Promise((r) => setTimeout(r, 800));

  let failed = false;
  try {
    let r = await callApi(PORT, '/secrets/list', {});
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.names, []);

    r = await callApi(PORT, '/secrets/set', { name: 'X', value: 'y' });
    assert.strictEqual(r.code, 200);
    assert.ok(r.body.committed_sha);

    r = await callApi(PORT, '/secrets/get', { name: 'X' });
    assert.strictEqual(r.body.value, 'y');

    r = await callApi(PORT, '/secrets/list', {});
    assert.deepStrictEqual(r.body.names, ['X']);

    r = await callApi(PORT, '/secrets/get', { name: 'MISSING' });
    assert.strictEqual(r.code, 404);

    console.log('rest api integration OK');
  } catch (e) {
    failed = true;
    console.error(e);
  } finally {
    api.kill();
    if (failed) process.exit(1);
  }
})();
