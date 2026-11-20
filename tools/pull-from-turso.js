'use strict';
// One-time: copy ALL data from the online (Turso) database into the local
// file data/inventory.db, so the app can run fully offline.
//
//   set TURSO_DATABASE_URL=libsql://...      (Windows: use "set"; Mac/Linux: export)
//   set TURSO_AUTH_TOKEN=...
//   node tools/pull-from-turso.js
//
// It only READS from the online database. It refuses to overwrite an existing
// local database unless you pass --force (the old one is kept as a .bak copy).
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const srcUrl = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!srcUrl) { console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first.'); process.exit(1); }

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const file = path.join(dir, 'inventory.db');
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(file)) {
  if (!process.argv.includes('--force')) {
    console.error(`${file} already exists. Re-run with --force to replace it (a .bak copy is kept).`);
    process.exit(1);
  }
  fs.copyFileSync(file, file + '.' + Date.now() + '.bak');
  fs.unlinkSync(file);
  for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(file + ext, { force: true });
}

const src = createClient(token ? { url: srcUrl, authToken: token } : { url: srcUrl });
const dst = createClient({ url: 'file:' + file.replace(/\\/g, '/') });

(async () => {
  const objs = (await src.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'"
  )).rows;
  const tables = objs.filter((o) => o.type === 'table');
  for (const t of tables) await dst.execute(t.sql);
  let total = 0;
  for (const t of tables) {
    const rs = await src.execute(`SELECT * FROM "${t.name}"`);
    if (!rs.rows.length) { console.log(`  ${t.name}: 0 rows`); continue; }
    const cols = rs.columns.map((c) => `"${c}"`).join(',');
    const ph = rs.columns.map(() => '?').join(',');
    const batch = rs.rows.map((r) => ({
      sql: `INSERT INTO "${t.name}" (${cols}) VALUES (${ph})`,
      args: rs.columns.map((c) => (typeof r[c] === 'bigint' ? Number(r[c]) : r[c])),
    }));
    for (let i = 0; i < batch.length; i += 200) await dst.batch(batch.slice(i, i + 200), 'write');
    total += rs.rows.length;
    console.log(`  ${t.name}: ${rs.rows.length} rows`);
  }
  // Keep AUTOINCREMENT counters so new IDs continue where the online system left off.
  try {
    const seq = (await src.execute('SELECT name, seq FROM sqlite_sequence')).rows;
    for (const s of seq) {
      await dst.execute({ sql: 'DELETE FROM sqlite_sequence WHERE name=?', args: [s.name] });
      await dst.execute({ sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', args: [s.name, Number(s.seq)] });
    }
  } catch (_) { /* no sequences */ }
  for (const o of objs.filter((x) => x.type === 'index')) {
    try { await dst.execute(o.sql); } catch (_) {}
  }
  console.log(`\nDone: ${total} rows copied into ${file}\nStart the app and log in with your usual online username/password.`);
  process.exit(0);
})().catch((e) => { console.error('Failed: ' + e.message); process.exit(1); });
