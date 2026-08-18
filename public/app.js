'use strict';

const S = {
  user: null,
  locations: [],
  categories: [],
  products: [],
  visibleLocations: [],
};

// ------------------------------------------------------------ helpers

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Converted quantities are often small — 5 ML of fragrance is 0.005 Kg — so
// show enough decimals for a sub-unit figure to survive rounding.
function fmtQty(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  return v.toLocaleString('en-PK', {
    maximumFractionDigits: abs > 0 && abs < 1 ? 4 : 2,
  });
}

function round4(n) {
  return Math.round(Number(n) * 1e4) / 1e4;
}

// Movement quantity for a table cell. Where the product was entered in another
// unit, lead with what the storekeeper typed and show the stock figure beneath,
// so the row matches both their paperwork and the balance it moved.
function qtyCell(m) {
  const stock = `<strong>${fmtQty(m.qty)}</strong> <span style="color:var(--muted)">${esc(m.unit)}</span>`;
  if (!m.entry_unit) return stock;
  return `<strong>${fmtQty(m.entry_qty)}</strong> <span style="color:var(--muted)">${esc(m.entry_unit)}</span>`
    + `<div class="hint">${fmtQty(m.qty)} ${esc(m.unit)}</div>`;
}

function fmtMoney(n) {
  return 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  if (res.status === 401) {
    S.user = null;
    showLogin();
    throw new Error('Please sign in');
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('Request failed');
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function locName(id) {
  const l = S.locations.find((x) => x.id === Number(id));
  return l ? l.name : '';
}

function canWrite(locId) {
  if (!S.user) return false;
  if (S.user.role === 'admin') return true;
  return Number(S.user.location_id) === Number(locId);
}

function writableLocations() {
  if (S.user.role === 'admin') return S.locations.filter((l) => l.active);
  return S.locations.filter((l) => l.active && l.id === S.user.location_id);
}

function viewableLocations() {
  return S.locations.filter((l) => S.visibleLocations.includes(l.id));
}

// ------------------------------------------------------------ modal

function openModal(title, bodyHtml, footHtml) {
  const modal = document.getElementById('modal');
  modal.innerHTML = `
    <div class="modal-head">
      <h3>${esc(title)}</h3>
      <div class="spacer"></div>
      <button class="close-x" data-close aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
    ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
  modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  const first = modal.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return modal;
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  document.getElementById('modal').innerHTML = '';
}

function modalError(msg) {
  const body = document.querySelector('#modal .modal-body');
  if (!body) return;
  let box = body.querySelector('.form-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'form-error';
    body.prepend(box);
  }
  box.textContent = msg;
  body.scrollTop = 0;
}

document.getElementById('modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ------------------------------------------------------------ login

function showLogin() {
  document.getElementById('login').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  closeModal();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('login-error');
  err.hidden = true;
  f.querySelector('button').disabled = true;
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: f.username.value, password: f.password.value }),
    });
    f.reset();
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    f.querySelector('button').disabled = false;
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  S.user = null;
  showLogin();
});

document.getElementById('btn-password').addEventListener('click', () => {
  const m = openModal('Change password', `
    <div class="grid" style="gap:14px">
      <label>Current password<input type="password" id="pw-current" autocomplete="current-password"></label>
      <label>New password <span class="hint">at least 6 characters</span>
        <input type="password" id="pw-next" autocomplete="new-password"></label>
      <label>Confirm new password<input type="password" id="pw-confirm" autocomplete="new-password"></label>
    </div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pw-save">Update</button>`);

  m.querySelector('#pw-save').addEventListener('click', async () => {
    const next = m.querySelector('#pw-next').value;
    if (next !== m.querySelector('#pw-confirm').value) return modalError('New passwords do not match');
    try {
      await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ current: m.querySelector('#pw-current').value, next }),
      });
      closeModal();
      toast('Password updated', 'success');
    } catch (ex) { modalError(ex.message); }
  });
});

document.getElementById('menu-toggle').addEventListener('click', () => {
  document.getElementById('sidenav').classList.toggle('open');
});

// ------------------------------------------------------------ boot + router

function syncNav() {
  document.querySelectorAll('.sidenav a').forEach((a) => {
    a.classList.toggle('hidden', !mayOpen(a.dataset.nav));
  });
}

async function boot() {
  const data = await api('/api/bootstrap');
  S.user = data.user;
  S.locations = data.locations;
  S.categories = data.categories;
  S.visibleLocations = data.visible_location_ids;
  S.permissions = data.permissions;

  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const roleLabel = { admin: 'Administrator', manager: 'Manager', staff: 'Staff' }[S.user.role];
  document.getElementById('user-chip').textContent =
    `${S.user.name} · ${roleLabel}${S.user.location_name ? ' · ' + S.user.location_name : ''}`;

  syncNav();

  await refreshProducts();
  const wanted = currentRoute();
  const target = mayOpen(wanted) ? wanted : homeView();
  if (location.hash !== '#/' + target) location.hash = '#/' + target; // fires hashchange
  else render();
}

async function refreshProducts() {
  const d = await api('/api/products');
  S.products = d.rows;
}

const VIEWS = {
  dashboard: viewDashboard,
  stock: viewStock,
  movements: viewMovements,
  batches: viewBatches,
  counts: viewCounts,
  consumption: viewConsumption,
  products: viewProducts,
  locations: viewLocations,
  users: viewUsers,
  permissions: viewPermissions,
};

// Which sections a manager/staff login can see is configurable from the
// Permissions page (admin only) rather than hardcoded. locations/users/
// permissions stay admin-only always -- those are account administration,
// not something to hand out per section. The server enforces the same
// permission table for dashboard/batches/counts; this is convenience for
// everything else, not the security boundary.
const ADMIN_ONLY_NAV = ['locations', 'users', 'permissions'];
const CONFIGURABLE_MODULES = ['dashboard', 'stock', 'movements', 'batches', 'counts', 'products', 'consumption'];

function mayOpen(name) {
  if (!S.user) return false;
  if (S.user.role === 'admin') return true;
  if (ADMIN_ONLY_NAV.includes(name)) return false;
  if (CONFIGURABLE_MODULES.includes(name)) {
    const forRole = S.permissions && S.permissions[S.user.role];
    return forRole ? forRole[name] !== false : true;
  }
  return false;
}

function homeView() {
  return Object.keys(VIEWS).find(mayOpen) || 'stock';
}

function currentRoute() {
  return (location.hash.replace('#/', '') || '').split('?')[0];
}

async function render() {
  if (!S.user) return;
  let name = currentRoute();
  if (!VIEWS[name] || !mayOpen(name)) {
    const home = homeView();
    if (location.hash !== '#/' + home) { location.hash = '#/' + home; return; }
    name = home;
  }
  const fn = VIEWS[name];
  document.querySelectorAll('.sidenav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
  document.getElementById('sidenav').classList.remove('open');
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await fn(view);
  } catch (ex) {
    view.innerHTML = `<div class="card"><div class="empty">${esc(ex.message)}</div></div>`;
  }
}

window.addEventListener('hashchange', render);

// ------------------------------------------------------------ dashboard

