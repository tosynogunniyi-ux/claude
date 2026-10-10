const { Pool, types } = require('pg');

// NUMERIC arrives as a string by default; every numeric column here is money
// or a quantity that the ledger arithmetic treats as a number.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE as the plain 'YYYY-MM-DD' the UI compares and sorts on, rather than a
// Date object that would shift across timezones on serialisation.
types.setTypeParser(1082, (v) => v);

// Every wait here is bounded. `pg` defaults to waiting forever for a free
// connection and to letting a query run forever, so one slow statement or one
// leaked client is enough to make every later request hang — and a request
// that never answers is served by whatever sits in front of the app as its
// own error page, which is HTML and tells the customer nothing. Failing in a
// few seconds with a real error is worth far more than a wait with no end.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PGPOOL_MAX || 10),
  // Give up queueing for a connection rather than stacking requests up behind
  // a pool that is not coming back.
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
  idleTimeoutMillis: 30000,
  // Belt and braces: the server cancels a runaway statement, and the client
  // stops waiting for one even if the server does not.
  statement_timeout: Number(process.env.PGSTATEMENT_TIMEOUT_MS || 15000),
  query_timeout: Number(process.env.PGQUERY_TIMEOUT_MS || 15000)
});

// A pool that emits an error with no listener takes the process down with it,
// which turns a dropped connection into a restart and a blank page.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
