const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireManager } = require('../middleware/auth');

router.use(requireAuth);

function getStore(req) {
  const s = (req.headers['x-store-id'] || 'sylvania').toLowerCase().trim();
  return ['sylvania', 'holland'].includes(s) ? s : 'sylvania';
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function withItems(order) {
  const items = db.prepare(
    `SELECT id, product_id, product_name, product_emoji, price, qty, sale_type
     FROM order_items WHERE order_id = ? ORDER BY id`
  ).all(order.id);
  return {
    id: order.id,
    date: order.created_at,
    userId: order.user_id,
    userName: order.user_name,
    customerId: order.customer_id,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    subtotal: order.subtotal,
    tax: order.tax,
    discount: order.discount,
    total: order.total,
    status: order.status,
    voidedBy: order.voided_by_name || null,
    voidedByUserId: order.voided_by_user_id || null,
    items: items.map(i => ({
      id: i.product_id,
      name: i.product_name,
      emoji: i.product_emoji,
      price: i.price,
      qty: i.qty,
      saleType: i.sale_type,
    })),
  };
}

function buildFilters(query, store) {
  const { q, from, to, status, userId } = query;
  const clauses = ['o.store_id = ?'];
  const params = [store];
  if (q) {
    clauses.push(`(o.id LIKE ? OR LOWER(o.customer_name) LIKE ? OR LOWER(o.customer_phone) LIKE ? OR LOWER(o.user_name) LIKE ?)`);
    const term = '%' + q.toLowerCase() + '%';
    params.push(term, term, term, term);
  }
  if (from) { clauses.push(`date(o.created_at) >= date(?)`); params.push(from); }
  if (to)   { clauses.push(`date(o.created_at) <= date(?)`); params.push(to); }
  if (status) { clauses.push(`o.status = ?`); params.push(status); }
  if (userId) { clauses.push(`o.user_id = ?`); params.push(userId); }
  return { where: 'WHERE ' + clauses.join(' AND '), params };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** GET /api/orders */
router.get('/', (req, res) => {
  const { where, params } = buildFilters(req.query, getStore(req));
  const orders = db.prepare(
    `SELECT o.* FROM orders o ${where} ORDER BY o.created_at DESC LIMIT 500`
  ).all(...params);
  res.json(orders.map(withItems));
});

/** GET /api/orders/:id */
router.get('/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.id, getStore(req));
  if (!o) return res.status(404).json({ error: 'Order not found' });
  res.json(withItems(o));
});

/** POST /api/orders */
router.post('/', (req, res) => {
  const store = getStore(req);
  const { customerId, customerName, customerPhone, userId, userName, items, subtotal, tax, discount, total } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items array is required' });
  if (!customerName) return res.status(400).json({ error: 'customerName is required' });
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const orderId = `ORD-${datePart}-${rand}`;

  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, store_id, customer_id, customer_name, customer_phone, user_id, user_name, subtotal, tax, discount, total, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'completed')`
    ).run(orderId, store, customerId || null, customerName, customerPhone || '', userId, userName,
          Number(subtotal), Number(tax), Number(discount) || 0, Number(total));
    const insertItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, product_emoji, price, qty, sale_type) VALUES (?,?,?,?,?,?,?)`);
    const decrementStock = db.prepare(`UPDATE products SET stock = MAX(0, stock - ?), updated_at = datetime('now') WHERE id = ? AND store_id = ?`);
    for (const item of items) {
      insertItem.run(orderId, item.id || null, item.name, item.emoji || '📦', Number(item.price), Number(item.qty), item.saleType || 'accessories');
      if (item.id) decrementStock.run(Number(item.qty), item.id, store);
    }
  });

  try {
    transaction();
    res.status(201).json(withItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
  } catch (err) {
    console.error('[orders] POST error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

/** PUT /api/orders/:id (Manager/Admin) */
router.put('/:id', requireManager, (req, res) => {
  const store = getStore(req);
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.id, store);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'voided') return res.status(400).json({ error: 'Cannot edit a voided order' });

  const { customerName, customerPhone, discount, userId, userName } = req.body;
  const newDiscount = discount !== undefined ? Number(discount) : o.discount;
  const newTotal = Math.max(0, o.subtotal + o.tax - newDiscount);
  let resolvedUserId = userId ?? o.user_id;
  let resolvedUserName = userName ?? o.user_name;
  if (userId && !userName) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (u) resolvedUserName = u.name;
  }
  db.prepare(`UPDATE orders SET customer_name=?, customer_phone=?, discount=?, total=?, user_id=?, user_name=? WHERE id=?`)
    .run(customerName ?? o.customer_name, customerPhone ?? o.customer_phone, newDiscount, newTotal, resolvedUserId, resolvedUserName, req.params.id);
  res.json(withItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

/** POST /api/orders/:id/void (any authenticated user) */
router.post('/:id/void', (req, res) => {
  const store = getStore(req);
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(req.params.id, store);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'voided') return res.status(400).json({ error: 'Order already voided' });

  const voiderId = req.user?.id || null;
  const voiderName = req.user?.name || null;

  db.transaction(() => {
    db.prepare(`UPDATE orders SET status = 'voided', voided_by_user_id = ?, voided_by_name = ? WHERE id = ?`)
      .run(voiderId, voiderName, req.params.id);
    const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(req.params.id);
    const restore = db.prepare(`UPDATE products SET stock = stock + ?, updated_at = datetime('now') WHERE id = ? AND store_id = ?`);
    for (const item of items) {
      if (item.product_id) restore.run(item.qty, item.product_id, store);
    }
  })();

  res.json(withItems(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

module.exports = router;
