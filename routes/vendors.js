const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { audit, softDelete } = require('../db/audit');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

// Vendors are SHARED across both stores, so we do NOT filter by store_id.

/** GET /api/vendors */
router.get('/', (req, res) => {
  const { q } = req.query;
  let rows;
  if (q) {
    const term = '%' + q.toLowerCase() + '%';
    rows = db.prepare(
      `SELECT * FROM vendors
       WHERE deleted_at IS NULL
         AND (LOWER(name) LIKE ? OR LOWER(contact_name) LIKE ? OR LOWER(contact_email) LIKE ? OR LOWER(contact_phone) LIKE ?)
       ORDER BY name`
    ).all(term, term, term, term);
  } else {
    rows = db.prepare('SELECT * FROM vendors WHERE deleted_at IS NULL ORDER BY name').all();
  }
  res.json(rows.map(normalize));
});

/** GET /api/vendors/:id */
router.get('/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  res.json(normalize(v));
});

/** POST /api/vendors */
router.post('/', (req, res) => {
  const { name, contactName, contactPhone, contactEmail, address, leadTimeDays, doaWindowDays, paymentTerms, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const id = 'v-' + uuidv4().slice(0, 8);
  db.prepare(
    `INSERT INTO vendors (id, name, contact_name, contact_phone, contact_email, address,
                          lead_time_days, doa_window_days, payment_terms, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name.trim(),
    contactName?.trim() || null,
    contactPhone?.trim() || null,
    contactEmail?.trim() || null,
    address?.trim() || null,
    Number.isFinite(Number(leadTimeDays)) ? Number(leadTimeDays) : 7,
    Number.isFinite(Number(doaWindowDays)) ? Number(doaWindowDays) : 30,
    paymentTerms?.trim() || null,
    notes?.trim() || null
  );
  const created = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  audit(req, 'vendor', id, 'create', null, created);
  res.status(201).json(normalize(created));
});

/** PUT /api/vendors/:id */
router.put('/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });

  const { name, contactName, contactPhone, contactEmail, address, leadTimeDays, doaWindowDays, paymentTerms, notes } = req.body;

  db.prepare(
    `UPDATE vendors
     SET name            = ?,
         contact_name    = ?,
         contact_phone   = ?,
         contact_email   = ?,
         address         = ?,
         lead_time_days  = ?,
         doa_window_days = ?,
         payment_terms   = ?,
         notes           = ?,
         updated_at      = datetime('now')
     WHERE id = ?`
  ).run(
    (name !== undefined ? name?.trim() : v.name),
    (contactName !== undefined ? contactName?.trim() || null : v.contact_name),
    (contactPhone !== undefined ? contactPhone?.trim() || null : v.contact_phone),
    (contactEmail !== undefined ? contactEmail?.trim() || null : v.contact_email),
    (address !== undefined ? address?.trim() || null : v.address),
    (leadTimeDays !== undefined && Number.isFinite(Number(leadTimeDays))) ? Number(leadTimeDays) : v.lead_time_days,
    (doaWindowDays !== undefined && Number.isFinite(Number(doaWindowDays))) ? Number(doaWindowDays) : v.doa_window_days,
    (paymentTerms !== undefined ? paymentTerms?.trim() || null : v.payment_terms),
    (notes !== undefined ? notes?.trim() || null : v.notes),
    req.params.id
  );
  const after = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  audit(req, 'vendor', req.params.id, 'update', v, after);
  res.json(normalize(after));
});

/** DELETE /api/vendors/:id (Admin only — soft-delete) */
router.delete('/:id', requireAdmin, (req, res) => {
  const v = db.prepare('SELECT id FROM vendors WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });

  // Check for open POs referencing this vendor
  const openCount = db.prepare(
    `SELECT COUNT(*) as c FROM purchase_orders
     WHERE vendor_id = ? AND deleted_at IS NULL AND status NOT IN ('closed', 'cancelled')`
  ).get(req.params.id).c;
  if (openCount > 0) {
    return res.status(409).json({ error: `Cannot delete vendor: ${openCount} open purchase order(s) still reference it` });
  }

  softDelete(req, 'vendors', req.params.id);
  res.json({ ok: true });
});

function normalize(v) {
  return {
    id: v.id,
    name: v.name,
    contactName: v.contact_name,
    contactPhone: v.contact_phone,
    contactEmail: v.contact_email,
    address: v.address,
    leadTimeDays: v.lead_time_days,
    doaWindowDays: v.doa_window_days,
    paymentTerms: v.payment_terms,
    notes: v.notes,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

module.exports = router;
