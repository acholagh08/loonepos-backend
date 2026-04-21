const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { audit, softDelete } = require('../db/audit');
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
      `SELECT * FROM customers
       WHERE store_id = ? AND deleted_at IS NULL
         AND (LOWER(name) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(email) LIKE ?)
       ORDER BY name`
    ).all(store, term, term, term);
  } else {
    customers = db.prepare('SELECT * FROM customers WHERE store_id = ? AND deleted_at IS NULL ORDER BY name').all(store);
  }
  res.json(customers);
});

/** GET /api/customers/:id */
router.get('/:id', (req, res) => {
  const store = getStore(req);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(req.params.id, store);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const orders = db.prepare(
    `SELECT o.*, GROUP_CONCAT(oi.product_name || ' ×' || oi.qty, ', ') as items_summary
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ? AND o.deleted_at IS NULL
     GROUP BY o.id
     ORDER BY o.created_at DESC`
  ).all(req.params.id);
  res.json({ ...customer, orders });
});

/** POST /api/customers */
router.post('/', (req, res) => {
  const store = getStore(req);
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const existing = db.prepare('SELECT id FROM customers WHERE phone = ? AND store_id = ? AND deleted_at IS NULL').get(phone.trim(), store);
  if (existing) {
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
    return res.status(200).json({ ...cust, existing: true });
  }
  const id = 'c-' + uuidv4().slice(0, 8);
  db.prepare(`INSERT INTO customers (id, store_id, name, phone, email) VALUES (?,?,?,?,?)`)
    .run(id, store, name.trim(), phone.trim(), email?.trim() || null);
  const created = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  audit(req, 'customer', id, 'create', null, created);
  res.status(201).json(created);
});

/** PUT /api/customers/:id */
router.put('/:id', (req, res) => {
  const store = getStore(req);
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(req.params.id, store);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const { name, phone, email, notes } = req.body;
  db.prepare(`UPDATE customers SET name=?, phone=?, email=?, notes=? WHERE id=?`)
    .run(
      name ?? c.name,
      phone ?? c.phone,
      email !== undefined ? email : c.email,
      notes !== undefined ? notes : c.notes,
      req.params.id
    );
  const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  audit(req, 'customer', req.params.id, 'update', c, after);
  res.json(after);
});

/** DELETE /api/customers/:id (Admin only — soft-delete) */
router.delete('/:id', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT id FROM customers WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(req.params.id, getStore(req));
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  softDelete(req, 'customers', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
