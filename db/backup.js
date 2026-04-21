// ─── Nightly encrypted backup to Cloudflare R2 ─────────────────────────────
// Cron runs once a night. Uses better-sqlite3's online backup API (safe
// while the DB is live — handles WAL correctly; a naive fs.copy of the
// .db file would miss uncommitted pages in the WAL).
//
// Pipeline:   sqlite -> .tmp/backup.db -> gzip -> AES-256-GCM encrypt -> R2
//
// Env vars required (set in Railway dashboard → Variables):
//   R2_ACCESS_KEY_ID       Cloudflare R2 access key
//   R2_SECRET_ACCESS_KEY   Cloudflare R2 secret
//   R2_BUCKET              bucket name (e.g., 'loonepos-backups')
//   R2_ENDPOINT            https://<ACCOUNT_ID>.r2.cloudflarestorage.com
//   BACKUP_KEY             32-byte hex or base64 encryption key (see README)
//
// Optional:
//   BACKUP_SCHEDULE        cron expression; default '0 2 * * *' (02:00 daily)
//   BACKUP_TZ              default 'America/New_York'
//   BACKUP_RETAIN_DAYS     how many daily backups to keep (R2-side lifecycle
//                          does retention, but we skip upload if disabled)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const db = require('./database');

// Lazy-load AWS SDK + cron so boot doesn't crash when deps are missing in dev.
let S3Client, PutObjectCommand, cron;
try {
  ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  cron = require('node-cron');
} catch (err) {
  // Will be reported via isConfigured() check.
}

function isConfigured() {
  return !!(
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_ENDPOINT &&
    process.env.BACKUP_KEY &&
    S3Client && cron
  );
}

function getS3Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

function deriveKey() {
  const raw = process.env.BACKUP_KEY.trim();
  // Accept hex (64 chars) or base64; fall back to sha256(passphrase) if neither.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch (_) {}
  return crypto.createHash('sha256').update(raw).digest();
}

async function encryptFileToGzip(srcPath, destPath) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);                    // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(destPath);

  // Prefix the output with IV so decryption can find it later.
  out.write(iv);

  // Pipeline: file -> gzip -> cipher -> out
  await pipeline(fs.createReadStream(srcPath), gzip, cipher, out, { end: false });
  out.write(cipher.getAuthTag());
  await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
}

async function uploadToR2(localPath, key) {
  const s3 = getS3Client();
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
    Metadata: {
      'loonepos-version': '1',
      'encrypted': 'aes-256-gcm',
      'compressed': 'gzip',
      'created-at': new Date().toISOString(),
    },
  }));
  return body.length;
}

/**
 * Run one backup. Called by the scheduler or by an admin endpoint.
 * Always writes a row to backup_runs with success/failure.
 */
async function runBackup() {
  const started = Date.now();
  const tmpDir  = path.join(path.dirname(process.env.DB_PATH || './data/loonepos.db'), '.backup-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const stamp     = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);  // 2026-04-21-02-00-00
  const sqliteOut = path.join(tmpDir, `loonepos-${stamp}.db`);
  const encOut    = path.join(tmpDir, `loonepos-${stamp}.db.gz.enc`);
  const r2Key     = `daily/loonepos-${stamp}.db.gz.enc`;

  let bytes = 0;
  let errText = null;

  try {
    if (!isConfigured()) {
      throw new Error('backup not configured (R2 env vars or deps missing)');
    }

    // 1. Online SQLite backup (WAL-safe).
    await db.backup(sqliteOut);

    // 2. Encrypt + gzip to a single file.
    await encryptFileToGzip(sqliteOut, encOut);

    // 3. Upload to R2.
    bytes = await uploadToR2(encOut, r2Key);

    db.prepare(
      `INSERT INTO backup_runs (tier, bytes, ok, error, duration_ms) VALUES (?,?,?,?,?)`
    ).run('r2', bytes, 1, null, Date.now() - started);

    console.log(`[backup] ok  r2://${process.env.R2_BUCKET}/${r2Key}  ${bytes} bytes  ${Date.now() - started}ms`);
    return { ok: true, key: r2Key, bytes, durationMs: Date.now() - started };

  } catch (err) {
    errText = String(err?.message || err);
    db.prepare(
      `INSERT INTO backup_runs (tier, bytes, ok, error, duration_ms) VALUES (?,?,?,?,?)`
    ).run('r2', bytes, 0, errText, Date.now() - started);
    console.error('[backup] FAILED:', errText);
    return { ok: false, error: errText, durationMs: Date.now() - started };

  } finally {
    // Clean up tmp files regardless of outcome.
    try { fs.unlinkSync(sqliteOut); } catch (_) {}
    try { fs.unlinkSync(encOut);    } catch (_) {}
  }
}

/**
 * Register the nightly cron. Call once from server.js at boot.
 * No-op when env vars are missing (safe in dev).
 */
function scheduleBackups() {
  if (!cron) {
    console.warn('[backup] node-cron not installed; skipping schedule');
    return;
  }
  if (!isConfigured()) {
    console.warn('[backup] env vars missing; nightly backup DISABLED');
    console.warn('[backup] set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT, BACKUP_KEY to enable');
    return;
  }

  const schedule = process.env.BACKUP_SCHEDULE || '0 2 * * *';  // 02:00 daily
  const tz       = process.env.BACKUP_TZ       || 'America/New_York';

  cron.schedule(schedule, () => {
    runBackup().catch(err => console.error('[backup] cron error:', err));
  }, { timezone: tz });

  console.log(`[backup] scheduled "${schedule}" (${tz}) → r2://${process.env.R2_BUCKET}/daily/`);
}

/**
 * Health check: returns the newest successful backup row and whether it's
 * within the staleness window (default 26h). Used by /health/backups.
 */
function backupHealth({ maxAgeHours = 26 } = {}) {
  const last = db.prepare(
    `SELECT * FROM backup_runs WHERE ok = 1 ORDER BY at DESC LIMIT 1`
  ).get();
  if (!last) {
    return { healthy: false, reason: 'no successful backups recorded yet', last: null };
  }
  const ageMs = Date.now() - new Date(last.at + 'Z').getTime();
  const ageHours = ageMs / 3_600_000;
  const healthy = ageHours <= maxAgeHours;
  return { healthy, ageHours: +ageHours.toFixed(1), last };
}

module.exports = { runBackup, scheduleBackups, backupHealth, isConfigured };
