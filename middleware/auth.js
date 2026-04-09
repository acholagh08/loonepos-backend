const jwt = require('jsonwebtoken');

/**
 * Require a valid JWT on any route that uses this middleware.
 * Attach the decoded payload to req.user.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized â no token provided' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;   // { id, name, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized â invalid or expired token' });
  }
}

/**
 * Allow only admins.
 * Must be used AFTER requireAuth.
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden â admin access required' });
  }
  next();
}

/**
 * Allow admins and managers.
 */
function requireManager(req, res, next) {
  if (!['admin', 'manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Forbidden â manager or admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireManager };
