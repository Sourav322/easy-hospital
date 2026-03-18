require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Database ──────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = (text, params) => pool.query(text, params);

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Auth Middleware ───────────────────────────────────────────
const auth = async (req, res, next) => {
    try {
        const h = req.headers.authorization;
        if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'No token' });
        const decoded = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
        const r = await db('SELECT u.*, h.name as hospital_name, h.hospital_id as hosp_code FROM users u LEFT JOIN hospitals h ON u.hospital_id = h.id WHERE u.id = $1 AND u.is_active = true', [decoded.userId]);
        if (!r.rows[0]) return res.status(401).json({ success: false, message: 'User not found' });
        req.user = r.rows[0];
        req.hospitalId = r.rows[0].hospital_id;
        next();
    } catch (e) {
        if (e.name === 'TokenExpiredError') return res.status(401).json({ success: false, message: 'Token expired' });
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
};

// ════════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ success: true, message: 'Easy Hospital HMS API is running', version: '1.0.0', env: process.env.NODE_ENV || 'production' }));

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
        const r = await db(`SELECT u.*, h.name as hospital_name, h.hospital_id as hosp_code, h.org_type FROM users u LEFT JOIN hospitals h ON u.hospital_id = h.id WHERE u.email = $1`, [email.toLowerCase().trim()]);
        if (!r.rows[0]) return res.status(401).json({ success: false, message: 'Invalid email or password' });
        const user = r.rows[0];
        if (!user.is_active) return res.status(401).json({ success: false, message: 'Account deactivated' });
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password' });
        await db('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
        const token = jwt.sign({ userId: user.id, role: user.role, hospitalId: user.hospital_id }, process.env.JWT_SECRET, { expiresIn: '8h' });
        const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: '7d' });
        return res.json({ success: true, message: 'Login successful', token, refreshToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, hospitalId: user.hospital_id, hospitalName: user.hospital_name, hospCode: user.hosp_code, orgType: user.org_type } });
    } catch (e) { console.error('Login:', e.message); return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, hospitalId: req.user.hospital_id, hospitalName: req.user.hospital_name } }));

