'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

// Local development falls back to a plain SQLite file so the app runs with no
// cloud account. In production TURSO_DATABASE_URL points at the hosted database.
const REMOTE_URL = process.env.TURSO_DATABASE_URL;
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

let url;
if (REMOTE_URL) {
  url = REMOTE_URL;
} else {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  url = 'file:' + path.join(dir, 'inventory.db').replace(/\\/g, '/');
}

const isLocalFile = url.startsWith('file:');
const client = createClient(AUTH_TOKEN ? { url, authToken: AUTH_TOKEN } : { url });

// libSQL can hand back BigInt for integer columns; the app expects plain numbers.
function normalize(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

async function all(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rs.rows.map(normalize);
}

async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

async function run(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return {
    changes: Number(rs.rowsAffected || 0),
    lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid),
  };
}

async function transaction() {
  return client.transaction('write');
}

// ---------------------------------------------------------------- schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'warehouse',
  address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  unit TEXT NOT NULL DEFAULT 'Litre',
  pack_size TEXT NOT NULL DEFAULT '',
  reorder_level REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  track_batch INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  location_id INTEGER REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  from_location_id INTEGER REFERENCES locations(id),
  to_location_id INTEGER REFERENCES locations(id),
  qty REAL NOT NULL,
  batch_no TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  unit_cost REAL NOT NULL DEFAULT 0,
  reference TEXT NOT NULL DEFAULT '',
  party TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mv_product ON movements(product_id);
CREATE INDEX IF NOT EXISTS idx_mv_ts ON movements(ts);
CREATE INDEX IF NOT EXISTS idx_mv_from ON movements(from_location_id);
CREATE INDEX IF NOT EXISTS idx_mv_to ON movements(to_location_id);

CREATE TABLE IF NOT EXISTS counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  kind TEXT NOT NULL DEFAULT 'cycle',
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_counts_location ON counts(location_id);
CREATE INDEX IF NOT EXISTS idx_counts_status ON counts(status);

CREATE TABLE IF NOT EXISTS count_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id INTEGER NOT NULL REFERENCES counts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_no TEXT NOT NULL DEFAULT '',
  system_qty REAL NOT NULL DEFAULT 0,
  counted_qty REAL,
  counted_at TEXT,
  counted_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_count_items_count ON count_items(count_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_count_items ON count_items(count_id, product_id, batch_no);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  module TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role, module)
);

CREATE VIEW IF NOT EXISTS ledger AS
  SELECT product_id, to_location_id AS location_id, batch_no, expiry, qty AS delta
    FROM movements WHERE to_location_id IS NOT NULL
  UNION ALL
  SELECT product_id, from_location_id AS location_id, batch_no, expiry, -qty AS delta
    FROM movements WHERE from_location_id IS NOT NULL;
