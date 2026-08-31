const { Pool, types } = require('pg');

// NUMERIC arrives as a string by default; every numeric column here is money
// or a quantity that the ledger arithmetic treats as a number.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// DATE as the plain 'YYYY-MM-DD' the UI compares and sorts on, rather than a
// Date object that would shift across timezones on serialisation.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined
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
