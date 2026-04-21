const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || './data/loonepos.db';
const resolvedPath = path.resolve(dbPath);

const dir = path.dirname(resolvedPath);
if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

const db = new Database(resolvedPath);

// ── Pragmas (safe defaults for production) ──────────────────────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');   // WAL-safe, faster than FULL
db.pragma('busy_timeout = 5000');

// ──────────────────────────────────────────────
// SCHEMA
// ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL CHECK(role IN ('admin','manager','rep')),
    pin_hash   TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6c63ff',
    initials   TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id         TEXT PRIMARY KEY,
    store_id   TEXT NOT NULL DEFAULT 'sylvania',
    name       TEXT NOT NULL,
    emoji      TEXT DEFAULT '📦',
    price      REAL NOT NULL,
    stock      INTEGER NOT NULL DEFAULT 0,
    category   TEXT NOT NULL,
    sale_type  TEXT NOT NULL DEFAULT 'accessories',
    imei       TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id         TEXT PRIMARY KEY,
    store_id   TEXT NOT NULL DEFAULT 'sylvania',
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    email      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id             TEXT PRIMARY KEY,
    store_id       TEXT NOT NULL DEFAULT 'sylvania',
    customer_id    TEXT,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL DEFAULT '',
    user_id        TEXT NOT NULL,
    user_name      TEXT NOT NULL,
    subtotal       REAL NOT NULL,
    tax            REAL NOT NULL,
    discount       REAL NOT NULL DEFAULT 0,
    total          REAL NOT NULL,
    status         TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','voided')),
    created_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      TEXT NOT NULL,
    product_id    TEXT,
    product_name  TEXT NOT NULL,
    product_emoji TEXT DEFAULT '📦',
    price         REAL NOT NULL,
    qty           INTEGER NOT NULL,
    sale_type     TEXT NOT NULL DEFAULT 'accessories',
    FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS receipt_settings (
    store_id   TEXT PRIMARY KEY,
    store_name TEXT DEFAULT 'LoonePOS Store',
    address    TEXT DEFAULT '',
    phone      TEXT DEFAULT '',
    tagline    TEXT DEFAULT '📱 Your trusted cell phone shop',
    logo       TEXT DEFAULT ''
  );

  -- ── Data-safety infrastructure (Phase 0) ─────────────────────────────────
  CREATE TABLE IF NOT EXISTS schema_versions (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    actor_id    TEXT,
    actor_name  TEXT,
    store_id    TEXT,
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    ip          TEXT,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
  CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, at);

  CREATE TABLE IF NOT EXISTS backup_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL DEFAULT (datetime('now')),
    tier        TEXT NOT NULL,      -- 'r2' | 'b2' | 'local'
    bytes       INTEGER,
    ok          INTEGER NOT NULL,   -- 1 = success, 0 = failure
    error       TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_backup_runs_at ON backup_runs(at DESC);
`);

// ──────────────────────────────────────────────
// MIGRATIONS  (safe to run on existing DBs)
// ──────────────────────────────────────────────
function addColIfMissing(table, col, def) {
  const cols = db.pragma(`table_info(${table})`).map(c => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[DB] Migrated: added ${col} to ${table}`);
  }
}
addColIfMissing('products',  'store_id', "TEXT NOT NULL DEFAULT 'sylvania'");
addColIfMissing('orders',    'store_id', "TEXT NOT NULL DEFAULT 'sylvania'");
addColIfMissing('customers', 'store_id', "TEXT NOT NULL DEFAULT 'sylvania'");
addColIfMissing('customers', 'notes', "TEXT DEFAULT ''");
addColIfMissing('orders', 'voided_by_user_id', "TEXT");
addColIfMissing('orders', 'voided_by_name', "TEXT");

