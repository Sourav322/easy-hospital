const jwt = require('jsonwebtoken');
const db = require('../config/database');

const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const userResult = await db.query(
            'SELECT u.*, h.hospital_id as hosp_code, h.name as hospital_name, h.org_type FROM users u LEFT JOIN hospitals h ON u.hospital_id = h.id WHERE u.id = $1 AND u.is_active = true',
            [decoded.userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User not found or inactive' });
        }

        req.user = userResult.rows[0];
        req.hospitalId = userResult.rows[0].hospital_id;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: 'Token expired' });
        }
        return res.status(500).json({ success: false, message: 'Authentication error' });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ 
                success: false, 
                message: `Access denied. Required roles: ${roles.join(', ')}` 
            });
        }
        next();
    };
};

// Role permissions map
const PERMISSIONS = {
    super_admin: ['*'],
    hospital_admin: ['patients', 'doctors', 'appointments', 'opd', 'ipd', 'lab', 'billing', 'staff', 'inventory', 'reports', 'settings'],
    doctor: ['patients:read', 'appointments:read', 'opd:write', 'lab:read', 'prescriptions:write'],
    receptionist: ['patients:write', 'appointments:write', 'patients:read', 'doctors:read'],
    nurse: ['patients:read', 'ipd:write', 'nurse_notes:write'],
    lab_tech: ['lab:write', 'patients:read'],
    billing: ['billing:write', 'patients:read'],
    staff: ['patients:read', 'appointments:read']
};

const hasPermission = (role, permission) => {
    const perms = PERMISSIONS[role] || [];
    return perms.includes('*') || perms.includes(permission) || perms.some(p => p.startsWith(permission.split(':')[0] + ':'));
};

module.exports = { authenticate, authorize, hasPermission };
