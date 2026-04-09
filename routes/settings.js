const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/settings/receipt
 */
router.get('/receipt', (req, res) => {
  const s = db.prepare('SELECT * FROM receipt_settings WHERE id = 1').get();
  res.json({
    name:    s.store_name,
    address: s.address,
    phone:   s.phone,
    tagline: s.tagline,
    logo:    s.logo,
  });
});

/**
 * PUT /api/settings/receipt   (Admin only)
 * Body: { name?, address?, phone?, tagline?, logo? }
 */
router.put('/receipt', requireAdmin, (req, res) => {
  const { name, address, phone, tagline, logo } = req.body;
  const current = db.prepare('SELECT * FROM receipt_settings WHERE id = 1').get();

  db.prepare(
    `UPDATE receipt_settings
     SET store_name=?, address=?, phone=?, tagline=?, logo=?
     WHERE id = 1`
  ).run(
    name    ?? current.store_name,
    address ?? current.address,
    phone   ?? current.phone,
    tagline ?? current.tagline,
    logo    ?? current.logo,
  );

  const updated = db.prepare('SELECT * FROM receipt_settings WHERE id = 1').get();
  res.json({
    name:    updated.store_name,
    address: updated.address,
    phone:   updated.phone,
    tagline: updated.tagline,
    logo:    updated.logo,
  });
});

module.exports = router;
