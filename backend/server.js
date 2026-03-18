
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const { rateLimit } = require('express-rate-limit');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Security Middleware ───────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
    origin: (origin, cb) => {
        const allowed = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim());
        // Allow requests with no origin (mobile apps, curl, etc.) and allowed origins
        if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
        return cb(new Error('CORS: Origin not allowed'));
    },
    methods:      ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials:  true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging (skip in test)
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// General rate limiter (API)
app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max:      500,
    message:  { success: false, message: 'Too many requests, please try again later.' }
}));

// ─── Static Files ──────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend from /frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── API Routes ────────────────────────────────────────────────
const authRoutes    = require('./routes/auth');
const patientRoutes = require('./routes/patients');
const { appointmentRouter, opdRouter, ipdRouter } = require('./routes/medical');
const {
    labRouter, billingRouter, staffRouter, inventoryRouter,
    dashboardRouter, doctorsRouter, reportsRouter, settingsRouter
} = require('./routes/modules');

app.use('/api/auth',        authRoutes);
app.use('/api/patients',    patientRoutes);
app.use('/api/doctors',     doctorsRouter);
app.use('/api/appointments', appointmentRouter);
app.use('/api/opd',         opdRouter);
app.use('/api/ipd',         ipdRouter);
app.use('/api/lab',         labRouter);
app.use('/api/billing',     billingRouter);
app.use('/api/staff',       staffRouter);
app.use('/api/inventory',   inventoryRouter);
app.use('/api/dashboard',   dashboardRouter);
app.use('/api/reports',     reportsRouter);
app.use('/api/settings',    settingsRouter);

// ─── Health Check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        success:   true,
        message:   'Easy Hospital HMS API is running',
        version:   '1.0.0',
        env:       process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString()
    });
});

// ─── Frontend catch-all ────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── Global Error Handler ──────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.stack);
    res.status(500).json({
        success: false,
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
});

// ─── Start Server ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   🏥  Easy Hospital HMS                      ║
║   Port  : ${PORT}                                ║
║   Mode  : ${(process.env.NODE_ENV || 'development').padEnd(12)}                ║
║   Health: /api/health                        ║
╚══════════════════════════════════════════════╝
    `);
});

module.exports = app;
