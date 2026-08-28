'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const SESSION_DAYS = 30;

// ---------------------------------------------------------------- auth

const { hashPassword } = db;

function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 864e5);
  await db.run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    [token, userId, now.toISOString(), exp.toISOString()]
  );
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAge) {
  const bits = [
    `sid=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`,
  ];
  if (isSecure(req)) bits.push('Secure');
  return bits.join('; ');
}

async function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = await db.get(
    `SELECT u.*, l.name AS location_name, l.code AS location_code, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN locations l ON l.id = u.location_id
      WHERE s.token = ?`,
    [token]
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await db.run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  if (!row.active) return null;
  return row;
}

// Roles: admin = everything. manager = view all, write own location, manage products.
// staff = view + write own location only.
// Staff logins must never see money -- cost price, sale price, a
// movement's snapshotted unit cost, or any computed "value"/"stock value".
// Managers and admins are unaffected. This is enforced here at the API
// layer (not just hidden in the UI) so it holds even if a staff account
// inspects the network tab or calls the API directly -- hiding a number in
// the DOM isn't the same as not sending it.
const VALUE_FIELDS = new Set(['cost_price', 'sale_price', 'unit_cost', 'value', 'stock_value']);
function hidesValue(user) {
  return user.role === 'staff';
}
function stripValues(data) {
  if (Array.isArray(data)) return data.map(stripValues);
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (VALUE_FIELDS.has(k)) continue;
      out[k] = stripValues(v);
    }
    return out;
  }
  return data;
}
// Wraps sendJson so every route that might carry money only has to remember
// one extra call instead of hand-rolling the staff check each time.
function sendJsonMasked(ctx, status, payload) {
  sendJson(ctx.res, status, hidesValue(ctx.user) ? stripValues(payload) : payload);
}

function canViewLocation(user, locId) {
  if (user.role === 'admin' || user.role === 'manager') return true;
  return Number(user.location_id) === Number(locId);
}

function canWriteLocation(user, locId) {
  if (locId == null) return false;
  if (user.role === 'admin') return true;
  return Number(user.location_id) === Number(locId);
}

async function visibleLocationIds(user) {
  if (user.role === 'admin' || user.role === 'manager') {
    return (await db.all('SELECT id FROM locations')).map((r) => r.id);
  }
  return user.location_id ? [user.location_id] : [];
}

// ---------------------------------------------------------------- permissions
//
// Which sections a manager/staff login can see is configurable by an admin
// (Settings > Permissions) instead of being hardcoded. Admin always has full
// access and is never stored here. This only gates page-level visibility for
// the modules listed below -- it does not touch the underlying
// location-based read/write rules (canViewLocation/canWriteLocation), which
// keep working exactly as before regardless of this table.
const PERMISSION_MODULES = ['dashboard', 'stock', 'movements', 'batches', 'counts', 'products', 'consumption'];
const PERMISSION_ROLES = ['manager', 'staff'];

async function permissionMatrix() {
  const rows = await db.all('SELECT role, module, allowed FROM role_permissions');
  const matrix = {};
  for (const role of PERMISSION_ROLES) {
    matrix[role] = {};
    for (const module of PERMISSION_MODULES) matrix[role][module] = true; // fail-open default
  }
  for (const r of rows) {
    if (matrix[r.role] && PERMISSION_MODULES.includes(r.module)) {
      matrix[r.role][r.module] = !!r.allowed;
    }
  }
  return matrix;
}

async function moduleAllowed(user, module) {
  if (user.role === 'admin') return true;
  if (!PERMISSION_ROLES.includes(user.role)) return false;
  const row = await db.get(
    'SELECT allowed FROM role_permissions WHERE role = ? AND module = ?',
    [user.role, module]
  );
  // No row yet (e.g. a module added after this table was seeded) fails open,
  // matching how these sections behaved before permissions existed.
  return row ? !!row.allowed : true;
}

// ---------------------------------------------------------------- http utils

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Length': data.length, ...headers });
  res.end(data);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8', ...headers,
  });
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  // Vercel's Node runtime may have parsed the body already.
  if (req.body != null) {
    if (typeof req.body === 'object') return req.body;
    try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  }
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function str(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

// Number(null) and Number('') are both 0, which would silently swallow the
// fallback for absent query params. Treat missing values as missing.
function num(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Unit conversion leaves long binary fractions; trim them for display.
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

function required(v, field) {
  const s = str(v);
  if (!s) throw new HttpError(400, `${field} is required`);
  return s;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvEscape(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------------------------------------------------------------- queries

async function stockRows({ locationIds, search, lowOnly }) {
  if (!locationIds.length) return [];
  const ph = locationIds.map(() => '?').join(',');
  const params = [...locationIds];
  let where = 'p.active = 1';
  if (search) {
    where += ' AND (p.name LIKE ? OR p.sku LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  const rows = await db.all(
    `SELECT p.id, p.sku, p.name, p.unit, p.pack_size, p.reorder_level,
            p.cost_price, p.sale_price, c.name AS category,
            COALESCE(s.qty, 0) AS total_qty
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN (
         SELECT product_id, SUM(delta) qty FROM ledger
          WHERE location_id IN (${ph}) GROUP BY product_id
       ) s ON s.product_id = p.id
      WHERE ${where}
      ORDER BY p.name`,
    params
  );

  const byLoc = await db.all(
    `SELECT product_id, location_id, SUM(delta) qty FROM ledger
      WHERE location_id IN (${ph})
      GROUP BY product_id, location_id`,
    locationIds
  );

  const map = new Map();
  for (const r of byLoc) {
    if (!map.has(r.product_id)) map.set(r.product_id, {});
    map.get(r.product_id)[r.location_id] = r.qty;
  }
  let out = rows.map((r) => ({ ...r, by_location: map.get(r.id) || {} }));
  if (lowOnly) out = out.filter((r) => r.reorder_level > 0 && r.total_qty <= r.reorder_level);
  return out;
}

async function batchRows(locationIds) {
  if (!locationIds.length) return [];
  const ph = locationIds.map(() => '?').join(',');
  return db.all(
    `SELECT l.product_id, p.sku, p.name, p.unit, l.location_id, loc.name AS location_name,
            l.batch_no, l.expiry, SUM(l.delta) qty
       FROM ledger l
       JOIN products p ON p.id = l.product_id
       JOIN locations loc ON loc.id = l.location_id
      WHERE l.location_id IN (${ph}) AND l.batch_no <> ''
      GROUP BY l.product_id, l.location_id, l.batch_no, l.expiry
     HAVING SUM(l.delta) > 0.0001
      ORDER BY l.expiry`,
    locationIds
  );
}

async function currentQty(productId, locationId) {
  const r = await db.get(
    'SELECT COALESCE(SUM(delta), 0) q FROM ledger WHERE product_id = ? AND location_id = ?',
    [productId, locationId]
  );
  return r ? r.q : 0;
}

// Same balance as currentQty, but pretends one specific movement doesn't
// exist. Used when editing a movement: the row being edited is still sitting
// in the ledger with its OLD values while we validate the NEW ones, so a
// naive currentQty() would double count it (once as "existing stock", once
// as "the thing you're about to change"). Queries movements directly instead
// of the ledger view since the view has no movement id to exclude by.
async function currentQtyExcluding(productId, locationId, excludeId) {
  const r = await db.get(
    `SELECT COALESCE(SUM(
        CASE WHEN to_location_id = ? THEN qty
             WHEN from_location_id = ? THEN -qty
             ELSE 0 END
      ), 0) q
     FROM movements
     WHERE product_id = ? AND id != ? AND (to_location_id = ? OR from_location_id = ?)`,
    [locationId, locationId, productId, excludeId, locationId, locationId]
  );
  return r ? r.q : 0;
}

// ---------------------------------------------------------------- routes

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, regex, keys, handler, auth: opts.auth !== false, roles: opts.roles });
}

function requireRole(user, roles) {
  if (roles && !roles.includes(user.role)) {
    throw new HttpError(403, 'You do not have permission to do this');
  }
}

// --- auth

route('POST', '/api/login', async (ctx) => {
  const body = await readJson(ctx.req);
  const username = str(body.username, 100).toLowerCase();
  const password = String(body.password ?? '');
  const user = await db.get('SELECT * FROM users WHERE lower(username) = ?', [username]);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Incorrect username or password');
  }
  const token = await createSession(user.id);
  sendJson(ctx.res, 200, { ok: true }, {
    'Set-Cookie': sessionCookie(ctx.req, token, SESSION_DAYS * 86400),
  });
}, { auth: false });

