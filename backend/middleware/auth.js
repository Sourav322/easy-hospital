const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/database');
const { authenticate } = require('../middleware/auth');


// ─── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate input
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }
        if (typeof email !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ success: false, message: 'Invalid input' });
        }

        const result = await db.query(
            `SELECT u.id, u.name, u.email, u.role, u.hospital_id, u.password_hash, u.is_active, u.avatar_url, u.phone,
                    h.name as hospital_name, h.hospital_id as hosp_code, h.org_type, h.logo_url
             FROM users u
             LEFT JOIN hospitals h ON u.hospital_id = h.id
             WHERE u.email = $1`,
            [email.toLowerCase().trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.status(401).json({ success: false, message: 'Account is deactivated. Contact your administrator.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // Update last login timestamp
        await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        // Sign tokens
        const token = jwt.sign(
            { userId: user.id, role: user.role, hospitalId: user.hospital_id },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        const refreshToken = jwt.sign(
            { userId: user.id },
            process.env.JWT_REFRESH_SECRET,
            { expiresIn: '7d' }
        );

        return res.json({
            success: true,
            message: 'Login successful',
            token,
            refreshToken,
            user: {
                id:           user.id,
                name:         user.name,
                email:        user.email,
                role:         user.role,
                hospitalId:   user.hospital_id,
                hospitalName: user.hospital_name,
                hospCode:     user.hosp_code,
                orgType:      user.org_type,
                logoUrl:      user.logo_url,
                avatar:       user.avatar_url,
                phone:        user.phone
            }
        });
    } catch (error) {
        console.error('Login error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ─── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const userResult = await db.query(
            'SELECT id, role, hospital_id, is_active FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );

        if (!userResult.rows[0]) return res.status(401).json({ success: false, message: 'User not found' });

        const user = userResult.rows[0];
        const newToken = jwt.sign(
            { userId: user.id, role: user.role, hospitalId: user.hospital_id },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        return res.json({ success: true, token: newToken });
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }
});

// ─── POST /api/auth/register-hospital ─────────────────────────
router.post('/register-hospital', async (req, res) => {
    try {
        const {
            hospital_name, hospital_type, bed_capacity,
            address, city, state, phone, email,
            admin_first_name, admin_last_name, admin_email, admin_phone, admin_password,
            plan
        } = req.body;

        // Validate required fields
        const required = { hospital_name, admin_email, admin_password };
        for (const [key, val] of Object.entries(required)) {
            if (!val) return res.status(400).json({ success: false, message: `${key} is required` });
        }

        if (admin_password.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }

        // Check duplicate admin email
        const existing = await db.query('SELECT id FROM users WHERE email = $1', [admin_email.toLowerCase()]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already registered' });
        }

        // Generate hospital code
        const hospCount = await db.query('SELECT COUNT(*) FROM hospitals');
        const hospCode  = `HOS-${String(parseInt(hospCount.rows[0].count) + 1).padStart(3, '0')}`;

        // Create hospital
        const hospResult = await db.query(
            `INSERT INTO hospitals (hospital_id, name, org_type, phone, email, address, city, state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [hospCode, hospital_name, hospital_type || 'hospital', phone, email, address, city, state]
        );
        const hId = hospResult.rows[0].id;

        // Hash password
        const passwordHash = await bcrypt.hash(admin_password, 12);
        const adminName    = `${admin_first_name || ''} ${admin_last_name || ''}`.trim();

        // Create admin user
        await db.query(
            `INSERT INTO users (hospital_id, name, email, phone, password_hash, role)
             VALUES ($1, $2, $3, $4, $5, 'super_admin')`,
            [hId, adminName, admin_email.toLowerCase(), admin_phone, passwordHash]
        );

        // Seed default departments
        const defaultDepts = ['General Medicine', 'Emergency', 'Radiology', 'Pathology', 'Pediatrics'];
        for (const dept of defaultDepts) {
            await db.query('INSERT INTO departments (hospital_id, name) VALUES ($1, $2)', [hId, dept]);
        }

        return res.status(201).json({
            success: true,
            message: 'Hospital registered successfully. You can now login.',
            hospitalId: hospCode
        });
    } catch (error) {
        console.error('Register hospital error:', error.message);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ─── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
    try {
        return res.json({
            success: true,
            user: {
                id:           req.user.id,
                name:         req.user.name,
                email:        req.user.email,
                role:         req.user.role,
                hospitalId:   req.user.hospital_id,
                hospitalName: req.user.hospital_name,
                phone:        req.user.phone,
                avatar:       req.user.avatar_url
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ─── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Both current and new password are required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
        }

        const userResult = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        const isMatch = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);

        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);

        return res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ─── POST /api/auth/create-staff ──────────────────────────────
router.post('/create-staff', authenticate, async (req, res) => {
    try {
        // Only super_admin can create users
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: 'Only Super Admin can create staff accounts' });
        }

        const { name, email, password, role, phone } = req.body;
        const allowedRoles = ['super_admin', 'doctor', 'reception', 'payment_desk'];

        if (!name || !email || !password || !role) {
            return res.status(400).json({ success: false, message: 'Name, email, password and role are required' });
        }
        if (!allowedRoles.includes(role)) {
            return res.status(400).json({ success: false, message: `Role must be one of: ${allowedRoles.join(', ')}` });
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }

        const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const result = await db.query(
            `INSERT INTO users (hospital_id, name, email, phone, password_hash, role)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, role`,
            [req.hospitalId, name, email.toLowerCase(), phone, passwordHash, role]
        );

        return res.status(201).json({ success: true, message: 'Staff account created', data: result.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
