const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { audit, softDelete } = require('../db/audit');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

function getStore(req) {
  const s = (req.headers['x-store-id'] || 'sylvania').toLowerCase().trim();
  return ['sylvania', 'holland'].includes(s) ? s : 'sylvania';
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getLinesFor(poId) {
  return db.prepare(
    `SELECT * FROM po_lines WHERE po_id = ? ORDER BY id`
  ).all(poId);
}

function withLines(po) {
  const lines = getLinesFor(po.id);
  const vendor = po.vendor_id
    ? db.prepare('SELECT id, name FROM vendors WHERE id = ?').get(po.vendor_id)
    : null;
  return {
    id: po.id,
    storeId: po.store_id,
    vendorId: po.vendor_id,
    vendor: vendor ? { id: vendor.id, name: vendor.name } : null,
    status: po.status,
    reference: po.reference,
    expectedDate: po.expected_date,
    notes: po.notes,
    createdAt: po.created_at,
    createdByUserId: po.created_by_user_id,
    createdByName: po.created_by_name,
    sentAt: po.sent_at,
    closedAt: po.closed_at,
    lines: lines.map(normalizeLine),
    totalCostCents: lines.reduce((sum, l) => sum + (l.unit_cost_cents || 0) * l.qty_ordered, 0),
  };
}

function normalizeLine(l) {
  return {
    id: l.id,
    productId: l.product_id,
    productName: l.product_name,
    qtyOrdered: l.qty_ordered,
    qtyReceived: l.qty_received,
    unitCostCents: l.unit_cost_cents,
    notes: l.notes,
  };
}

// Status helper: compute correct status based on line receipt counts.
function computeStatus(currentStatus, lines) {
  if (currentStatus === 'cancelled' || currentStatus === 'closed') return currentStatus;
  const anyReceived = lines.some(l => l.qty_received > 0);
  const allReceived = lines.length > 0 && lines.every(l => l.qty_received >= l.qty_ordered);
  if (allReceived) return 'received';
  if (anyReceived) return 'partially_received';
  return currentStatus; // still draft or sent
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** GET /api/purchase-orders?status=&vendorId= */
router.get('/', (req, res) => {
  const store = getStore(req);
  const { status, vendorId } = req.query;
  const clauses = ['store_id = ?', 'deleted_at IS NULL'];
  const params = [store];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (vendorId) { clauses.push('vendor_id = ?'); params.push(vendorId); }
  const pos = db.prepare(
    `SELECT * FROM purchase_orders WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 500`
  ).all(...params);
  res.json(pos.map(withLines));
});

/** GET /api/purchase-orders/:id */
router.get('/:id', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, getStore(req));
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json(withLines(po));
});

/** POST /api/purchase-orders
 *  Body: {
 *    vendorId?, reference?, expectedDate?, notes?,
 *    lines: [{ productId?, productName, qtyOrdered, unitCostCents? }]
 *  }
 *  Creates a new draft PO. Lines are required (at least one).
 */
router.post('/', (req, res) => {
  const store = getStore(req);
  const { vendorId, reference, expectedDate, notes, lines } = req.body;

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'lines array with at least one entry is required' });
  }
  for (const [i, l] of lines.entries()) {
    if (!l.productName || !l.productName.trim()) return res.status(400).json({ error: `line ${i}: productName is required` });
    const qty = Number(l.qtyOrdered);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: `line ${i}: qtyOrdered must be a positive number` });
  }
  if (vendorId) {
    const v = db.prepare('SELECT id FROM vendors WHERE id = ? AND deleted_at IS NULL').get(vendorId);
    if (!v) return res.status(400).json({ error: 'vendorId does not exist' });
  }

  const poId = 'po-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + uuidv4().slice(0, 6).toUpperCase();

  const insertPo = db.prepare(
    `INSERT INTO purchase_orders
       (id, store_id, vendor_id, status, reference, expected_date, notes,
        created_by_user_id, created_by_name)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
  );
  const insertLine = db.prepare(
    `INSERT INTO po_lines (po_id, product_id, product_name, qty_ordered, qty_received, unit_cost_cents, notes)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  );

  const tx = db.transaction(() => {
    insertPo.run(
      poId, store, vendorId || null,
      reference?.trim() || null,
      expectedDate || null,
      notes?.trim() || null,
      req.user?.id || null,
      req.user?.name || null
    );
    for (const l of lines) {
      insertLine.run(
        poId,
        l.productId || null,
        l.productName.trim(),
        Number(l.qtyOrdered),
        Number.isFinite(Number(l.unitCostCents)) ? Number(l.unitCostCents) : null,
        l.notes?.trim() || null
      );
    }
  });

  try {
    tx();
  } catch (err) {
    console.error('[POs] create error:', err);
    return res.status(500).json({ error: 'Failed to create purchase order' });
  }

  const created = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  const full = withLines(created);
  audit(req, 'purchase_order', poId, 'create', null,
    { id: poId, vendor_id: vendorId, lineCount: lines.length, totalCostCents: full.totalCostCents }
  );
  res.status(201).json(full);
});