route('POST', '/api/logout', async (ctx) => {
  const token = parseCookies(ctx.req.headers.cookie).sid;
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.req, '', 0) });
}, { auth: false });

route('POST', '/api/change-password', async (ctx) => {
  const body = await readJson(ctx.req);
  const next = String(body.next ?? '');
  if (next.length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
  if (!verifyPassword(String(body.current ?? ''), ctx.user.password_hash)) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?',
    [hashPassword(next), ctx.user.id]);
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/bootstrap', async (ctx) => {
  const u = ctx.user;
  sendJson(ctx.res, 200, {
    user: {
      id: u.id, username: u.username, name: u.name, role: u.role,
      location_id: u.location_id, location_name: u.location_name,
    },
    locations: await db.all('SELECT * FROM locations ORDER BY city, name'),
    categories: await db.all('SELECT * FROM categories ORDER BY name'),
    visible_location_ids: await visibleLocationIds(u),
    permissions: await permissionMatrix(),
  });
});

// --- permissions

route('GET', '/api/permissions', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  sendJson(ctx.res, 200, {
    modules: PERMISSION_MODULES,
    roles: PERMISSION_ROLES,
    matrix: await permissionMatrix(),
  });
});

route('PUT', '/api/permissions', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const body = await readJson(ctx.req);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const clean = [];
  for (const r of rows) {
    const role = str(r.role, 20);
    const module = str(r.module, 20);
    if (!PERMISSION_ROLES.includes(role) || !PERMISSION_MODULES.includes(module)) {
      throw new HttpError(400, `Unknown role/module: ${role}/${module}`);
    }
    clean.push({ role, module, allowed: r.allowed ? 1 : 0 });
  }
  const tx = await db.transaction();
  try {
    for (const r of clean) {
      await tx.execute({
        sql: `INSERT INTO role_permissions (role, module, allowed) VALUES (?,?,?)
              ON CONFLICT(role, module) DO UPDATE SET allowed = excluded.allowed`,
        args: [r.role, r.module, r.allowed],
      });
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
  sendJson(ctx.res, 200, { ok: true, matrix: await permissionMatrix() });
});

// --- dashboard

route('GET', '/api/dashboard', async (ctx) => {
  if (!(await moduleAllowed(ctx.user, 'dashboard'))) throw new HttpError(403, 'You do not have permission to view this section');
  const locIds = await visibleLocationIds(ctx.user);
  const stock = await stockRows({ locationIds: locIds, search: '', lowOnly: false });
  const low = stock.filter((r) => r.reorder_level > 0 && r.total_qty <= r.reorder_level);
  const value = stock.reduce((sum, r) => sum + r.total_qty * r.cost_price, 0);

  const horizon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const expiring = (await batchRows(locIds))
    .filter((b) => b.expiry && b.expiry <= horizon)
    .map((b) => ({ ...b, expired: b.expiry < today }))
    .slice(0, 50);

  let recent = [];
  if (locIds.length) {
    const ph = locIds.map(() => '?').join(',');
    recent = await db.all(
      `SELECT m.*, p.sku, p.name AS product_name, p.unit,
              fl.name AS from_name, tl.name AS to_name, u.name AS user_name
         FROM movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN locations fl ON fl.id = m.from_location_id
         LEFT JOIN locations tl ON tl.id = m.to_location_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.from_location_id IN (${ph}) OR m.to_location_id IN (${ph})
        ORDER BY m.id DESC LIMIT 12`,
      [...locIds, ...locIds]
    );
  }

  sendJsonMasked(ctx, 200, {
    product_count: stock.length,
    stock_value: value,
    low_stock: low.slice(0, 50),
    low_stock_count: low.length,
    expiring,
    recent,
  });
});

// --- stock

route('GET', '/api/stock', async (ctx) => {
  const q = ctx.url.searchParams;
  let locIds = await visibleLocationIds(ctx.user);
  const filter = q.get('location');
  if (filter && filter !== 'all') {
    const id = Number(filter);
    if (!canViewLocation(ctx.user, id)) throw new HttpError(403, 'No access to that location');
    locIds = [id];
  }
  sendJsonMasked(ctx, 200, {
    rows: await stockRows({
      locationIds: locIds,
      search: str(q.get('search'), 80),
      lowOnly: q.get('low') === '1',
    }),
  });
});

route('GET', '/api/batches', async (ctx) => {
  if (!(await moduleAllowed(ctx.user, 'batches'))) throw new HttpError(403, 'You do not have permission to view this section');
  sendJson(ctx.res, 200, { rows: await batchRows(await visibleLocationIds(ctx.user)) });
});

// --- consumption
//
// "Consumption" is defined as stock recorded via an 'issue' movement --
// dispatched to a customer, or otherwise used up / written off -- which
// matches the meaning 'issue' already has everywhere else in the app (see
// the movement modal's own help text). Transfers between own locations and
// manual adjustments are deliberately excluded: neither represents stock
// actually leaving the business. Value is computed from unit_cost as it was
// recorded on each movement (snapshotted at the time, defaulting to that
// product's cost price that day), not today's cost price, so historical
// totals stay accurate even after prices change.

function monthRangeDefault() {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 11);
  from.setDate(1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

route('GET', '/api/consumption', async (ctx) => {
  if (!(await moduleAllowed(ctx.user, 'consumption'))) throw new HttpError(403, 'You do not have permission to view this section');

  const q = ctx.url.searchParams;
  let locIds = await visibleLocationIds(ctx.user);
  const locFilter = q.get('location');
  if (locFilter && locFilter !== 'all') {
    const id = Number(locFilter);
    if (!canViewLocation(ctx.user, id)) throw new HttpError(403, 'No access to that location');
    locIds = [id];
  }
  if (!locIds.length) return sendJson(ctx.res, 200, { rows: [], totals: [], movements: [], grand_total: { movements: 0, value: 0 } });

  const granularity = q.get('granularity') === 'month' ? 'month' : 'day';
  const periodExpr = granularity === 'month' ? 'substr(m.ts,1,7)' : 'substr(m.ts,1,10)';
  const defaults = monthRangeDefault();
  const from = str(q.get('from'), 10) || defaults.from;
  const to = str(q.get('to'), 10) || defaults.to;

  const productFilter = q.get('product');
  const singleProductId = productFilter && productFilter !== 'all' ? Number(productFilter) : null;

  const ph = locIds.map(() => '?').join(',');
  const params = [...locIds, from, to + 'T23:59:59.999Z'];
  let productClause = '';
  if (singleProductId) { productClause = ' AND m.product_id = ?'; params.push(singleProductId); }

  // Value is qty * unit_cost, where unit_cost is snapshotted on the
  // movement itself (the product's cost price at the moment it was
  // recorded, per its stock unit -- e.g. per Kg) rather than recomputed
  // from today's price, so past consumption value stays accurate even
  // after cost prices change later.
  const rows = await db.all(
    `SELECT m.product_id, p.sku, p.name, p.unit, ${periodExpr} AS period,
            SUM(m.qty) AS qty, SUM(m.qty * m.unit_cost) AS value, COUNT(*) AS movements
       FROM movements m
       JOIN products p ON p.id = m.product_id
      WHERE m.kind = 'issue' AND m.from_location_id IN (${ph})
        AND m.ts >= ? AND m.ts <= ?${productClause}
      GROUP BY m.product_id, period
      ORDER BY p.name, period`,
    params
  );

  const totalsMap = new Map();
  let grandMovements = 0;
  let grandValue = 0;
  for (const r of rows) {
    grandMovements += r.movements;
    grandValue += r.value;
    if (!totalsMap.has(r.product_id)) {
      totalsMap.set(r.product_id, {
        product_id: r.product_id, sku: r.sku, name: r.name, unit: r.unit,
        qty: 0, value: 0, movements: 0,
      });
    }
    const t = totalsMap.get(r.product_id);
    t.qty += r.qty;
    t.value += r.value;
    t.movements += r.movements;
  }
  // The consumption table above only ever contains products with an
  // 'issue' movement inside [from, to] -- a product that's just sitting in
  // stock with zero consumption this period would otherwise silently drop
  // out of `totals` entirely, which would also silently drop it out of the
  // opening/closing stock totals below (even though it has a real opening
  // and closing balance). So every product that's ever had ANY movement
  // touch these locations (as of `to`) gets a zero-consumption row here if
  // it isn't already present from an actual issue.
  const toBoundaryForTouch = to + 'T23:59:59.999Z';
  const touchedParams = [...locIds, ...locIds, toBoundaryForTouch];
  let touchedClause = '';
  if (singleProductId) { touchedClause = ' AND m.product_id = ?'; touchedParams.push(singleProductId); }
  const touched = await db.all(
    `SELECT DISTINCT p.id AS product_id, p.sku, p.name, p.unit
       FROM movements m
       JOIN products p ON p.id = m.product_id
      WHERE (m.to_location_id IN (${ph}) OR m.from_location_id IN (${ph}))
        AND m.ts <= ?${touchedClause}`,
    touchedParams
  );
  for (const p of touched) {
    if (!totalsMap.has(p.product_id)) {
      totalsMap.set(p.product_id, {
        product_id: p.product_id, sku: p.sku, name: p.name, unit: p.unit,
        qty: 0, value: 0, movements: 0,
      });
    }
  }
  const totals = [...totalsMap.values()].sort((a, b) => b.qty - a.qty);

  // Opening stock (per-product totals) is deliberately DIFFERENT between
  // the two report granularities:
  //   - Daily: the ledger balance strictly before the report's `from` date
  //     -- i.e. "yesterday's closing stock" relative to whatever From is
  //     selected (From=Sep 1 -> opening is the balance as of Aug 31; a
  //     single day selected as both From and To -> opening is that same
  //     balance as of the end of the day before). Standard "this period's
  //     opening = the previous period's closing" relationship.
  //   - Monthly: opening ALWAYS shows the product's first-ever receive
  //     quantity, completely fixed, no matter which From/To is selected --
  //     a whole-month (or multi-month) report should always surface the
  //     real stock a product started with, even for a month before that
  //     stock ever arrived, rather than reading as empty/missing data.
  // Both are computed from every movement of any kind (receive/issue/
  // transfer/adjust), not just the 'issue' movements this report otherwise
  // counts, and Daily looks back through the FULL history regardless of
  // how far `from` reaches -- stock a product already had years before the
  // report window still needs to be included.
  // Closing stock is the same ledger, evaluated as of the report's To date,
  // for both granularities.
  const productIds = [...new Set(totals.map((t) => t.product_id))];
  const openingByRowKey = new Map();
  const openingAtFrom = new Map();
  const closingAtTo = new Map();
  if (productIds.length) {
    const phQ = productIds.map(() => '?').join(',');
    const history = await db.all(
      `SELECT product_id, ts, kind,
              (CASE WHEN to_location_id IN (${ph}) THEN qty ELSE 0 END)
            - (CASE WHEN from_location_id IN (${ph}) THEN qty ELSE 0 END) AS delta
         FROM movements
        WHERE product_id IN (${phQ})
          AND (to_location_id IN (${ph}) OR from_location_id IN (${ph}))
        ORDER BY product_id, ts`,
      [...locIds, ...locIds, ...productIds, ...locIds, ...locIds]
    );
    const byProduct = new Map();
    for (const h of history) {
      if (!byProduct.has(h.product_id)) byProduct.set(h.product_id, []);
      byProduct.get(h.product_id).push(h);
    }
    const fromBoundary = from + 'T00:00:00.000Z';
    const toBoundary = to + 'T23:59:59.999Z';
    for (const pid of productIds) {
      const list = byProduct.get(pid) || [];
      let opening = 0;
      let closing = 0;
      for (const h of list) {
        if (h.ts < fromBoundary) opening += h.delta;
        if (h.ts <= toBoundary) closing += h.delta;
      }
      if (granularity === 'month') {
        // Monthly: always the fixed first-ever receive, regardless of
        // From/To (see comment above the productIds block).
        const firstReceive = list.find((h) => h.kind === 'receive');
        opening = firstReceive ? firstReceive.delta : 0;
      }
      // Daily keeps the plain date-sensitive `opening` computed above.
      openingAtFrom.set(pid, opening);
      closingAtTo.set(pid, closing);
    }
    const nextPeriodBoundary = (period) => {
      const d = granularity === 'month' ? new Date(`${period}-01T00:00:00.000Z`) : new Date(`${period}T00:00:00.000Z`);
      if (granularity === 'month') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    };
    const closingByRowKey = new Map();
    for (const r of rows) {
      const calendarStart = granularity === 'month' ? `${r.period}-01T00:00:00.000Z` : `${r.period}T00:00:00.000Z`;
      // A month row's opening is normally "balance at the 1st of that
      // calendar month" -- but if the report's own From date falls partway
      // through that month (e.g. From=Aug 8, viewing the Aug row), the
      // calendar start (Aug 1) is earlier than what the user actually asked
      // to see. Clamping to whichever is later keeps this row's opening
      // consistent with the top-level "opening as of From" figure, instead
      // of ignoring everything received between the 1st and the From date.
      // (Day rows are unaffected: their calendar day always falls on or
      // after From already, since every row comes from an issue inside
      // [from, to].)
      const periodBoundary = calendarStart > fromBoundary ? calendarStart : fromBoundary;
      const calendarEnd = nextPeriodBoundary(r.period);
      const list = byProduct.get(r.product_id) || [];
      let opening = 0;
      let closing = 0;
      for (const h of list) {
        if (h.ts < periodBoundary) opening += h.delta;
        // Symmetrically, closing must never reach past the report's own To
        // date even if the calendar period (a whole month) technically
        // extends further -- otherwise a month row could silently include
        // movements the user's date range explicitly excluded.
        if (h.ts < calendarEnd && h.ts <= toBoundary) closing += h.delta;
      }
      openingByRowKey.set(`${r.product_id}|${r.period}`, opening);
      closingByRowKey.set(`${r.product_id}|${r.period}`, closing);
    }
    for (const r of rows) {
      r.opening_stock = openingByRowKey.get(`${r.product_id}|${r.period}`) || 0;
      r.closing_stock = closingByRowKey.get(`${r.product_id}|${r.period}`) || 0;
    }
  }
  for (const t of totals) {
    t.opening_stock = openingAtFrom.get(t.product_id) || 0;
    t.closing_stock = closingAtTo.get(t.product_id) || 0;
  }

  // Single-product view drills all the way down to the individual issue
  // movements that made up the total, not just a day/month roll-up, so the
  // export actually shows what happened rather than just a sum.
  let movements = [];
  if (singleProductId) {
    movements = await db.all(
      `SELECT m.id, m.ts, m.qty, m.entry_qty, m.entry_unit, m.unit_cost, m.qty * m.unit_cost AS value,
              m.reference, m.party, m.note, fl.name AS from_name, u.name AS user_name
         FROM movements m
         LEFT JOIN locations fl ON fl.id = m.from_location_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.kind = 'issue' AND m.from_location_id IN (${ph})
          AND m.ts >= ? AND m.ts <= ?${productClause}
        ORDER BY m.ts ASC`,
      params
    );
  }

  sendJsonMasked(ctx, 200, {
    granularity, from, to,
    product: singleProductId ? (totals[0] || (await db.get(
      'SELECT id AS product_id, sku, name, unit FROM products WHERE id = ?', [singleProductId]
    ))) : null,
    rows,
    totals,
    movements,
    grand_total: { movements: grandMovements, value: grandValue },
  });
});

// --- movements

const KINDS = new Set(['receive', 'issue', 'transfer', 'adjust']);
const STATUSES = new Set(['approved', 'pending', 'rejected']);

route('GET', '/api/movements', async (ctx) => {
  const q = ctx.url.searchParams;
  const locIds = await visibleLocationIds(ctx.user);
  if (!locIds.length) return sendJson(ctx.res, 200, { rows: [] });
  const ph = locIds.map(() => '?').join(',');
  const params = [...locIds, ...locIds];
  let where = `(m.from_location_id IN (${ph}) OR m.to_location_id IN (${ph}))`;

  const kind = q.get('kind');
  if (kind && KINDS.has(kind)) { where += ' AND m.kind = ?'; params.push(kind); }

  const productId = q.get('product');
  if (productId) { where += ' AND m.product_id = ?'; params.push(Number(productId)); }

  const from = q.get('from');
  if (from) { where += ' AND m.ts >= ?'; params.push(from); }
  const to = q.get('to');
  if (to) { where += ' AND m.ts <= ?'; params.push(to + 'T23:59:59.999Z'); }

  const search = str(q.get('search'), 80);
  if (search) {
    where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR m.reference LIKE ? OR m.party LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const status = q.get('status');
  if (status && STATUSES.has(status)) { where += ' AND m.status = ?'; params.push(status); }

  const limit = Math.min(Math.max(num(q.get('limit'), 500), 1), 2000);
  sendJsonMasked(ctx, 200, {
    rows: await db.all(
      `SELECT m.*, p.sku, p.name AS product_name, p.unit,
              fl.name AS from_name, tl.name AS to_name, u.name AS user_name,
              eu.name AS edited_by_name, ru.name AS reviewed_by_name
         FROM movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN locations fl ON fl.id = m.from_location_id
         LEFT JOIN locations tl ON tl.id = m.to_location_id
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN users eu ON eu.id = m.edited_by
         LEFT JOIN users ru ON ru.id = m.reviewed_by
        WHERE ${where}
        ORDER BY m.id DESC LIMIT ${limit}`,
      params
    ),
  });
});

route('POST', '/api/movements', async (ctx) => {
  const body = await readJson(ctx.req);
  const kind = str(body.kind, 20);
  if (!KINDS.has(kind)) throw new HttpError(400, 'Invalid movement type');

  const product = await db.get('SELECT * FROM products WHERE id = ?', [Number(body.product_id)]);
  if (!product) throw new HttpError(400, 'Product not found');

  // Products with an entry unit are typed in that unit (fragrances in ML) but
  // stored, valued and reported in the stock unit (KG). Convert on the way in
  // and keep what was typed so the audit trail reflects what the person did.
  const usesEntryUnit = !!product.entry_unit && product.entry_factor > 0;
  const entryQty = usesEntryUnit ? num(body.qty) : 0;
  const qty = usesEntryUnit ? entryQty / product.entry_factor : num(body.qty);
  // Quantities are shown to a sensible precision; describe shortages in the
  // unit the person is actually typing in.
  const asEntry = (baseQty) => usesEntryUnit
    ? `${round4(baseQty * product.entry_factor)} ${product.entry_unit}`
    : `${round4(baseQty)} ${product.unit}`;

  let fromId = body.from_location_id ? Number(body.from_location_id) : null;
  let toId = body.to_location_id ? Number(body.to_location_id) : null;

  if (kind === 'receive') {
    fromId = null;
    if (!toId) throw new HttpError(400, 'Choose the location receiving the stock');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, toId)) throw new HttpError(403, 'No permission at that location');
  } else if (kind === 'issue') {
    toId = null;
    if (!fromId) throw new HttpError(400, 'Choose the location issuing the stock');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, fromId)) throw new HttpError(403, 'No permission at that location');
    const have = await currentQty(product.id, fromId);
    if (qty > have + 1e-9) throw new HttpError(400, `Only ${asEntry(have)} in stock at that location`);
  } else if (kind === 'transfer') {
    if (!fromId || !toId) throw new HttpError(400, 'Choose both source and destination locations');
    if (fromId === toId) throw new HttpError(400, 'Source and destination must be different');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, fromId)) throw new HttpError(403, 'No permission at the source location');
    const have = await currentQty(product.id, fromId);
    if (qty > have + 1e-9) throw new HttpError(400, `Only ${asEntry(have)} in stock at the source`);
  } else {
    if (!toId) throw new HttpError(400, 'Choose the location to adjust');
    if (qty === 0) throw new HttpError(400, 'Adjustment cannot be zero');
    if (!canWriteLocation(ctx.user, toId)) throw new HttpError(403, 'No permission at that location');
    fromId = null;
    const have = await currentQty(product.id, toId);
    if (have + qty < -1e-9) {
      throw new HttpError(400, `That would take stock below zero (currently ${asEntry(have)})`);
    }
  }

  // A staff-recorded receive doesn't take effect immediately -- it's
  // inserted as 'pending' (the ledger view only counts 'approved' rows), so
  // an admin can review it, correct the price if the rate for that shipment
  // differed, and approve it before it touches stock. Every other case
  // (any kind from admin/manager, or any issue/transfer/adjust regardless
  // of who makes it) is approved immediately, exactly as before this existed.
  const needsApproval = kind === 'receive' && ctx.user.role === 'staff';

  const info = await db.run(
    `INSERT INTO movements
       (ts, kind, product_id, from_location_id, to_location_id, qty, entry_qty, entry_unit,
        batch_no, expiry, unit_cost, reference, party, note, user_id, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      body.ts ? new Date(body.ts).toISOString() : new Date().toISOString(),
      kind, product.id, fromId, toId, qty,
      usesEntryUnit ? entryQty : 0, usesEntryUnit ? product.entry_unit : '',
      str(body.batch_no, 60), str(body.expiry, 10),
      num(body.unit_cost, product.cost_price),
      str(body.reference, 80), str(body.party, 120), str(body.note, 500),
      ctx.user.id, needsApproval ? 'pending' : 'approved',
    ]
  );
  sendJson(ctx.res, 201, { ok: true, id: info.lastInsertRowid, status: needsApproval ? 'pending' : 'approved' });
});

// Admins only, same as delete -- editing a permanent audit trail is
// deliberately a step above what managers/staff can do. Validation mirrors
// the POST handler above almost exactly (same per-kind rules, same
// entry-unit conversion) so a corrected movement is held to the same
// standard as a brand new one. The only real difference is every
// stock-availability check uses currentQtyExcluding() instead of
// currentQty(), so the row's own old values don't get counted twice while
// checking whether its new values are valid.
route('PUT', '/api/movements/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = Number(ctx.params.id);
  const existing = await db.get('SELECT * FROM movements WHERE id = ?', [id]);
  if (!existing) throw new HttpError(404, 'Movement not found');

  const body = await readJson(ctx.req);
  const kind = str(body.kind, 20);
  if (!KINDS.has(kind)) throw new HttpError(400, 'Invalid movement type');

  const product = await db.get('SELECT * FROM products WHERE id = ?', [Number(body.product_id)]);
  if (!product) throw new HttpError(400, 'Product not found');

  const usesEntryUnit = !!product.entry_unit && product.entry_factor > 0;
  const entryQty = usesEntryUnit ? num(body.qty) : 0;
  const qty = usesEntryUnit ? entryQty / product.entry_factor : num(body.qty);
  const asEntry = (baseQty) => usesEntryUnit
    ? `${round4(baseQty * product.entry_factor)} ${product.entry_unit}`
    : `${round4(baseQty)} ${product.unit}`;

  let fromId = body.from_location_id ? Number(body.from_location_id) : null;
  let toId = body.to_location_id ? Number(body.to_location_id) : null;

  if (kind === 'receive') {
    fromId = null;
    if (!toId) throw new HttpError(400, 'Choose the location receiving the stock');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, toId)) throw new HttpError(403, 'No permission at that location');
  } else if (kind === 'issue') {
    toId = null;
    if (!fromId) throw new HttpError(400, 'Choose the location issuing the stock');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, fromId)) throw new HttpError(403, 'No permission at that location');
    const have = await currentQtyExcluding(product.id, fromId, id);
    if (qty > have + 1e-9) throw new HttpError(400, `Only ${asEntry(have)} in stock at that location`);
  } else if (kind === 'transfer') {
    if (!fromId || !toId) throw new HttpError(400, 'Choose both source and destination locations');
    if (fromId === toId) throw new HttpError(400, 'Source and destination must be different');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, fromId)) throw new HttpError(403, 'No permission at the source location');
    const have = await currentQtyExcluding(product.id, fromId, id);
    if (qty > have + 1e-9) throw new HttpError(400, `Only ${asEntry(have)} in stock at the source`);
  } else {
    if (!toId) throw new HttpError(400, 'Choose the location to adjust');
    if (qty === 0) throw new HttpError(400, 'Adjustment cannot be zero');
    if (!canWriteLocation(ctx.user, toId)) throw new HttpError(403, 'No permission at that location');
    fromId = null;
    const have = await currentQtyExcluding(product.id, toId, id);
    if (have + qty < -1e-9) {
      throw new HttpError(400, `That would take stock below zero (currently ${asEntry(have)})`);
    }
  }

  await db.run(
    `UPDATE movements SET
       ts = ?, kind = ?, product_id = ?, from_location_id = ?, to_location_id = ?, qty = ?,
       entry_qty = ?, entry_unit = ?, batch_no = ?, expiry = ?, unit_cost = ?,
       reference = ?, party = ?, note = ?, edited_at = ?, edited_by = ?
     WHERE id = ?`,
    [
      body.ts ? new Date(body.ts).toISOString() : existing.ts,
      kind, product.id, fromId, toId, qty,
      usesEntryUnit ? entryQty : 0, usesEntryUnit ? product.entry_unit : '',
      str(body.batch_no, 60), str(body.expiry, 10),
      // Unlike creating a movement (where an unspecified cost silently
      // defaults to the product's CURRENT cost_price), editing preserves
      // whatever cost was already recorded on this row unless the caller
      // explicitly overrides it -- the product's cost_price may well have
      // changed since, and we don't want a routine correction (e.g. fixing a
      // typo'd party name) to quietly rewrite this movement's historical value.
      num(body.unit_cost, existing.unit_cost),
      str(body.reference, 80), str(body.party, 120), str(body.note, 500),
      new Date().toISOString(), ctx.user.id,
      id,
    ]
  );
  sendJson(ctx.res, 200, { ok: true });
});

// A pending receive (see needsApproval in the POST handler above) sits
// outside the ledger until an admin reviews it here. The payload is the
// exact same shape the edit modal already sends to PUT -- so approving
// doubles as "approve, with the chance to correct the price or anything
// else first" in one step, without a separate edit-then-approve round trip.
// Validation mirrors PUT's 'receive' branch exactly.
route('POST', '/api/movements/:id/approve', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = Number(ctx.params.id);
  const existing = await db.get('SELECT * FROM movements WHERE id = ?', [id]);
  if (!existing) throw new HttpError(404, 'Movement not found');
  if (existing.status !== 'pending') throw new HttpError(400, 'Only pending entries can be approved');

  const body = await readJson(ctx.req);
  const product = await db.get('SELECT * FROM products WHERE id = ?', [Number(body.product_id)]);
  if (!product) throw new HttpError(400, 'Product not found');

  const usesEntryUnit = !!product.entry_unit && product.entry_factor > 0;
  const entryQty = usesEntryUnit ? num(body.qty) : 0;
  const qty = usesEntryUnit ? entryQty / product.entry_factor : num(body.qty);

  const toId = body.to_location_id ? Number(body.to_location_id) : null;
  if (!toId) throw new HttpError(400, 'Choose the location receiving the stock');
  if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
  if (!canWriteLocation(ctx.user, toId)) throw new HttpError(403, 'No permission at that location');

  await db.run(
    `UPDATE movements SET
       ts = ?, product_id = ?, to_location_id = ?, qty = ?, entry_qty = ?, entry_unit = ?,
       batch_no = ?, expiry = ?, unit_cost = ?, reference = ?, party = ?, note = ?,
       status = 'approved', reviewed_by = ?, reviewed_at = ?
     WHERE id = ?`,
    [
      body.ts ? new Date(body.ts).toISOString() : existing.ts,
      product.id, toId, qty,
      usesEntryUnit ? entryQty : 0, usesEntryUnit ? product.entry_unit : '',
      str(body.batch_no, 60), str(body.expiry, 10),
      num(body.unit_cost, existing.unit_cost),
      str(body.reference, 80), str(body.party, 120), str(body.note, 500),
      ctx.user.id, new Date().toISOString(),
      id,
    ]
  );
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/movements/:id/reject', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = Number(ctx.params.id);
  const existing = await db.get('SELECT * FROM movements WHERE id = ?', [id]);
  if (!existing) throw new HttpError(404, 'Movement not found');
  if (existing.status !== 'pending') throw new HttpError(400, 'Only pending entries can be rejected');
  await db.run(
    `UPDATE movements SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
    [ctx.user.id, new Date().toISOString(), id]
  );
  sendJson(ctx.res, 200, { ok: true });
});

