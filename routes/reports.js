const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/** Parse date range query params into a SQL filter fragment */
function dateFilter(from, to, col = 'o.created_at') {
  const clauses = [`o.status = 'completed'`];
  const params = [];
  if (from) { clauses.push(`date(${col}) >= date(?)`); params.push(from); }
  if (to)   { clauses.push(`date(${col}) <= date(?)`); params.push(to); }
  return { where: 'WHERE ' + clauses.join(' AND '), params };
}

/**
 * GET /api/reports/summary
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns: { revenue, orders, itemsSold, avgOrder }
 */
router.get('/summary', (req, res) => {
  const { from, to } = req.query;
  const { where, params } = dateFilter(from, to);

  const row = db.prepare(
    `SELECT
       COALESCE(SUM(o.total), 0)       AS revenue,
       COUNT(o.id)                     AS orders,
       COALESCE(SUM(oi.qty_sum), 0)    AS itemsSold
     FROM orders o
     LEFT JOIN (
       SELECT order_id, SUM(qty) AS qty_sum FROM order_items GROUP BY order_id
     ) oi ON oi.order_id = o.id
     ${where}`
  ).get(...params);

  const avgOrder = row.orders > 0 ? row.revenue / row.orders : 0;
  res.json({ ...row, avgOrder });
});

/**
 * GET /api/reports/top-products
 * Query: ?from=&to=&limit=10
 */
router.get('/top-products', (req, res) => {
  const { from, to, limit = 10 } = req.query;
  const { where, params } = dateFilter(from, to);

  const rows = db.prepare(
    `SELECT
       oi.product_name  AS name,
       oi.product_emoji AS emoji,
       SUM(oi.qty)      AS sold,
       SUM(oi.qty * oi.price) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ${where}
     GROUP BY oi.product_name
     ORDER BY sold DESC
     LIMIT ?`
  ).all(...params, Number(limit));

  res.json(rows);
});

/**
 * GET /api/reports/top-reps
 * Query: ?from=&to=&limit=10
 */
router.get('/top-reps', (req, res) => {
  const { from, to, limit = 10 } = req.query;
  const { where, params } = dateFilter(from, to);

  const rows = db.prepare(
    `SELECT
       o.user_id   AS userId,
       o.user_name AS name,
       COUNT(o.id) AS orders,
       SUM(o.total) AS revenue
     FROM orders o
     ${where}
     GROUP BY o.user_id
     ORDER BY revenue DESC
     LIMIT ?`
  ).all(...params, Number(limit));

  // Attach user color
  const users = db.prepare('SELECT id, color FROM users').all();
  const colorMap = Object.fromEntries(users.map(u => [u.id, u.color]));

  res.json(rows.map(r => ({ ...r, color: colorMap[r.userId] || '#888' })));
});

/**
 * GET /api/reports/sales-by-category
 * Query: ?from=&to=
 */
router.get('/sales-by-category', (req, res) => {
  const { from, to } = req.query;
  const { where, params } = dateFilter(from, to);

  const rows = db.prepare(
    `SELECT
       p.category,
       SUM(oi.qty)           AS sold,
       SUM(oi.qty * oi.price) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     ${where}
     GROUP BY p.category
     ORDER BY revenue DESC`
  ).all(...params);

  res.json(rows);
});

/**
 * GET /api/reports/daily
 * Revenue per day over the last 30 days (or custom range).
 * Query: ?from=&to=
 */
router.get('/daily', (req, res) => {
  const { from, to } = req.query;
  const { where, params } = dateFilter(from, to);

  const rows = db.prepare(
    `SELECT
       date(o.created_at) AS day,
       COUNT(o.id)        AS orders,
       SUM(o.total)       AS revenue
     FROM orders o
     ${where}
     GROUP BY day
     ORDER BY day ASC`
  ).all(...params);

  res.json(rows);
});

module.exports = router;
