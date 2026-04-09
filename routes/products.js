const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/products
 * Returns all products, optionally filtered by category.
 * Query params: ?category=Phones
 */
router.get('/', (req, res) => {
  const { category } = req.query;
  let products;
  if (category) {
    products = db.prepare(
      'SELECT * FROM products WHERE category = ? ORDER BY category, name'
    ).all(category);
  } else {
    products = db.prepare('SELECT * FROM products ORDER BY category, name').all();
  }
  // Normalize snake_case to camelCase for the frontend
  res.json(products.map(normalize));
});

/**
 * GET /api/products/:id
 */
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json(normalize(p));
});

/**
 * POST /api/products   (Admin only)
 * Body: { name, emoji?, price, stock, category, saleType, imei? }
 */
router.post('/', requireAdmin, (req, res) => {
  const { name, emoji, price, stock, category, saleType, imei } = req.body;

  if (!name || price === undefined || stock === undefined || !category || !saleType) {
    return res.status(400).json({ error: 'name, price, stock, category, and saleType are required' });
  }
  if (!['phones', 'accessories'].includes(saleType)) {
    return res.status(400).json({ error: 'saleType must be phones or accessories' });
  }

  const id = 'p-' + uuidv4().slice(0, 8);
  db.prepare(
    `INSERT INTO products (id, name, emoji, price, stock, category, sale_type, imei)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, name.trim(), emoji || 'ð¦', Number(price), Number(stock), category, saleType, imei || null);

  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.status(201).json(normalize(p));
});

/**
 * PUT /api/products/:id   (Admin only)
 */
router.put('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Product not found' });

  const { name, emoji, price, stock, category, saleType, imei } = req.body;

  if (saleType && !['phones', 'accessories'].includes(saleType)) {
    return res.status(400).json({ error: 'saleType must be phones or accessories' });
  }

  db.prepare(
    `UPDATE products
     SET name=?, emoji=?, price=?, stock=?, category=?, sale_type=?, imei=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name       ?? p.name,
    emoji      ?? p.emoji,
    price      !== undefined ? Number(price) : p.price,
    stock      !== undefined ? Number(stock) : p.stock,
    category   ?? p.category,
    saleType   ?? p.sale_type,
    imei       !== undefined ? imei : p.imei,
    id
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  res.json(normalize(updated));
});

/**
 * PATCH /api/products/:id/stock   (Auth required)
 * Adjust stock by a delta value (positive or negative).
 * Body: { delta: -1 }
 */
router.patch('/:id/stock', (req, res) => {
  const { id } = req.params;
  const { delta } = req.body;
  if (delta === undefined) return res.status(400).json({ error: 'delta is required' });

  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Product not found' });

  const newStock = Math.max(0, p.stock + Number(delta));
  db.prepare(`UPDATE products SET stock=?, updated_at=datetime('now') WHERE id=?`).run(newStock, id);
  res.json({ id, stock: newStock });
});

/**
 * DELETE /api/products/:id   (Admin only)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Convert snake_case columns â camelCase for frontend compatibility
function normalize(p) {
  return {
    id:        p.id,
    name:      p.name,
    emoji:     p.emoji,
    price:     p.price,
    stock:     p.stock,
    category:  p.category,
    saleType:  p.sale_type,
    imei:      p.imei,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

module.exports = router;