route('DELETE', '/api/movements/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const m = await db.get('SELECT * FROM movements WHERE id = ?', [Number(ctx.params.id)]);
  if (!m) throw new HttpError(404, 'Movement not found');
  await db.run('DELETE FROM movements WHERE id = ?', [m.id]);
  sendJson(ctx.res, 200, { ok: true });
});

// --- inventory counts
//
// Physical count workflow: someone opens a count (cycle = a chosen list of
// products, full = every active product) at a location, walks the floor and
// records what they actually see, then submits it. An admin or manager for
// that location reviews the variances and approves — only approval posts
// 'adjust' movements, so nothing touches the ledger until a second person has
// signed off. The adjustment always reconciles against the LIVE balance at
// approval time (not the snapshot taken when the count was opened), so any
// legitimate receipts/issues recorded while the count was in progress are
// respected rather than overwritten.

const COUNT_KINDS = new Set(['cycle', 'full']);

route('GET', '/api/counts', async (ctx) => {
  const locIds = await visibleLocationIds(ctx.user);
  if (!locIds.length) return sendJson(ctx.res, 200, { rows: [] });
  const ph = locIds.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT c.*, l.name AS location_name, l.code AS location_code,
            cu.name AS created_by_name, su.name AS submitted_by_name, ru.name AS reviewed_by_name,
            (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id) AS item_count,
            (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id
               AND ci.counted_qty IS NOT NULL) AS counted_count,
            (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id
               AND ci.counted_qty IS NOT NULL
               AND ABS(ci.counted_qty - ci.system_qty) > 0.0001) AS variance_count
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users cu ON cu.id = c.created_by
       LEFT JOIN users su ON su.id = c.submitted_by
       LEFT JOIN users ru ON ru.id = c.reviewed_by
      WHERE c.location_id IN (${ph})
      ORDER BY c.id DESC`,
    locIds
  );
  sendJson(ctx.res, 200, { rows });
});

route('POST', '/api/counts', async (ctx) => {
  const body = await readJson(ctx.req);
  const locationId = Number(body.location_id);
  if (!locationId) throw new HttpError(400, 'Choose a location');
  if (!canWriteLocation(ctx.user, locationId)) throw new HttpError(403, 'No permission at that location');
  const kind = COUNT_KINDS.has(str(body.kind, 10)) ? str(body.kind, 10) : 'cycle';

  let productIds;
  if (kind === 'full') {
    productIds = (await db.all('SELECT id FROM products WHERE active = 1 ORDER BY name')).map((r) => r.id);
    if (!productIds.length) throw new HttpError(400, 'No active products to count');
  } else {
    productIds = Array.isArray(body.product_ids)
      ? [...new Set(body.product_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))]
      : [];
    if (!productIds.length) throw new HttpError(400, 'Choose at least one product to count');
  }

  const now = new Date().toISOString();
  const tx = await db.transaction();
  try {
    const ins = await tx.execute({
      sql: `INSERT INTO counts (location_id, kind, status, note, created_by, created_at)
            VALUES (?,?,?,?,?,?)`,
      args: [locationId, kind, 'open', str(body.note, 500), ctx.user.id, now],
    });
    const countId = Number(ins.lastInsertRowid);
    for (const pid of productIds) {
      const bal = await tx.execute({
        sql: 'SELECT COALESCE(SUM(delta),0) q FROM ledger WHERE product_id = ? AND location_id = ?',
        args: [pid, locationId],
      });
      const system = Number(bal.rows[0]?.q || 0);
      await tx.execute({
        sql: 'INSERT INTO count_items (count_id, product_id, system_qty) VALUES (?,?,?)',
        args: [countId, pid, system],
      });
    }
    await tx.commit();
    sendJson(ctx.res, 201, { ok: true, id: countId });
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
});

route('GET', '/api/counts/:id', async (ctx) => {
  const count = await db.get(
    `SELECT c.*, l.name AS location_name, l.code AS location_code,
            cu.name AS created_by_name, su.name AS submitted_by_name, ru.name AS reviewed_by_name
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users cu ON cu.id = c.created_by
       LEFT JOIN users su ON su.id = c.submitted_by
       LEFT JOIN users ru ON ru.id = c.reviewed_by
      WHERE c.id = ?`,
    [Number(ctx.params.id)]
  );
  if (!count) throw new HttpError(404, 'Count not found');
  if (!canViewLocation(ctx.user, count.location_id)) throw new HttpError(403, 'No access to that location');

  const items = await db.all(
    `SELECT ci.*, p.sku, p.name AS product_name, p.unit, u.name AS counted_by_name
       FROM count_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN users u ON u.id = ci.counted_by
      WHERE ci.count_id = ?
      ORDER BY p.name`,
    [count.id]
  );
  sendJson(ctx.res, 200, { count, items });
});

route('PUT', '/api/counts/:cid/items/:iid', async (ctx) => {
  const count = await db.get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.cid)]);
  if (!count) throw new HttpError(404, 'Count not found');
  if (count.status !== 'open') throw new HttpError(400, 'This count is no longer open for entry');
  if (!canWriteLocation(ctx.user, count.location_id)) throw new HttpError(403, 'No permission at that location');

  const item = await db.get(
    'SELECT * FROM count_items WHERE id = ? AND count_id = ?',
    [Number(ctx.params.iid), count.id]
  );
  if (!item) throw new HttpError(404, 'Item not found on this count');

  const body = await readJson(ctx.req);
  if (body.counted_qty === null || body.counted_qty === '' || body.counted_qty === undefined) {
    await db.run(
      'UPDATE count_items SET counted_qty = NULL, counted_at = NULL, counted_by = NULL WHERE id = ?',
      [item.id]
    );
  } else {
    const qty = Number(body.counted_qty);
    if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, 'Enter a counted quantity of zero or more');
    // Refresh system_qty to the live balance at the moment of counting, not the
    // balance when the count sheet was opened. This is what the person is
    // actually comparing against as they stand in front of the shelf, and it's
    // the figure approval will use to compute the adjustment — so movements
    // recorded before this item was counted are correctly folded in, while
    // movements recorded afterwards are left alone rather than overwritten.
    const live = await currentQty(item.product_id, count.location_id);
    await db.run(
      'UPDATE count_items SET counted_qty = ?, system_qty = ?, counted_at = ?, counted_by = ? WHERE id = ?',
      [qty, live, new Date().toISOString(), ctx.user.id, item.id]
    );
  }
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/counts/:id/submit', async (ctx) => {
  const count = await db.get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!count) throw new HttpError(404, 'Count not found');
  if (count.status !== 'open') throw new HttpError(400, 'This count has already been submitted');
  if (!canWriteLocation(ctx.user, count.location_id)) throw new HttpError(403, 'No permission at that location');

  const pending = await db.get(
    'SELECT COUNT(*) n FROM count_items WHERE count_id = ? AND counted_qty IS NULL',
    [count.id]
  );
  if (pending.n > 0) throw new HttpError(400, `${pending.n} item(s) still need a counted quantity`);

  await db.run(
    `UPDATE counts SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?`,
    [ctx.user.id, new Date().toISOString(), count.id]
  );
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/counts/:id/approve', async (ctx) => {
  requireRole(ctx.user, ['admin', 'manager']);
  const count = await db.get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!count) throw new HttpError(404, 'Count not found');
  if (count.status !== 'submitted') throw new HttpError(400, 'Only submitted counts can be approved');
  if (!canWriteLocation(ctx.user, count.location_id)) throw new HttpError(403, 'No permission at that location');

  const body = await readJson(ctx.req);
  const items = await db.all('SELECT * FROM count_items WHERE count_id = ?', [count.id]);
  const now = new Date().toISOString();
  let adjustments = 0;

  const tx = await db.transaction();
  try {
    for (const item of items) {
      if (item.counted_qty == null) continue;
      // system_qty was captured at the moment this item was counted (see the
      // items/:iid handler), so this delta is exactly the variance the count
      // discovered — safe to apply on top of the current ledger regardless of
      // what else has happened to this product since.
      const delta = item.counted_qty - item.system_qty;
      if (Math.abs(delta) > 1e-9) {
        await tx.execute({
          sql: `INSERT INTO movements
                  (ts, kind, product_id, from_location_id, to_location_id, qty, reference, note, user_id)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          args: [now, 'adjust', item.product_id, null, count.location_id, delta,
                 `COUNT-${count.id}`, `Physical count #${count.id} variance`, ctx.user.id],
        });
        adjustments++;
      }
    }
    await tx.execute({
      sql: `UPDATE counts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`,
      args: [ctx.user.id, now, str(body.note, 500), count.id],
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
  sendJson(ctx.res, 200, { ok: true, adjustments });
});

route('POST', '/api/counts/:id/cancel', async (ctx) => {
  const count = await db.get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!count) throw new HttpError(404, 'Count not found');
  if (count.status === 'approved') throw new HttpError(400, 'Approved counts cannot be cancelled');
  if (!canWriteLocation(ctx.user, count.location_id)) throw new HttpError(403, 'No permission at that location');
  await db.run(`UPDATE counts SET status = 'cancelled' WHERE id = ?`, [count.id]);
  sendJson(ctx.res, 200, { ok: true });
});

// --- products

route('GET', '/api/products', async (ctx) => {
  const includeInactive = ctx.url.searchParams.get('all') === '1';
  sendJsonMasked(ctx, 200, {
    rows: await db.all(
      `SELECT p.*, c.name AS category FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        ${includeInactive ? '' : 'WHERE p.active = 1'}
        ORDER BY p.name`
    ),
  });
});

function productPayload(body) {
  // A product may be dispensed in one unit and stocked in another (fragrances
  // are measured out in ML but held and valued in KG). entry_factor says how
  // many entry units make one stock unit; both must be set or neither.
  const entryUnit = str(body.entry_unit, 20);
  const entryFactor = Math.max(0, num(body.entry_factor));
  if (entryUnit && entryFactor <= 0) {
    throw new HttpError(400, `Set how many ${entryUnit} make one ${str(body.unit, 20) || 'unit'}`);
  }
  return {
    sku: required(body.sku, 'SKU').toUpperCase().slice(0, 40),
    name: required(body.name, 'Product name').slice(0, 160),
    category_id: body.category_id ? Number(body.category_id) : null,
    unit: str(body.unit, 20) || 'Litre',
    entry_unit: entryFactor > 0 ? entryUnit : '',
    entry_factor: entryUnit ? entryFactor : 0,
    pack_size: str(body.pack_size, 40),
    reorder_level: Math.max(0, num(body.reorder_level)),
    cost_price: Math.max(0, num(body.cost_price)),
    sale_price: Math.max(0, num(body.sale_price)),
    track_batch: body.track_batch ? 1 : 0,
    notes: str(body.notes, 500),
    active: body.active === false ? 0 : 1,
  };
}

