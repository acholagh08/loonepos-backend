const express = require('express');
const router  = express.Router();
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

function getStore(req) {
  const s = (req.headers['x-store-id'] || 'sylvania').toLowerCase().trim();
  return ['sylvania', 'holland'].includes(s) ? s : 'sylvania';
}

/** GET /api/settings/receipt */
router.get('/receipt', (req, res) => {
  const store = getStore(req);
  const s = db.prepare('SELECT * FROM receipt_settings WHERE store_id = ?').get(store);
  if (!s) return res.status(404).json({ error: 'Settings not found for store: ' + store });
  res.json({ name: s.store_name, address: s.address, phone: s.phone, tagline: s.tagline, logo: s.logo });
});

/** PUT /api/settings/receipt  (Admin only) */
router.put('/receipt', requireAdmin, (req, res) => {
  const store = getStore(req);
  const { name, address, phone, tagline, logo } = req.body;
  const current = db.prepare('SELECT * FROM receipt_settings WHERE store_id = ?').get(store);
  if (!current) return res.status(404).json({ error: 'Settings not found for store: ' + store });

  db.prepare(
    `UPDATE receipt_settings SET store_name=?, address=?, phone=?, tagline=?, logo=? WHERE store_id=?`
  ).run(
    name    ?? current.store_name,
    address ?? current.address,
    phone   ?? current.phone,
    tagline ?? current.tagline,
    logo    ?? current.logo,
    store
  );
  const updated = db.prepare('SELECT * FROM receipt_settings WHERE store_id = ?').get(store);
  res.json({ name: updated.store_name, address: updated.address, phone: updated.phone, tagline: updated.tagline, logo: updated.logo });
});

module.exports = router;
