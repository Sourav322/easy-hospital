const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
    if (process.env.NODE_ENV !== 'production') {
        console.log('✅ Connected to PostgreSQL');
    }
});

pool.on('error', (err) => {
    console.error('❌ PostgreSQL error:', err.message);
});

const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        if (process.env.NODE_ENV === 'development') {
            console.log('Query executed:', { text: text.substring(0, 50), duration, rows: res.rowCount });
        }
        return res;
    } catch (error) {
        console.error('Query error:', error.message);
        throw error;
    }
};

const getClient = () => pool.connect();

module.exports = { query, getClient, pool };

