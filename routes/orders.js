const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireAdmin, requireManager } = require('../middleware/auth');

router.use(requireAuth);

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/** Attach items array to an order row */
function withItems(order) {
  const items = db.prepare(
    `SELECT id, product_id, product_name, product_emoji, price, qty, sale_type
     FROM order_items WHERE order_id = ? ORDER BY id`
  ).all(order.id);

  return {
    id:            order.id,
    date:          order.created_at,
    userId:        order.user_id,
    userName:      order.user_name,
    customerId:    order.customer_id,
    customerName:  order.customer_name,
    customerPhone: order.customer_phone,
    subtotal:      order.subtotal,
    tax:           order.tax,
    discount:      order.discount,
    total:         order.total,
    status:        order.status,
    items:         items.map(i => ({
      id:        i.product_id,
      name:      i.product_name,
      emoji:     i.product_emoji,
      price:     i.price,
      qty:       i.qty,
      saleType:  i.sale_type,
    })),
  };
}

/** Build a WHERE clause + params from query filters */
function buildFilters(query) {
  const { q, from, to, status, userId } = query;
  const clauses = [];
  const params = [];

  if (q) {
    clauses.push(
      `(o.id LIKE ? OR LOWER(o.customer_name) LIKE ? OR LOWER(o.customer_phone) LIKE ? OR LOWER(o.user_name) LIKE ?)`
    );
    const term = '%' + q.toLowerCase() + '%';
    params.push(term, term, term, term);
  }
  if (from) { clauses.push(`date(o.created_at) >= date(?)`); params.push(from); }
  if (to)   { clauses.push(`date(o.created_at) <= date(?)`); params.push(to); }
  if (status) { clauses.push(`o.status = ?`); params.push(status); }
  if (userId) { clauses.push(`o.user_id = ?`); params.push(userId); }

  return {
    where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '',
    params,
  };
}

// ââ Routes âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * GET /api/orders
 * Query: ?q=&from=YYYY-MM-DD&to=YYYY-MM-DD&status=completed|voided&userId=
 */
router.get('/', (req, res) => {
  const { where, params } = buildFilters(req.query);
  const orders = db.prepare(
    `SELECT o.* FROM orders o ${where} ORDER BY o.created_at DESC LIMIT 500`
  ).all(...params);

  res.json(orders.map(withItems));
});

/**
 * GET /api/orders/:id
 */
router.get('/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  res.json(withItems(o));
});

/**
 * POST /api/orders
 * Creates an order and decrements stock atomically.
 * Body: {
 *   customerId, customerName, customerPhone,
 *   userId, userName,
 *   items: [{ id, name, emoji, price, qty, saleType }],
 *   subtotal, tax, discount, total
 * }
 */
router.post('/', (req, res) => {
  const {
    customerId, customerName, customerPhone,
    userId, userName,
    items, subtotal, tax, discount, total,
  } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'items array is required' });
  if (!customerName)  return res.status(400).json({ error: 'customerName is required' });
  if (!userId)        return res.status(400).json({ error: 'userId is required' });

  // Generate an order ID like ORD-20240409-xxxxx
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const orderId = `ORD-${datePart}-${rand}`;

  // Run everything in a transaction so stock and order save together
  const transaction = db.transaction(() => {
    // Insert order
    db.prepare(
      `INSERT INTO orders (id, customer_id, customer_name, customer_phone, user_id, user_name,
                           subtotal, tax, discount, total, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,'completed')`
    ).run(
      orderId,
      customerId || null,
      customerName,
      customerPhone || '',
      userId,
      userName,
      Number(subtotal),
      Number(tax),
      Number(discount) || 0,
      Number(total),
    );

    // Insert items + decrement stock
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, product_emoji, price, qty, sale_type)
       VALUES (?,?,?,?,?,?,?)`
    );
    const decrementStock = db.prepare(
      `UPDATE products SET stock = MAX(0, stock - ?), updated_at = datetime('now') WHERE id = ?`
    );

    for (const item of items) {
      insertItem.run(
        orderId,
        item.id   || null,
        item.name,
        item.emoji || 'ð¦',
        Number(item.price),
        Number(item.qty),
        item.saleType || 'accessories',
      );
      if (item.id) decrementStock.run(Number(item.qty), item.id);
    }
  });

  try {
    transaction();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    res.status(201).json(withItems(order));
  } catch (err) {
    console.error('[orders] POST error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

/**
 * PUT /api/orders/:id   (Manager/Admin)
 * Allows editing customer info, discount, and served-by user.
 * Does NOT change items (to keep inventory consistent).
 */
router.put('/:id', requireManager, (req, res) => {
  const { id } = req.params;
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'voided') return res.status(400).json({ error: 'Cannot edit a voided order' });

  const { customerName, customerPhone, discount, userId, userName } = req.body;

  // Recalculate total if discount changes
  const newDiscount = discount !== undefined ? Number(discount) : o.discount;
  const newTotal = Math.max(0, o.subtotal + o.tax - newDiscount);

  // Resolve new userName from DB if only userId is provided
  let resolvedUserName = userName ?? o.user_name;
  let resolvedUserId   = userId   ?? o.user_id;
  if (userId && !userName) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (u) resolvedUserName = u.name;
  }

  db.prepare(
    `UPDATE orders
     SET customer_name=?, customer_phone=?, discount=?, total=?, user_id=?, user_name=?
     WHERE id=?`
  ).run(
    customerName  ?? o.customer_name,
    customerPhone ?? o.customer_phone,
    newDiscount,
    newTotal,
    resolvedUserId,
    resolvedUserName,
    id,
  );

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  res.json(withItems(updated));
});

/**
 * POST /api/orders/:id/void   (Manager/Admin)
 * Marks the order as voided and restores stock.
 */
router.post('/:id/void', requireManager, (req, res) => {
  const { id } = req.params;
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'voided') return res.status(400).json({ error: 'Order already voided' });

  const transaction = db.transaction(() => {
    db.prepare(`UPDATE orders SET status = 'voided' WHERE id = ?`).run(id);

    // Restore stock
    const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(id);
    const restoreStock = db.prepare(
      `UPDATE products SET stock = stock + ?, updated_at = datetime('now') WHERE id = ?`
    );
    for (const item of items) {
      if (item.product_id) restoreStock.run(item.qty, item.product_id);
    }
  });

  transaction();
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  res.json(withItems(updated));
});

module.exports = router;