/** PUT /api/purchase-orders/:id
 *  Only allowed while status is 'draft'. Updates header + replaces lines.
 */
router.put('/:id', (req, res) => {
  const store = getStore(req);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, store);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'draft') return res.status(400).json({ error: `Cannot edit a PO in status "${po.status}"; only draft POs are editable` });

  const { vendorId, reference, expectedDate, notes, lines } = req.body;

  if (lines !== undefined) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'lines must be a non-empty array' });
    }
    for (const [i, l] of lines.entries()) {
      if (!l.productName || !l.productName.trim()) return res.status(400).json({ error: `line ${i}: productName is required` });
      const qty = Number(l.qtyOrdered);
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: `line ${i}: qtyOrdered must be a positive number` });
    }
  }
  if (vendorId !== undefined && vendorId !== null) {
    const v = db.prepare('SELECT id FROM vendors WHERE id = ? AND deleted_at IS NULL').get(vendorId);
    if (!v) return res.status(400).json({ error: 'vendorId does not exist' });
  }

  const before = withLines(po);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE purchase_orders
       SET vendor_id = ?, reference = ?, expected_date = ?, notes = ?
       WHERE id = ?`
    ).run(
      vendorId !== undefined ? (vendorId || null) : po.vendor_id,
      reference !== undefined ? (reference?.trim() || null) : po.reference,
      expectedDate !== undefined ? (expectedDate || null) : po.expected_date,
      notes !== undefined ? (notes?.trim() || null) : po.notes,
      req.params.id
    );
    if (lines !== undefined) {
      db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(req.params.id);
      const insertLine = db.prepare(
        `INSERT INTO po_lines (po_id, product_id, product_name, qty_ordered, qty_received, unit_cost_cents, notes)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      );
      for (const l of lines) {
        insertLine.run(
          req.params.id,
          l.productId || null,
          l.productName.trim(),
          Number(l.qtyOrdered),
          Number.isFinite(Number(l.unitCostCents)) ? Number(l.unitCostCents) : null,
          l.notes?.trim() || null
        );
      }
    }
  });
  tx();

  const after = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  const fullAfter = withLines(after);
  audit(req, 'purchase_order', req.params.id, 'update',
    { vendor_id: before.vendorId, lineCount: before.lines.length },
    { vendor_id: fullAfter.vendorId, lineCount: fullAfter.lines.length }
  );
  res.json(fullAfter);
});

/** POST /api/purchase-orders/:id/send
 *  draft → sent. Marks the PO as sent to vendor. Notes can be added.
 */
