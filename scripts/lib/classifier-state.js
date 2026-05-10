async function lookup(pg, path) {
  const { rows } = await pg.query(
    `SELECT * FROM inbox_classifier_state WHERE path=$1`,
    [path]
  );
  return rows[0] || null;
}

async function claim(pg, path, sha) {
  const existing = await lookup(pg, path);
  if (!existing) {
    await pg.query(
      `INSERT INTO inbox_classifier_state (path, sha, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (path) DO NOTHING`,
      [path, sha]
    );
  }
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='processing', started_at=now(), sha=$1, updated_at=now()
      WHERE path=$2`,
    [sha, path]
  );
}

async function markDone(pg, path, { target_folder, confidence }) {
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='done',
            target_folder=$1,
            confidence=$2,
            classified_at=now(),
            last_error=NULL,
            updated_at=now()
      WHERE path=$3`,
    [target_folder, confidence, path]
  );
}

async function markDeadletter(pg, path, { last_error, attempts }) {
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='deadletter',
            last_error=$1,
            attempts=$2,
            updated_at=now()
      WHERE path=$3`,
    [last_error, attempts, path]
  );
}

async function release(pg, path, { last_error, attempts }) {
  await pg.query(
    `UPDATE inbox_classifier_state
        SET status='pending',
            last_error=$1,
            attempts=$2,
            updated_at=now()
      WHERE path=$3`,
    [last_error, attempts, path]
  );
}

async function recoverStaleProcessing(pg) {
  const r = await pg.query(
    `UPDATE inbox_classifier_state
        SET status='pending', attempts=attempts+1, updated_at=now()
      WHERE status='processing'
        AND started_at < now() - interval '5 min'
      RETURNING path`
  );
  return (r.rows || []).map(x => x.path);
}

module.exports = { lookup, claim, markDone, markDeadletter, release, recoverStaleProcessing };
