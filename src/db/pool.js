/**
 * SugoNow — src/db/pool.js
 * PostgreSQL connection pool
 */
require('dotenv').config();
const { Pool } = require('pg');

// Railway (and most hosts) provide a single DATABASE_URL connection string and
// require SSL. Locally we use the separate DB_* vars with no SSL. This supports
// both: if DATABASE_URL is set, use it; otherwise fall back to the local vars.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
    })
  : new Pool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max:      20,
      idleTimeoutMillis: 30000,
    });

pool.on('error', (err) => console.error('PG pool error:', err));

const query = (text, params) => pool.query(text, params);

const withTransaction = async (fn) => {
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
};

module.exports = { pool, query, withTransaction };
