/**
 * SugoNow — Reset admin password
 * Run: node resetpassword.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function resetPassword() {
  try {
    const newPassword = 'Admin123';
    const hash        = await bcrypt.hash(newPassword, 12);
    const result      = await pool.query(
      "UPDATE users SET password_hash=$1 WHERE role='admin'",
      [hash]
    );
    console.log('✅ Admin password updated to:', newPassword);
    console.log('Updated rows:', result.rowCount);
    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
  }
}

resetPassword();
