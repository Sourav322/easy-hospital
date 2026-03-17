const express = require('express');
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// ====== LABORATORY ======
const labRouter = express.Router();

labRouter.get('/tests', authenticate, async (req, res) => {
    try {
        const { category, search } = req.query;
        let conditions = ['hospital_id = $1', 'is_active = true'];
        let params = [req.hospitalId];
        let idx = 2;
        if (category) { conditions.push(`category = $${idx}`); params.push(category); idx++; }
        if (search) { conditions.push(`test_name ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
        const result = await db.query(`SELECT * FROM lab_tests WHERE ${conditions.join(' AND ')} ORDER BY category, test_name`, params);
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

labRouter.get('/orders', authenticate, async (req, res) => {
    try {
        const { status, patientId, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['lo.hospital_id = $1'];
        let params = [req.hospitalId];
        let idx = 2;
        if (status) { conditions.push(`lo.status = $${idx}`); params.push(status); idx++; }
        if (patientId) { conditions.push(`lo.patient_id = $${idx}`); params.push(patientId); idx++; }
        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT lo.*, p.name as patient_name, p.uhid, u.name as doctor_name,
                    COUNT(loi.id) as test_count
             FROM lab_orders lo
             JOIN patients p ON lo.patient_id = p.id
             LEFT JOIN users u ON lo.ordered_by = u.id
             LEFT JOIN lab_order_items loi ON lo.id = loi.order_id
             WHERE ${where} GROUP BY lo.id, p.name, p.uhid, u.name
             ORDER BY lo.order_date DESC LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

labRouter.post('/orders', authenticate, async (req, res) => {
    try {
        const { patientId, doctorId, testIds, priority, notes, opdId, admissionId } = req.body;
        const countResult = await db.query('SELECT COUNT(*) FROM lab_orders WHERE hospital_id = $1', [req.hospitalId]);
        const orderId = `LAB-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;
        
        const order = await db.query(
            `INSERT INTO lab_orders (hospital_id, order_id, patient_id, doctor_id, opd_id, admission_id, priority, notes, ordered_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [req.hospitalId, orderId, patientId, doctorId, opdId, admissionId, priority || 'routine', notes, req.user.id]
        );

        for (const testId of (testIds || [])) {
            await db.query('INSERT INTO lab_order_items (order_id, test_id) VALUES ($1,$2)', [order.rows[0].id, testId]);
        }
        return res.status(201).json({ success: true, data: order.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

labRouter.put('/orders/:id/results', authenticate, async (req, res) => {
    try {
        const { results } = req.body; // [{itemId, resultValue, isAbnormal, notes}]
        for (const r of (results || [])) {
            await db.query(
                `UPDATE lab_order_items SET result_value=$1, is_abnormal=$2, notes=$3, status='completed', result_time=NOW(), conducted_by=$4 WHERE id=$5`,
                [r.resultValue, r.isAbnormal, r.notes, req.user.id, r.itemId]
            );
        }
        // Check if all items completed
        const pending = await db.query("SELECT COUNT(*) FROM lab_order_items WHERE order_id = $1 AND status != 'completed'", [req.params.id]);
        if (parseInt(pending.rows[0].count) === 0) {
            await db.query("UPDATE lab_orders SET status = 'completed' WHERE id = $1", [req.params.id]);
        }
        return res.json({ success: true, message: 'Results updated' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

labRouter.get('/orders/:id/items', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT loi.*, lt.test_name, lt.category, lt.normal_range, lt.unit
             FROM lab_order_items loi JOIN lab_tests lt ON loi.test_id = lt.id
             WHERE loi.order_id = $1`,
            [req.params.id]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== BILLING ======
const billingRouter = express.Router();

billingRouter.get('/', authenticate, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, patientId } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['b.hospital_id = $1'];
        let params = [req.hospitalId];
        let idx = 2;
        if (status) { conditions.push(`b.payment_status = $${idx}`); params.push(status); idx++; }
        if (patientId) { conditions.push(`b.patient_id = $${idx}`); params.push(patientId); idx++; }
        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT b.*, p.name as patient_name, p.uhid, u.name as created_by_name
             FROM bills b JOIN patients p ON b.patient_id = p.id LEFT JOIN users u ON b.created_by = u.id
             WHERE ${where} ORDER BY b.bill_date DESC LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );
        const total = await db.query(`SELECT COUNT(*) FROM bills b WHERE ${where}`, params);
        return res.json({ success: true, data: result.rows, pagination: { total: parseInt(total.rows[0].count) } });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

billingRouter.post('/', authenticate, async (req, res) => {
    try {
        const { patientId, billType, opdId, admissionId, items, discountPercent, discountAmount, gstPercent, paymentMethod, insuranceProvider, notes, paidAmount } = req.body;
        
        const countResult = await db.query('SELECT COUNT(*) FROM bills WHERE hospital_id = $1', [req.hospitalId]);
        const billNumber = `BILL-${String(parseInt(countResult.rows[0].count) + 1).padStart(6, '0')}`;

        let subtotal = 0;
        for (const item of (items || [])) {
            subtotal += parseFloat(item.totalPrice || 0);
        }

        const discAmt = discountAmount || (subtotal * (discountPercent || 0) / 100);
        const afterDiscount = subtotal - discAmt;
        const gstAmt = afterDiscount * (gstPercent || 0) / 100;
        const total = afterDiscount + gstAmt;
        const paid = parseFloat(paidAmount || 0);
        const due = total - paid;

        const bill = await db.query(
            `INSERT INTO bills (hospital_id, bill_number, patient_id, bill_type, opd_id, admission_id,
             subtotal, discount_amount, discount_percent, gst_amount, gst_percent, total_amount, paid_amount,
             due_amount, payment_method, insurance_provider, notes, created_by,
             payment_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
            [req.hospitalId, billNumber, patientId, billType, opdId, admissionId,
             subtotal, discAmt, discountPercent || 0, gstAmt, gstPercent || 0, total, paid, due,
             paymentMethod, insuranceProvider, notes, req.user.id,
             due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending']
        );

        for (const item of (items || [])) {
            await db.query(
                `INSERT INTO bill_items (bill_id, item_type, item_name, quantity, unit_price, total_price, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [bill.rows[0].id, item.type, item.name, item.quantity || 1, item.unitPrice, item.totalPrice, item.notes]
            );
        }
        return res.status(201).json({ success: true, data: bill.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

billingRouter.get('/:id', authenticate, async (req, res) => {
    try {
        const bill = await db.query(
            `SELECT b.*, p.name as patient_name, p.uhid, p.phone, p.address, h.name as hospital_name, h.address as hospital_address, h.gst_number
             FROM bills b JOIN patients p ON b.patient_id = p.id JOIN hospitals h ON b.hospital_id = h.id
             WHERE b.id = $1 AND b.hospital_id = $2`,
            [req.params.id, req.hospitalId]
        );
        if (!bill.rows[0]) return res.status(404).json({ success: false, message: 'Bill not found' });

        const items = await db.query('SELECT * FROM bill_items WHERE bill_id = $1', [req.params.id]);
        return res.json({ success: true, data: { ...bill.rows[0], items: items.rows } });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

billingRouter.put('/:id/payment', authenticate, async (req, res) => {
    try {
        const { paidAmount, paymentMethod } = req.body;
        const bill = await db.query('SELECT * FROM bills WHERE id = $1', [req.params.id]);
        if (!bill.rows[0]) return res.status(404).json({ success: false, message: 'Bill not found' });
        const newPaid = parseFloat(bill.rows[0].paid_amount) + parseFloat(paidAmount);
        const newDue = parseFloat(bill.rows[0].total_amount) - newPaid;
        const status = newDue <= 0 ? 'paid' : 'partial';
        await db.query(
            'UPDATE bills SET paid_amount=$1, due_amount=$2, payment_status=$3, payment_method=$4 WHERE id=$5',
            [newPaid, newDue, status, paymentMethod, req.params.id]
        );
        return res.json({ success: true, message: 'Payment updated' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== STAFF ======
const staffRouter = express.Router();

staffRouter.get('/', authenticate, async (req, res) => {
    try {
        const { role, search, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['s.hospital_id = $1', 's.is_active = true'];
        let params = [req.hospitalId];
        let idx = 2;
        if (role) { conditions.push(`s.role = $${idx}`); params.push(role); idx++; }
        if (search) { conditions.push(`s.name ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT s.*, d.name as department_name FROM staff s
             LEFT JOIN departments d ON s.department_id = d.id
             WHERE ${where} ORDER BY s.name LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

staffRouter.post('/', authenticate, authorize('hospital_admin', 'super_admin'), async (req, res) => {
    try {
        const { name, role, departmentId, phone, email, address, joinDate, salary, shift } = req.body;
        const countResult = await db.query('SELECT COUNT(*) FROM staff WHERE hospital_id = $1', [req.hospitalId]);
        const staffId = `STF-${String(parseInt(countResult.rows[0].count) + 1).padStart(4, '0')}`;
        
        const result = await db.query(
            `INSERT INTO staff (hospital_id, staff_id, name, role, department_id, phone, email, address, join_date, salary, shift)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [req.hospitalId, staffId, name, role, departmentId, phone, email, address, joinDate, salary, shift]
        );
        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

staffRouter.post('/attendance', authenticate, async (req, res) => {
    try {
        const { staffId, status, checkIn, checkOut, notes } = req.body;
        const existing = await db.query(
            'SELECT id FROM attendance WHERE staff_id = $1 AND attendance_date = CURRENT_DATE AND hospital_id = $2',
            [staffId, req.hospitalId]
        );
        if (existing.rows.length > 0) {
            await db.query('UPDATE attendance SET check_in=$1, check_out=$2, status=$3 WHERE id=$4', [checkIn, checkOut, status, existing.rows[0].id]);
        } else {
            await db.query(
                'INSERT INTO attendance (hospital_id, staff_id, status, check_in, check_out, notes) VALUES ($1,$2,$3,$4,$5,$6)',
                [req.hospitalId, staffId, status, checkIn, checkOut, notes]
            );
        }
        return res.json({ success: true, message: 'Attendance recorded' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== INVENTORY ======
const inventoryRouter = express.Router();

inventoryRouter.get('/', authenticate, async (req, res) => {
    try {
        const { search, category, lowStock, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        let conditions = ['i.hospital_id = $1', 'i.is_active = true'];
        let params = [req.hospitalId];
        let idx = 2;
        if (search) { conditions.push(`i.item_name ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
        if (category) { conditions.push(`ic.name = $${idx}`); params.push(category); idx++; }
        if (lowStock === 'true') { conditions.push(`i.current_quantity <= i.reorder_level`); }
        const where = conditions.join(' AND ');
        const result = await db.query(
            `SELECT i.*, ic.name as category_name FROM inventory_items i
             LEFT JOIN inventory_categories ic ON i.category_id = ic.id
             WHERE ${where} ORDER BY i.item_name LIMIT $${idx} OFFSET $${idx+1}`,
            [...params, limit, offset]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

inventoryRouter.post('/', authenticate, async (req, res) => {
    try {
        const { itemName, categoryId, supplier, unit, purchasePrice, sellingPrice, currentQuantity, reorderLevel, expiryDate, batchNumber } = req.body;
        const countResult = await db.query('SELECT COUNT(*) FROM inventory_items WHERE hospital_id = $1', [req.hospitalId]);
        const itemCode = `ITM-${String(parseInt(countResult.rows[0].count) + 1).padStart(5, '0')}`;
        const result = await db.query(
            `INSERT INTO inventory_items (hospital_id, item_code, item_name, category_id, supplier, unit, purchase_price, selling_price, current_quantity, reorder_level, expiry_date, batch_number)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [req.hospitalId, itemCode, itemName, categoryId, supplier, unit, purchasePrice, sellingPrice, currentQuantity || 0, reorderLevel || 10, expiryDate, batchNumber]
        );
        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

inventoryRouter.post('/transaction', authenticate, async (req, res) => {
    try {
        const { itemId, type, quantity, unitPrice, notes } = req.body;
        const total = parseFloat(quantity) * parseFloat(unitPrice || 0);
        await db.query(
            `INSERT INTO inventory_transactions (hospital_id, item_id, transaction_type, quantity, unit_price, total_price, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [req.hospitalId, itemId, type, quantity, unitPrice, total, notes, req.user.id]
        );
        const adj = type === 'in' ? quantity : -quantity;
        await db.query('UPDATE inventory_items SET current_quantity = current_quantity + $1, updated_at = NOW() WHERE id = $2', [adj, itemId]);
        return res.json({ success: true, message: 'Transaction recorded' });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== DASHBOARD ======
const dashboardRouter = express.Router();

dashboardRouter.get('/stats', authenticate, async (req, res) => {
    try {
        const hId = req.hospitalId;
        const [totalPatients, todayAppointments, activeAdmissions, todayRevenue, pendingLabs, newPatientsToday] = await Promise.all([
            db.query('SELECT COUNT(*) FROM patients WHERE hospital_id = $1 AND is_active = true', [hId]),
            db.query("SELECT COUNT(*) FROM appointments WHERE hospital_id = $1 AND appointment_date = CURRENT_DATE", [hId]),
            db.query("SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = $1 AND status = 'admitted'", [hId]),
            db.query("SELECT COALESCE(SUM(paid_amount), 0) as revenue FROM bills WHERE hospital_id = $1 AND DATE(bill_date) = CURRENT_DATE", [hId]),
            db.query("SELECT COUNT(*) FROM lab_orders WHERE hospital_id = $1 AND status IN ('pending', 'sample_collected', 'processing')", [hId]),
            db.query("SELECT COUNT(*) FROM patients WHERE hospital_id = $1 AND DATE(created_at) = CURRENT_DATE", [hId])
        ]);

        // Monthly patient registrations (last 6 months)
        const monthlyPatients = await db.query(
            `SELECT TO_CHAR(created_at, 'Mon YYYY') as month, COUNT(*) as count
             FROM patients WHERE hospital_id = $1 AND created_at >= NOW() - INTERVAL '6 months'
             GROUP BY TO_CHAR(created_at, 'Mon YYYY'), DATE_TRUNC('month', created_at)
             ORDER BY DATE_TRUNC('month', created_at)`,
            [hId]
        );

        // Daily revenue last 7 days
        const dailyRevenue = await db.query(
            `SELECT TO_CHAR(bill_date, 'DD Mon') as day, COALESCE(SUM(paid_amount), 0) as revenue
             FROM bills WHERE hospital_id = $1 AND bill_date >= NOW() - INTERVAL '7 days'
             GROUP BY TO_CHAR(bill_date, 'DD Mon'), DATE_TRUNC('day', bill_date)
             ORDER BY DATE_TRUNC('day', bill_date)`,
            [hId]
        );

        // Appointment status distribution
        const apptStats = await db.query(
            `SELECT status, COUNT(*) as count FROM appointments WHERE hospital_id = $1 AND appointment_date = CURRENT_DATE GROUP BY status`,
            [hId]
        );

        // Recent appointments
        const recentAppts = await db.query(
            `SELECT a.*, p.name as patient_name, p.uhid, d.name as doctor_name
             FROM appointments a JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id
             WHERE a.hospital_id = $1 AND a.appointment_date = CURRENT_DATE ORDER BY a.token_number LIMIT 5`,
            [hId]
        );

        return res.json({
            success: true,
            data: {
                stats: {
                    totalPatients: parseInt(totalPatients.rows[0].count),
                    todayAppointments: parseInt(todayAppointments.rows[0].count),
                    activeAdmissions: parseInt(activeAdmissions.rows[0].count),
                    todayRevenue: parseFloat(todayRevenue.rows[0].revenue),
                    pendingLabs: parseInt(pendingLabs.rows[0].count),
                    newPatientsToday: parseInt(newPatientsToday.rows[0].count)
                },
                charts: {
                    monthlyPatients: monthlyPatients.rows,
                    dailyRevenue: dailyRevenue.rows,
                    appointmentStats: apptStats.rows
                },
                recentAppointments: recentAppts.rows
            }
        });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== DOCTORS ======
const doctorsRouter = express.Router();

doctorsRouter.get('/', authenticate, async (req, res) => {
    try {
        const { search, departmentId } = req.query;
        let conditions = ['d.hospital_id = $1', 'd.is_active = true'];
        let params = [req.hospitalId];
        let idx = 2;
        if (search) { conditions.push(`d.name ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
        if (departmentId) { conditions.push(`d.department_id = $${idx}`); params.push(departmentId); idx++; }
        const result = await db.query(
            `SELECT d.*, dept.name as department_name,
                    (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id = d.id AND a.appointment_date = CURRENT_DATE) as today_appointments
             FROM doctors d LEFT JOIN departments dept ON d.department_id = dept.id
             WHERE ${conditions.join(' AND ')} ORDER BY d.name`,
            params
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

doctorsRouter.post('/', authenticate, authorize('hospital_admin', 'super_admin'), async (req, res) => {
    try {
        const { name, specialization, departmentId, qualification, experienceYears, consultationFee, contactNumber, email, availableDays, availableFrom, availableTo, bio } = req.body;
        const countResult = await db.query('SELECT COUNT(*) FROM doctors WHERE hospital_id = $1', [req.hospitalId]);
        const doctorId = `DOC-${String(parseInt(countResult.rows[0].count) + 1).padStart(4, '0')}`;
        const result = await db.query(
            `INSERT INTO doctors (hospital_id, doctor_id, name, specialization, department_id, qualification, experience_years, consultation_fee, contact_number, email, available_days, available_from, available_to, bio)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [req.hospitalId, doctorId, name, specialization, departmentId, qualification, experienceYears, consultationFee, contactNumber, email, availableDays, availableFrom, availableTo, bio]
        );
        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

doctorsRouter.put('/:id', authenticate, authorize('hospital_admin', 'super_admin'), async (req, res) => {
    try {
        const { name, specialization, departmentId, qualification, experienceYears, consultationFee, contactNumber, email, availableDays, availableFrom, availableTo, bio } = req.body;
        const result = await db.query(
            `UPDATE doctors SET name=$1, specialization=$2, department_id=$3, qualification=$4, experience_years=$5, consultation_fee=$6, contact_number=$7, email=$8, available_days=$9, available_from=$10, available_to=$11, bio=$12, updated_at=NOW()
             WHERE id=$13 AND hospital_id=$14 RETURNING *`,
            [name, specialization, departmentId, qualification, experienceYears, consultationFee, contactNumber, email, availableDays, availableFrom, availableTo, bio, req.params.id, req.hospitalId]
        );
        return res.json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

doctorsRouter.get('/departments', authenticate, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM departments WHERE hospital_id = $1 AND is_active = true ORDER BY name', [req.hospitalId]);
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== REPORTS ======
const reportsRouter = express.Router();

reportsRouter.get('/patient-visits', authenticate, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const result = await db.query(
            `SELECT p.name, p.uhid, p.phone, p.gender, COUNT(a.id) as visits, MAX(a.appointment_date) as last_visit
             FROM patients p LEFT JOIN appointments a ON p.id = a.patient_id
             WHERE p.hospital_id = $1 AND ($2::date IS NULL OR a.appointment_date >= $2) AND ($3::date IS NULL OR a.appointment_date <= $3)
             GROUP BY p.id ORDER BY visits DESC LIMIT 100`,
            [req.hospitalId, startDate || null, endDate || null]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

reportsRouter.get('/revenue', authenticate, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const result = await db.query(
            `SELECT DATE(bill_date) as date, bill_type, 
                    SUM(total_amount) as total, SUM(paid_amount) as paid, SUM(due_amount) as due,
                    COUNT(*) as count
             FROM bills WHERE hospital_id = $1 
             AND ($2::date IS NULL OR DATE(bill_date) >= $2) 
             AND ($3::date IS NULL OR DATE(bill_date) <= $3)
             GROUP BY DATE(bill_date), bill_type ORDER BY date DESC`,
            [req.hospitalId, startDate || null, endDate || null]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

reportsRouter.get('/doctor-wise', authenticate, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const result = await db.query(
            `SELECT d.name as doctor_name, d.specialization,
                    COUNT(DISTINCT a.id) as total_appointments,
                    COUNT(DISTINCT o.id) as total_opd,
                    COALESCE(SUM(b.paid_amount), 0) as revenue
             FROM doctors d
             LEFT JOIN appointments a ON d.id = a.doctor_id AND ($2::date IS NULL OR a.appointment_date >= $2) AND ($3::date IS NULL OR a.appointment_date <= $3)
             LEFT JOIN opd_consultations o ON d.id = o.doctor_id
             LEFT JOIN bills b ON b.opd_id = o.id
             WHERE d.hospital_id = $1 GROUP BY d.id ORDER BY revenue DESC`,
            [req.hospitalId, startDate || null, endDate || null]
        );
        return res.json({ success: true, data: result.rows });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

// ====== SETTINGS ======
const settingsRouter = express.Router();

settingsRouter.get('/', authenticate, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM hospitals WHERE id = $1', [req.hospitalId]);
        return res.json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

settingsRouter.put('/', authenticate, authorize('hospital_admin', 'super_admin'), async (req, res) => {
    try {
        const { name, orgType, address, city, state, pincode, phone, email, website, gstNumber, registrationNumber } = req.body;
        const result = await db.query(
            `UPDATE hospitals SET name=$1, org_type=$2, address=$3, city=$4, state=$5, pincode=$6, phone=$7, email=$8, website=$9, gst_number=$10, registration_number=$11, updated_at=NOW()
             WHERE id=$12 RETURNING *`,
            [name, orgType, address, city, state, pincode, phone, email, website, gstNumber, registrationNumber, req.hospitalId]
        );
        return res.json({ success: true, data: result.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
});

module.exports = { labRouter, billingRouter, staffRouter, inventoryRouter, dashboardRouter, doctorsRouter, reportsRouter, settingsRouter };
