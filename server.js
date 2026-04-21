require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));   // 5 MB to allow base64 logo uploads
app.use(express.urlencoded({ extended: true }));

// ── Request logger (dev) ─────────────────────────────────────────────────────
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ── Health checks ────────────────────────────────────────────────────────────
const { backupHealth, runBackup, isConfigured } = require('./db/backup');
const { requireAuth, requireAdmin } = require('./middleware/auth');

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Returns 200 if most recent successful backup was within 26 hours, 500 otherwise.
// Point UptimeRobot at this URL to get paged when nightly backups fail.
app.get('/health/backups', (_req, res) => {
  const h = backupHealth();
  if (!h.healthy) return res.status(500).json(h);
  res.json(h);
});

// Admin-only: run a backup right now. Useful to prove the pipeline works
// after first deploy without waiting for 02:00.
app.post('/api/admin/backup/run', requireAuth, requireAdmin, async (_req, res) => {
  if (!isConfigured()) {
    return res.status(412).json({ error: 'Backup not configured — env vars missing' });
  }
  const result = await runBackup();
  res.status(result.ok ? 200 : 500).json(result);
});

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/settings',  require('./routes/settings'));

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  LoonePOS Backend running on http://localhost:${PORT}`);
  console.log(`  Database:  ${process.env.DB_PATH || './data/loonepos.db'}`);
  console.log(`  CORS:      ${allowedOrigins.length ? allowedOrigins.join(', ') : 'all origins (open)'}\n`);

  // Schedule nightly R2 backup (no-op when env vars absent).
  const { scheduleBackups } = require('./db/backup');
  scheduleBackups();
});
