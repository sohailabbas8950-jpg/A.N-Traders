# A.N Traders — Inventory Management

Multi-location stock control for ZEEPER manufacturing and trading.
Runs **fully offline on one laptop** — no internet, no hosting, no cloud account.

## Using it

Double-click **`Start Inventory.bat`**. A browser tab opens at http://localhost:4000.
The first run needs internet **once** to install components; after that it works with no connection.
It only listens on this laptop (`127.0.0.1`), so nobody else on the network can reach it.

Default login on a brand-new database is `admin` / `admin123` — change it straight away.

## Your data

Everything lives in one file: **`data/inventory.db`**. Back it up by double-clicking
**`Backup Data.bat`** (copies it into `backups/` with the date) and copy that folder to a USB
drive regularly. If the laptop dies and you have no copy, the data is gone.

## Moving your existing online data onto this laptop (once)

1. Get `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (Vercel project → Settings → Environment Variables, or the Turso dashboard).
2. In a terminal in this folder:
   ```
   set TURSO_DATABASE_URL=libsql://your-db.turso.io
   set TURSO_AUTH_TOKEN=your-token
   node tools/pull-from-turso.js
   ```
3. Start the app and log in with your usual online username and password.

This only reads from the online database. Afterwards the online copy is no longer needed.

---

## Appendix — online deployment (no longer used)

The Vercel/Turso setup (`api/`, `vercel.json`) is still in the repo but is not needed for offline use.
