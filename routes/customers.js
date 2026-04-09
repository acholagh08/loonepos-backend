const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/customers
 * Returns all customers sorted by name.
 * Query params: ?q=search_term
 */
router.get('/', (req, res) => {
  const { q } = req.query;
  let customers;
  if (q) {
    const term = '%' + q.toLowerCase() + '%';
    customers = db.prepare(
      `SELECT * FROM customers
       WHERE LOWER(name) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(email) LIKE ?
       ORDER BY name`
    ).all(term, term, term);
  } else {
    customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  }
  res.json(customers);
});

/**
 * GET /api/customers/:id
 * Returns the customer plus their order history.
 */
router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const orders = db.prepare(
    `SELECT o.*, GROUP_CONCAT(oi.product_name || ' Ã' || oi.qty, ', ') as items_summary
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ?
     GROUP BY o.id
     ORDER BY o.created_at DESC`
  ).all(req.params.id);

  res.json({ ...customer, orders });
});

/**
 * POST /api/customers
 * Body: { name, phone, email? }
 */
router.post('/', (req, res) => {
  const { name, phone, email } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required' });
  }

  // Check for duplicate phone
  const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone.trim());
  if (existing) {
    // Return the existing customer rather than an error â convenient for the frontend
    const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
    return res.status(200).json({ ...cust, existing: true });
  }

  const id = 'c-' + uuidv4().slice(0, 8);
  db.prepare(
    `INSERT INTO customers (id, name, phone, email) VALUES (?,?,?,?)`
  ).run(id, name.trim(), phone.trim(), email?.trim() || null);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  res.status(201).json(customer);
});

/**
 * PUT /api/customers/:id
 */
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const { name, phone, email } = req.body;
  db.prepare(
    `UPDATE customers SET name=?, phone=?, email=? WHERE id=?`
  ).run(name ?? c.name, phone ?? c.phone, email !== undefined ? email : c.email, id);

  const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  res.json(updated);
});

/**
 * DELETE /api/customers/:id   (Admin only)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
