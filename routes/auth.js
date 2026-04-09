const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');

/**
 * POST /api/auth/login
 * Body: { userId, pin }
 * Returns: { token, user: { id, name, role, color, initials } }
 *
 * The frontend sends the userId (selected from the grid) and the PIN
 * the user typed. We verify the PIN against the bcrypt hash, then
 * issue a short-lived JWT.
 */
router.post('/login', (req, res) => {
  const { userId, pin } = req.body;

  if (!userId || !pin) {
    return res.status(400).json({ error: 'userId and pin are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = bcrypt.compareSync(String(pin), user.pin_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  const payload = { id: user.id, name: user.name, role: user.role };
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });

  res.json({
    token,
    user: {
      id:       user.id,
      name:     user.name,
      role:     user.role,
      color:    user.color,
      initials: user.initials,
    },
  });
});

/**
 * GET /api/auth/me
 * Returns the currently-authenticated user (useful on page reload).
 */
const { requireAuth } = require('../middleware/auth');

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, role, color, initials FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
