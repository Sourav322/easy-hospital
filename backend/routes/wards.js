const express = require("express");
const router = express.Router();
const pool = require("../db"); // ensure yeh path sahi hai

// GET all wards with bed count
router.get("/", async (req, res) => {
  try {
    const hospitalId = 1; // 🔥 abhi test ke liye fix rakho

    const query = `
      SELECT 
        w.id,
        w.ward_name,
        COUNT(b.id) as total_beds,
        COUNT(CASE WHEN b.status='available' THEN 1 END) as available_beds
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id
      WHERE w.hospital_id=$1 AND w.is_active=true
      GROUP BY w.id, w.ward_name
      ORDER BY w.ward_name;
    `;

    const result = await pool.query(query, [hospitalId]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
