require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

// ââ CORS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Body parsing âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use(express.json({ limit: '5mb' }));   // 5 MB to allow base64 logo uploads
app.use(express.urlencoded({ extended: true }));

// ââ Request logger (dev) ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ââ Health check âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ââ API Routes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/reports',   require('./routes/reports'));
app.use('/api/settings',  require('./routes/settings'));

// ââ 404 handler âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// ââ Global error handler ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ââ Start âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  âââ      âââââââ  âââââââ ââââ   âââââââââââ âââââââ  âââââââ ââââââââ`);
  console.log(`  âââ     âââââââââââââââââââââââ  âââââââââââ âââââââââââââââââââââââââ`);
  console.log(`  âââ     âââ   ââââââ   âââââââââ âââââââââ   âââââââââââ   âââââââââââ`);
  console.log(`  âââ     âââ   ââââââ   âââââââââââââââââââ   âââââââ âââ   âââââââââââ`);
  console.log(`  âââââââââââââââââââââââââââââ ââââââââââââââ âââ     âââââââââââââââââ`);
  console.log(`  ââââââââ âââââââ  âââââââ âââ  âââââââââââââ âââ      âââââââ ââââââââ\n`);
  console.log(`  ð  LoonePOS Backend running on http://localhost:${PORT}`);
  console.log(`  ð¦  Database:  ${process.env.DB_PATH || './data/loonepos.db'}`);
  console.log(`  ð  CORS:      ${allowedOrigins.length ? allowedOrigins.join(', ') : 'all origins (open)'}\n`);
});
