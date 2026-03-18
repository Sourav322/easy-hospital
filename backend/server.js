require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

// DATABASE
const pool = require('./config/database');

const app = express();
const PORT = process.env.PORT || 8080;

/* ================= DATABASE CONNECTION ================= */

pool.connect()
  .then(() => console.log('✅ PostgreSQL Connected'))
  .catch(err => console.error('❌ PostgreSQL Connection Error:', err.message));


/* ================= MIDDLEWARE ================= */

app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5000',
        'https://easy-hospital.vercel.app',
        'https://web-production-b4bc9.up.railway.app'
    ],
    methods: ['GET','POST','PUT','DELETE','PATCH'],
    allowedHeaders: ['Content-Type','Authorization'],
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));


/* ================= RATE LIMIT ================= */

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success:false, message:'Too many requests' }
});

app.use('/api/', limiter);


/* ================= STATIC FILES ================= */

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


/* ================= ROUTES ================= */

const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patients');

const { appointmentRouter, opdRouter, ipdRouter } = require('./routes/medical');

const {
    labRouter,
    billingRouter,
    staffRouter,
    inventoryRouter,
    dashboardRouter,
    doctorsRouter,
    reportsRouter,
    settingsRouter
} = require('./routes/modules');

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


/* ================= HEALTH CHECK ================= */

app.get('/api/health', (req,res)=>{
    res.json({
        success:true,
        message:'Easy Hospital HMS API running',
        version:'1.0.0',
        time:new Date()
    });
});


/* ================= DATABASE TEST ================= */

app.get('/api/db-test', async (req,res)=>{
    try{
        const result = await pool.query('SELECT NOW()');
        res.json({ success:true, dbTime: result.rows[0] });
    }catch(err){
        res.status(500).json({ success:false, error: err.message });
    }
});


/* ================= ROOT ROUTE ================= */

app.get('/', (req,res)=>{
    res.send('Easy Hospital HMS API running');
});


/* ================= ERROR HANDLER ================= */

app.use((err,req,res,next)=>{
    console.error(err.stack);

    res.status(500).json({
        success:false,
        message: process.env.NODE_ENV === 'production'
        ? 'Server Error'
        : err.message
    });
});


/* ================= SERVER ================= */

app.listen(PORT, ()=>{
    console.log(`
🚀 Easy Hospital HMS Server Started
🌐 Port: ${PORT}
📦 Environment: ${process.env.NODE_ENV}
    `);
});

module.exports = app;
