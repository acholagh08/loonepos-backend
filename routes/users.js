const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * GET /api/users
 * Returns all users (without pin hashes).
 * PUBLIC â no token needed. This is intentional: the login screen needs
 * the user list (name, color, initials) before authentication can happen.
 * No sensitive data (PINs are hashed and never returned).
 */
router.get('/', (req, res) => {
  const users = db.prepare(
    'SELECT id, name, role, color, initials, created_at FROM users ORDER BY name'
  ).all();
  res.json(users);
});

// All routes below this point require authentication
router.use(requireAuth);

/**
 * POST /api/users   (Admin only)
 * Body: { name, role, pin, color, initials? }
 */
router.post('/', requireAdmin, (req, res) => {
  const { name, role, pin, color, initials } = req.body;

  if (!name || !role || !pin) {
    return res.status(400).json({ error: 'name, role, and pin are required' });
  }
  if (!['admin', 'manager', 'rep'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, manager, or rep' });
  }
  if (String(pin).length !== 4 || !/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }

  const id = uuidv4();
  const pin_hash = bcrypt.hashSync(String(pin), 8);
  const derivedInitials = initials || name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  db.prepare(
    `INSERT INTO users (id, name, role, pin_hash, color, initials) VALUES (?,?,?,?,?,?)`
  ).run(id, name.trim(), role, pin_hash, color || '#6c63ff', derivedInitials);

  const user = db.prepare('SELECT id, name, role, color, initials, created_at FROM users WHERE id = ?').get(id);
  res.status(201).json(user);
});

/**
 * PUT /api/users/:id   (Admin only)
 * Body: { name?, role?, pin?, color?, initials? }
 */
router.put('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, role, pin, color, initials } = req.body;

  if (role && !['admin', 'manager', 'rep'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, manager, or rep' });
  }
  if (pin && (String(pin).length !== 4 || !/^\d{4}$/.test(String(pin)))) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }

  const updates = {
    name:     name     ?? user.name,
    role:     role     ?? user.role,
    color:    color    ?? user.color,
    initials: initials ?? user.initials,
    pin_hash: pin ? bcrypt.hashSync(String(pin), 8) : user.pin_hash,
  };

  db.prepare(
    `UPDATE users SET name=?, role=?, color=?, initials=?, pin_hash=? WHERE id=?`
  ).run(updates.name, updates.role, updates.color, updates.initials, updates.pin_hash, id);

  const updated = db.prepare('SELECT id, name, role, color, initials, created_at FROM users WHERE id = ?').get(id);
  res.json(updated);
});

/**
 * DELETE /api/users/:id   (Admin only)
 * Cannot delete yourself.
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
