# A.N Traders — Inventory Management

Multi-location stock control for ZEEPER manufacturing and trading.
Tracks what you hold at every warehouse and plant, who moved it, and which batch it came from.

Runs in two places from the same code:

- **On your own computer** — for trying things out. Uses a local database file.
- **On Vercel** — the live system all four cities connect to. Uses a Turso cloud database.

---

## Part 1 — Running it locally

Double-click **`Start Inventory.bat`**. First run installs components; after that it
opens straight away.

First login is `admin` / `admin123`. **Change that password immediately** —
click *Password* in the top-right.

This local copy keeps its own database in `data/`, completely separate from the
live site. Nothing you do here affects the real stock.

---

## Part 2 — Putting it online

### Step 1 — Create the database (Turso)

1. Go to **[turso.tech](https://turso.tech)** and sign up (free).
2. Create a database — any name, pick the region closest to Pakistan.
3. Copy two things it shows you:
   - the **Database URL** (starts with `libsql://`)
   - an **auth token** (create one if it isn't shown)

Keep these private. The token is a key to all your stock data.

### Step 2 — Put the code on GitHub

1. Go to **[github.com/new](https://github.com/new)**.
2. Name it `an-traders-inventory`, choose **Private**, and create it.
   Do not tick "Add a README" — the repo already has one.
3. GitHub then shows you a URL. Run these two commands in this folder:

```bash
git remote add origin https://github.com/YOUR-USERNAME/an-traders-inventory.git
```

```bash
git push -u origin main
```

### Step 3 — Deploy on Vercel

1. In Vercel, click **Add New → Project** and import the repo.
2. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | the `libsql://…` URL from Step 1 |
   | `TURSO_AUTH_TOKEN` | the token from Step 1 |
   | `ADMIN_PASSWORD` | a strong first password for the `admin` account |

3. Click **Deploy**.

The first time anyone opens the site, it creates the tables and your locations
automatically, then you sign in as `admin` with the password you set.

That URL is what your Karachi, Lahore, Islamabad and Peshawar offices use. It is
HTTPS by default, so passwords are encrypted in transit.

### Updating it later

Any change pushed to GitHub redeploys automatically:

```bash
git add -A && git commit -m "describe the change" && git push
```

---

## Roles

| Role | Can do |
|---|---|
| **Administrator** | Everything: users, locations, products, all stock, deleting movements |
| **Manager** | Sees all locations, records movements at their own, manages the product catalogue |
| **Staff** | Sees and records only at their own location |

A Karachi storekeeper can *send* a transfer to Lahore, but cannot record anything
into Karachi's stock on Lahore's behalf — and cannot see Lahore's balances.

## How stock is calculated

There is no editable "quantity" field anywhere. Every balance is the sum of the
movements recorded against it:

- **Receive in** — arriving from production or a supplier
- **Issue out** — going to a customer, or consumed / written off
- **Transfer** — between two of your own locations
- **Adjust** — correcting after a physical count (use a minus sign to reduce)

This means the stock figure and the audit trail can never disagree. Nothing is
overwritten; a mistake is corrected by recording a correction, and only an
administrator can delete a movement outright.

The system refuses any movement that would push a location below zero.

## Batches and expiry

Add a batch number and expiry date when you receive stock. The **Batches** page
then shows how much of each batch is still on hand and flags anything expiring
within 90 days — which is what ISO 9001 and HACCP audits ask for.

## Loading your product list

Products → **Import CSV**. Download the template, fill it in from your existing
price list, paste or upload it back. Required columns are `sku` and `name`;
`category`, `unit`, `pack_size`, `reorder_level`, `cost_price`, `sale_price` are optional.

Re-importing an existing SKU updates it rather than creating a duplicate, so you
can use the same file to push a price revision across the catalogue.

`product-catalogue.csv` in this folder is your current item list, built from your
purchase requests. It is deliberately **not** in the GitHub repo, because it
contains supplier cost prices.

## Reorder alerts

Set a **reorder level** on each product. Anything at or below it appears on the
dashboard and can be filtered on the Stock page — so you see what to make or buy
before a hotel order arrives.

## Backups

Turso keeps automatic point-in-time backups on its own infrastructure. For your
own copy, sign in as administrator and use **Export CSV** on the Stock and
Movements pages — the movements export is the complete history, which is enough
to rebuild every balance from scratch.

Do that monthly and keep it off the machine.

## Technical notes

- Node.js 20+. One dependency: `@libsql/client`.
- `lib/app.js` holds every API route; `server.js` (local) and `api/index.js`
  (Vercel) both hand requests to it, so the two environments run identical code.
- With no `TURSO_DATABASE_URL` set, the app uses a local SQLite file automatically.
- Passwords are stored as salted scrypt hashes, never in plain text.
- Sessions last 30 days and are stored in the database, so signing someone out
  works across all locations.