route('POST', '/api/products', async (ctx) => {
  requireRole(ctx.user, ['admin', 'manager']);
  const p = productPayload(await readJson(ctx.req));
  if (await db.get('SELECT id FROM products WHERE sku = ?', [p.sku])) {
    throw new HttpError(400, `SKU ${p.sku} already exists`);
  }
  const info = await db.run(
    `INSERT INTO products (sku, name, category_id, unit, entry_unit, entry_factor,
        pack_size, reorder_level, cost_price, sale_price, track_batch, notes, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.sku, p.name, p.category_id, p.unit, p.entry_unit, p.entry_factor, p.pack_size,
     p.reorder_level, p.cost_price, p.sale_price, p.track_batch, p.notes, p.active,
     new Date().toISOString()]
  );
  sendJson(ctx.res, 201, { ok: true, id: info.lastInsertRowid });
});

route('PUT', '/api/products/:id', async (ctx) => {
  requireRole(ctx.user, ['admin', 'manager']);
  const id = Number(ctx.params.id);
  if (!(await db.get('SELECT id FROM products WHERE id = ?', [id]))) {
    throw new HttpError(404, 'Product not found');
  }
  const p = productPayload(await readJson(ctx.req));
  if (await db.get('SELECT id FROM products WHERE sku = ? AND id <> ?', [p.sku, id])) {
    throw new HttpError(400, `SKU ${p.sku} is used by another product`);
  }
  await db.run(
    `UPDATE products SET sku=?, name=?, category_id=?, unit=?, entry_unit=?, entry_factor=?,
        pack_size=?, reorder_level=?, cost_price=?, sale_price=?, track_batch=?, notes=?,
        active=? WHERE id=?`,
    [p.sku, p.name, p.category_id, p.unit, p.entry_unit, p.entry_factor, p.pack_size,
     p.reorder_level, p.cost_price, p.sale_price, p.track_batch, p.notes, p.active, id]
  );
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/products/import', async (ctx) => {
  requireRole(ctx.user, ['admin', 'manager']);
  const body = await readJson(ctx.req);
  const rows = parseCsv(String(body.csv ?? ''));
  if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one product');

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (name) => header.indexOf(name);
  if (idx('sku') < 0 || idx('name') < 0) {
    throw new HttpError(400, 'CSV must include at least "sku" and "name" columns');
  }

  const cats = new Map(
    (await db.all('SELECT id, lower(name) n FROM categories')).map((c) => [c.n, c.id])
  );
  const results = { created: 0, updated: 0, errors: [] };
  const tx = await db.transaction();

  try {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const cell = (n) => (idx(n) >= 0 ? (r[idx(n)] ?? '').trim() : '');
      try {
        const catName = cell('category');
        let catId = null;
        if (catName) {
          const key = catName.toLowerCase();
          if (!cats.has(key)) {
            const ins = await tx.execute({
              sql: 'INSERT INTO categories (name) VALUES (?)', args: [catName],
            });
            cats.set(key, Number(ins.lastInsertRowid));
          }
          catId = cats.get(key);
        }
        const p = productPayload({
          sku: cell('sku'), name: cell('name'), category_id: catId,
          unit: cell('unit'), entry_unit: cell('entry_unit'),
          entry_factor: cell('entry_factor'), pack_size: cell('pack_size'),
          reorder_level: cell('reorder_level'), cost_price: cell('cost_price'),
          sale_price: cell('sale_price'), track_batch: cell('track_batch') !== '0',
          notes: cell('notes'),
        });
        const existing = await tx.execute({
          sql: 'SELECT id FROM products WHERE sku = ?', args: [p.sku],
        });
        if (existing.rows.length) {
          await tx.execute({
            sql: `UPDATE products SET name=?, category_id=COALESCE(?, category_id), unit=?,
                    entry_unit=?, entry_factor=?, pack_size=?, reorder_level=?, cost_price=?,
                    sale_price=?, track_batch=?, notes=?, active=1 WHERE id=?`,
            args: [p.name, p.category_id, p.unit, p.entry_unit, p.entry_factor,
                   p.pack_size, p.reorder_level, p.cost_price, p.sale_price,
                   p.track_batch, p.notes, Number(existing.rows[0].id)],
          });
          results.updated++;
        } else {
          await tx.execute({
            sql: `INSERT INTO products (sku, name, category_id, unit, entry_unit, entry_factor,
                    pack_size, reorder_level, cost_price, sale_price, track_batch, notes,
                    active, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
            args: [p.sku, p.name, p.category_id, p.unit, p.entry_unit, p.entry_factor,
                   p.pack_size, p.reorder_level, p.cost_price, p.sale_price,
                   p.track_batch, p.notes, new Date().toISOString()],
          });
          results.created++;
        }
      } catch (e) {
        results.errors.push(`Row ${i + 1}: ${e.message}`);
      }
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
  sendJson(ctx.res, 200, results);
});

// --- categories

route('POST', '/api/categories', async (ctx) => {
  requireRole(ctx.user, ['admin', 'manager']);
  const name = required((await readJson(ctx.req)).name, 'Category name').slice(0, 80);
  if (await db.get('SELECT id FROM categories WHERE lower(name) = lower(?)', [name])) {
    throw new HttpError(400, 'That category already exists');
  }
  const info = await db.run('INSERT INTO categories (name) VALUES (?)', [name]);
  sendJson(ctx.res, 201, { ok: true, id: info.lastInsertRowid });
});

// --- locations

route('GET', '/api/locations', async (ctx) => {
  sendJson(ctx.res, 200, { rows: await db.all('SELECT * FROM locations ORDER BY city, name') });
});

route('POST', '/api/locations', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const b = await readJson(ctx.req);
  const code = required(b.code, 'Location code').toUpperCase().slice(0, 20);
  if (await db.get('SELECT id FROM locations WHERE code = ?', [code])) {
    throw new HttpError(400, `Code ${code} already exists`);
  }
  const info = await db.run(
    'INSERT INTO locations (code, name, city, kind, address, active) VALUES (?,?,?,?,?,1)',
    [code, required(b.name, 'Location name').slice(0, 120), str(b.city, 60),
     str(b.kind, 20) || 'warehouse', str(b.address, 300)]
  );
  sendJson(ctx.res, 201, { ok: true, id: info.lastInsertRowid });
});

route('PUT', '/api/locations/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = Number(ctx.params.id);
  if (!(await db.get('SELECT id FROM locations WHERE id = ?', [id]))) {
    throw new HttpError(404, 'Location not found');
  }
  const b = await readJson(ctx.req);
  const code = required(b.code, 'Location code').toUpperCase().slice(0, 20);
  if (await db.get('SELECT id FROM locations WHERE code = ? AND id <> ?', [code, id])) {
    throw new HttpError(400, `Code ${code} is used by another location`);
  }
  await db.run(
    'UPDATE locations SET code=?, name=?, city=?, kind=?, address=?, active=? WHERE id=?',
    [code, required(b.name, 'Location name').slice(0, 120), str(b.city, 60),
     str(b.kind, 20) || 'warehouse', str(b.address, 300), b.active === false ? 0 : 1, id]
  );
  sendJson(ctx.res, 200, { ok: true });
});

// --- users

route('GET', '/api/users', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  sendJson(ctx.res, 200, {
    rows: await db.all(
      `SELECT u.id, u.username, u.name, u.role, u.location_id, u.active, u.created_at,
              l.name AS location_name
         FROM users u LEFT JOIN locations l ON l.id = u.location_id ORDER BY u.name`
    ),
  });
});

const ROLES = new Set(['admin', 'manager', 'staff']);

