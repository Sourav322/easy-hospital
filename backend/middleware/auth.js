const jwt = require('jsonwebtoken');
const db = require('../config/database');

// ─── Authenticate ──────────────────────────────────────────────
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const userResult = await db.query(
            `SELECT u.id, u.name, u.email, u.role, u.hospital_id, u.is_active, u.avatar_url, u.phone,
                    h.hospital_id as hosp_code, h.name as hospital_name, h.org_type
             FROM users u
             LEFT JOIN hospitals h ON u.hospital_id = h.id
             WHERE u.id = $1 AND u.is_active = true`,
            [decoded.userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User not found or inactive' });
        }

        req.user       = userResult.rows[0];
        req.hospitalId = userResult.rows[0].hospital_id;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') return res.status(401).json({ success: false, message: 'Invalid token' });
        if (error.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired, please login again' });
        return res.status(500).json({ success: false, message: 'Authentication error' });
    }
};

// ─── Authorize (role guard) ────────────────────────────────────
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Access denied. Insufficient role.' });
        }
        next();
    };
};

// ─── Role → Permissions Map ───────────────────────────────────
//
//  ROLES (4 client roles):
//  ┌──────────────┬────────────────────────────────────────────────────┐
//  │ super_admin  │ Full control — all hospitals, all modules           │
//  │ doctor       │ Clinical — appointments, OPD, lab orders, IPD view  │
//  │ reception    │ Front-desk — patients, appointments, queue           │
//  │ payment_desk │ Finance — billing, invoices, payment recording       │
//  └──────────────┴────────────────────────────────────────────────────┘
//
const PERMISSIONS = {
    super_admin: ['*'],

    doctor: [
        'patients:read',
        'appointments:read',
        'appointments:write',
        'opd:read',
        'opd:write',
        'ipd:read',
        'lab:read',
        'lab:write',
        'prescriptions:read',
        'prescriptions:write'
    ],

    reception: [
        'patients:read',
        'patients:write',
        'appointments:read',
        'appointments:write',
        'doctors:read',
        'queue:read',
        'queue:write'
    ],

    payment_desk: [
        'patients:read',
        'billing:read',
        'billing:write',
        'payments:read',
        'payments:write',
        'invoices:read',
        'invoices:write',
        'reports:read'
    ]
};

const hasPermission = (role, permission) => {
    const perms = PERMISSIONS[role] || [];
    if (perms.includes('*')) return true;
    if (perms.includes(permission)) return true;
    const resource = permission.split(':')[0];
    return perms.some(p => p.startsWith(resource + ':'));
};

const requirePermission = (permission) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (!hasPermission(req.user.role, permission)) {
            return res.status(403).json({ success: false, message: `Access denied. '${req.user.role}' role cannot perform '${permission}'.` });
        }
        next();
    };
};

module.exports = { authenticate, authorize, hasPermission, requirePermission };
