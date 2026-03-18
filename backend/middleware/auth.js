const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/database');
const { authenticate } = require('../middleware/auth');


// ─── LOGIN ──────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        const result = await db.query(
            `SELECT u.*, h.name as hospital_name, h.hospital_id as hosp_code, h.org_type, h.logo_url
             FROM users u
             LEFT JOIN hospitals h ON u.hospital_id = h.id
             WHERE u.email = $1`,
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        const user = result.rows[0];

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        const token = jwt.sign(
            { userId: user.id, role: user.role, hospitalId: user.hospital_id },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        return res.json({
            success: true,
            token,
            user
        });

    } catch (error) {
        console.error('Login error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});


// 🔥 FIX ROUTE (IMPORTANT)
router.post('/register', async (req, res) => {
    try {
        req.url = '/register-hospital';
        return router.handle(req, res);
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Route error' });
    }
});


// ─── REGISTER HOSPITAL ─────────────────────────
router.post('/register-hospital', async (req, res) => {
    try {
        const {
            hospital_name, hospital_type,
            address, city, state, phone, email,
            admin_first_name, admin_last_name,
            admin_email, admin_phone, admin_password
        } = req.body;

        if (!hospital_name || !admin_email || !admin_password) {
            return res.status(400).json({ success: false, message: 'Required fields missing' });
        }

        const hospCount = await db.query('SELECT COUNT(*) FROM hospitals');
        const hospCode  = `HOS-${String(parseInt(hospCount.rows[0].count) + 1).padStart(3, '0')}`;

        const hospResult = await db.query(
            `INSERT INTO hospitals (hospital_id, name, org_type, phone, email, address, city, state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [hospCode, hospital_name, hospital_type || 'hospital', phone, email, address, city, state]
        );

        const hId = hospResult.rows[0].id;

        const passwordHash = await bcrypt.hash(admin_password, 10);
        const adminName = `${admin_first_name || ''} ${admin_last_name || ''}`.trim();

        await db.query(
            `INSERT INTO users (hospital_id, name, email, phone, password_hash, role)
             VALUES ($1,$2,$3,$4,$5,'super_admin')`,
            [hId, adminName, admin_email.toLowerCase(), admin_phone, passwordHash]
        );

        const depts = ['General Medicine','Emergency','Radiology','Pathology','Pediatrics'];
        for (let d of depts) {
            await db.query('INSERT INTO departments (hospital_id, name) VALUES ($1,$2)', [hId, d]);
        }

        return res.status(201).json({
            success: true,
            message: 'Hospital registered successfully'
        });

    } catch (error) {
        console.error('Register error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});


// ─── ME ─────────────────────────
router.get('/me', authenticate, async (req, res) => {
    return res.json({ success: true, user: req.user });
});

module.exports = router;