async function viewDashboard(view) {
  const d = await api('/api/dashboard');

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Dashboard</h2>
        <p class="page-sub">${esc(S.user.role === 'staff' ? locName(S.user.location_id) : 'All locations')}</p>
      </div>
      <div class="spacer"></div>
      <button class="btn primary" id="quick-move">Record movement</button>
    </div>

    <div class="grid stats" style="margin-bottom:16px">
      <div class="card stat"><div class="label">Active products</div>
        <div class="value">${fmtQty(d.product_count)}</div></div>
      <div class="card stat"><div class="label">Stock value</div>
        <div class="value">${esc(fmtMoney(d.stock_value))}</div>
        <div class="foot">at cost price</div></div>
      <div class="card stat"><div class="label">Low stock</div>
        <div class="value ${d.low_stock_count ? 'danger' : ''}">${fmtQty(d.low_stock_count)}</div>
        <div class="foot">at or below reorder level</div></div>
      <div class="card stat"><div class="label">Batches expiring</div>
        <div class="value ${d.expiring.length ? 'warn' : ''}">${fmtQty(d.expiring.length)}</div>
        <div class="foot">within 90 days</div></div>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head">Reorder now</div>
        <div class="card-body">${
          d.low_stock.length
            ? d.low_stock.slice(0, 8).map((r) => `
                <div class="alert-row">
                  <span class="pill low">${fmtQty(r.total_qty)} ${esc(r.unit)}</span>
                  <span class="grow">${esc(r.name)}</span>
                  <span class="mono" style="color:var(--muted)">min ${fmtQty(r.reorder_level)}</span>
                </div>`).join('')
            : '<div class="empty">Everything is above its reorder level.</div>'
        }</div>
      </div>
      <div class="card">
        <div class="card-head">Expiring batches</div>
        <div class="card-body">${
          d.expiring.length
            ? d.expiring.slice(0, 8).map((b) => `
                <div class="alert-row">
                  <span class="pill ${b.expired ? 'low' : 'adjust'}">${b.expired ? 'Expired' : fmtDate(b.expiry)}</span>
                  <span class="grow">${esc(b.name)} <span style="color:var(--muted)">· ${esc(b.batch_no)}</span></span>
                  <span class="mono" style="color:var(--muted)">${fmtQty(b.qty)} ${esc(b.unit)}</span>
                </div>`).join('')
            : '<div class="empty">No batches expiring soon.</div>'
        }</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">Recent activity
        <div class="spacer"></div>
        <a class="btn small" href="#/movements">View all</a>
      </div>
      <div class="table-wrap">${movementsTable(d.recent)}</div>
    </div>`;

  view.querySelector('#quick-move').addEventListener('click', () => openMovementModal());
}

// ------------------------------------------------------------ stock

async function viewStock(view) {
  const locs = viewableLocations();
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Stock on hand</h2>
        <p class="page-sub">Live balance calculated from every recorded movement</p></div>
      <div class="spacer"></div>
      <button class="btn" id="export-stock">Export CSV</button>
      <button class="btn primary" id="new-move">Record movement</button>
    </div>
    <div class="toolbar">
      <input id="f-search" placeholder="Search product or SKU…" style="min-width:230px">
      <select id="f-loc">
        <option value="all">All my locations</option>
        ${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
      </select>
      <label class="checkline"><input type="checkbox" id="f-low"> Low stock only</label>
    </div>
    <div class="card"><div class="table-wrap" id="stock-table"></div></div>`;

  const load = async () => {
    const params = new URLSearchParams({
      search: view.querySelector('#f-search').value,
      location: view.querySelector('#f-loc').value,
      low: view.querySelector('#f-low').checked ? '1' : '0',
    });
    const box = view.querySelector('#stock-table');
    const d = await api('/api/stock?' + params);
    const showCols = view.querySelector('#f-loc').value === 'all' ? locs : [];

    if (!d.rows.length) {
      box.innerHTML = '<div class="empty">No products match. Add products under the Products tab.</div>';
      return;
    }
    box.innerHTML = `
      <table>
        <thead><tr>
          <th>SKU</th><th>Product</th><th>Category</th>
          ${showCols.map((l) => `<th class="num" title="${esc(l.name)}">${esc(l.name)}</th>`).join('')}
          <th class="num">Total</th><th class="num">Reorder</th><th></th><th class="num">Value</th>
        </tr></thead>
        <tbody>${d.rows.map((r) => {
          const low = r.reorder_level > 0 && r.total_qty <= r.reorder_level;
          return `<tr>
            <td class="mono">${esc(r.sku)}</td>
            <td class="wrap">${esc(r.name)}${r.pack_size ? ` <span style="color:var(--muted)">· ${esc(r.pack_size)}</span>` : ''}</td>
            <td style="color:var(--muted)">${esc(r.category || '—')}</td>
            ${showCols.map((l) => `<td class="num">${fmtQty(r.by_location[l.id] || 0)}</td>`).join('')}
            <td class="num"><strong>${fmtQty(r.total_qty)}</strong> <span style="color:var(--muted)">${esc(r.unit)}</span></td>
            <td class="num" style="color:var(--muted)">${r.reorder_level ? fmtQty(r.reorder_level) : '—'}</td>
            <td>${low ? '<span class="pill low">Reorder</span>' : '<span class="pill ok">OK</span>'}</td>
            <td class="num">${esc(fmtMoney(r.total_qty * r.cost_price))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  };

  let timer;
  view.querySelector('#f-search').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 220);
  });
  view.querySelector('#f-loc').addEventListener('change', load);
  view.querySelector('#f-low').addEventListener('change', load);
  view.querySelector('#new-move').addEventListener('click', () => openMovementModal(null, load));
  view.querySelector('#export-stock').addEventListener('click', () => {
    window.location.href = '/api/export/stock.csv';
  });

  await load();
}

// ------------------------------------------------------------ movements

