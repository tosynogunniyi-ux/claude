require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const DIR = path.join(__dirname, 'sql');

// Hosts that start containers without ordering them — Easypanel, Dokku, plain
// `docker run` — will start this before Postgres is accepting connections.
// Without this wait the first migration fails, the container exits, and the
// platform restart-loops it, which reads as "the app won't start".
async function waitForDatabase(timeoutMs = 90000) {
  const started = Date.now();
  let lastError = null;
  let announced = false;

  while (Date.now() - started < timeoutMs) {
    try {
      await pool.query('SELECT 1');
      if (announced) console.log('database is accepting connections');
      return;
    } catch (err) {
      lastError = err;
      if (!announced) {
        console.log('waiting for the database at ' + describeTarget() + ' …');
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(
    'could not reach the database at ' + describeTarget() + ' after ' +
    Math.round(timeoutMs / 1000) + 's: ' + (lastError && lastError.message) +
    '\nCheck DATABASE_URL. Common causes: the database service is in a different' +
    ' project so its hostname does not resolve, or a special character in the' +
    ' password is not percent-encoded (% must be written %25).'
  );
}

// Host, port and database only — never the password, since this reaches logs.
function describeTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return '(DATABASE_URL is not set)';
  try {
    const u = new URL(raw);
    return u.hostname + ':' + (u.port || '5432') + u.pathname + ' as ' + (u.username || '(no user)');
  } catch {
    return '(DATABASE_URL is not a valid URL)';
  }
}

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — the server has no database to connect to.');
  }
  await waitForDatabase();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied ' + file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error('migration ' + file + ' failed: ' + err.message);
    } finally {
      client.release();
    }
  }
  console.log('migrations up to date (' + files.length + ' total)');
}

migrate()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
