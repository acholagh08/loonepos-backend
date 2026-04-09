const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || './data/loonepos.db';
const resolvedPath = path.resolve(dbPath);

// Ensure data directory exists
const dir = path.dirname(resolvedPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(resolvedPath);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ââââââââââââââââââââââââââââââââââââââââââââââ
//  SCHEMA
// ââââââââââââââââââââââââââââââââââââââââââââââ
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('admin','manager','rep')),
    pin_hash    TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#6c63ff',
    initials    TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    emoji       TEXT DEFAULT 'ð¦',
    price       REAL NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    category    TEXT NOT NULL,
    sale_type   TEXT NOT NULL DEFAULT 'accessories',
    imei        TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT,
    customer_name   TEXT NOT NULL,
    customer_phone  TEXT NOT NULL DEFAULT '',
    user_id         TEXT NOT NULL,
    user_name       TEXT NOT NULL,
    subtotal        REAL NOT NULL,
    tax             REAL NOT NULL,
    discount        REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','voided')),
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      TEXT NOT NULL,
    product_id    TEXT,
    product_name  TEXT NOT NULL,
    product_emoji TEXT DEFAULT 'ð¦',
    price         REAL NOT NULL,
    qty           INTEGER NOT NULL,
    sale_type     TEXT NOT NULL DEFAULT 'accessories',
    FOREIGN KEY (order_id)   REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS receipt_settings (
    id         INTEGER PRIMARY KEY DEFAULT 1,
    store_name TEXT DEFAULT 'LoonePOS Store',
    address    TEXT DEFAULT '',
    phone      TEXT DEFAULT '',
    tagline    TEXT DEFAULT 'ð± Your trusted cell phone shop',
    logo       TEXT DEFAULT ''
  );
`);

// ââââââââââââââââââââââââââââââââââââââââââââââ
//  SEED DEFAULT DATA (only if tables are empty)
// ââââââââââââââââââââââââââââââââââââââââââââââ
function seed() {
  // Receipt settings
  const hasSettings = db.prepare('SELECT COUNT(*) as c FROM receipt_settings').get().c;
  if (!hasSettings) {
    db.prepare(`INSERT INTO receipt_settings (id, store_name, address, phone, tagline, logo)
                VALUES (1, 'LoonePOS Store', '', '', 'ð± Your trusted cell phone shop', '')`).run();
  }

  // Users
  const hasUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (!hasUsers) {
    const insert = db.prepare(
      `INSERT INTO users (id, name, role, pin_hash, color, initials) VALUES (?,?,?,?,?,?)`
    );
    const seedUsers = [
      { id: 'u1', name: 'Admin',       role: 'admin',   pin: '0000', color: '#fbbf24', initials: 'AD' },
      { id: 'u2', name: 'Alex Rivera', role: 'rep',     pin: '1234', color: '#6c63ff', initials: 'AR' },
      { id: 'u3', name: 'Sam Chen',    role: 'rep',     pin: '5678', color: '#22d3a0', initials: 'SC' },
    ];
    for (const u of seedUsers) {
      const hash = bcrypt.hashSync(u.pin, 8);
      insert.run(u.id, u.name, u.role, hash, u.color, u.initials);
    }
    console.log('[DB] Seeded default users (Admin pin: 0000, Alex pin: 1234, Sam pin: 5678)');
  }

  // Products
  const hasProds = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  if (!hasProds) {
    const insert = db.prepare(
      `INSERT INTO products (id, name, emoji, price, stock, category, sale_type) VALUES (?,?,?,?,?,?,?)`
    );
    const seedProds = [
      { id: 'p1',  name: 'iPhone 15 Pro',      emoji: 'ð±', price: 999,  stock: 8,   category: 'Phones',      saleType: 'phones' },
      { id: 'p2',  name: 'Samsung Galaxy S24',  emoji: 'ð±', price: 849,  stock: 5,   category: 'Phones',      saleType: 'phones' },
      { id: 'p3',  name: 'Google Pixel 8',      emoji: 'ð²', price: 699,  stock: 12,  category: 'Phones',      saleType: 'phones' },
      { id: 'p4',  name: 'AirPods Pro',         emoji: 'ð§', price: 249,  stock: 20,  category: 'Earbuds',     saleType: 'accessories' },
      { id: 'p5',  name: 'MagSafe Charger',     emoji: 'ð', price: 39,   stock: 30,  category: 'Chargers',    saleType: 'accessories' },
      { id: 'p6',  name: 'iPhone 15 Case',      emoji: 'ð¡ï¸', price: 29,   stock: 50,  category: 'Cases',       saleType: 'accessories' },
      { id: 'p7',  name: 'Samsung Case',        emoji: 'ð¡ï¸', price: 25,   stock: 45,  category: 'Cases',       saleType: 'accessories' },
      { id: 'p8',  name: 'USB-C Cable 2m',      emoji: 'ð', price: 19,   stock: 0,   category: 'Chargers',    saleType: 'accessories' },
      { id: 'p9',  name: 'iPad Air',            emoji: 'ð»', price: 749,  stock: 3,   category: 'Tablets',     saleType: 'phones' },
      { id: 'p10', name: 'Screen Protector',    emoji: 'ðª', price: 15,   stock: 100, category: 'Accessories', saleType: 'accessories' },
    ];
    for (const p of seedProds) {
      insert.run(p.id, p.name, p.emoji, p.price, p.stock, p.category, p.saleType);
    }
    console.log('[DB] Seeded default products');
  }
}

seed();

module.exports = db;
