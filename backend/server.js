require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// DB
const pool = require('./config/database');

/* ================= MIDDLEWARE ================= */

app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://easy-hospital.vercel.app',
    'https://web-production-b4bc9.up.railway.app'
  ],
  methods: ['GET','POST','PUT','DELETE','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(morgan('dev'));

/* ================= RATE LIMIT ================= */

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
}));

/* ================= ROUTES ================= */

const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

/* ================= HEALTH ================= */

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Easy Hospital HMS API running'
  });
});

/* ================= DB TEST ================= */

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= ROOT ================= */

app.get('/', (req, res) => {
  res.send('Easy Hospital HMS API running');
});

/* ================= ERROR ================= */

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Server Error' });
});

/* ================= SERVER ================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