router.post('/:id/send', (req, res) => {
  const store = getStore(req);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, store);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'draft') return res.status(400).json({ error: `Cannot send a PO in status "${po.status}"` });

  const lines = getLinesFor(po.id);
  if (lines.length === 0) return res.status(400).json({ error: 'Cannot send a PO with no lines' });

  db.prepare(
    `UPDATE purchase_orders SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
  ).run(req.params.id);

  const after = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  audit(req, 'purchase_order', req.params.id, 'send',
    { status: 'draft' },
    { status: 'sent', sent_at: after.sent_at }
  );
  res.json(withLines(after));
});

/** POST /api/purchase-orders/:id/receive
 *  Body: { receipts: [{ lineId, qtyReceived, unitCostCents? }] }
 *  Increments qty_received on each line, bumps linked product.stock,
 *  captures unit_cost_cents if provided (overriding any earlier value),
 *  updates PO status (partially_received or received).
 *  Allowed from status: sent, partially_received.
 */
router.post('/:id/receive', (req, res) => {
  const store = getStore(req);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, store);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (!['sent', 'partially_received'].includes(po.status)) {
    return res.status(400).json({ error: `Cannot receive against a PO in status "${po.status}"` });
  }

  const { receipts } = req.body;
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return res.status(400).json({ error: 'receipts array is required' });
  }
  for (const [i, r] of receipts.entries()) {
    if (r.lineId === undefined || r.lineId === null) return res.status(400).json({ error: `receipt ${i}: lineId is required` });
    const q = Number(r.qtyReceived);
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: `receipt ${i}: qtyReceived must be a positive number` });
  }

  const linesBefore = getLinesFor(po.id);
  const lineMap = new Map(linesBefore.map(l => [l.id, l]));

  // Validate each receipt line and that qty doesn't exceed outstanding
  for (const [i, r] of receipts.entries()) {
    const line = lineMap.get(Number(r.lineId));
    if (!line) return res.status(400).json({ error: `receipt ${i}: line ${r.lineId} not found on this PO` });
    const outstanding = line.qty_ordered - line.qty_received;
    if (Number(r.qtyReceived) > outstanding) {
      return res.status(400).json({ error: `receipt ${i}: qty ${r.qtyReceived} exceeds outstanding ${outstanding} on line ${line.id}` });
    }
  }

  const tx = db.transaction(() => {
    for (const r of receipts) {
      const line = lineMap.get(Number(r.lineId));
      const qtyToReceive = Number(r.qtyReceived);
      const newUnitCost = Number.isFinite(Number(r.unitCostCents)) ? Number(r.unitCostCents) : line.unit_cost_cents;

      db.prepare(
        `UPDATE po_lines
         SET qty_received = qty_received + ?,
             unit_cost_cents = COALESCE(?, unit_cost_cents)
         WHERE id = ?`
      ).run(qtyToReceive, newUnitCost, line.id);

      // Bump stock on linked product (if any)
      if (line.product_id) {
        db.prepare(
          `UPDATE products SET stock = stock + ?, updated_at = datetime('now')
           WHERE id = ? AND store_id = ?`
        ).run(qtyToReceive, line.product_id, store);
      }
    }
    // Recompute status after all lines updated
    const linesAfter = getLinesFor(po.id);
    const newStatus = computeStatus(po.status, linesAfter);
    if (newStatus !== po.status) {
      db.prepare(`UPDATE purchase_orders SET status = ? WHERE id = ?`).run(newStatus, po.id);
    }
  });

  tx();

  const after = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  const fullAfter = withLines(after);
  audit(req, 'purchase_order', req.params.id, 'receive',
    { status: po.status },
    { status: after.status, receiptCount: receipts.length,
      totalQtyReceived: receipts.reduce((s, r) => s + Number(r.qtyReceived), 0) }
  );
  res.json(fullAfter);
});

/** POST /api/purchase-orders/:id/cancel (Manager/Admin) */
router.post('/:id/cancel', (req, res) => {
  const store = getStore(req);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, store);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (['closed', 'cancelled'].includes(po.status)) {
    return res.status(400).json({ error: `PO already ${po.status}` });
  }
  db.prepare(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
  const after = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  audit(req, 'purchase_order', req.params.id, 'cancel',
    { status: po.status },
    { status: 'cancelled' }
  );
  res.json(withLines(after));
});

/** POST /api/purchase-orders/:id/close (Admin) — final, no further edits */
router.post('/:id/close', requireAdmin, (req, res) => {
  const store = getStore(req);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, store);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'closed') return res.status(400).json({ error: 'Already closed' });
  db.prepare(`UPDATE purchase_orders SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(req.params.id);
  const after = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  audit(req, 'purchase_order', req.params.id, 'close',
    { status: po.status },
    { status: 'closed', closed_at: after.closed_at }
  );
  res.json(withLines(after));
});

/** DELETE /api/purchase-orders/:id (Admin, soft-delete, draft/cancelled only) */
router.delete('/:id', requireAdmin, (req, res) => {
  const store = getStore(req);
  const po = db.prepare('SELECT id, status FROM purchase_orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, store);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (!['draft', 'cancelled'].includes(po.status)) {
    return res.status(400).json({ error: `Can only delete draft or cancelled POs; this one is "${po.status}"` });
  }
  softDelete(req, 'purchase_orders', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
