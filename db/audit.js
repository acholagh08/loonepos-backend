// ─── Audit log + soft-delete helpers ───────────────────────────────────────
// Shared mutation wrappers. Every write that we care about (create/update/
// delete/void) should go through one of these, not raw prepare().run().
//
// Usage:
//   const { audit, softDelete, getSoftDeleted } = require('../db/audit');
//   audit(req, 'customer', id, 'update', before, after);
//   softDelete(req, 'customers', id);
//
// The req argument supplies actor (req.user), IP, and user-agent. Pass
// null for background/cron jobs — they get actor_name='system' instead.

const db = require('./database');

const insertAudit = db.prepare(`
  INSERT INTO audit_log
    (actor_id, actor_name, store_id, entity, entity_id, action, before_json, after_json, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function getStoreId(req) {
  if (!req) return null;
  const s = (req.headers?.['x-store-id'] || 'sylvania').toLowerCase().trim();
  return ['sylvania', 'holland'].includes(s) ? s : 'sylvania';
}

/**
 * Record a mutation in the audit log.
 *
 * @param {object|null} req  Express request (for actor + IP + UA). Null for system jobs.
 * @param {string} entity    'customer' | 'product' | 'order' | 'user' | ...
 * @param {string|number} entityId
 * @param {string} action    'create' | 'update' | 'delete' | 'restore' | 'void' | ...
 * @param {object|null} before  Snapshot before the change (null on create).
 * @param {object|null} after   Snapshot after the change (null on delete).
 */
function audit(req, entity, entityId, action, before, after) {
  try {
    insertAudit.run(
      req?.user?.id || null,
      req?.user?.name || (req ? null : 'system'),
      getStoreId(req),
      entity,
      String(entityId),
      action,
      before ? JSON.stringify(before) : null,
      after  ? JSON.stringify(after)  : null,
      req?.ip || req?.headers?.['x-forwarded-for'] || null,
      req?.headers?.['user-agent']?.slice(0, 500) || null
    );
  } catch (err) {
    // Never let an audit failure break the user's action.
    console.error('[audit] failed to write:', err.message);
  }
}

/**
 * Soft-delete: mark a row as deleted without removing it. Reads filter on
 * `deleted_at IS NULL`, so the row disappears from normal queries but can be
 * restored via the admin trash UI (coming in Phase 0.2).
 *
 * Returns the row that was soft-deleted (for audit snapshotting).
 *
 * @param {object} req
 * @param {string} table  Must be in the allowed list below.
 * @param {string} id
 * @param {string} [idCol='id']
 */
const SOFT_DELETABLE_TABLES = new Set(['customers', 'products', 'orders', 'users']);

function softDelete(req, table, id, idCol = 'id') {
  if (!SOFT_DELETABLE_TABLES.has(table)) {
    throw new Error(`softDelete: table "${table}" is not in the allowlist`);
  }
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? AND deleted_at IS NULL`).get(id);
  if (!row) return null;
  db.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE ${idCol} = ?`).run(id);
  audit(req, singular(table), id, 'delete', row, null);
  return row;
}

/**
 * Restore a soft-deleted row. Used by the (forthcoming) Trash admin UI.
 */
function restoreSoftDeleted(req, table, id, idCol = 'id') {
  if (!SOFT_DELETABLE_TABLES.has(table)) {
    throw new Error(`restoreSoftDeleted: table "${table}" is not in the allowlist`);
  }
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? AND deleted_at IS NOT NULL`).get(id);
  if (!row) return null;
  db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE ${idCol} = ?`).run(id);
  const after = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id);
  audit(req, singular(table), id, 'restore', row, after);
  return after;
}

/**
 * List soft-deleted rows, newest first, limited to the last N days.
 */
function getSoftDeleted(table, { days = 90, limit = 500 } = {}) {
  if (!SOFT_DELETABLE_TABLES.has(table)) {
    throw new Error(`getSoftDeleted: table "${table}" is not in the allowlist`);
  }
  return db.prepare(
    `SELECT * FROM ${table}
     WHERE deleted_at IS NOT NULL
       AND deleted_at > datetime('now', ?)
     ORDER BY deleted_at DESC
     LIMIT ?`
  ).all(`-${Number(days)} days`, Number(limit));
}

function singular(table) {
  if (table.endsWith('s')) return table.slice(0, -1);
  return table;
}

module.exports = {
  audit,
  softDelete,
  restoreSoftDeleted,
  getSoftDeleted,
};
