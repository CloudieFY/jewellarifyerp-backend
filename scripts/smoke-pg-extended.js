/*
 * Smoke test for the PG ports of `inventory-extended` and `superAdmin`.
 *
 * Mints a tenant JWT (owner of the DEMO shop) and a super-admin JWT with the
 * app's own signing secrets — no credential extraction. Runs create/list/get/
 * update/delete against the PG test server and cleans everything up.
 *
 *   node scripts/smoke-pg-extended.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.SMOKE_BASE || 'http://localhost:' + (process.env.PG_PORT || 3019);
const SHOP_ID = '6a718b3b4dc2277b0539b1e0'; // DEMO JEWELLERS
const USER_ID = '6a718b3b4dc2277b0539b1e4'; // demog (owner)

const tenantToken = jwt.sign(
  { sub: USER_ID, shopId: SHOP_ID, username: 'demog', role: 'owner', type: 'tenant' },
  process.env.JWT_TENANT_SECRET,
  { expiresIn: '1h' }
);
const adminToken = jwt.sign(
  { sub: 'smoke-admin', username: 'smoke-admin', type: 'superadmin' },
  process.env.JWT_SECRET || process.env.JWT_SUPERADMIN_SECRET,
  { expiresIn: '1h' }
);

let pass = 0,
  fail = 0;
const results = [];

async function api(method, path, body, token = tenantToken) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

function check(name, cond, detail) {
  if (cond) {
    pass++;
    results.push(`  ✓ ${name}`);
  } else {
    fail++;
    results.push(`  ✗ ${name}  ${detail ? JSON.stringify(detail).slice(0, 400) : ''}`);
  }
}

async function masterCrud(label, path, createBody, patchBody) {
  results.push(`\n== ${label} (${path}) ==`);
  const list0 = await api('GET', path);
  check(`${label} list`, list0.status === 200 && Array.isArray(list0.json), list0);
  const created = await api('POST', path, createBody);
  check(`${label} create`, created.status === 201 && (created.json.id || created.json._id), created);
  if (created.status !== 201) return;
  const id = created.json.id || created.json._id;
  const got = await api('GET', `${path}/${id}`);
  check(`${label} get by id`, got.status === 200 && (got.json.id === id || got.json._id === id), got);
  const upd = await api('PUT', `${path}/${id}`, { ...createBody, ...patchBody });
  const key = Object.keys(patchBody)[0];
  check(`${label} update (${key})`, upd.status === 200 && JSON.stringify(upd.json[key]) === JSON.stringify(patchBody[key]), upd);
  const del = await api('DELETE', `${path}/${id}`);
  check(`${label} delete`, del.status === 200, del);
  const gone = await api('GET', `${path}/${id}`);
  check(`${label} get after delete = 404`, gone.status === 404, gone);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const health = await api('GET', '/health', null, null);
  check('health', health.status === 200 && health.json.db === 'postgres', health);

  /* ---------------- inventory-extended: masters ---------------- */
  const EX = '/api/inventory-extended';
  await masterCrud('categories', `${EX}/categories`,
    { code: 'SMK-CAT', name: 'Smoke Category', description: 'x' }, { name: 'Smoke Category 2' });
  await masterCrud('brands', `${EX}/brands`,
    { code: 'SMK-BR', name: 'Smoke Brand' }, { description: 'branded' });
  await masterCrud('purities', `${EX}/purities`,
    { name: 'SMK-22K', metalType: 'Gold', purityPercentage: 91.6 }, { purityPercentage: 92 });
  await masterCrud('hsn', `${EX}/hsn`,
    { hsnCode: 'SMK-7113', gstPct: 3, description: 'jewellery' }, { gstPct: 5 });

  /* ---------------- inventory-extended: stock movements ---------------- */
  results.push(`\n== stock movements (${EX}) ==`);
  // dedicated throwaway inventory item so we never disturb real DEMO stock
  const invCreate = await api('POST', '/api/inventory', {
    name: 'SMOKE EXT ITEM', itemCode: 'SMK-EXT-1', category: 'SmokeCat', purity: '22K',
    stock: 10, grossWeight: 100, netWeight: 95, costPrice: 5000, reorderLevel: 2,
  });
  check('inventory item create', invCreate.status === 201 && (invCreate.json.id || invCreate.json._id), invCreate);
  const itemId = invCreate.json && (invCreate.json.id || invCreate.json._id);

  if (itemId) {
    const adj = await api('POST', `${EX}/adjustments`, {
      itemId, type: 'INCREASE', qty: 3, grossWeight: 30, netWeight: 28, reason: 'smoke count',
    });
    check('adjustment INCREASE', adj.status === 201 && adj.json.item && Number(adj.json.item.stock) === 13, { got: adj.json && adj.json.item && adj.json.item.stock });
    check('adjustment persisted', adj.json && adj.json.adjustment && /^ADJ-/.test(adj.json.adjustment.adjustmentNo || ''), adj.json && adj.json.adjustment);

    const adjList = await api('GET', `${EX}/adjustments`);
    check('adjustments list', adjList.status === 200 && Array.isArray(adjList.json) && adjList.json.some((a) => a.itemId === String(itemId)), adjList.status);

    const adj2 = await api('POST', `${EX}/adjustments`, { itemId, type: 'DECREASE', qty: 3, grossWeight: 30, netWeight: 28, reason: 'smoke restore' });
    check('adjustment DECREASE restores stock', adj2.status === 201 && Number(adj2.json.item.stock) === 10, { got: adj2.json && adj2.json.item && adj2.json.item.stock });

    const trf = await api('POST', `${EX}/transfers`, {
      itemId, fromBranch: 'Main Store', toBranch: 'Branch B', toGodown: 'G2', qty: 1, remarks: 'smoke',
    });
    check('transfer create', trf.status === 201 && /^TRF-/.test(trf.json.transfer.transferNo || '') && trf.json.item.branch === 'Branch B', trf.json && trf.json.transfer);

    const trfList = await api('GET', `${EX}/transfers`);
    check('transfers list', trfList.status === 200 && Array.isArray(trfList.json), trfList.status);

    const opn = await api('POST', `${EX}/opening-stock`, {
      itemId, qty: 20, grossWeight: 200, netWeight: 190, rate: 5200, remarks: 'smoke opening',
    });
    check('opening-stock create', opn.status === 201 && /^OPN-/.test(opn.json.openingStock.entryNo || '') && Number(opn.json.item.stock) === 20, opn.json && opn.json.openingStock);

    const opnList = await api('GET', `${EX}/opening-stock`);
    check('opening-stock list', opnList.status === 200 && Array.isArray(opnList.json), opnList.status);

    const ledger = await api('GET', `${EX}/ledger?itemId=${itemId}`);
    check('ledger for item (>=4 rows: 2 ADJ + 1 TRF + 1 OPN)', ledger.status === 200 && Array.isArray(ledger.json) && ledger.json.length >= 4, { n: ledger.json && ledger.json.length });

    // cleanup: delete the item (clears its stock_ledger + opening_stock), then its adj/transfer rows
    const delItem = await api('DELETE', `/api/inventory/${itemId}`);
    check('inventory item delete', delItem.status === 200, delItem);
    await pool.query(`DELETE FROM stock_adjustments WHERE item_id = $1`, [String(itemId)]);
    await pool.query(`DELETE FROM stock_transfers WHERE item_id = $1`, [String(itemId)]);
  }

  const summary = await api('GET', `${EX}/reports/summary`);
  check('reports/summary', summary.status === 200 && typeof summary.json.totalItemsCount === 'number' && summary.json.categoryBreakdown && summary.json.purityBreakdown, summary.status);

  /* ---------------- superadmin ---------------- */
  const SA = '/api/superadmin';
  results.push(`\n== superadmin (${SA}) ==`);

  check('login rejects bad body', (await api('POST', `${SA}/login`, {}, null)).status === 400);
  const me = await api('GET', `${SA}/me`, null, adminToken);
  check('me requires admin token (401 w/ tenant token)', (await api('GET', `${SA}/me`, null, tenantToken)).status === 401);
  // /me will 404 because our minted sub isn't a real superadmin row — that still proves auth passed
  check('me passes admin auth (404 unknown id, not 401)', me.status === 404 || me.status === 200, me);

  const shopsList = await api('GET', `${SA}/shops`, null, adminToken);
  check('shops list w/ userCount', shopsList.status === 200 && Array.isArray(shopsList.json) && shopsList.json.every((s) => typeof s.userCount === 'number'), shopsList.status);

  // public demo request
  const dr = await api('POST', `${SA}/demo-requests`, { name: 'Smoke', shopName: 'Smoke Shop', phone: '9990001111', message: 'hi' }, null);
  check('demo-request create (public)', dr.status === 201 && (dr.json.id || dr.json._id) && dr.json.status === 'Pending', dr);
  const drId = dr.json && (dr.json.id || dr.json._id);
  if (drId) {
    const drList = await api('GET', `${SA}/demo-requests`, null, adminToken);
    check('demo-requests list', drList.status === 200 && drList.json.some((d) => (d.id || d._id) === drId), drList.status);
    const drUpd = await api('PUT', `${SA}/demo-requests/${drId}`, { status: 'Contacted' }, adminToken);
    check('demo-request update status', drUpd.status === 200 && drUpd.json.status === 'Contacted', drUpd);
    const drDel = await api('DELETE', `${SA}/demo-requests/${drId}`, null, adminToken);
    check('demo-request delete', drDel.status === 200, drDel);
  }

  // full shop lifecycle
  const slug = 'smoke-shop-' + Date.now().toString().slice(-6);
  const shopCreate = await api('POST', `${SA}/shops`, {
    slug, shopName: 'Smoke Shop', ownerName: 'Smoke Owner', phone: '9998887777', plan: 'trial',
    gstAdminUsername: slug + '-gst', gstAdminPassword: 'secret123',
    nonGstAdminUsername: slug + '-ngst', nonGstAdminPassword: 'secret456',
  }, adminToken);
  check('shop create', shopCreate.status === 201 && shopCreate.json.shop && shopCreate.json.shop.slug === slug, shopCreate);
  check('shop create returns 2 logins', shopCreate.json && Array.isArray(shopCreate.json.loginCredentials) && shopCreate.json.loginCredentials.length === 2, shopCreate.json && shopCreate.json.loginCredentials);
  const newShopId = shopCreate.json && shopCreate.json.shop && (shopCreate.json.shop.id || shopCreate.json.shop._id);

  if (newShopId) {
    const seededUsers = await pool.query(`SELECT role FROM users WHERE shop_id = $1 ORDER BY role`, [newShopId]);
    check('shop create seeded owner+operator', seededUsers.rows.map((r) => r.role).join(',') === 'operator,owner', seededUsers.rows);
    const seededRate = await pool.query(`SELECT 1 FROM gold_rates WHERE shop_id = $1`, [newShopId]);
    check('shop create seeded gold_rates row', seededRate.rowCount === 1);

    const dupSlug = await api('POST', `${SA}/shops`, {
      slug, shopName: 'Dup', gstAdminUsername: 'a-gst', gstAdminPassword: 'secret123',
      nonGstAdminUsername: 'a-ngst', nonGstAdminPassword: 'secret456',
    }, adminToken);
    check('shop create rejects duplicate slug (409)', dupSlug.status === 409, dupSlug.status);

    const getShop = await api('GET', `${SA}/shops/${newShopId}`, null, adminToken);
    check('shop get by id', getShop.status === 200 && (getShop.json.id === newShopId || getShop.json._id === newShopId), getShop.status);

    const putShop = await api('PUT', `${SA}/shops/${newShopId}`, { notes: 'smoke note', plan: 'standard' }, adminToken);
    check('shop update (notes/plan)', putShop.status === 200 && putShop.json.notes === 'smoke note' && putShop.json.plan === 'standard', putShop.json && { notes: putShop.json.notes, plan: putShop.json.plan });

    const newSlug = slug + '-x';
    const slugUpd = await api('POST', `${SA}/shops/${newShopId}/update-slug`, { slug: newSlug }, adminToken);
    check('shop update-slug', slugUpd.status === 200 && slugUpd.json.slug === newSlug, slugUpd.json && slugUpd.json.slug);

    const susp = await api('POST', `${SA}/shops/${newShopId}/suspend`, {}, adminToken);
    check('shop suspend', susp.status === 200 && susp.json.status === 'suspended', susp.json && susp.json.status);
    const act = await api('POST', `${SA}/shops/${newShopId}/activate`, {}, adminToken);
    check('shop activate', act.status === 200 && act.json.status === 'active', act.json && act.json.status);
    const renew = await api('POST', `${SA}/shops/${newShopId}/renew`, { newEndDate: '2030-01-01', plan: 'premium' }, adminToken);
    check('shop renew', renew.status === 200 && renew.json.plan === 'premium' && new Date(renew.json.subscriptionEndDate).getFullYear() === 2030, renew.json && { plan: renew.json.plan, end: renew.json.subscriptionEndDate });

    const pw = await api('GET', `${SA}/shops/${newShopId}/users/owner/password`, null, adminToken);
    check('shop view owner password (decrypts)', pw.status === 200 && pw.json.password === 'secret123', { got: pw.json && pw.json.password });

    // usernames are NOT renamed when the slug changes — reset by the original username
    const reset = await api('POST', `${SA}/shops/${newShopId}/reset-user-password`, { username: slug + '-gst', role: 'owner', newPassword: 'brandnew1' }, adminToken);
    check('shop reset owner password', reset.status === 200 && reset.json.newPassword === 'brandnew1', reset.status);
    const pw2 = await api('GET', `${SA}/shops/${newShopId}/users/owner/password`, null, adminToken);
    check('shop owner password reflects reset', pw2.status === 200 && pw2.json.password === 'brandnew1', { got: pw2.json && pw2.json.password });

    const delShop = await api('DELETE', `${SA}/shops/${newShopId}`, null, adminToken);
    check('shop delete', delShop.status === 200, delShop);
    const goneUsers = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE shop_id = $1`, [newShopId]);
    check('shop delete cascades users', goneUsers.rows[0].n === 0, goneUsers.rows[0]);
    const goneShop = await api('GET', `${SA}/shops/${newShopId}`, null, adminToken);
    check('shop delete -> get 404', goneShop.status === 404, goneShop.status);
  }

  await pool.end();
  console.log(results.join('\n'));
  console.log(`\n────────────\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
