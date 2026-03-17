const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }

        const result = await db.query(
            `SELECT u.*, h.name as hospital_name, h.hospital_id as hosp_code, h.org_type, h.logo_url
             FROM users u 
             LEFT JOIN hospitals h ON u.hospital_id = h.id 
             WHERE u.email = $1 AND u.is_active = true`,
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Update last login
        await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        const token = jwt.sign(
            { userId: user.id, role: user.role, hospitalId: user.hospital_id },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );

        const refreshToken = jwt.sign(
            { userId: user.id },
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + '_refresh',
            { expiresIn: '7d' }
        );

        return res.json({
            success: true,
            message: 'Login successful',
            token,
            refreshToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                hospitalId: user.hospital_id,
                hospitalName: user.hospital_name,
                hospCode: user.hosp_code,
                orgType: user.org_type,
                logoUrl: user.logo_url,
                avatar: user.avatar_url
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/auth/register-hospital
router.post('/register-hospital', async (req, res) => {
    try {
        const { hospitalName, orgType, adminName, adminEmail, adminPassword, phone, city, state, planName } = req.body;

        // Check if email already exists
        const existing = await db.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }

        // Get plan
        const plan = await db.query('SELECT id FROM subscription_plans WHERE name = $1', [planName || 'Starter']);
        const planId = plan.rows[0]?.id;

        // Generate hospital ID
        const hospCount = await db.query('SELECT COUNT(*) FROM hospitals');
        const hospNum = String(parseInt(hospCount.rows[0].count) + 1).padStart(3, '0');
        const hospitalId = `HOS-${hospNum}`;

        // Create hospital
        const hospResult = await db.query(
            `INSERT INTO hospitals (hospital_id, name, org_type, phone, city, state, plan_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [hospitalId, hospitalName, orgType || 'hospital', phone, city, state, planId]
        );

        const hId = hospResult.rows[0].id;

        // Hash password
        const passwordHash = await bcrypt.hash(adminPassword, 12);

        // Create admin user
        await db.query(
            `INSERT INTO users (hospital_id, name, email, phone, password_hash, role)
             VALUES ($1, $2, $3, $4, $5, 'hospital_admin')`,
            [hId, adminName, adminEmail, phone, passwordHash]
        );

        // Create default departments
        const defaultDepts = ['General Medicine', 'Emergency', 'Radiology', 'Pathology'];
        for (const dept of defaultDepts) {
            await db.query('INSERT INTO departments (hospital_id, name) VALUES ($1, $2)', [hId, dept]);
        }

        return res.status(201).json({
            success: true,
            message: 'Hospital registered successfully',
            hospitalId
        });
    } catch (error) {
        console.error('Register hospital error:', error);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
    try {
        return res.json({
            success: true,
            user: {
                id: req.user.id,
                name: req.user.name,
                email: req.user.email,
                role: req.user.role,
                hospitalId: req.user.hospital_id,
                hospitalName: req.user.hospital_name,
                phone: req.user.phone,
                avatar: req.user.avatar_url
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const user = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        
        const isMatch = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

        return res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
