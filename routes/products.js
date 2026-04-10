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

/** GET /api/products */
router.get('/', (req, res) => {
  const store = getStore(req);
  const { category } = req.query;
  const products = category
    ? db.prepare('SELECT * FROM products WHERE store_id = ? AND category = ? ORDER BY category, name').all(store, category)
    : db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY category, name').all(store);
  res.json(products.map(normalize));
});

/** GET /api/products/:id */
router.get('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(req.params.id, getStore(req));
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json(normalize(p));
});

/** POST /api/products  (Admin only) */
router.post('/', requireAdmin, (req, res) => {
  const store = getStore(req);
  const { name, emoji, price, stock, category, saleType, imei } = req.body;
  if (!name || price === undefined || stock === undefined || !category || !saleType)
    return res.status(400).json({ error: 'name, price, stock, category, and saleType are required' });
  if (!['phones', 'accessories'].includes(saleType))
    return res.status(400).json({ error: 'saleType must be phones or accessories' });

  const id = store.slice(0, 3) + '-' + uuidv4().slice(0, 8);
  db.prepare(
    `INSERT INTO products (id, store_id, name, emoji, price, stock, category, sale_type, imei)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, store, name.trim(), emoji || '📦', Number(price), Number(stock), category, saleType, imei || null);
  res.status(201).json(normalize(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
});

/** PUT /api/products/:id  (Admin only) */
router.put('/:id', requireAdmin, (req, res) => {
  const store = getStore(req);
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(req.params.id, store);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const { name, emoji, price, stock, category, saleType, imei } = req.body;
  if (saleType && !['phones', 'accessories'].includes(saleType))
    return res.status(400).json({ error: 'saleType must be phones or accessories' });
  db.prepare(
    `UPDATE products SET name=?, emoji=?, price=?, stock=?, category=?, sale_type=?, imei=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    name ?? p.name, emoji ?? p.emoji,
    price  !== undefined ? Number(price)  : p.price,
    stock  !== undefined ? Number(stock)  : p.stock,
    category ?? p.category, saleType ?? p.sale_type,
    imei !== undefined ? imei : p.imei,
    req.params.id
  );
  res.json(normalize(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id)));
});

/** PATCH /api/products/:id/stock */
router.patch('/:id/stock', (req, res) => {
  const store = getStore(req);
  const { delta } = req.body;
  if (delta === undefined) return res.status(400).json({ error: 'delta is required' });
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(req.params.id, store);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const newStock = Math.max(0, p.stock + Number(delta));
  db.prepare(`UPDATE products SET stock=?, updated_at=datetime('now') WHERE id=?`).run(newStock, req.params.id);
  res.json({ id: req.params.id, stock: newStock });
});

/** DELETE /api/products/:id  (Admin only) */
router.delete('/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT id FROM products WHERE id = ? AND store_id = ?').get(req.params.id, getStore(req));
  if (!p) return res.status(404).json({ error: 'Product not found' });
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function normalize(p) {
  return {
    id: p.id, name: p.name, emoji: p.emoji, price: p.price,
    stock: p.stock, category: p.category, saleType: p.sale_type,
    imei: p.imei, createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

module.exports = router;