function movementsTable(rows, opts = {}) {
  if (!rows.length) return '<div class="empty">No movements recorded yet.</div>';
  const labels = { receive: 'Receive', issue: 'Issue', transfer: 'Transfer', adjust: 'Adjust' };
  return `
    <table>
      <thead><tr>
        <th>Date</th><th>Type</th><th>SKU</th><th>Product</th>
        <th class="num">Qty</th><th>From</th><th>To</th><th>Batch</th>
        <th>Reference</th><th>Party</th><th>By</th>${opts.actions ? '<th></th>' : ''}
      </tr></thead>
      <tbody>${rows.map((m) => `
        <tr>
          <td style="color:var(--muted)">${fmtDateTime(m.ts)}</td>
          <td><span class="pill ${esc(m.kind)}">${esc(labels[m.kind] || m.kind)}</span></td>
          <td class="mono">${esc(m.sku)}</td>
          <td class="wrap">${esc(m.product_name)}</td>
          <td class="num">${qtyCell(m)}</td>
          <td>${esc(m.from_name || '—')}</td>
          <td>${esc(m.to_name || '—')}</td>
          <td class="mono">${esc(m.batch_no || '—')}</td>
          <td>${esc(m.reference || '—')}</td>
          <td class="wrap">${esc(m.party || '—')}</td>
          <td style="color:var(--muted)">${esc(m.user_name || '—')}</td>
          ${opts.actions ? `<td><button class="btn small danger" data-del="${m.id}">Delete</button></td>` : ''}
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function viewMovements(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h2>Stock movements</h2>
        <p class="page-sub">Every receipt, issue, transfer and adjustment — permanent audit trail</p></div>
      <div class="spacer"></div>
      <button class="btn" id="export-mv">Export CSV</button>
      <button class="btn primary" id="new-move">Record movement</button>
    </div>
    <div class="toolbar">
      <input id="f-search" placeholder="Product, SKU, reference or party…" style="min-width:240px">
      <select id="f-kind">
        <option value="">All types</option>
        <option value="receive">Receive</option>
        <option value="issue">Issue</option>
        <option value="transfer">Transfer</option>
        <option value="adjust">Adjust</option>
      </select>
      <label class="checkline">From <input type="date" id="f-from"></label>
      <label class="checkline">To <input type="date" id="f-to"></label>
      <button class="btn" id="f-clear">Clear</button>
    </div>
    <div class="card"><div class="table-wrap" id="mv-table"></div></div>`;

  const load = async () => {
    const p = new URLSearchParams();
    const q = (id) => view.querySelector(id).value;
    if (q('#f-search')) p.set('search', q('#f-search'));
    if (q('#f-kind')) p.set('kind', q('#f-kind'));
    if (q('#f-from')) p.set('from', q('#f-from'));
    if (q('#f-to')) p.set('to', q('#f-to'));
    const d = await api('/api/movements?' + p);
    const box = view.querySelector('#mv-table');
    box.innerHTML = movementsTable(d.rows, { actions: S.user.role === 'admin' });
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this movement? Stock balances will be recalculated.')) return;
        try {
          await api('/api/movements/' + b.dataset.del, { method: 'DELETE' });
          toast('Movement deleted', 'success');
          load();
        } catch (ex) { toast(ex.message, 'error'); }
      });
    });
  };

  let timer;
  view.querySelector('#f-search').addEventListener('input', () => {
    clearTimeout(timer); timer = setTimeout(load, 220);
  });
  ['#f-kind', '#f-from', '#f-to'].forEach((id) =>
    view.querySelector(id).addEventListener('change', load));
  view.querySelector('#f-clear').addEventListener('click', () => {
    ['#f-search', '#f-kind', '#f-from', '#f-to'].forEach((id) => { view.querySelector(id).value = ''; });
    load();
  });
  view.querySelector('#new-move').addEventListener('click', () => openMovementModal(null, load));
  view.querySelector('#export-mv').addEventListener('click', () => {
    window.location.href = '/api/export/movements.csv';
  });

  await load();
}

function openMovementModal(preset, onDone) {
  const writable = writableLocations();
  if (!writable.length) return toast('You are not assigned to a location yet', 'error');
  if (!S.products.length) return toast('Add a product first', 'error');

  const kind = preset?.kind || 'receive';
  const productOpts = S.products
    .map((p) => `<option value="${p.id}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('');
  const locOpts = (list) => list.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  const allLocs = S.locations.filter((l) => l.active);

  const m = openModal('Record stock movement', `
    <div class="tabs" id="kind-tabs">
      <button data-kind="receive" class="${kind === 'receive' ? 'active' : ''}">Receive in</button>
      <button data-kind="issue" class="${kind === 'issue' ? 'active' : ''}">Issue out</button>
      <button data-kind="transfer" class="${kind === 'transfer' ? 'active' : ''}">Transfer</button>
      <button data-kind="adjust" class="${kind === 'adjust' ? 'active' : ''}">Adjust</button>
    </div>
    <p class="page-sub" id="kind-help" style="margin-bottom:16px"></p>
    <div class="form-grid">
      <label class="full">Product
        <select id="mv-product">${productOpts}</select></label>

      <label id="wrap-from"><span id="from-label">From location</span>
        <select id="mv-from">${locOpts(writable)}</select></label>
      <label id="wrap-to"><span id="to-label">To location</span>
        <select id="mv-to">${locOpts(writable)}</select></label>

      <label><span id="qty-label">Quantity</span> <span class="hint" id="qty-hint"></span>
        <input type="number" id="mv-qty" step="any" placeholder="0">
        <span class="hint" id="qty-convert"></span></label>
      <label>Date
        <input type="date" id="mv-date" value="${todayStr()}"></label>

      <label>Batch number <span class="hint">optional</span>
        <input id="mv-batch" placeholder="e.g. B-2408-14"></label>
      <label>Expiry date <span class="hint">optional</span>
        <input type="date" id="mv-expiry"></label>

      <label>Reference <span class="hint">invoice / GRN / DC no.</span>
        <input id="mv-ref"></label>
      <label id="wrap-party">Customer / Supplier
        <input id="mv-party" placeholder="e.g. Pearl Continental Lahore"></label>

      <label class="full">Note <span class="hint">optional</span>
        <textarea id="mv-note" rows="2"></textarea></label>
    </div>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="mv-save">Save movement</button>`);

  let current = kind;

  const HELP = {
    receive: 'Stock arriving from production or a supplier.',
    issue: 'Stock leaving for a customer, or consumed / written off.',
    transfer: 'Move stock from one of your locations to another.',
    adjust: 'Correct the balance after a physical count. Use a minus sign to reduce.',
  };

  function applyKind(k) {
    current = k;
    m.querySelectorAll('#kind-tabs button').forEach((b) =>
      b.classList.toggle('active', b.dataset.kind === k));
    m.querySelector('#kind-help').textContent = HELP[k];

    const wrapFrom = m.querySelector('#wrap-from');
    const wrapTo = m.querySelector('#wrap-to');
    const selTo = m.querySelector('#mv-to');

    wrapFrom.classList.toggle('hidden', k === 'receive' || k === 'adjust');
    wrapTo.classList.toggle('hidden', k === 'issue');

    // Transfers may target any location; everything else must be one you can write to.
    selTo.innerHTML = locOpts(k === 'transfer' ? allLocs : writable);
    m.querySelector('#to-label').textContent =
      k === 'adjust' ? 'Location to adjust' : 'To location';
    m.querySelector('#qty-hint').textContent = k === 'adjust' ? 'use − to reduce' : '';
    m.querySelector('#wrap-party').classList.toggle('hidden', k === 'transfer' || k === 'adjust');
  }

  // Some products are measured out in one unit but stocked in another — a
  // fragrance is poured in ML but held in KG. Label the box with the unit the
  // storekeeper actually uses, and show what it becomes in stock as they type.
  function selectedProduct() {
    return S.products.find((p) => String(p.id) === m.querySelector('#mv-product').value);
  }

  function applyProduct() {
    const p = selectedProduct();
    const label = m.querySelector('#qty-label');
    const conv = m.querySelector('#qty-convert');
    if (!p) return;
    const entry = p.entry_unit && p.entry_factor > 0;
    label.textContent = `Quantity (${entry ? p.entry_unit : p.unit})`;
    conv.classList.toggle('hidden', !entry);
    updateConversion();
  }

  function updateConversion() {
    const p = selectedProduct();
    const conv = m.querySelector('#qty-convert');
    if (!p || !p.entry_unit || !(p.entry_factor > 0)) { conv.textContent = ''; return; }
    const typed = Number(m.querySelector('#mv-qty').value);
    conv.textContent = typed
      ? `= ${round4(typed / p.entry_factor)} ${p.unit} in stock`
      : `${p.entry_factor} ${p.entry_unit} = 1 ${p.unit}`;
  }

  m.querySelector('#mv-product').addEventListener('change', applyProduct);
  m.querySelector('#mv-qty').addEventListener('input', updateConversion);

  m.querySelectorAll('#kind-tabs button').forEach((b) =>
    b.addEventListener('click', () => applyKind(b.dataset.kind)));
  applyKind(kind);
  applyProduct();

  m.querySelector('#mv-save').addEventListener('click', async () => {
    const btn = m.querySelector('#mv-save');
    const date = m.querySelector('#mv-date').value;
    const payload = {
      kind: current,
      product_id: m.querySelector('#mv-product').value,
      qty: Number(m.querySelector('#mv-qty').value),
      from_location_id: (current === 'issue' || current === 'transfer')
        ? m.querySelector('#mv-from').value : null,
      to_location_id: (current === 'receive' || current === 'transfer' || current === 'adjust')
        ? m.querySelector('#mv-to').value : null,
      batch_no: m.querySelector('#mv-batch').value,
      expiry: m.querySelector('#mv-expiry').value,
      reference: m.querySelector('#mv-ref').value,
      party: m.querySelector('#mv-party').value,
      note: m.querySelector('#mv-note').value,
      ts: date ? new Date(date + 'T12:00:00').toISOString() : undefined,
    };
    if (!payload.qty) return modalError('Enter a quantity');

    btn.disabled = true;
    try {
      await api('/api/movements', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('Movement recorded', 'success');
      if (onDone) onDone(); else render();
    } catch (ex) {
      modalError(ex.message);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------ batches

async function viewBatches(view) {
  const d = await api('/api/batches');
  const today = todayStr();
  const soon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Batch tracking</h2>
        <p class="page-sub">Remaining quantity per batch — for HACCP and ISO traceability</p></div>
    </div>
    <div class="card"><div class="table-wrap">${
      !d.rows.length
        ? '<div class="empty">No batches yet. Add a batch number when you record a receipt.</div>'
        : `<table>
            <thead><tr><th>Batch</th><th>SKU</th><th>Product</th><th>Location</th>
              <th class="num">Remaining</th><th>Expiry</th><th>Status</th></tr></thead>
            <tbody>${d.rows.map((b) => {
              const state = !b.expiry ? ['muted', 'No expiry']
                : b.expiry < today ? ['low', 'Expired']
                : b.expiry <= soon ? ['adjust', 'Expiring soon'] : ['ok', 'Good'];
              return `<tr>
                <td class="mono">${esc(b.batch_no)}</td>
                <td class="mono">${esc(b.sku)}</td>
                <td class="wrap">${esc(b.name)}</td>
                <td>${esc(b.location_name)}</td>
                <td class="num"><strong>${fmtQty(b.qty)}</strong> <span style="color:var(--muted)">${esc(b.unit)}</span></td>
                <td>${b.expiry ? fmtDate(b.expiry) : '—'}</td>
                <td><span class="pill ${state[0]}">${state[1]}</span></td>
              </tr>`;
            }).join('')}</tbody>
          </table>`
    }</div></div>`;
}

// ------------------------------------------------------------ counts

const COUNT_STATUS = {
  open:      ['transfer', 'Open'],
  submitted: ['adjust', 'Submitted'],
  approved:  ['ok', 'Approved'],
  cancelled: ['muted', 'Cancelled'],
};

function countRoute() {
  const q = location.hash.split('?')[1] || '';
  const id = new URLSearchParams(q).get('id');
  return id ? Number(id) : null;
}

async function viewCounts(view) {
  const id = countRoute();
  if (id) return viewCountDetail(view, id);

  const d = await api('/api/counts');
  const canCreate = writableLocations().length > 0;

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Stock counts</h2>
        <p class="page-sub">Cycle and full physical counts, with variance review before anything posts</p></div>
      <div class="spacer"></div>
      ${canCreate ? '<button class="btn primary" id="new-count">New count</button>' : ''}
    </div>
    <div class="card"><div class="table-wrap">${
      !d.rows.length
        ? '<div class="empty">No counts yet. Start one from a location you have access to.</div>'
        : `<table>
            <thead><tr><th>#</th><th>Location</th><th>Kind</th><th>Status</th>
              <th class="num">Items</th><th class="num">Counted</th><th class="num">Variances</th>
              <th>Started</th><th>By</th></tr></thead>
            <tbody>${d.rows.map((c) => {
              const st = COUNT_STATUS[c.status] || ['muted', c.status];
              return `<tr class="row-link" data-open="${c.id}">
                <td class="mono">#${c.id}</td>
                <td>${esc(c.location_name)}</td>
                <td style="text-transform:capitalize">${esc(c.kind)}</td>
                <td><span class="pill ${st[0]}">${esc(st[1])}</span></td>
                <td class="num">${fmtQty(c.item_count)}</td>
                <td class="num">${fmtQty(c.counted_count)}</td>
                <td class="num">${c.variance_count ? `<span class="pill low">${fmtQty(c.variance_count)}</span>` : '—'}</td>
                <td style="color:var(--muted)">${fmtDateTime(c.created_at)}</td>
                <td style="color:var(--muted)">${esc(c.created_by_name || '—')}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>`
    }</div></div>`;

  view.querySelectorAll('[data-open]').forEach((tr) => tr.addEventListener('click', () => {
    location.hash = '#/counts?id=' + tr.dataset.open;
  }));
  if (canCreate) view.querySelector('#new-count').addEventListener('click', openNewCountModal);
}

async function viewCountDetail(view, id) {
  const d = await api('/api/counts/' + id);
  const c = d.count;
  const canWriteHere = canWrite(c.location_id);
  const canApprove = (S.user.role === 'admin' || S.user.role === 'manager') && canWriteHere;
  const st = COUNT_STATUS[c.status] || ['muted', c.status];
  const pendingCount = d.items.filter((i) => i.counted_qty == null).length;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <p class="page-sub" style="margin-bottom:4px"><a href="#/counts">← All counts</a></p>
        <h2>Count #${c.id} <span class="pill ${st[0]}" style="vertical-align:middle">${esc(st[1])}</span></h2>
        <p class="page-sub">${esc(c.location_name)} · ${esc(c.kind)} count · started by ${esc(c.created_by_name || '—')} on ${fmtDateTime(c.created_at)}</p>
      </div>
      <div class="spacer"></div>
      ${c.status === 'open' && canWriteHere ? `
        <button class="btn danger" id="cnt-cancel">Cancel</button>
        <button class="btn primary" id="cnt-submit">Submit for review${pendingCount ? ` (${pendingCount} left)` : ''}</button>` : ''}
      ${c.status === 'submitted' && canApprove ? `
        <button class="btn danger" id="cnt-cancel">Reject / cancel</button>
        <button class="btn primary" id="cnt-approve">Approve &amp; post adjustments</button>` : ''}
    </div>

    ${c.note ? `<div class="card" style="margin-bottom:16px"><div class="card-body">${esc(c.note)}</div></div>` : ''}
    ${c.status === 'approved' ? `<div class="card" style="margin-bottom:16px"><div class="card-body">
        Approved by ${esc(c.reviewed_by_name || '—')} on ${fmtDateTime(c.reviewed_at)}.
        ${c.review_note ? esc(c.review_note) : ''}</div></div>` : ''}

    <div class="card"><div class="table-wrap">
      <table>
        <thead><tr><th>SKU</th><th>Product</th><th class="num">System qty</th>
          <th class="num">Counted qty</th><th class="num">Variance</th><th>By</th></tr></thead>
        <tbody>${d.items.map((i) => {
          const has = i.counted_qty != null;
          const variance = has ? i.counted_qty - i.system_qty : null;
          const editable = c.status === 'open' && canWriteHere;
          return `<tr>
            <td class="mono">${esc(i.sku)}</td>
            <td class="wrap">${esc(i.product_name)}</td>
            <td class="num">${fmtQty(i.system_qty)} <span style="color:var(--muted)">${esc(i.unit)}</span></td>
            <td class="num">${editable
              ? `<input type="number" step="any" min="0" class="cnt-input" data-item="${i.id}"
                   style="width:100px;text-align:right" value="${has ? i.counted_qty : ''}" placeholder="—">`
              : (has ? `${fmtQty(i.counted_qty)} ${esc(i.unit)}` : '<span style="color:var(--muted)">—</span>')}</td>
            <td class="num">${has
              ? (Math.abs(variance) > 0.0001
                  ? `<span class="pill low">${variance > 0 ? '+' : ''}${fmtQty(variance)}</span>`
                  : '<span class="pill ok">0</span>')
              : '—'}</td>
            <td style="color:var(--muted)">${esc(i.counted_by_name || '')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div></div>`;

  view.querySelectorAll('.cnt-input').forEach((inp) => {
    let timer;
    const save = async () => {
      const val = inp.value.trim();
      try {
        await api(`/api/counts/${c.id}/items/${inp.dataset.item}`, {
          method: 'PUT',
          body: JSON.stringify({ counted_qty: val === '' ? null : Number(val) }),
        });
      } catch (ex) { toast(ex.message, 'error'); }
    };
    inp.addEventListener('change', () => { clearTimeout(timer); save(); });
  });

  const cancelBtn = view.querySelector('#cnt-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!confirm('Cancel this count? Nothing has been posted to stock yet, so nothing needs to be undone.')) return;
    try {
      await api(`/api/counts/${c.id}/cancel`, { method: 'POST' });
      toast('Count cancelled', 'success');
      render();
    } catch (ex) { toast(ex.message, 'error'); }
  });

  const submitBtn = view.querySelector('#cnt-submit');
  if (submitBtn) submitBtn.addEventListener('click', async () => {
    try {
      await api(`/api/counts/${c.id}/submit`, { method: 'POST' });
      toast('Submitted for review', 'success');
      render();
    } catch (ex) { toast(ex.message, 'error'); }
  });

  const approveBtn = view.querySelector('#cnt-approve');
  if (approveBtn) approveBtn.addEventListener('click', () => openApproveModal(c));
}

function openApproveModal(c) {
  const m = openModal('Approve count #' + c.id, `
    <p class="page-sub" style="margin-bottom:14px">
      Any counted item that differs from the current stock balance will post an adjustment
      the moment you approve. This cannot be undone from here — an administrator can still
      delete an individual movement afterwards if needed.
    </p>
    <label>Review note <span class="hint">optional</span>
      <textarea id="ap-note" rows="2"></textarea></label>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="ap-save">Approve &amp; post</button>`);

  m.querySelector('#ap-save').addEventListener('click', async () => {
    const btn = m.querySelector('#ap-save');
    btn.disabled = true;
    try {
      const r = await api(`/api/counts/${c.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ note: m.querySelector('#ap-note').value }),
      });
      closeModal();
      toast(`Approved — ${r.adjustments} adjustment${r.adjustments === 1 ? '' : 's'} posted`, 'success');
      render();
    } catch (ex) {
      modalError(ex.message);
      btn.disabled = false;
    }
  });
}

function openNewCountModal() {
  const locs = writableLocations();
  if (!locs.length) return toast('You are not assigned to a location yet', 'error');
  if (!S.products.length) return toast('Add a product first', 'error');

  const m = openModal('New stock count', `
    <div class="form-grid">
      <label>Location
        <select id="nc-loc">${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
      <label>Type
        <select id="nc-kind">
          <option value="cycle">Cycle count — pick specific products</option>
          <option value="full">Full count — every active product</option>
        </select></label>
      <label class="full">Note <span class="hint">optional</span>
        <input id="nc-note" placeholder="e.g. Monthly cycle count — chemicals aisle"></label>
    </div>
    <div id="nc-picker" style="margin-top:14px">
      <input id="nc-search" placeholder="Search products to add…" style="width:100%;margin-bottom:8px">
      <div id="nc-list" style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px"></div>
      <p class="hint" id="nc-count-label" style="margin-top:6px"></p>
    </div>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="nc-save">Start count</button>`);

  const picker = m.querySelector('#nc-picker');
  const list = m.querySelector('#nc-list');
  const countLabel = m.querySelector('#nc-count-label');
  const selected = new Set();

  const drawList = () => {
    const q = m.querySelector('#nc-search').value.toLowerCase();
    const rows = S.products.filter((p) =>
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    list.innerHTML = rows.length
      ? rows.map((p) => `
          <label class="checkline" style="padding:4px 0">
            <input type="checkbox" data-pid="${p.id}" ${selected.has(p.id) ? 'checked' : ''}>
            <span class="mono" style="color:var(--muted)">${esc(p.sku)}</span> ${esc(p.name)}
          </label>`).join('')
      : '<div class="empty">No products match.</div>';
    list.querySelectorAll('[data-pid]').forEach((cb) => cb.addEventListener('change', () => {
      const pid = Number(cb.dataset.pid);
      if (cb.checked) selected.add(pid); else selected.delete(pid);
      countLabel.textContent = `${selected.size} product${selected.size === 1 ? '' : 's'} selected`;
    }));
    countLabel.textContent = `${selected.size} product${selected.size === 1 ? '' : 's'} selected`;
  };

  const syncKind = () => {
    const isFull = m.querySelector('#nc-kind').value === 'full';
    picker.classList.toggle('hidden', isFull);
  };
  m.querySelector('#nc-kind').addEventListener('change', syncKind);
  m.querySelector('#nc-search').addEventListener('input', drawList);
  syncKind();
  drawList();

  m.querySelector('#nc-save').addEventListener('click', async () => {
    const btn = m.querySelector('#nc-save');
    const kind = m.querySelector('#nc-kind').value;
    const body = {
      location_id: m.querySelector('#nc-loc').value,
      kind,
      note: m.querySelector('#nc-note').value,
    };
    if (kind === 'cycle') {
      if (!selected.size) return modalError('Select at least one product to count');
      body.product_ids = [...selected];
    }
    btn.disabled = true;
    try {
      const r = await api('/api/counts', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      toast('Count started', 'success');
      location.hash = '#/counts?id=' + r.id;
    } catch (ex) {
      modalError(ex.message);
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------ consumption

function periodLabel(period, granularity) {
  if (granularity === 'month') {
    const [y, m] = period.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }
  return fmtDate(period);
}

function consumptionDefaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 11);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

async function viewConsumption(view) {
  const locs = viewableLocations();

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Consumption</h2>
        <p class="page-sub">Stock issued to customers or used up — by day or by month, per product or across everything</p></div>
      <div class="spacer"></div>
      <button class="btn" id="dl-pdf">Download PDF</button>
    </div>
    <div class="toolbar">
      <select id="f-product" style="min-width:220px">
        <option value="all">All products</option>
        ${S.products.map((p) => `<option value="${p.id}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}
      </select>
      <select id="f-loc">
        <option value="all">All my locations</option>
        ${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
      </select>
      <div class="tabs" id="gran-tabs" style="border-bottom:none;margin:0">
        <button data-gran="day" class="active">Daily</button>
        <button data-gran="month">Monthly</button>
      </div>
      <label class="checkline">From <input type="date" id="f-from" value="${consumptionDefaultFrom()}"></label>
      <label class="checkline">To <input type="date" id="f-to" value="${todayStr()}"></label>
    </div>
    <div id="cons-summary" class="grid stats" style="margin-bottom:16px"></div>
    <div id="cons-body"></div>`;

  let granularity = 'day';
  let lastData = null;

  const load = async () => {
    const params = new URLSearchParams({
      product: view.querySelector('#f-product').value,
      location: view.querySelector('#f-loc').value,
      granularity,
      from: view.querySelector('#f-from').value,
      to: view.querySelector('#f-to').value,
    });
    const summary = view.querySelector('#cons-summary');
    const body = view.querySelector('#cons-body');
    summary.innerHTML = '<div class="empty">Loading…</div>';
    body.innerHTML = '';

    let d;
    try {
      d = await api('/api/consumption?' + params);
    } catch (ex) {
      summary.innerHTML = '';
      body.innerHTML = `<div class="card"><div class="empty">${esc(ex.message)}</div></div>`;
      return;
    }
    lastData = d;

    const isSingle = !!d.product;
    summary.innerHTML = `
      <div class="card stat"><div class="label">Total value</div>
        <div class="value">${esc(fmtMoney(d.grand_total.value))}</div>
        <div class="foot">${fmtDate(d.from)} – ${fmtDate(d.to)}</div></div>
      <div class="card stat"><div class="label">Movements</div>
        <div class="value">${fmtQty(d.grand_total.movements)}</div>
        <div class="foot">issue movements in range</div></div>
      ${isSingle ? `
        <div class="card stat"><div class="label">Total quantity</div>
          <div class="value">${fmtQty(d.totals[0] ? d.totals[0].qty : 0)}</div>
          <div class="foot">${esc(d.product.unit)}</div></div>
        <div class="card stat"><div class="label">Product</div>
          <div class="value" style="font-size:16px">${esc(d.product.sku)}</div>
          <div class="foot">${esc(d.product.name)}</div></div>`
      : `
        <div class="card stat"><div class="label">Products with activity</div>
          <div class="value">${fmtQty(d.totals.length)}</div>
          <div class="foot">of ${fmtQty(S.products.length)} total</div></div>`}
    `;

    if (!d.rows.length) {
      body.innerHTML = '<div class="card"><div class="empty">No consumption recorded in this range.</div></div>';
      return;
    }

    if (isSingle) {
      body.innerHTML = `
        <div class="card"><div class="table-wrap">
          <table>
            <thead><tr><th>${granularity === 'month' ? 'Month' : 'Date'}</th>
              <th class="num">Qty</th><th class="num">Value</th><th class="num">Movements</th></tr></thead>
            <tbody>${d.rows.map((r) => `
              <tr><td>${esc(periodLabel(r.period, granularity))}</td>
                <td class="num">${fmtQty(r.qty)} ${esc(r.unit)}</td>
                <td class="num">${esc(fmtMoney(r.value))}</td>
                <td class="num">${fmtQty(r.movements)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div></div>`;
    } else {
      body.innerHTML = `
        <div class="card" style="margin-bottom:16px"><div class="card-head">Totals by product</div>
          <div class="table-wrap"><table>
            <thead><tr><th>SKU</th><th>Product</th><th class="num">Qty</th>
              <th class="num">Value</th><th class="num">Movements</th></tr></thead>
            <tbody>${d.totals.map((t) => `
              <tr><td class="mono">${esc(t.sku)}</td><td class="wrap">${esc(t.name)}</td>
                <td class="num">${fmtQty(t.qty)} ${esc(t.unit)}</td>
                <td class="num">${esc(fmtMoney(t.value))}</td>
                <td class="num">${fmtQty(t.movements)}</td></tr>`).join('')}
            </tbody>
          </table></div>
        </div>
        <div class="card"><div class="card-head">Detailed breakdown</div>
          <div class="table-wrap"><table>
            <thead><tr><th>SKU</th><th>Product</th><th>${granularity === 'month' ? 'Month' : 'Date'}</th>
              <th class="num">Qty</th><th class="num">Value</th></tr></thead>
            <tbody>${d.rows.map((r) => `
              <tr><td class="mono">${esc(r.sku)}</td><td class="wrap">${esc(r.name)}</td>
                <td>${esc(periodLabel(r.period, granularity))}</td>
                <td class="num">${fmtQty(r.qty)} ${esc(r.unit)}</td>
                <td class="num">${esc(fmtMoney(r.value))}</td></tr>`).join('')}
            </tbody>
          </table></div>
        </div>`;
    }
  };

  view.querySelector('#f-product').addEventListener('change', load);
  view.querySelector('#f-loc').addEventListener('change', load);
  view.querySelector('#f-from').addEventListener('change', load);
  view.querySelector('#f-to').addEventListener('change', load);
  view.querySelectorAll('#gran-tabs button').forEach((b) => b.addEventListener('click', () => {
    granularity = b.dataset.gran;
    view.querySelectorAll('#gran-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    load();
  }));

  view.querySelector('#dl-pdf').addEventListener('click', () => exportConsumptionPdf(lastData, granularity));

  await load();
}

function exportConsumptionPdf(d, granularity) {
  if (!d) return toast('Nothing to export yet', 'error');
  if (!window.jspdf) return toast('PDF library did not load — check your connection', 'error');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const isSingle = !!d.product;
  const title = isSingle ? `Consumption — ${d.product.sku} ${d.product.name}` : 'Consumption — All products';

  doc.setFontSize(14);
  doc.text('A.N Traders', 14, 16);
  doc.setFontSize(11);
  doc.text(title, 14, 24);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `${fmtDate(d.from)} to ${fmtDate(d.to)}  ·  ${granularity === 'month' ? 'Monthly' : 'Daily'}  ·  Generated ${fmtDateTime(new Date().toISOString())}`,
    14, 30
  );
  doc.setTextColor(0);

  let y = 36;
  if (!isSingle) {
    doc.autoTable({
      startY: y,
      head: [['SKU', 'Product', 'Qty', 'Value', 'Movements']],
      body: d.totals.map((t) => [t.sku, t.name, `${fmtQty(t.qty)} ${t.unit}`, fmtMoney(t.value), String(t.movements)]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [15, 92, 74] },
    });
    y = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(10);
    doc.text('Detailed breakdown', 14, y);
    y += 4;
  }

  doc.autoTable({
    startY: y,
    head: isSingle
      ? [[granularity === 'month' ? 'Month' : 'Date', 'Qty', 'Value', 'Movements']]
      : [['SKU', 'Product', granularity === 'month' ? 'Month' : 'Date', 'Qty', 'Value']],
    body: isSingle
      ? d.rows.map((r) => [periodLabel(r.period, granularity), `${fmtQty(r.qty)} ${r.unit}`, fmtMoney(r.value), String(r.movements)])
      : d.rows.map((r) => [r.sku, r.name, periodLabel(r.period, granularity), `${fmtQty(r.qty)} ${r.unit}`, fmtMoney(r.value)]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [15, 92, 74] },
  });

  const fname = `consumption-${isSingle ? d.product.sku : 'all-products'}-${d.from}_to_${d.to}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-');
  doc.save(fname);
}

// ------------------------------------------------------------ products

async function viewProducts(view) {
  await refreshProducts();
  const canEdit = S.user.role === 'admin' || S.user.role === 'manager';

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Products</h2>
        <p class="page-sub">${S.products.length} active items in the catalogue</p></div>
      <div class="spacer"></div>
      ${canEdit ? `
        <button class="btn" id="import-btn">Import CSV</button>
        <button class="btn primary" id="new-product">New product</button>` : ''}
    </div>
    <div class="toolbar"><input id="p-search" placeholder="Search…" style="min-width:240px"></div>
    <div class="card"><div class="table-wrap" id="p-table"></div></div>`;

  const draw = () => {
    const q = view.querySelector('#p-search').value.toLowerCase();
    const rows = S.products.filter((p) =>
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    const box = view.querySelector('#p-table');
    if (!rows.length) {
      box.innerHTML = '<div class="empty">No products yet. Use “New product” or import a CSV list.</div>';
      return;
    }
    box.innerHTML = `
      <table>
        <thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Unit</th><th>Pack</th>
          <th class="num">Reorder</th><th class="num">Cost</th><th class="num">Sale</th>
          ${canEdit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((p) => `
          <tr>
            <td class="mono">${esc(p.sku)}</td>
            <td class="wrap">${esc(p.name)}</td>
            <td style="color:var(--muted)">${esc(p.category || '—')}</td>
            <td>${esc(p.unit)}${p.entry_unit && p.entry_factor > 0
              ? `<div class="hint">entered in ${esc(p.entry_unit)}</div>` : ''}</td>
            <td>${esc(p.pack_size || '—')}</td>
            <td class="num">${p.reorder_level ? fmtQty(p.reorder_level) : '—'}</td>
            <td class="num">${esc(fmtMoney(p.cost_price))}</td>
            <td class="num">${esc(fmtMoney(p.sale_price))}</td>
            ${canEdit ? `<td><button class="btn small" data-edit="${p.id}">Edit</button></td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>`;
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
      openProductModal(S.products.find((p) => p.id === Number(b.dataset.edit)))));
  };

  view.querySelector('#p-search').addEventListener('input', draw);
  if (canEdit) {
    view.querySelector('#new-product').addEventListener('click', () => openProductModal(null));
    view.querySelector('#import-btn').addEventListener('click', openImportModal);
  }
  draw();
}

function openProductModal(p) {
  const isNew = !p;
  const m = openModal(isNew ? 'New product' : 'Edit product', `
    <div class="form-grid">
      <label>SKU <span class="hint">unique code</span>
        <input id="p-sku" value="${esc(p?.sku || '')}" placeholder="ZEP-DW-05"></label>
      <label>Category
        <select id="p-cat">
          <option value="">— none —</option>
          ${S.categories.map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
      <label class="full">Product name
        <input id="p-name" value="${esc(p?.name || '')}" placeholder="ZEEPER Dish Wash Liquid"></label>
      <label>Unit
        <input id="p-unit" value="${esc(p?.unit || 'Litre')}" list="units" placeholder="Litre">
        <datalist id="units">
          <option>Litre</option><option>Kg</option><option>Piece</option>
          <option>Can</option><option>Drum</option><option>Carton</option><option>Bag</option>
        </datalist></label>
      <label>Pack size <span class="hint">optional</span>
        <input id="p-pack" value="${esc(p?.pack_size || '')}" placeholder="5 L Can"></label>

      <label>Record movements in <span class="hint">leave blank to use the stock unit</span>
        <input id="p-entry-unit" value="${esc(p?.entry_unit || '')}" list="entry-units" placeholder="e.g. ML">
        <datalist id="entry-units">
          <option>ML</option><option>Gram</option><option>Piece</option>
        </datalist></label>
      <label>…that equal one stock unit <span class="hint">1000 ML = 1 Kg at density 1.0</span>
        <input type="number" id="p-entry-factor" step="any" min="0"
               value="${p?.entry_factor || ''}" placeholder="1000"></label>
      <label>Reorder level
        <input type="number" id="p-reorder" step="any" value="${Number(p?.reorder_level || 0)}"></label>
      <label>Cost price <span class="hint">Rs per unit</span>
        <input type="number" id="p-cost" step="any" value="${Number(p?.cost_price || 0)}"></label>
      <label>Sale price <span class="hint">Rs per unit</span>
        <input type="number" id="p-sale" step="any" value="${Number(p?.sale_price || 0)}"></label>
      <label class="full">Notes <span class="hint">optional</span>
        <textarea id="p-notes" rows="2">${esc(p?.notes || '')}</textarea></label>
      ${isNew ? '' : `<label class="full checkline" style="display:flex">
        <input type="checkbox" id="p-active" ${p.active ? 'checked' : ''}> Active (uncheck to hide from lists)</label>`}
    </div>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="p-save">${isNew ? 'Create product' : 'Save changes'}</button>`);

  m.querySelector('#p-save').addEventListener('click', async () => {
    const body = {
      sku: m.querySelector('#p-sku').value,
      name: m.querySelector('#p-name').value,
      category_id: m.querySelector('#p-cat').value || null,
      unit: m.querySelector('#p-unit').value,
      entry_unit: m.querySelector('#p-entry-unit').value,
      entry_factor: m.querySelector('#p-entry-factor').value,
      pack_size: m.querySelector('#p-pack').value,
      reorder_level: m.querySelector('#p-reorder').value,
      cost_price: m.querySelector('#p-cost').value,
      sale_price: m.querySelector('#p-sale').value,
      track_batch: true,
      notes: m.querySelector('#p-notes').value,
      active: isNew ? true : m.querySelector('#p-active').checked,
    };
    try {
      await api(isNew ? '/api/products' : '/api/products/' + p.id, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      });
      closeModal();
      toast(isNew ? 'Product created' : 'Product updated', 'success');
      render();
    } catch (ex) { modalError(ex.message); }
  });
}

function openImportModal() {
  const m = openModal('Import products from CSV', `
    <p class="page-sub" style="margin-bottom:14px">
      Paste your list below, or choose a .csv file. The first row must be column names.
      Required: <strong>sku</strong> and <strong>name</strong>.
      Optional: category, unit, pack_size, reorder_level, cost_price, sale_price.
      Existing SKUs are updated rather than duplicated.
    </p>
    <div class="grid" style="gap:12px">
      <div><button class="btn small" id="dl-template">Download template</button></div>
      <label>Choose a file<input type="file" id="csv-file" accept=".csv,text/csv"></label>
      <label>…or paste CSV
        <textarea id="csv-text" rows="9" style="font-family:var(--mono);font-size:12.5px"
          placeholder="sku,name,category,unit,pack_size,reorder_level,cost_price,sale_price"></textarea></label>
    </div>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="csv-run">Import</button>`);

  m.querySelector('#dl-template').addEventListener('click', () => {
    window.location.href = '/api/export/products-template.csv';
  });
  m.querySelector('#csv-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((t) => { m.querySelector('#csv-text').value = t; });
  });
  m.querySelector('#csv-run').addEventListener('click', async () => {
    const csv = m.querySelector('#csv-text').value.trim();
    if (!csv) return modalError('Paste some CSV or choose a file first');
    try {
      const r = await api('/api/products/import', { method: 'POST', body: JSON.stringify({ csv }) });
      closeModal();
      toast(`${r.created} added, ${r.updated} updated` +
        (r.errors.length ? `, ${r.errors.length} skipped` : ''), r.errors.length ? '' : 'success');
      if (r.errors.length) console.warn('Import issues:', r.errors);
      render();
    } catch (ex) { modalError(ex.message); }
  });
}

// ------------------------------------------------------------ locations

async function viewLocations(view) {
  const d = await api('/api/locations');
  S.locations = d.rows;

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Locations</h2>
        <p class="page-sub">Warehouses, plants and offices holding stock</p></div>
      <div class="spacer"></div>
      <button class="btn primary" id="new-loc">New location</button>
    </div>
    <div class="card"><div class="table-wrap">
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>City</th><th>Type</th><th>Address</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.rows.map((l) => `
          <tr>
            <td class="mono">${esc(l.code)}</td>
            <td>${esc(l.name)}</td>
            <td>${esc(l.city || '—')}</td>
            <td style="text-transform:capitalize">${esc(l.kind)}</td>
            <td class="wrap" style="color:var(--muted)">${esc(l.address || '—')}</td>
            <td>${l.active ? '<span class="pill ok">Active</span>' : '<span class="pill muted">Inactive</span>'}</td>
            <td><button class="btn small" data-edit="${l.id}">Edit</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div></div>`;

  view.querySelector('#new-loc').addEventListener('click', () => openLocationModal(null));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
    openLocationModal(d.rows.find((l) => l.id === Number(b.dataset.edit)))));
}

function openLocationModal(l) {
  const isNew = !l;
  const kinds = ['warehouse', 'plant', 'office', 'vehicle'];
  const m = openModal(isNew ? 'New location' : 'Edit location', `
    <div class="form-grid">
      <label>Code <span class="hint">short, unique</span>
        <input id="l-code" value="${esc(l?.code || '')}" placeholder="KHI-WH"></label>
      <label>City<input id="l-city" value="${esc(l?.city || '')}" placeholder="Karachi"></label>
      <label class="full">Name
        <input id="l-name" value="${esc(l?.name || '')}" placeholder="Karachi Warehouse"></label>
      <label>Type
        <select id="l-kind">${kinds.map((k) =>
          `<option value="${k}" ${l?.kind === k ? 'selected' : ''} style="text-transform:capitalize">${k}</option>`).join('')}
        </select></label>
      ${isNew ? '<div></div>' : `<label class="checkline" style="display:flex;align-items:end;gap:8px">
        <input type="checkbox" id="l-active" ${l.active ? 'checked' : ''}> Active</label>`}
      <label class="full">Address <span class="hint">optional</span>
        <textarea id="l-address" rows="2">${esc(l?.address || '')}</textarea></label>
    </div>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="l-save">${isNew ? 'Create' : 'Save changes'}</button>`);

  m.querySelector('#l-save').addEventListener('click', async () => {
    const body = {
      code: m.querySelector('#l-code').value,
      name: m.querySelector('#l-name').value,
      city: m.querySelector('#l-city').value,
      kind: m.querySelector('#l-kind').value,
      address: m.querySelector('#l-address').value,
      active: isNew ? true : m.querySelector('#l-active').checked,
    };
    try {
      await api(isNew ? '/api/locations' : '/api/locations/' + l.id, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      });
      closeModal();
      toast(isNew ? 'Location created' : 'Location updated', 'success');
      const b = await api('/api/bootstrap');
      S.locations = b.locations;
      S.visibleLocations = b.visible_location_ids;
      render();
    } catch (ex) { modalError(ex.message); }
  });
}

// ------------------------------------------------------------ users

async function viewUsers(view) {
  const d = await api('/api/users');
  const roleLabel = { admin: 'Administrator', manager: 'Manager', staff: 'Staff' };

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Users</h2>
        <p class="page-sub">Staff at each location get their own login</p></div>
      <div class="spacer"></div>
      <button class="btn primary" id="new-user">New user</button>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-body" style="color:var(--muted);font-size:13px">
      <strong style="color:var(--ink)">Administrator</strong> — full access, manages users and locations.
      &nbsp;·&nbsp; <strong style="color:var(--ink)">Manager</strong> — sees all locations, records movements at their own,
      manages the product catalogue.
      &nbsp;·&nbsp; <strong style="color:var(--ink)">Staff</strong> — sees and records only at their own location.
    </div></div>
    <div class="card"><div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Location</th><th>Status</th><th></th></tr></thead>
        <tbody>${d.rows.map((u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td class="mono">${esc(u.username)}</td>
            <td>${esc(roleLabel[u.role] || u.role)}</td>
            <td>${esc(u.location_name || 'All')}</td>
            <td>${u.active ? '<span class="pill ok">Active</span>' : '<span class="pill muted">Disabled</span>'}</td>
            <td><button class="btn small" data-edit="${u.id}">Edit</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div></div>`;

  view.querySelector('#new-user').addEventListener('click', () => openUserModal(null));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
    openUserModal(d.rows.find((u) => u.id === Number(b.dataset.edit)))));
}

function openUserModal(u) {
  const isNew = !u;
  const roles = [['staff', 'Staff'], ['manager', 'Manager'], ['admin', 'Administrator']];
  const m = openModal(isNew ? 'New user' : 'Edit user', `
    <div class="form-grid">
      <label>Full name<input id="u-name" value="${esc(u?.name || '')}"></label>
      <label>Username <span class="hint">${isNew ? 'no spaces' : 'cannot be changed'}</span>
        <input id="u-username" value="${esc(u?.username || '')}" ${isNew ? '' : 'disabled'}></label>
      <label>Role
        <select id="u-role">${roles.map(([v, t]) =>
          `<option value="${v}" ${u?.role === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></label>
      <label>Location
        <select id="u-loc">
          <option value="">— all locations —</option>
          ${S.locations.filter((l) => l.active).map((l) =>
            `<option value="${l.id}" ${u?.location_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select></label>
      <label class="full">${isNew ? 'Password' : 'New password'}
        <span class="hint">${isNew ? 'at least 6 characters' : 'leave blank to keep current'}</span>
        <input type="password" id="u-pass" autocomplete="new-password"></label>
      ${isNew ? '' : `<label class="full checkline" style="display:flex">
        <input type="checkbox" id="u-active" ${u.active ? 'checked' : ''}> Active (uncheck to block sign-in)</label>`}
    </div>`,
    `<button class="btn" data-close>Cancel</button>
     <button class="btn primary" id="u-save">${isNew ? 'Create user' : 'Save changes'}</button>`);

  const syncLoc = () => {
    const isAdmin = m.querySelector('#u-role').value === 'admin';
    m.querySelector('#u-loc').disabled = isAdmin;
    if (isAdmin) m.querySelector('#u-loc').value = '';
  };
  m.querySelector('#u-role').addEventListener('change', syncLoc);
  syncLoc();

  m.querySelector('#u-save').addEventListener('click', async () => {
    const body = {
      name: m.querySelector('#u-name').value,
      username: m.querySelector('#u-username').value,
      role: m.querySelector('#u-role').value,
      location_id: m.querySelector('#u-loc').value || null,
      password: m.querySelector('#u-pass').value || undefined,
      active: isNew ? true : m.querySelector('#u-active').checked,
    };
    try {
      await api(isNew ? '/api/users' : '/api/users/' + u.id, {
        method: isNew ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      });
      closeModal();
      toast(isNew ? 'User created' : 'User updated', 'success');
      render();
    } catch (ex) { modalError(ex.message); }
  });
}

// ------------------------------------------------------------ permissions

const MODULE_LABEL = {
  dashboard: 'Dashboard', stock: 'Stock', movements: 'Movements',
  batches: 'Batches', counts: 'Stock counts', products: 'Products',
  consumption: 'Consumption',
};

async function viewPermissions(view) {
  const d = await api('/api/permissions');
  const cell = (role, module) => d.matrix[role][module];

  view.innerHTML = `
    <div class="page-head">
      <div><h2>Permissions</h2>
        <p class="page-sub">Choose which sections Managers and Staff can see. Administrators always see everything.</p></div>
    </div>
    <div class="card"><div class="table-wrap">
      <table>
        <thead><tr><th>Section</th><th class="num">Manager</th><th class="num">Staff</th></tr></thead>
        <tbody>${d.modules.map((m) => `
          <tr>
            <td>${esc(MODULE_LABEL[m] || m)}</td>
            ${d.roles.map((r) => `
              <td class="num"><input type="checkbox" data-role="${r}" data-module="${m}" ${cell(r, m) ? 'checked' : ''}></td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div></div>
    <div class="page-head" style="margin-top:16px">
      <div class="spacer"></div>
      <button class="btn primary" id="perm-save">Save changes</button>
    </div>`;

  view.querySelector('#perm-save').addEventListener('click', async () => {
    const btn = view.querySelector('#perm-save');
    const rows = Array.from(view.querySelectorAll('input[data-role]')).map((cb) => ({
      role: cb.dataset.role,
      module: cb.dataset.module,
      allowed: cb.checked,
    }));
    btn.disabled = true;
    try {
      const r = await api('/api/permissions', { method: 'PUT', body: JSON.stringify({ rows }) });
      S.permissions = r.matrix;
      syncNav();
      toast('Permissions updated', 'success');
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------ start

boot().catch(() => showLogin());
