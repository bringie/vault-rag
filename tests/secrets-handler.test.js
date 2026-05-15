const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { SecretsHandler, NotFound } = require('../scripts/secrets-handler.js');

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-test-'));
  execSync(`age-keygen -o ${dir}/age.key 2>/dev/null`);
  const pub = execSync(
    `grep '^# public key:' ${dir}/age.key | cut -d: -f2 | tr -d ' '`,
  )
    .toString()
    .trim();
  fs.writeFileSync(`${dir}/recipients`, `# host: test\n${pub}\n`);
  return {
    dir,
    ageKey: `${dir}/age.key`,
    recipients: `${dir}/recipients`,
    vaultAge: `${dir}/vault.age`,
  };
}

async function main() {
  // Test 1: decrypt round-trip
  const t1 = makeTmp();
  const initial = { _meta: { schema: 1, version: 1, rotated_at: {} } };
  execSync(
    `echo '${JSON.stringify(initial)}' | age -R ${t1.recipients} -o ${t1.vaultAge}`,
  );
  const h1 = new SecretsHandler({
    ageKeyPath: t1.ageKey,
    recipientsPath: t1.recipients,
    vaultAgePath: t1.vaultAge,
    repoPath: t1.dir,
    skipGit: true,
  });
  const blob1 = await h1._decryptVaultAge();
  assert.strictEqual(blob1._meta.version, 1);
  console.log('round-trip OK');

  // Test 2: encrypt + write
  const t2 = makeTmp();
  execSync(
    `echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${t2.recipients} -o ${t2.vaultAge}`,
  );
  const h2 = new SecretsHandler({
    ageKeyPath: t2.ageKey,
    recipientsPath: t2.recipients,
    vaultAgePath: t2.vaultAge,
    repoPath: t2.dir,
    skipGit: true,
  });
  const blob2 = await h2._decryptVaultAge();
  blob2.MY_KEY = 'super-secret-value';
  blob2._meta.version += 1;
  await h2._encryptAndWrite(blob2);
  const back = await h2._decryptVaultAge();
  assert.strictEqual(back.MY_KEY, 'super-secret-value');
  assert.strictEqual(back._meta.version, 2);
  console.log('encrypt-write OK');

  // Test 3: get/list/set basics
  const t3 = makeTmp();
  execSync(
    `echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${t3.recipients} -o ${t3.vaultAge}`,
  );
  const h3 = new SecretsHandler({
    ageKeyPath: t3.ageKey,
    recipientsPath: t3.recipients,
    vaultAgePath: t3.vaultAge,
    repoPath: t3.dir,
    skipGit: true,
  });
  assert.deepStrictEqual(await h3.list(), []);
  await h3.set('K1', 'v1');
  assert.strictEqual(await h3.get('K1'), 'v1');
  assert.deepStrictEqual(await h3.list(), ['K1']);
  try {
    await h3.get('MISSING');
    assert.fail('expected NotFound');
  } catch (e) {
    assert.ok(e instanceof NotFound, 'wrong error type: ' + e.constructor.name);
  }
  console.log('api basics OK');

  // Test 4: delete/rotate/verify
  const t4 = makeTmp();
  execSync(
    `echo '{"_meta":{"schema":1,"version":1,"rotated_at":{}}}' | age -R ${t4.recipients} -o ${t4.vaultAge}`,
  );
  const h4 = new SecretsHandler({
    ageKeyPath: t4.ageKey,
    recipientsPath: t4.recipients,
    vaultAgePath: t4.vaultAge,
    repoPath: t4.dir,
    skipGit: true,
  });
  await h4.set('K1', 'v1');
  await h4.set('K2', 'v2');

  await h4.delete('K1');
  assert.deepStrictEqual(await h4.list(), ['K2']);
  try {
    await h4.get('K1');
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof NotFound);
  }

  try {
    await h4.delete('MISSING');
    assert.fail();
  } catch (e) {
    assert.ok(e instanceof NotFound);
  }

  await h4.rotate('K2', 'v2-new');
  assert.strictEqual(await h4.get('K2'), 'v2-new');
  const blob4 = await h4._decryptVaultAge();
  assert.ok(blob4._meta.rotated_at.K2, 'rotated_at not set');

  await h4.rotate('GENERATED');
  const gen = await h4.get('GENERATED');
  assert.strictEqual(gen.length, 64);
  assert.ok(/^[0-9a-f]+$/.test(gen), 'not hex');

  const v = await h4.verify();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.count, 2);
  console.log('delete/rotate/verify OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
