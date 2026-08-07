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

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
  });
});

// --- dashboard

route('GET', '/api/dashboard', async (ctx) => {
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

  sendJson(ctx.res, 200, {
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
  sendJson(ctx.res, 200, {
    rows: await stockRows({
      locationIds: locIds,
      search: str(q.get('search'), 80),
      lowOnly: q.get('low') === '1',
    }),
  });
});

route('GET', '/api/batches', async (ctx) => {
  sendJson(ctx.res, 200, { rows: await batchRows(await visibleLocationIds(ctx.user)) });
});

// --- movements

const KINDS = new Set(['receive', 'issue', 'transfer', 'adjust']);

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

  const limit = Math.min(Math.max(num(q.get('limit'), 200), 1), 2000);
  sendJson(ctx.res, 200, {
    rows: await db.all(
      `SELECT m.*, p.sku, p.name AS product_name, p.unit,
              fl.name AS from_name, tl.name AS to_name, u.name AS user_name
         FROM movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN locations fl ON fl.id = m.from_location_id
         LEFT JOIN locations tl ON tl.id = m.to_location_id
         LEFT JOIN users u ON u.id = m.user_id
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

  const qty = num(body.qty);
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
    if (qty > have + 1e-9) throw new HttpError(400, `Only ${have} ${product.unit} in stock at that location`);
  } else if (kind === 'transfer') {
    if (!fromId || !toId) throw new HttpError(400, 'Choose both source and destination locations');
    if (fromId === toId) throw new HttpError(400, 'Source and destination must be different');
    if (qty <= 0) throw new HttpError(400, 'Quantity must be greater than zero');
    if (!canWriteLocation(ctx.user, fromId)) throw new HttpError(403, 'No permission at the source location');
    const have = await currentQty(product.id, fromId);
    if (qty > have + 1e-9) throw new HttpError(400, `Only ${have} ${product.unit} in stock at the source`);
  } else {
    if (!toId) throw new HttpError(400, 'Choose the location to adjust');
    if (qty === 0) throw new HttpError(400, 'Adjustment cannot be zero');
    if (!canWriteLocation(ctx.user, toId)) throw new HttpError(403, 'No permission at that location');
    fromId = null;
    const have = await currentQty(product.id, toId);
    if (have + qty < -1e-9) throw new HttpError(400, `That would take stock below zero (currently ${have})`);
  }

  const info = await db.run(
    `INSERT INTO movements
       (ts, kind, product_id, from_location_id, to_location_id, qty, batch_no, expiry,
        unit_cost, reference, party, note, user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      body.ts ? new Date(body.ts).toISOString() : new Date().toISOString(),
      kind, product.id, fromId, toId, qty,
      str(body.batch_no, 60), str(body.expiry, 10),
      num(body.unit_cost, product.cost_price),
      str(body.reference, 80), str(body.party, 120), str(body.note, 500),
      ctx.user.id,
    ]
  );
  sendJson(ctx.res, 201, { ok: true, id: info.lastInsertRowid });
});

route('DELETE', '/api/movements/:id', async (ctx) => {
  requireRole(ctx.user, ['admin']);
  const m = await db.get('SELECT * FROM movements WHERE id = ?', [Number(ctx.params.id)]);
  if (!m) throw new HttpError(404, 'Movement not found');
  await db.run('DELETE FROM movements WHERE id = ?', [m.id]);
  sendJson(ctx.res, 200, { ok: true });
});

// --- products

route('GET', '/api/products', async (ctx) => {
  const includeInactive = ctx.url.searchParams.get('all') === '1';
  sendJson(ctx.res, 200, {
    rows: await db.all(
      `SELECT p.*, c.name AS category FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        ${includeInactive ? '' : 'WHERE p.active = 1'}
        ORDER BY p.name`
    ),
  });
});

function productPayload(body) {
  return {
    sku: required(body.sku, 'SKU').toUpperCase().slice(0, 40),
    name: required(body.name, 'Product name').slice(0, 160),
    category_id: body.category_id ? Number(body.category_id) : null,
    unit: str(body.unit, 20) || 'Litre',
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
    `INSERT INTO products (sku, name, category_id, unit, pack_size, reorder_level,
        cost_price, sale_price, track_batch, notes, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.sku, p.name, p.category_id, p.unit, p.pack_size, p.reorder_level,
     p.cost_price, p.sale_price, p.track_batch, p.notes, p.active, new Date().toISOString()]
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
    `UPDATE products SET sku=?, name=?, category_id=?, unit=?, pack_size=?, reorder_level=?,
        cost_price=?, sale_price=?, track_batch=?, notes=?, active=? WHERE id=?`,
    [p.sku, p.name, p.category_id, p.unit, p.pack_size, p.reorder_level,
     p.cost_price, p.sale_price, p.track_batch, p.notes, p.active, id]
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
          unit: cell('unit'), pack_size: cell('pack_size'),
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
                    pack_size=?, reorder_level=?, cost_price=?, sale_price=?, track_batch=?,
                    notes=?, active=1 WHERE id=?`,
            args: [p.name, p.category_id, p.unit, p.pack_size, p.reorder_level,
                   p.cost_price, p.sale_price, p.track_batch, p.notes,
                   Number(existing.rows[0].id)],
          });
          results.updated++;
        } else {
          await tx.execute({
            sql: `INSERT INTO products (sku, name, category_id, unit, pack_size, reorder_level,
                    cost_price, sale_price, track_batch, notes, active, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
            args: [p.sku, p.name, p.category_id, p.unit, p.pack_size, p.reorder_level,
                   p.cost_price, p.sale_price, p.track_batch, p.notes,
                   new Date().toISOString()],
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
    { key: 'cost_price', label: 'Cost Price' }, { key: 'stock_value', label: 'Stock Value' },
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
  }));
  const columns = [
    { key: 'ts', label: 'Date' }, { key: 'time', label: 'Time' }, { key: 'kind', label: 'Type' },
    { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' },
    { key: 'qty', label: 'Qty' }, { key: 'unit', label: 'Unit' },
    { key: 'from_name', label: 'From' }, { key: 'to_name', label: 'To' },
    { key: 'batch_no', label: 'Batch' }, { key: 'expiry', label: 'Expiry' },
    { key: 'unit_cost', label: 'Unit Cost' }, { key: 'reference', label: 'Reference' },
    { key: 'party', label: 'Customer / Supplier' }, { key: 'note', label: 'Note' },
    { key: 'user_name', label: 'Recorded By' },
  ];
  send(ctx.res, 200, toCsv(rows, columns), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="movements-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

route('GET', '/api/export/products-template.csv', async (ctx) => {
  const columns = ['sku', 'name', 'category', 'unit', 'pack_size', 'reorder_level',
    'cost_price', 'sale_price'].map((k) => ({ key: k, label: k }));
  const sample = [{
    sku: 'ZEP-DW-05', name: 'ZEEPER Dish Wash Liquid', category: 'Stewarding Chemicals',
    unit: 'Litre', pack_size: '5 L Can', reorder_level: '100', cost_price: '210', sale_price: '320',
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
