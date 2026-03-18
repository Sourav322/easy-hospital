const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Logs
pool.on('connect', () => {
  console.log('✅ PostgreSQL Connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL Pool Error:', err.message);
});

module.exports = pool;
