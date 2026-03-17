const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ====== APPOINTMENTS ======
const appointmentRouter = express.Router();

appointmentRouter.get('/', authenticate, async (req, res) => {
    try {
        const { date, doctorId, status, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['a.hospital_id = $1'];
        let params = [req.hospitalId];
        let idx = 2;

        if (date) { conditions.push(`a.appointment_date = $${idx}`); params.push(date); idx++; }
        if (doctorId) { conditions.push(`a.doctor_id = $${idx}`); params.push(doctorId); idx++; }
        if (status) { conditions.push(`a.status = $${idx}`); params.push(status); idx++; }

        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT a.*, p.name as patient_name, p.phone as patient_phone, p.uhid,
                    d.name as doctor_name, d.specialization
             FROM appointments a
             JOIN patients p ON a.patient_id = p.id
             JOIN doctors d ON a.doctor_id = d.id
             WHERE ${where} ORDER BY a.appointment_date DESC, a.token_number ASC
             LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );

        const total = await db.query(`SELECT COUNT(*) FROM appointments a WHERE ${where}`, params);
        return res.json({ success: true, data: result.rows, pagination: { total: parseInt(total.rows[0].count), page: parseInt(page) } });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

appointmentRouter.post('/', authenticate, async (req, res) => {
    try {
        const { patientId, doctorId, appointmentDate, appointmentTime, type, chiefComplaint } = req.body;
        
        // Generate token number for the day
        const tokenResult = await db.query(
            `SELECT COALESCE(MAX(token_number), 0) + 1 as next_token FROM appointments 
             WHERE doctor_id = $1 AND appointment_date = $2 AND hospital_id = $3`,
            [doctorId, appointmentDate, req.hospitalId]
        );
        const token = tokenResult.rows[0].next_token;

        // Generate appointment ID
        const countResult = await db.query('SELECT COUNT(*) FROM appointments WHERE hospital_id = $1', [req.hospitalId]);
        const apptId = `APT-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;

        const result = await db.query(
            `INSERT INTO appointments (hospital_id, appointment_id, patient_id, doctor_id, appointment_date, 
             appointment_time, token_number, type, chief_complaint, booked_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [req.hospitalId, apptId, patientId, doctorId, appointmentDate, appointmentTime, token, type || 'scheduled', chiefComplaint, req.user.id]
        );
        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

appointmentRouter.put('/:id/status', authenticate, async (req, res) => {
    try {
        const { status } = req.body;
        const result = await db.query(
            'UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2 AND hospital_id = $3 RETURNING *',
            [status, req.params.id, req.hospitalId]
        );
        return res.json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

appointmentRouter.get('/today', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT a.*, p.name as patient_name, p.uhid, d.name as doctor_name
             FROM appointments a JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id
             WHERE a.hospital_id = $1 AND a.appointment_date = CURRENT_DATE ORDER BY a.token_number`,
            [req.hospitalId]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== OPD ======
const opdRouter = express.Router();

opdRouter.get('/', authenticate, async (req, res) => {
    try {
        const { date, doctorId, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['o.hospital_id = $1'];
        let params = [req.hospitalId];
        let idx = 2;
        if (date) { conditions.push(`DATE(o.consultation_date) = $${idx}`); params.push(date); idx++; }
        if (doctorId) { conditions.push(`o.doctor_id = $${idx}`); params.push(doctorId); idx++; }
        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT o.*, p.name as patient_name, p.uhid, p.phone, d.name as doctor_name
             FROM opd_consultations o
             JOIN patients p ON o.patient_id = p.id JOIN doctors d ON o.doctor_id = d.id
             WHERE ${where} ORDER BY o.consultation_date DESC LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

opdRouter.post('/', authenticate, async (req, res) => {
    try {
        const { patientId, doctorId, appointmentId, symptoms, diagnosis, clinicalNotes, bp, temperature, pulse, weight, height, spo2, nextVisit, medicines, advice } = req.body;
        
        const countResult = await db.query('SELECT COUNT(*) FROM opd_consultations WHERE hospital_id = $1', [req.hospitalId]);
        const opdId = `OPD-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;

        const opd = await db.query(
            `INSERT INTO opd_consultations (hospital_id, opd_id, patient_id, doctor_id, appointment_id, symptoms, diagnosis, clinical_notes, bp, temperature, pulse, weight, height, spo2, next_visit)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [req.hospitalId, opdId, patientId, doctorId, appointmentId, symptoms, diagnosis, clinicalNotes, bp, temperature, pulse, weight, height, spo2, nextVisit]
        );

        // Save prescription if provided
        if (medicines && medicines.length > 0) {
            await db.query(
                `INSERT INTO prescriptions (opd_id, hospital_id, patient_id, doctor_id, medicines, advice)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [opd.rows[0].id, req.hospitalId, patientId, doctorId, JSON.stringify(medicines), advice]
            );
        }

        // Update appointment status if linked
        if (appointmentId) {
            await db.query("UPDATE appointments SET status = 'completed' WHERE id = $1", [appointmentId]);
        }

        return res.status(201).json({ success: true, data: opd.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

opdRouter.get('/:id/prescription', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT p.*, u.name as doctor_name, pt.name as patient_name, pt.uhid, pt.age, pt.gender
             FROM prescriptions p
             JOIN users u ON p.doctor_id = u.id
             JOIN patients pt ON p.patient_id = pt.id
             WHERE p.opd_id = $1`,
            [req.params.id]
        );
        return res.json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== IPD ======
const ipdRouter = express.Router();

ipdRouter.get('/', authenticate, async (req, res) => {
    try {
        const { status, wardId, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['ia.hospital_id = $1'];
        let params = [req.hospitalId];
        let idx = 2;
        if (status) { conditions.push(`ia.status = $${idx}`); params.push(status); idx++; }
        if (wardId) { conditions.push(`ia.ward_id = $${idx}`); params.push(wardId); idx++; }
        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT ia.*, p.name as patient_name, p.uhid, p.phone, d.name as doctor_name,
                    w.name as ward_name, b.bed_number
             FROM ipd_admissions ia
             JOIN patients p ON ia.patient_id = p.id JOIN doctors d ON ia.doctor_id = d.id
             JOIN wards w ON ia.ward_id = w.id JOIN beds b ON ia.bed_id = b.id
             WHERE ${where} ORDER BY ia.admission_date DESC LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

ipdRouter.post('/admit', authenticate, async (req, res) => {
    try {
        const { patientId, doctorId, wardId, bedId, admissionType, chiefComplaint, diagnosisOnAdmission, attendantName, attendantPhone, attendantRelation } = req.body;
        
        // Check bed availability
        const bed = await db.query("SELECT * FROM beds WHERE id = $1 AND status = 'available'", [bedId]);
        if (bed.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Bed not available' });
        }

        const countResult = await db.query('SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = $1', [req.hospitalId]);
        const admissionId = `IPD-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;

        const admission = await db.query(
            `INSERT INTO ipd_admissions (hospital_id, admission_id, patient_id, doctor_id, ward_id, bed_id,
             admission_type, chief_complaint, diagnosis_on_admission, attendant_name, attendant_phone,
             attendant_relation, admitted_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [req.hospitalId, admissionId, patientId, doctorId, wardId, bedId, admissionType,
             chiefComplaint, diagnosisOnAdmission, attendantName, attendantPhone, attendantRelation, req.user.id]
        );

        // Mark bed as occupied
        await db.query("UPDATE beds SET status = 'occupied', current_admission_id = $1 WHERE id = $2", [admission.rows[0].id, bedId]);
        await db.query("UPDATE wards SET available_beds = available_beds - 1 WHERE id = $1", [wardId]);

        return res.status(201).json({ success: true, data: admission.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

ipdRouter.post('/:id/discharge', authenticate, async (req, res) => {
    try {
        const { dischargeSummary, dischargeCondition } = req.body;
        const admission = await db.query("SELECT * FROM ipd_admissions WHERE id = $1", [req.params.id]);
        if (!admission.rows[0]) return res.status(404).json({ success: false, message: 'Admission not found' });
        
        await db.query(
            "UPDATE ipd_admissions SET status = 'discharged', discharge_date = NOW(), discharge_summary = $1, discharge_condition = $2 WHERE id = $3",
            [dischargeSummary, dischargeCondition, req.params.id]
        );

        // Free bed
        await db.query("UPDATE beds SET status = 'cleaning', current_admission_id = NULL WHERE id = $1", [admission.rows[0].bed_id]);
        await db.query("UPDATE wards SET available_beds = available_beds + 1 WHERE id = $1", [admission.rows[0].ward_id]);

        return res.json({ success: true, message: 'Patient discharged' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

ipdRouter.post('/:id/nurse-note', authenticate, async (req, res) => {
    try {
        const { bp, temperature, pulse, spo2, note, medicationGiven } = req.body;
        await db.query(
            `INSERT INTO nurse_notes (admission_id, hospital_id, nurse_id, bp, temperature, pulse, spo2, note, medication_given)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [req.params.id, req.hospitalId, req.user.id, bp, temperature, pulse, spo2, note, medicationGiven]
        );
        return res.json({ success: true, message: 'Nurse note added' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

ipdRouter.get('/wards', authenticate, async (req, res) => {
    try {
        const wards = await db.query('SELECT * FROM wards WHERE hospital_id = $1 AND is_active = true ORDER BY name', [req.hospitalId]);
        return res.json({ success: true, data: wards.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

ipdRouter.get('/beds/:wardId', authenticate, async (req, res) => {
    try {
        const beds = await db.query('SELECT * FROM beds WHERE ward_id = $1 AND hospital_id = $2 ORDER BY bed_number', [req.params.wardId, req.hospitalId]);
        return res.json({ success: true, data: beds.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

module.exports = { appointmentRouter, opdRouter, ipdRouter };
