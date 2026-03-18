const { Pool } = require('pg');

/**
 * Create PostgreSQL connection pool
 * Uses DATABASE_URL from environment (Railway provides this automatically)
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    max: 20,                  // maximum number of clients in pool
    idleTimeoutMillis: 30000, // close idle clients after 30 seconds
    connectionTimeoutMillis: 2000
});

/**
 * Log successful connections
 */
pool.on('connect', () => {
    console.log('✅ PostgreSQL connected');
});

/**
 * Handle unexpected errors
 */
pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err.message);
});

/**
 * Helper function for queries
 */
const query = async (text, params) => {
    const start = Date.now();

    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;

        if (process.env.NODE_ENV !== 'production') {
            console.log('SQL:', {
                query: text.substring(0, 80),
                duration: `${duration}ms`,
                rows: res.rowCount
            });
        }

        return res;

    } catch (error) {
        console.error('❌ Query error:', error.message);
        throw error;
    }
};

/**
 * Get raw client for transactions
 */
const getClient = async () => {
    const client = await pool.connect();
    return client;
};

/**
 * Simple database health test
 */
const testConnection = async () => {
    try {
        const res = await pool.query('SELECT NOW()');
        console.log('🟢 DB time:', res.rows[0].now);
        return true;
    } catch (err) {
        console.error('🔴 DB connection failed:', err.message);
        return false;
    }
};

module.exports = {
    pool,
    query,
    getClient,
    testConnection
};