app.post('/api/auth/change-password', auth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword || newPassword.length < 8) return res.status(400).json({ success: false, message: 'Invalid input' });
        const r = await db('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        if (!await bcrypt.compare(currentPassword, r.rows[0].password_hash)) return res.status(400).json({ success: false, message: 'Current password incorrect' });
        await db('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [await bcrypt.hash(newPassword, 12), req.user.id]);
        return res.json({ success: true, message: 'Password changed' });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/auth/register-hospital', async (req, res) => {
    try {
        const { hospital_name, hospital_type, address, city, state, phone, email, admin_first_name, admin_last_name, admin_email, admin_phone, admin_password } = req.body;
        if (!hospital_name || !admin_email || !admin_password) return res.status(400).json({ success: false, message: 'Required fields missing' });
        if (admin_password.length < 8) return res.status(400).json({ success: false, message: 'Password min 8 chars' });
        const ex = await db('SELECT id FROM users WHERE email = $1', [admin_email.toLowerCase()]);
        if (ex.rows.length > 0) return res.status(400).json({ success: false, message: 'Email already registered' });
        const cnt = await db('SELECT COUNT(*) FROM hospitals');
        const hospCode = `HOS-${String(parseInt(cnt.rows[0].count) + 1).padStart(3, '0')}`;
        const hosp = await db(`INSERT INTO hospitals (hospital_id, name, org_type, phone, email, address, city, state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [hospCode, hospital_name, hospital_type || 'hospital', phone, email, address, city, state]);
        const hash = await bcrypt.hash(admin_password, 12);
        const adminName = `${admin_first_name || ''} ${admin_last_name || ''}`.trim();
        await db(`INSERT INTO users (hospital_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,'super_admin')`, [hosp.rows[0].id, adminName, admin_email.toLowerCase(), admin_phone, hash]);
        const depts = ['General Medicine', 'Emergency', 'Radiology', 'Pathology'];
        for (const d of depts) { try { await db('INSERT INTO departments (hospital_id, name) VALUES ($1,$2)', [hosp.rows[0].id, d]); } catch(e){} }
        return res.status(201).json({ success: true, message: 'Hospital registered! You can now login.', hospitalId: hospCode });
    } catch (e) { console.error('Register:', e.message); return res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.post('/api/auth/create-staff', auth, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Only Super Admin can create staff' });
        const { name, email, password, role, phone } = req.body;
        if (!name || !email || !password || !role) return res.status(400).json({ success: false, message: 'All fields required' });
        const ex = await db('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (ex.rows.length > 0) return res.status(400).json({ success: false, message: 'Email exists' });
        const hash = await bcrypt.hash(password, 12);
        const r = await db(`INSERT INTO users (hospital_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, role`, [req.hospitalId, name, email.toLowerCase(), phone, hash, role]);
        return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  PATIENTS
// ════════════════════════════════════════════════════════════
app.get('/api/patients/search', auth, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) return res.json({ success: true, data: [] });
        const r = await db(`SELECT id, uhid, name, phone, age, gender FROM patients WHERE hospital_id=$1 AND is_active=true AND (name ILIKE $2 OR phone ILIKE $2 OR uhid ILIKE $2) LIMIT 10`, [req.hospitalId, `%${q}%`]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/patients/stats/summary', auth, async (req, res) => {
    try {
        const [total, today] = await Promise.all([
            db('SELECT COUNT(*) FROM patients WHERE hospital_id=$1 AND is_active=true', [req.hospitalId]),
            db("SELECT COUNT(*) FROM patients WHERE hospital_id=$1 AND DATE(created_at)=CURRENT_DATE", [req.hospitalId])
        ]);
        return res.json({ success: true, data: { total: parseInt(total.rows[0].count), todayNew: parseInt(today.rows[0].count) } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/patients/:id', auth, async (req, res) => {
    try {
        const r = await db('SELECT * FROM patients WHERE id=$1 AND hospital_id=$2 AND is_active=true', [req.params.id, req.hospitalId]);
        if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
        const appts = await db(`SELECT a.*, d.name as doctor_name FROM appointments a LEFT JOIN doctors d ON a.doctor_id=d.id WHERE a.patient_id=$1 ORDER BY a.appointment_date DESC LIMIT 5`, [req.params.id]);
        return res.json({ success: true, data: { ...r.rows[0], recentAppointments: appts.rows } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/patients', auth, async (req, res) => {
    try {
        const { search, page=1, limit=20 } = req.query;
        const offset = (parseInt(page)-1)*parseInt(limit);
        let conditions = ['p.hospital_id=$1','p.is_active=true']; let params=[req.hospitalId]; let idx=2;
        if (search) { conditions.push(`(p.name ILIKE $${idx} OR p.phone ILIKE $${idx} OR p.uhid ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
        const where = conditions.join(' AND ');
        const r = await db(`SELECT p.id,p.uhid,p.name,p.age,p.gender,p.phone,p.blood_group,p.city,p.created_at FROM patients p WHERE ${where} ORDER BY p.created_at DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params, limit, offset]);
        const total = await db(`SELECT COUNT(*) FROM patients p WHERE ${where}`, params);
        return res.json({ success: true, data: r.rows, pagination: { total: parseInt(total.rows[0].count), page: parseInt(page) } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/patients', auth, async (req, res) => {
    try {
        const { name, age, dob, gender, phone, alternatePhone, email, address, city, state, pincode, bloodGroup, allergyNotes, emergencyContactName, emergencyContactPhone } = req.body;
        if (!name || !phone) return res.status(400).json({ success: false, message: 'Name and phone required' });
        const dup = await db('SELECT uhid FROM patients WHERE phone=$1 AND hospital_id=$2 AND is_active=true', [phone, req.hospitalId]);
        if (dup.rows.length > 0) return res.status(409).json({ success: false, message: `Already exists: ${dup.rows[0].uhid}` });
        const hc = await db('SELECT hospital_id FROM hospitals WHERE id=$1', [req.hospitalId]);
        const code = hc.rows[0].hospital_id.replace('HOS-','');
        const cnt = await db('SELECT COUNT(*) FROM patients WHERE hospital_id=$1', [req.hospitalId]);
        const uhid = `UHID-${code}-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
        const r = await db(`INSERT INTO patients (hospital_id,uhid,name,age,dob,gender,phone,alternate_phone,email,address,city,state,pincode,blood_group,allergy_notes,emergency_contact_name,emergency_contact_phone,registered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id,uhid,name,phone,age,gender`, [req.hospitalId,uhid,name,age,dob,gender,phone,alternatePhone,email,address,city,state,pincode,bloodGroup,allergyNotes,emergencyContactName,emergencyContactPhone,req.user.id]);
        return res.status(201).json({ success: true, message: 'Patient registered', data: r.rows[0] });
    } catch (e) { console.error(e.message); return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/patients/:id', auth, async (req, res) => {
    try {
        const { name, age, dob, gender, phone, alternatePhone, email, address, city, state, pincode, bloodGroup, allergyNotes } = req.body;
        const r = await db(`UPDATE patients SET name=$1,age=$2,dob=$3,gender=$4,phone=$5,alternate_phone=$6,email=$7,address=$8,city=$9,state=$10,pincode=$11,blood_group=$12,allergy_notes=$13,updated_at=NOW() WHERE id=$14 AND hospital_id=$15 RETURNING *`, [name,age,dob,gender,phone,alternatePhone,email,address,city,state,pincode,bloodGroup,allergyNotes,req.params.id,req.hospitalId]);
        return res.json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  DOCTORS
// ════════════════════════════════════════════════════════════
app.get('/api/doctors/departments', auth, async (req, res) => {
    try {
        const r = await db('SELECT * FROM departments WHERE hospital_id=$1 AND is_active=true ORDER BY name', [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/doctors', auth, async (req, res) => {
    try {
        const { search, departmentId } = req.query;
        let conditions=['d.hospital_id=$1','d.is_active=true']; let params=[req.hospitalId]; let idx=2;
        if (search)       { conditions.push(`d.name ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
        if (departmentId) { conditions.push(`d.department_id=$${idx}`); params.push(departmentId); idx++; }
        const r = await db(`SELECT d.*,dept.name as department_name FROM doctors d LEFT JOIN departments dept ON d.department_id=dept.id WHERE ${conditions.join(' AND ')} ORDER BY d.name`, params);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/doctors', auth, async (req, res) => {
    try {
        const { name, specialization, departmentId, qualification, experienceYears, consultationFee, contactNumber, email, availableDays, availableFrom, availableTo } = req.body;
        if (!name||!specialization) return res.status(400).json({ success: false, message: 'Name and specialization required' });
        const cnt = await db('SELECT COUNT(*) FROM doctors WHERE hospital_id=$1', [req.hospitalId]);
        const docId = `DOC-${String(parseInt(cnt.rows[0].count)+1).padStart(4,'0')}`;
        const r = await db(`INSERT INTO doctors (hospital_id,doctor_id,name,specialization,department_id,qualification,experience_years,consultation_fee,contact_number,email,available_days,available_from,available_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [req.hospitalId,docId,name,specialization,departmentId,qualification,experienceYears,consultationFee,contactNumber,email,availableDays,availableFrom,availableTo]);
        return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/doctors/:id', auth, async (req, res) => {
    try {
        const { name, specialization, departmentId, qualification, experienceYears, consultationFee, contactNumber, email, availableDays, availableFrom, availableTo } = req.body;
        const r = await db(`UPDATE doctors SET name=$1,specialization=$2,department_id=$3,qualification=$4,experience_years=$5,consultation_fee=$6,contact_number=$7,email=$8,available_days=$9,available_from=$10,available_to=$11,updated_at=NOW() WHERE id=$12 AND hospital_id=$13 RETURNING *`, [name,specialization,departmentId,qualification,experienceYears,consultationFee,contactNumber,email,availableDays,availableFrom,availableTo,req.params.id,req.hospitalId]);
        return res.json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  APPOINTMENTS
// ════════════════════════════════════════════════════════════
app.get('/api/appointments/today', auth, async (req, res) => {
    try {
        const r = await db(`SELECT a.*,p.name as patient_name,p.uhid,d.name as doctor_name FROM appointments a JOIN patients p ON a.patient_id=p.id JOIN doctors d ON a.doctor_id=d.id WHERE a.hospital_id=$1 AND a.appointment_date=CURRENT_DATE ORDER BY a.token_number`, [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/appointments', auth, async (req, res) => {
    try {
        const { date, doctorId, status, page=1, limit=20 } = req.query;
        const offset = (parseInt(page)-1)*parseInt(limit);
        let conditions=['a.hospital_id=$1']; let params=[req.hospitalId]; let idx=2;
        if (date)     { conditions.push(`a.appointment_date=$${idx}`); params.push(date); idx++; }
        if (doctorId) { conditions.push(`a.doctor_id=$${idx}`); params.push(doctorId); idx++; }
        if (status)   { conditions.push(`a.status=$${idx}`); params.push(status); idx++; }
        const where = conditions.join(' AND ');
        const r = await db(`SELECT a.*,p.name as patient_name,p.uhid,d.name as doctor_name FROM appointments a JOIN patients p ON a.patient_id=p.id JOIN doctors d ON a.doctor_id=d.id WHERE ${where} ORDER BY a.appointment_date DESC,a.token_number LIMIT $${idx} OFFSET $${idx+1}`, [...params,limit,offset]);
        const total = await db(`SELECT COUNT(*) FROM appointments a WHERE ${where}`, params);
        return res.json({ success: true, data: r.rows, pagination: { total: parseInt(total.rows[0].count) } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/appointments', auth, async (req, res) => {
    try {
        const { patientId, doctorId, appointmentDate, appointmentTime, type, chiefComplaint } = req.body;
        if (!patientId||!doctorId||!appointmentDate) return res.status(400).json({ success: false, message: 'Patient, doctor, date required' });
        const token = await db(`SELECT COALESCE(MAX(token_number),0)+1 as t FROM appointments WHERE doctor_id=$1 AND appointment_date=$2 AND hospital_id=$3`, [doctorId,appointmentDate,req.hospitalId]);
        const cnt = await db('SELECT COUNT(*) FROM appointments WHERE hospital_id=$1', [req.hospitalId]);
        const apptId = `APT-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
        const r = await db(`INSERT INTO appointments (hospital_id,appointment_id,patient_id,doctor_id,appointment_date,appointment_time,token_number,type,chief_complaint,booked_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [req.hospitalId,apptId,patientId,doctorId,appointmentDate,appointmentTime,token.rows[0].t,type||'scheduled',chiefComplaint,req.user.id]);
        return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/appointments/:id/status', auth, async (req, res) => {
    try {
        const r = await db('UPDATE appointments SET status=$1,updated_at=NOW() WHERE id=$2 AND hospital_id=$3 RETURNING *', [req.body.status,req.params.id,req.hospitalId]);
        return res.json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.delete('/api/appointments/:id', auth, async (req, res) => {
    try {
        await db("UPDATE appointments SET status='cancelled',updated_at=NOW() WHERE id=$1 AND hospital_id=$2", [req.params.id,req.hospitalId]);
        return res.json({ success: true, message: 'Cancelled' });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  OPD
// ════════════════════════════════════════════════════════════
app.get('/api/opd', auth, async (req, res) => {
    try {
        const { date, doctorId, page=1, limit=20 } = req.query;
        const offset = (parseInt(page)-1)*parseInt(limit);
        let conditions=['o.hospital_id=$1']; let params=[req.hospitalId]; let idx=2;
        if (date)     { conditions.push(`DATE(o.consultation_date)=$${idx}`); params.push(date); idx++; }
        if (doctorId) { conditions.push(`o.doctor_id=$${idx}`); params.push(doctorId); idx++; }
        const where = conditions.join(' AND ');
        const r = await db(`SELECT o.*,p.name as patient_name,p.uhid,d.name as doctor_name FROM opd_consultations o JOIN patients p ON o.patient_id=p.id JOIN doctors d ON o.doctor_id=d.id WHERE ${where} ORDER BY o.consultation_date DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params,limit,offset]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/opd', auth, async (req, res) => {
    try {
        const { patientId, doctorId, appointmentId, symptoms, diagnosis, clinicalNotes, bp, temperature, pulse, weight, height, spo2, nextVisit, medicines, advice } = req.body;
        const cnt = await db('SELECT COUNT(*) FROM opd_consultations WHERE hospital_id=$1', [req.hospitalId]);
        const opdId = `OPD-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
        const r = await db(`INSERT INTO opd_consultations (hospital_id,opd_id,patient_id,doctor_id,appointment_id,symptoms,diagnosis,clinical_notes,bp,temperature,pulse,weight,height,spo2,next_visit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [req.hospitalId,opdId,patientId,doctorId,appointmentId,symptoms,diagnosis,clinicalNotes,bp,temperature,pulse,weight,height,spo2,nextVisit]);
        if (medicines && medicines.length > 0) await db(`INSERT INTO prescriptions (opd_id,hospital_id,patient_id,doctor_id,medicines,advice) VALUES ($1,$2,$3,$4,$5,$6)`, [r.rows[0].id,req.hospitalId,patientId,doctorId,JSON.stringify(medicines),advice]);
        if (appointmentId) await db("UPDATE appointments SET status='completed',updated_at=NOW() WHERE id=$1", [appointmentId]);
        return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  IPD
// ════════════════════════════════════════════════════════════
app.get('/api/ipd/wards', auth, async (req, res) => {
    try {
        const r = await db(`SELECT w.*,COUNT(b.id) as total_beds,COUNT(CASE WHEN b.status='available' THEN 1 END) as available_beds FROM wards w LEFT JOIN beds b ON w.id=b.ward_id WHERE w.hospital_id=$1 AND w.is_active=true GROUP BY w.id ORDER BY w.name`, [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/ipd', auth, async (req, res) => {
    try {
        const { status } = req.query;
        let conditions=['ia.hospital_id=$1']; let params=[req.hospitalId]; let idx=2;
        if (status) { conditions.push(`ia.status=$${idx}`); params.push(status); idx++; }
        const r = await db(`SELECT ia.*,p.name as patient_name,p.uhid,d.name as doctor_name FROM ipd_admissions ia JOIN patients p ON ia.patient_id=p.id JOIN doctors d ON ia.doctor_id=d.id WHERE ${conditions.join(' AND ')} ORDER BY ia.admission_date DESC LIMIT 50`, params);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/ipd', auth, async (req, res) => {
    try {
        const { patientId, doctorId, wardId, bedId, admissionDate, diagnosis, notes } = req.body;
        const cnt = await db('SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id=$1', [req.hospitalId]);
        const admId = `IPD-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
        const r = await db(`INSERT INTO ipd_admissions (hospital_id,admission_id,patient_id,doctor_id,ward_id,bed_id,admission_date,diagnosis,notes,admitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [req.hospitalId,admId,patientId,doctorId,wardId,bedId,admissionDate||new Date(),diagnosis,notes,req.user.id]);
        if (bedId) await db("UPDATE beds SET status='occupied' WHERE id=$1", [bedId]);
        return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/ipd/:id/discharge', auth, async (req, res) => {
    try {
        const { dischargeDate, dischargeNotes } = req.body;
        const adm = await db('SELECT * FROM ipd_admissions WHERE id=$1', [req.params.id]);
        await db("UPDATE ipd_admissions SET status='discharged',discharge_date=$1,discharge_notes=$2,updated_at=NOW() WHERE id=$3", [dischargeDate||new Date(),dischargeNotes,req.params.id]);
        if (adm.rows[0]?.bed_id) await db("UPDATE beds SET status='available' WHERE id=$1", [adm.rows[0].bed_id]);
        return res.json({ success: true, message: 'Patient discharged' });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  LAB
// ════════════════════════════════════════════════════════════
app.get('/api/lab/tests', auth, async (req, res) => {
    try {
        const r = await db('SELECT * FROM lab_tests WHERE hospital_id=$1 AND is_active=true ORDER BY test_name', [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/lab/orders', auth, async (req, res) => {
    try {
        const { status, page=1, limit=20 } = req.query;
        const offset = (parseInt(page)-1)*parseInt(limit);
        let conditions=['lo.hospital_id=$1']; let params=[req.hospitalId]; let idx=2;
        if (status) { conditions.push(`lo.status=$${idx}`); params.push(status); idx++; }
        const r = await db(`SELECT lo.*,p.name as patient_name,p.uhid FROM lab_orders lo JOIN patients p ON lo.patient_id=p.id WHERE ${conditions.join(' AND ')} ORDER BY lo.order_date DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params,limit,offset]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/lab/orders', auth, async (req, res) => {
    try {
        const { patientId, testIds, priority, notes } = req.body;
        const cnt = await db('SELECT COUNT(*) FROM lab_orders WHERE hospital_id=$1', [req.hospitalId]);
        const orderId = `LAB-${String(parseInt(cnt.rows[0].count)+1).padStart(5,'0')}`;
        const order = await db(`INSERT INTO lab_orders (hospital_id,order_id,patient_id,priority,notes,ordered_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.hospitalId,orderId,patientId,priority||'routine',notes,req.user.id]);
        if (testIds) for (const tid of testIds) { try { await db('INSERT INTO lab_order_items (order_id,test_id) VALUES ($1,$2)', [order.rows[0].id,tid]); } catch(e){} }
        return res.status(201).json({ success: true, data: order.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  BILLING
// ════════════════════════════════════════════════════════════
app.get('/api/billing/stats/summary', auth, async (req, res) => {
    try {
        const [total, today, pending] = await Promise.all([
            db('SELECT COALESCE(SUM(paid_amount),0) as t FROM bills WHERE hospital_id=$1', [req.hospitalId]),
            db("SELECT COALESCE(SUM(paid_amount),0) as t FROM bills WHERE hospital_id=$1 AND DATE(bill_date)=CURRENT_DATE", [req.hospitalId]),
            db("SELECT COALESCE(SUM(due_amount),0) as t FROM bills WHERE hospital_id=$1 AND payment_status!='paid'", [req.hospitalId])
        ]);
        return res.json({ success: true, data: { totalRevenue: parseFloat(total.rows[0].t), todayRevenue: parseFloat(today.rows[0].t), pendingDues: parseFloat(pending.rows[0].t) } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/billing/:id', auth, async (req, res) => {
    try {
        const bill = await db(`SELECT b.*,p.name as patient_name,p.uhid,p.phone,h.name as hospital_name FROM bills b JOIN patients p ON b.patient_id=p.id JOIN hospitals h ON b.hospital_id=h.id WHERE b.id=$1 AND b.hospital_id=$2`, [req.params.id,req.hospitalId]);
        if (!bill.rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
        const items = await db('SELECT * FROM bill_items WHERE bill_id=$1', [req.params.id]);
        return res.json({ success: true, data: { ...bill.rows[0], items: items.rows } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/billing', auth, async (req, res) => {
    try {
        const { page=1, limit=20, status } = req.query;
        const offset = (parseInt(page)-1)*parseInt(limit);
        let conditions=['b.hospital_id=$1']; let params=[req.hospitalId]; let idx=2;
        if (status) { conditions.push(`b.payment_status=$${idx}`); params.push(status); idx++; }
        const where = conditions.join(' AND ');
        const r = await db(`SELECT b.id,b.bill_number,b.bill_date,b.total_amount,b.paid_amount,b.due_amount,b.payment_status,p.name as patient_name,p.uhid FROM bills b JOIN patients p ON b.patient_id=p.id WHERE ${where} ORDER BY b.bill_date DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params,limit,offset]);
        const total = await db(`SELECT COUNT(*) FROM bills b WHERE ${where}`, params);
        return res.json({ success: true, data: r.rows, pagination: { total: parseInt(total.rows[0].count) } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/billing', auth, async (req, res) => {
    try {
        const { patientId, billType, items, discountPercent=0, gstPercent=0, paymentMethod, notes, paidAmount=0 } = req.body;
        if (!patientId||!items||!items.length) return res.status(400).json({ success: false, message: 'Patient and items required' });
        const cnt = await db('SELECT COUNT(*) FROM bills WHERE hospital_id=$1', [req.hospitalId]);
        const billNum = `BILL-${String(parseInt(cnt.rows[0].count)+1).padStart(6,'0')}`;
        let subtotal = 0;
        for (const item of items) subtotal += parseFloat(item.totalPrice||0);
        const discAmt = subtotal * parseFloat(discountPercent) / 100;
        const afterDisc = subtotal - discAmt;
        const gstAmt = afterDisc * parseFloat(gstPercent) / 100;
        const total = afterDisc + gstAmt;
        const paid = parseFloat(paidAmount);
        const due = total - paid;
        const status = due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending';
        const bill = await db(`INSERT INTO bills (hospital_id,bill_number,patient_id,bill_type,subtotal,discount_amount,discount_percent,gst_amount,gst_percent,total_amount,paid_amount,due_amount,payment_method,notes,created_by,payment_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`, [req.hospitalId,billNum,patientId,billType||'opd',subtotal,discAmt,discountPercent,gstAmt,gstPercent,total,paid,due,paymentMethod,notes,req.user.id,status]);
        for (const item of items) { try { await db(`INSERT INTO bill_items (bill_id,item_type,item_name,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5,$6)`, [bill.rows[0].id,item.type,item.name,item.quantity||1,item.unitPrice,item.totalPrice]); } catch(e){} }
        return res.status(201).json({ success: true, data: bill.rows[0] });
    } catch (e) { console.error(e.message); return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/billing/:id/payment', auth, async (req, res) => {
    try {
        const { paidAmount, paymentMethod } = req.body;
        const bill = await db('SELECT * FROM bills WHERE id=$1 AND hospital_id=$2', [req.params.id,req.hospitalId]);
        if (!bill.rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
        const newPaid = parseFloat(bill.rows[0].paid_amount) + parseFloat(paidAmount);
        const newDue = Math.max(0, parseFloat(bill.rows[0].total_amount) - newPaid);
        const status = newDue <= 0 ? 'paid' : 'partial';
        await db('UPDATE bills SET paid_amount=$1,due_amount=$2,payment_status=$3,payment_method=$4,updated_at=NOW() WHERE id=$5', [newPaid,newDue,status,paymentMethod,req.params.id]);
        return res.json({ success: true, message: 'Payment recorded', status });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ════════════════════════════════════════════════════════════
//  DASHBOARD & REPORTS & SETTINGS
// ════════════════════════════════════════════════════════════
app.get('/api/dashboard/stats', auth, async (req, res) => {
    try {
        const hId = req.hospitalId;
        const [p, a, rev, np] = await Promise.all([
            db('SELECT COUNT(*) FROM patients WHERE hospital_id=$1 AND is_active=true', [hId]),
            db('SELECT COUNT(*) FROM appointments WHERE hospital_id=$1 AND appointment_date=CURRENT_DATE', [hId]),
            db("SELECT COALESCE(SUM(paid_amount),0) as r FROM bills WHERE hospital_id=$1 AND DATE(bill_date)=CURRENT_DATE", [hId]),
            db("SELECT COUNT(*) FROM patients WHERE hospital_id=$1 AND DATE(created_at)=CURRENT_DATE", [hId])
        ]);
        const recentAppts = await db(`SELECT a.token_number,a.status,a.appointment_time,p.name as patient_name,p.uhid,d.name as doctor_name FROM appointments a JOIN patients p ON a.patient_id=p.id JOIN doctors d ON a.doctor_id=d.id WHERE a.hospital_id=$1 AND a.appointment_date=CURRENT_DATE ORDER BY a.token_number LIMIT 8`, [hId]);
        return res.json({ success: true, data: { stats: { totalPatients: parseInt(p.rows[0].count), todayAppointments: parseInt(a.rows[0].count), todayRevenue: parseFloat(rev.rows[0].r), newPatientsToday: parseInt(np.rows[0].count), activeAdmissions: 0, pendingLabs: 0 }, charts: { monthlyPatients: [], dailyRevenue: [], appointmentStats: [] }, recentAppointments: recentAppts.rows } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/reports/overview', auth, async (req, res) => {
    try {
        const { from, to } = req.query;
        const hId = req.hospitalId;
        const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
        const dateTo   = to   || new Date().toISOString().split('T')[0];
        const [patients, appts, revenue] = await Promise.all([
            db("SELECT COUNT(*) FROM patients WHERE hospital_id=$1 AND DATE(created_at) BETWEEN $2 AND $3", [hId,dateFrom,dateTo]),
            db("SELECT COUNT(*) FROM appointments WHERE hospital_id=$1 AND appointment_date BETWEEN $2 AND $3", [hId,dateFrom,dateTo]),
            db("SELECT COALESCE(SUM(paid_amount),0) as total FROM bills WHERE hospital_id=$1 AND DATE(bill_date) BETWEEN $2 AND $3", [hId,dateFrom,dateTo])
        ]);
        return res.json({ success: true, data: { kpi: { patients: parseInt(patients.rows[0].count), appts: parseInt(appts.rows[0].count), revenue: parseFloat(revenue.rows[0].total), occupancy: 0 }, kpiDelta: { patients:'+0%', appts:'+0%', revenue:'+0%', occupancy:'0%' }, patientTrend: { labels:[], data:[] }, revenuePie: { labels:[], data:[] }, opdIpd: { labels:[], opd:[], ipd:[] }, depts: { labels:[], data:[] } } });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/settings', auth, async (req, res) => {
    try {
        const r = await db('SELECT * FROM hospitals WHERE id=$1', [req.hospitalId]);
        return res.json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/settings', auth, async (req, res) => {
    try {
        const { name, orgType, address, city, state, phone, email } = req.body;
        const r = await db('UPDATE hospitals SET name=$1,org_type=$2,address=$3,city=$4,state=$5,phone=$6,email=$7,updated_at=NOW() WHERE id=$8 RETURNING *', [name,orgType,address,city,state,phone,email,req.hospitalId]);
        return res.json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/settings/users', auth, async (req, res) => {
    try {
        const r = await db('SELECT id,name,email,role,phone,is_active,last_login,created_at FROM users WHERE hospital_id=$1 ORDER BY name', [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/staff', auth, async (req, res) => {
    try {
        const r = await db('SELECT s.*,d.name as department_name FROM staff s LEFT JOIN departments d ON s.department_id=d.id WHERE s.hospital_id=$1 AND s.is_active=true ORDER BY s.name', [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/staff', auth, async (req, res) => {
    try {
        const { name, role, departmentId, phone, email, salary, shift } = req.body;
        const cnt = await db('SELECT COUNT(*) FROM staff WHERE hospital_id=$1', [req.hospitalId]);
        const staffId = `STF-${String(parseInt(cnt.rows[0].count)+1).padStart(4,'0')}`;
        const r = await db(`INSERT INTO staff (hospital_id,staff_id,name,role,department_id,phone,email,salary,shift) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.hospitalId,staffId,name,role,departmentId,phone,email,salary,shift]);
        return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/inventory', auth, async (req, res) => {
    try {
        const { lowStock } = req.query;
        let where = 'i.hospital_id=$1 AND i.is_active=true';
        if (lowStock==='true') where += ' AND i.current_quantity<=i.reorder_level';
        const r = await db(`SELECT i.*,ic.name as category_name FROM inventory_items i LEFT JOIN inventory_categories ic ON i.category_id=ic.id WHERE ${where} ORDER BY i.item_name`, [req.hospitalId]);
        return res.json({ success: true, data: r.rows });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Frontend catch-all ────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

app.use((err, req, res, next) => res.status(500).json({ success: false, message: 'Server error' }));

app.listen(PORT, '0.0.0.0', () => console.log(`\n🏥  Easy Hospital HMS | Port: ${PORT} | Health: /api/health\n`));
module.exports = app;