// Phase 0 — soft-delete columns on all user-data tables.
// Reads continue to work unchanged (deleted_at IS NULL filter is added in routes).
addColIfMissing('customers', 'deleted_at', "TEXT");
addColIfMissing('products',  'deleted_at', "TEXT");
addColIfMissing('orders',    'deleted_at', "TEXT");
addColIfMissing('users',     'deleted_at', "TEXT");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_customers_deleted ON customers(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_products_deleted  ON products(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_orders_deleted    ON orders(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_users_deleted     ON users(deleted_at);
`);

// receipt_settings: old schema used  id INTEGER PRIMARY KEY  (single row).
// New schema uses  store_id TEXT PRIMARY KEY  (one row per store).
// Detect old schema and migrate.
const rsInfo = db.pragma('table_info(receipt_settings)');
const rsHasStoreId = rsInfo.some(c => c.name === 'store_id' && c.pk === 1);
if (!rsHasStoreId) {
  let oldRow = null;
  try { oldRow = db.prepare('SELECT * FROM receipt_settings LIMIT 1').get(); } catch (_) {}
  db.exec('DROP TABLE IF EXISTS receipt_settings');
  db.exec(`
    CREATE TABLE receipt_settings (
      store_id   TEXT PRIMARY KEY,
      store_name TEXT DEFAULT 'LoonePOS Store',
      address    TEXT DEFAULT '',
      phone      TEXT DEFAULT '',
      tagline    TEXT DEFAULT '📱 Your trusted cell phone shop',
      logo       TEXT DEFAULT ''
    )
  `);
  if (oldRow) {
    db.prepare(
      `INSERT INTO receipt_settings (store_id, store_name, address, phone, tagline, logo)
       VALUES ('sylvania', ?, ?, ?, ?, ?)`
    ).run(oldRow.store_name, oldRow.address, oldRow.phone, oldRow.tagline, oldRow.logo);
  }
  console.log('[DB] Migrated receipt_settings to per-store schema');
}

// Record the Phase-0 migration so we have a record it was applied.
const recordMigration = db.prepare(
  `INSERT OR IGNORE INTO schema_versions (version, description) VALUES (?, ?)`
);
recordMigration.run(1, 'Phase 0: audit_log, backup_runs, schema_versions, soft-delete columns');

// ──────────────────────────────────────────────
// SEED  (only if tables are empty)
// ──────────────────────────────────────────────
function seed() {
  // Receipt settings — one row per store
  for (const sid of ['sylvania', 'holland']) {
    if (!db.prepare('SELECT store_id FROM receipt_settings WHERE store_id = ?').get(sid)) {
      const name = sid.charAt(0).toUpperCase() + sid.slice(1) + ' LoonePOS';
      db.prepare(
        `INSERT INTO receipt_settings (store_id, store_name, address, phone, tagline, logo)
         VALUES (?, ?, '', '', '📱 Your trusted cell phone shop', '')`
      ).run(sid, name);
    }
  }

  // Users — shared across stores
  if (!db.prepare('SELECT COUNT(*) as c FROM users').get().c) {
    const ins = db.prepare(
      `INSERT INTO users (id, name, role, pin_hash, color, initials) VALUES (?,?,?,?,?,?)`
    );
    const seedUsers = [
      { id: 'u1', name: 'Admin',       role: 'admin',   pin: '0000', color: '#fbbf24', initials: 'AD' },
      { id: 'u2', name: 'Alex Rivera', role: 'rep',     pin: '1234', color: '#6c63ff', initials: 'AR' },
      { id: 'u3', name: 'Sam Chen',    role: 'rep',     pin: '5678', color: '#22d3a0', initials: 'SC' },
    ];
    for (const u of seedUsers) ins.run(u.id, u.name, u.role, bcrypt.hashSync(u.pin, 8), u.color, u.initials);
    console.log('[DB] Seeded default users (Admin:0000, Alex:1234, Sam:5678)');
  }

  // Products — seed separately for each store
  for (const sid of ['sylvania', 'holland']) {
    if (!db.prepare('SELECT COUNT(*) as c FROM products WHERE store_id = ?').get(sid).c) {
      const ins = db.prepare(
        `INSERT INTO products (id, store_id, name, emoji, price, stock, category, sale_type)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      const prods = [
        { name: 'iPhone 15 Pro',      emoji: '📱', price: 999,  stock: 8,   cat: 'Phones',      type: 'phones'       },
        { name: 'Samsung Galaxy S24', emoji: '📱', price: 849,  stock: 5,   cat: 'Phones',      type: 'phones'       },
        { name: 'Google Pixel 8',     emoji: '📲', price: 699,  stock: 12,  cat: 'Phones',      type: 'phones'       },
        { name: 'AirPods Pro',        emoji: '🎧', price: 249,  stock: 20,  cat: 'Earbuds',     type: 'accessories'  },
        { name: 'MagSafe Charger',    emoji: '🔌', price: 39,   stock: 30,  cat: 'Chargers',    type: 'accessories'  },
        { name: 'iPhone 15 Case',     emoji: '🛡️', price: 29,   stock: 50,  cat: 'Cases',       type: 'accessories'  },
        { name: 'Screen Protector',   emoji: '🪟', price: 15,   stock: 100, cat: 'Accessories', type: 'accessories'  },
      ];
      for (const p of prods) {
        const id = sid.slice(0, 3) + '-' + Math.random().toString(36).slice(2, 10);
        ins.run(id, sid, p.name, p.emoji, p.price, p.stock, p.cat, p.type);
      }
      console.log(`[DB] Seeded default products for ${sid}`);
    }
  }
}
seed();

module.exports = db;
