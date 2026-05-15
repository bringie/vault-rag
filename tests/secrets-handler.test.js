const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { SecretsHandler } = require('../scripts/secrets-handler.js');

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

(async () => {
  const t = makeTmp();
  const initial = { _meta: { schema: 1, version: 1, rotated_at: {} } };
  execSync(
    `echo '${JSON.stringify(initial)}' | age -R ${t.recipients} -o ${t.vaultAge}`,
  );

  const h = new SecretsHandler({
    ageKeyPath: t.ageKey,
    recipientsPath: t.recipients,
    vaultAgePath: t.vaultAge,
    repoPath: t.dir,
    skipGit: true,
  });
  const blob = await h._decryptVaultAge();
  assert.strictEqual(blob._meta.version, 1);
  console.log('round-trip OK');
})();