route('POST', '/api/users', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const b = await readJson(ctx.req);
  const username = required(b.username, 'Username').toLowerCase().replace(/\s+/g, '').slice(0, 40);
  const password = String(b.password ?? '');
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  const role = str(b.role, 20);
  if (!ROLES.has(role)) throw new HttpError(400, 'Invalid role');
  if (await db.get('SELECT id FROM users WHERE username = ?', [username])) {
    throw new HttpError(400, 'That username is taken');
  }
  const locationId = b.location_id ? Number(b.location_id) : null;
  if (role !== 'admin' && !locationId) throw new HttpError(400, 'Choose a location for this user');
  const info = await db.run(
    `INSERT INTO users (username, name, password_hash, role, location_id, active, created_at)
     VALUES (?,?,?,?,?,1,?)`,
    [username, required(b.name, 'Full name').slice(0, 120), hashPassword(password),
     role, locationId, new Date().toISOString()]
  );
  sendJson(ctx.res, 201, { ok: true, id: info.lastInsertRowid });
});

route('PUT', '/api/users/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const id = Number(ctx.params.id);
  if (!(await db.get('SELECT * FROM users WHERE id = ?', [id]))) {
    throw new HttpError(404, 'User not found');
  }
  const b = await readJson(ctx.req);
  const role = str(b.role, 20);
  if (!ROLES.has(role)) throw new HttpError(400, 'Invalid role');
  const locationId = b.location_id ? Number(b.location_id) : null;
  if (role !== 'admin' && !locationId) throw new HttpError(400, 'Choose a location for this user');
  const active = b.active === false ? 0 : 1;

  if (id === ctx.user.id && (role !== 'admin' || !active)) {
    throw new HttpError(400, 'You cannot remove your own admin access');
  }
  await db.run('UPDATE users SET name=?, role=?, location_id=?, active=? WHERE id=?',
    [required(b.name, 'Full name').slice(0, 120), role, locationId, active, id]);

  if (b.password) {
    if (String(b.password).length < 6) {
      throw new HttpError(400, 'Password must be at least 6 characters');
    }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(b.password), id]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  }
  if (!active) await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  sendJson(ctx.res, 200, { ok: true });
});

// --- exports

route('GET', '/api/export/stock.csv', async (ctx) => {
  const locIds = await visibleLocationIds(ctx.user);
  const ph = locIds.length ? locIds.map(() => '?').join(',') : 'NULL';
  const locations = await db.all(`SELECT id, name FROM locations WHERE id IN (${ph})`, locIds);
  const rows = (await stockRows({ locationIds: locIds, search: '', lowOnly: false })).map((r) => {
    const out = {
      sku: r.sku, name: r.name, category: r.category, unit: r.unit, pack_size: r.pack_size,
      total_qty: r.total_qty, reorder_level: r.reorder_level, cost_price: r.cost_price,
      stock_value: (r.total_qty * r.cost_price).toFixed(2),
    };
    for (const l of locations) out[`loc_${l.id}`] = r.by_location[l.id] ?? 0;
    return out;
  });
  const columns = [
    { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' },
    { key: 'category', label: 'Category' }, { key: 'unit', label: 'Unit' },
    { key: 'pack_size', label: 'Pack Size' },
    ...locations.map((l) => ({ key: `loc_${l.id}`, label: l.name })),
    { key: 'total_qty', label: 'Total Qty' }, { key: 'reorder_level', label: 'Reorder Level' },
    // Staff never see money -- omit these two columns entirely for them
    // rather than exporting a blank/zeroed Cost Price and Stock Value.
    ...(hidesValue(ctx.user) ? [] : [
      { key: 'cost_price', label: 'Cost Price' }, { key: 'stock_value', label: 'Stock Value' },
    ]),
  ];
  send(ctx.res, 200, toCsv(rows, columns), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="stock-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

route('GET', '/api/export/movements.csv', async (ctx) => {
  const locIds = await visibleLocationIds(ctx.user);
  const ph = locIds.length ? locIds.map(() => '?').join(',') : 'NULL';
  const labels = { receive: 'Receive', issue: 'Issue', transfer: 'Transfer', adjust: 'Adjust' };
  const rows = (await db.all(
    `SELECT m.ts, m.kind, p.sku, p.name AS product_name, m.qty, p.unit,
            m.entry_qty, m.entry_unit,
            fl.name AS from_name, tl.name AS to_name, m.batch_no, m.expiry,
            m.unit_cost, m.reference, m.party, m.note, u.name AS user_name
       FROM movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN locations fl ON fl.id = m.from_location_id
       LEFT JOIN locations tl ON tl.id = m.to_location_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.from_location_id IN (${ph}) OR m.to_location_id IN (${ph})
      ORDER BY m.id DESC`,
    [...locIds, ...locIds]
  )).map((r) => ({
    ...r,
    ts: String(r.ts).slice(0, 10),
    time: String(r.ts).slice(11, 16),
    kind: labels[r.kind] || r.kind,
    qty: round4(r.qty),
    entry_qty: r.entry_unit ? round4(r.entry_qty) : '',
  }));
  const columns = [
    { key: 'ts', label: 'Date' }, { key: 'time', label: 'Time' }, { key: 'kind', label: 'Type' },
    { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' },
    { key: 'entry_qty', label: 'Entered Qty' }, { key: 'entry_unit', label: 'Entered Unit' },
    { key: 'qty', label: 'Qty' }, { key: 'unit', label: 'Unit' },
    { key: 'from_name', label: 'From' }, { key: 'to_name', label: 'To' },
    { key: 'batch_no', label: 'Batch' }, { key: 'expiry', label: 'Expiry' },
    // Staff never see money -- omit Unit Cost entirely rather than export a
    // blank/zeroed column.
    ...(hidesValue(ctx.user) ? [] : [{ key: 'unit_cost', label: 'Unit Cost' }]),
    { key: 'reference', label: 'Reference' },
    { key: 'party', label: 'Customer / Supplier' }, { key: 'note', label: 'Note' },
    { key: 'user_name', label: 'Recorded By' },
  ];
  send(ctx.res, 200, toCsv(rows, columns), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="movements-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

route('GET', '/api/export/products-template.csv', async (ctx) => {
  const columns = ['sku', 'name', 'category', 'unit', 'entry_unit', 'entry_factor',
    'pack_size', 'reorder_level', 'cost_price', 'sale_price'].map((k) => ({ key: k, label: k }));
  const sample = [{
    sku: 'ZEP-DW-05', name: 'ZEEPER Dish Wash Liquid', category: 'Stewarding Chemicals',
    unit: 'Litre', entry_unit: '', entry_factor: '', pack_size: '5 L Can',
    reorder_level: '100', cost_price: '210', sale_price: '320',
  }, {
    sku: 'FRG-EXAMPLE', name: 'Example fragrance recorded in ML, stocked in KG',
    category: 'Fragrances', unit: 'Kg', entry_unit: 'ML', entry_factor: '1000',
    pack_size: '', reorder_level: '0', cost_price: '0', sale_price: '0',
  }];
  send(ctx.res, 200, toCsv(sample, columns), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="product-import-template.csv"',
  });
});

// ---------------------------------------------------------------- dispatch

let lastPrune = 0;
async function prune() {
  const now = Date.now();
  if (now - lastPrune < 3600_000) return;
  lastPrune = now;
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [new Date().toISOString()])
    .catch(() => {});
}

async function handleApi(req, res, url) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  const pathname = decodeURIComponent(url.pathname);
  try {
    await db.ensureReady();
    prune();

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });

      let user = null;
      if (r.auth) {
        user = await userFromRequest(req);
        if (!user) throw new HttpError(401, 'Please sign in');
      }
      if (r.roles) requireRole(user, r.roles);
      return await r.handler({ req, res, url, params, user });
    }
    throw new HttpError(404, 'Endpoint not found');
  } catch (err) {
    if (res.headersSent) return;
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, {
      error: status === 500 ? 'Something went wrong on the server' : err.message,
    });
  }
}

module.exports = { handleApi };
