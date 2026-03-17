const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const QRCode = require('qrcode');

// Generate UHID
const generateUHID = async (hospitalId) => {
    const hospResult = await db.query('SELECT hospital_id FROM hospitals WHERE id = $1', [hospitalId]);
    const hospCode = hospResult.rows[0].hospital_id.replace('HOS-', '');
    const countResult = await db.query('SELECT COUNT(*) FROM patients WHERE hospital_id = $1', [hospitalId]);
    const count = String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0');
    return `UHID-${hospCode}-${count}`;
};

// GET all patients
router.get('/', authenticate, async (req, res) => {
    try {
        const { search, page = 1, limit = 20, bloodGroup, gender } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['p.hospital_id = $1'];
        let params = [req.hospitalId];
        let idx = 2;

        if (search) {
            conditions.push(`(p.name ILIKE $${idx} OR p.phone ILIKE $${idx} OR p.uhid ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }
        if (bloodGroup) {
            conditions.push(`p.blood_group = $${idx}`);
            params.push(bloodGroup);
            idx++;
        }
        if (gender) {
            conditions.push(`p.gender = $${idx}`);
            params.push(gender);
            idx++;
        }

        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT p.*, 
                    (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id) as total_appointments,
                    (SELECT MAX(appointment_date) FROM appointments a WHERE a.patient_id = p.id) as last_visit
             FROM patients p WHERE ${where} ORDER BY p.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );

        const total = await db.query(`SELECT COUNT(*) FROM patients p WHERE ${where}`, params);

        return res.json({
            success: true,
            data: result.rows,
            pagination: {
                total: parseInt(total.rows[0].count),
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total.rows[0].count / limit)
            }
        });
    } catch (error) {
        console.error('Get patients error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET single patient
router.get('/:id', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM patients WHERE id = $1 AND hospital_id = $2',
            [req.params.id, req.hospitalId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Patient not found' });
        }

        // Get medical history
        const history = await db.query(
            `SELECT pmh.*, u.name as doctor_name FROM patient_medical_history pmh
             LEFT JOIN users u ON pmh.doctor_id = u.id
             WHERE pmh.patient_id = $1 ORDER BY pmh.recorded_at DESC`,
            [req.params.id]
        );

        // Get recent appointments
        const appointments = await db.query(
            `SELECT a.*, d.name as doctor_name, d.specialization FROM appointments a
             LEFT JOIN doctors d ON a.doctor_id = d.id
             WHERE a.patient_id = $1 ORDER BY a.appointment_date DESC LIMIT 5`,
            [req.params.id]
        );

        return res.json({
            success: true,
            data: {
                ...result.rows[0],
                medicalHistory: history.rows,
                recentAppointments: appointments.rows
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST create patient
router.post('/', authenticate, async (req, res) => {
    try {
        const {
            name, age, dob, gender, phone, alternatePhone, email, address, city, state, pincode,
            bloodGroup, allergyNotes, emergencyContactName, emergencyContactPhone, emergencyContactRelation
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ success: false, message: 'Name and phone required' });
        }

        // Check duplicate phone in same hospital
        const dupCheck = await db.query(
            'SELECT id FROM patients WHERE phone = $1 AND hospital_id = $2',
            [phone, req.hospitalId]
        );
        if (dupCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Patient with this phone already exists' });
        }

        const uhid = await generateUHID(req.hospitalId);

        // Generate QR code
        const qrData = JSON.stringify({ uhid, name, phone, hospitalId: req.hospitalId });
        const qrCode = await QRCode.toDataURL(qrData);

        const result = await db.query(
            `INSERT INTO patients (hospital_id, uhid, name, age, dob, gender, phone, alternate_phone, email,
             address, city, state, pincode, blood_group, allergy_notes, emergency_contact_name,
             emergency_contact_phone, emergency_contact_relation, qr_code, registered_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
            [req.hospitalId, uhid, name, age, dob, gender, phone, alternatePhone, email,
             address, city, state, pincode, bloodGroup, allergyNotes, emergencyContactName,
             emergencyContactPhone, emergencyContactRelation, qrCode, req.user.id]
        );

        return res.status(201).json({ success: true, message: 'Patient registered', data: result.rows[0] });
    } catch (error) {
        console.error('Create patient error:', error);
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
});

// PUT update patient
router.put('/:id', authenticate, async (req, res) => {
    try {
        const {
            name, age, dob, gender, phone, alternatePhone, email, address, city, state, pincode,
            bloodGroup, allergyNotes, emergencyContactName, emergencyContactPhone, emergencyContactRelation
        } = req.body;

        const result = await db.query(
            `UPDATE patients SET name=$1, age=$2, dob=$3, gender=$4, phone=$5, alternate_phone=$6,
             email=$7, address=$8, city=$9, state=$10, pincode=$11, blood_group=$12, allergy_notes=$13,
             emergency_contact_name=$14, emergency_contact_phone=$15, emergency_contact_relation=$16,
             updated_at=NOW() WHERE id=$17 AND hospital_id=$18 RETURNING *`,
            [name, age, dob, gender, phone, alternatePhone, email, address, city, state, pincode,
             bloodGroup, allergyNotes, emergencyContactName, emergencyContactPhone, emergencyContactRelation,
             req.params.id, req.hospitalId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Patient not found' });
        }
        return res.json({ success: true, message: 'Patient updated', data: result.rows[0] });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// DELETE patient
router.delete('/:id', authenticate, authorize('hospital_admin', 'super_admin'), async (req, res) => {
    try {
        await db.query('UPDATE patients SET is_active = false WHERE id = $1 AND hospital_id = $2', [req.params.id, req.hospitalId]);
        return res.json({ success: true, message: 'Patient deactivated' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET patient stats
router.get('/stats/summary', authenticate, async (req, res) => {
    try {
        const total = await db.query('SELECT COUNT(*) FROM patients WHERE hospital_id = $1 AND is_active = true', [req.hospitalId]);
        const today = await db.query(
            "SELECT COUNT(*) FROM patients WHERE hospital_id = $1 AND DATE(created_at) = CURRENT_DATE",
            [req.hospitalId]
        );
        const bloodGroups = await db.query(
            'SELECT blood_group, COUNT(*) as count FROM patients WHERE hospital_id = $1 AND blood_group IS NOT NULL GROUP BY blood_group',
            [req.hospitalId]
        );

        return res.json({
            success: true,
            data: {
                total: parseInt(total.rows[0].count),
                todayNew: parseInt(today.rows[0].count),
                bloodGroups: bloodGroups.rows
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