`;

// CREATE TABLE IF NOT EXISTS cannot widen an existing table, so columns added
// after the first release are applied here. Safe to re-run on every cold start.
const ADDED_COLUMNS = [
  // Products dispensed in a different unit than they are stocked in.
  // entry_unit '' means "record movements in the stock unit", the normal case.
  ['products', 'entry_unit', "TEXT NOT NULL DEFAULT ''"],
  // How many entry_units make one stock unit. 1000 ML per KG assumes a density
  // of 1.0 g/ml; set it per product for the real density of that fragrance.
  ['products', 'entry_factor', 'REAL NOT NULL DEFAULT 0'],
  // What the person actually typed, kept verbatim so the audit trail stays true
  // even if the conversion factor is corrected later.
  ['movements', 'entry_qty', 'REAL NOT NULL DEFAULT 0'],
  ['movements', 'entry_unit', "TEXT NOT NULL DEFAULT ''"],
  // Set the moment an admin corrects a movement after the fact, so the
  // permanent audit trail still shows that a change happened even though the
  // row itself is updated in place rather than versioned.
  ['movements', 'edited_at', 'TEXT'],
  ['movements', 'edited_by', 'INTEGER REFERENCES users(id)'],
  // Staff-recorded RECEIVE entries wait for an admin's sign-off before they
  // touch stock (see the ledger view rebuild in migrate(), which only counts
  // status='approved' rows). Every other movement -- any kind from
  // admin/manager, and every issue/transfer/adjust regardless of who makes
  // it -- is inserted already 'approved', exactly matching the app's
  // behavior before this column existed.
  ['movements', 'status', "TEXT NOT NULL DEFAULT 'approved'"],
  ['movements', 'reviewed_by', 'INTEGER REFERENCES users(id)'],
  ['movements', 'reviewed_at', 'TEXT'],
];

async function addColumns() {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = await all(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === column)) continue;
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    console.log(`Added ${table}.${column}`);
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

const SEED_LOCATIONS = [
  ['KHI-WH', 'Karachi Warehouse', 'Karachi', 'warehouse'],
  ['LHE-WH', 'Lahore Warehouse', 'Lahore', 'warehouse'],
  ['ISB-WH', 'Islamabad Warehouse', 'Islamabad', 'warehouse'],
  ['PEW-WH', 'Peshawar Warehouse', 'Peshawar', 'warehouse'],
  ['PLANT-1', 'Manufacturing Plant', 'Lahore', 'plant'],
];

const SEED_CATEGORIES = [
  'Stewarding Chemicals', 'Laundry Chemicals', 'Housekeeping Chemicals',
  'Swimming Pool Chemicals', 'Engineering Chemicals', 'Raw Materials',
  'Packaging', 'Fragrances', 'Freight & Services',
];

async function migrate() {
  if (isLocalFile) {
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA foreign_keys = ON');
  }
  // executeMultiple runs the whole DDL script in one round trip.
  await client.executeMultiple(SCHEMA);
  await addColumns();

  // The ledger must only reflect APPROVED movements -- a still-pending
  // receive (movements.status, added above) has not been signed off yet and
  // must not affect stock. The bootstrap definition inside SCHEMA above uses
  // CREATE VIEW IF NOT EXISTS so a brand-new database gets some definition
  // immediately, but on a database that already has the view from an
  // earlier deploy that would silently keep the OLD (unfiltered) definition
  // forever. So the view is unconditionally dropped and recreated here,
  // every cold start, strictly after addColumns() guarantees the status
  // column exists -- cheap and non-destructive, since a view holds no data
  // of its own.
  await client.execute('DROP VIEW IF EXISTS ledger');
  await client.execute(`
    CREATE VIEW ledger AS
      SELECT product_id, to_location_id AS location_id, batch_no, expiry, qty AS delta
        FROM movements WHERE to_location_id IS NOT NULL AND status = 'approved'
      UNION ALL
      SELECT product_id, from_location_id AS location_id, batch_no, expiry, -qty AS delta
        FROM movements WHERE from_location_id IS NOT NULL AND status = 'approved'
  `);

  await seedRolePermissions();

  const { count } = await get('SELECT COUNT(*) AS count FROM locations');
  if (count > 0) return;

  for (const [code, name, city, kind] of SEED_LOCATIONS) {
    await run(
      'INSERT INTO locations (code, name, city, kind, active) VALUES (?, ?, ?, ?, 1)',
      [code, name, city, kind]
    );
  }
  for (const name of SEED_CATEGORIES) {
    await run('INSERT INTO categories (name) VALUES (?)', [name]);
  }

  const initialPassword = process.env.ADMIN_PASSWORD || 'admin123';
  await run(
    `INSERT INTO users (username, name, password_hash, role, location_id, active, created_at)
     VALUES ('admin', 'Administrator', ?, 'admin', NULL, 1, ?)`,
    [hashPassword(initialPassword), new Date().toISOString()]
  );
  console.log('Seeded starter data. Login: admin / ' + initialPassword);
}

// role_permissions rows are seeded separately (not gated on the locations-empty
// check above) so that upgrading an existing, already-seeded production
// database still gets a sensible starting matrix on its next cold start,
// matching exactly what was hardcoded before this table existed.
const DEFAULT_ROLE_PERMISSIONS = {
  dashboard:   { manager: 1, staff: 0 },
  stock:       { manager: 1, staff: 1 },
  movements:   { manager: 1, staff: 1 },
  batches:     { manager: 1, staff: 0 },
  counts:      { manager: 1, staff: 1 },
  products:    { manager: 1, staff: 0 },
  consumption: { manager: 1, staff: 0 },
};

async function seedRolePermissions() {
  // Per-row, not all-or-nothing: a database that already has rows from an
  // earlier deploy (e.g. before the "consumption" module existed) still
  // needs the newly-added module's defaults inserted on its next cold start.
  // Existing rows -- including anything an admin has since customised via
  // the Permissions page -- are never touched.
  const existing = await all('SELECT role, module FROM role_permissions');
  const have = new Set(existing.map((r) => `${r.role}:${r.module}`));
  for (const [module, byRole] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const [role, allowed] of Object.entries(byRole)) {
      if (have.has(`${role}:${module}`)) continue;
      await run(
        'INSERT INTO role_permissions (role, module, allowed) VALUES (?,?,?)',
        [role, module, allowed]
      );
    }
  }
}

// Serverless functions run migrate() on cold start only; the promise is cached
// so concurrent requests in the same instance wait on one run rather than racing.
let ready = null;
function ensureReady() {
  if (!ready) {
    ready = migrate().catch((err) => {
      ready = null; // let the next request retry rather than wedging the instance
      throw err;
    });
  }
  return ready;
}

module.exports = {
  client, all, get, run, transaction, ensureReady, hashPassword, isLocalFile, url,
};
