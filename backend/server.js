require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ===== MIDDLEWARE =====
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Static files (uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// ===== ROUTES =====
const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patients');
const { appointmentRouter, opdRouter, ipdRouter } = require('./routes/medical');
const { labRouter, billingRouter, staffRouter, inventoryRouter, dashboardRouter, doctorsRouter, reportsRouter, settingsRouter } = require('./routes/modules');

app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/doctors', doctorsRouter);
app.use('/api/appointments', appointmentRouter);
app.use('/api/opd', opdRouter);
app.use('/api/ipd', ipdRouter);
app.use('/api/lab', labRouter);
app.use('/api/billing', billingRouter);
app.use('/api/staff', staffRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/settings', settingsRouter);

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Easy Hospital HMS API is running',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err.stack);
    res.status(500).json({
        success: false,
        message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   🏥 Easy Hospital HMS Server            ║
║   Running on port ${PORT}                   ║
║   Environment: ${process.env.NODE_ENV || 'development'}              ║
╚══════════════════════════════════════════╝
    `);
});

module.exports = app;
