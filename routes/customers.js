const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

function getStore(req) {
  const s = (req.headers['x-store-id'] || 'sylvania').toLowerCase().trim();
  return ['sylvania', 'holland'].includes(s) ? s : 'sylvania';
}

/** GET /api/customers */
router.get('/', (req, res) => {
  const store = getStore(req);
  const { q } = req.query;
  let customers;
  if (q) {
    const term = '%' + q.toLowerCase() + '%';
    customers = db.prepare(
      `SELECT * FROM customers WHERE store_id = ? AND (LOWER(name) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(email) LIKE ?) ORDER BY name`
    ).all(store, term, term, term);
  } else {
    customers = db.prepare('SELECT * FROM customers WHERE store_id = ? ORDER BY name').all(store);
  }
  res.json(customers);
});

/** GET /api/customers/:id */
router.get('/:id', (req, res) => {
  const store = getStore(req);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND store_id = ?').get(req.params.id, store);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const orders = db.prepare(
    `SELECT o.*, GROUP_CONCAT(oi.product_name || ' ×' || oi.qty, ', ') as items_summary
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ?
     GROUP BY o.id ORDER BY o.created_at DESC`
  ).all(req.params.id);
  res.json({ ...customer, orders });
});

/** POST /api/customers */
router.post('/', (req, res) => {
  const store = getStore(req);
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });

  // Duplicate phone check — scoped to store
  const existing = db.prepare('SELECT id FROM customers WHERE phone = ? AND store_id = ?').get(phone.trim(), store);
  if (existing) {
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
    return res.status(200).json({ ...cust, existing: true });
  }

  const id = 'c-' + uuidv4().slice(0, 8);
  db.prepare(`INSERT INTO customers (id, store_id, name, phone, email) VALUES (?,?,?,?,?)`)
    .run(id, store, name.trim(), phone.trim(), email?.trim() || null);
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
});

/** PUT /api/customers/:id */
router.put('/:id', (req, res) => {
  const store = getStore(req);
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND store_id = ?').get(req.params.id, store);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const { name, phone, email } = req.body;
  db.prepare(`UPDATE customers SET name=?, phone=?, email=? WHERE id=?`)
    .run(name ?? c.name, phone ?? c.phone, email !== undefined ? email : c.email, req.params.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

/** DELETE /api/customers/:id  (Admin only) */
router.delete('/:id', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT id FROM customers WHERE id = ? AND store_id = ?').get(req.params.id, getStore(req));
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
