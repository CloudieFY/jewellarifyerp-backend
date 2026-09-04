/* Smoke test for the newly-ported PG routes. Mints a tenant JWT with the
 * app's own signing secret (no credential extraction) for the DEMO shop
 * owner, then runs create/list/get/update/delete against :3019, cleaning up. */
require('dotenv').config({ path: '/var/www/jewellarifyerp/jewellarifyerp-backend/.env' });
const jwt = require('jsonwebtoken');

const BASE = 'http://localhost:3019';
const SHOP_ID = '6a718b3b4dc2277b0539b1e0';   // DEMO JEWELLERS
const USER_ID = '6a718b3b4dc2277b0539b1e4';   // demog (owner)

const token = jwt.sign(
  { sub: USER_ID, shopId: SHOP_ID, username: 'demog', role: 'owner', type: 'tenant' },
  process.env.JWT_TENANT_SECRET,
  { expiresIn: '1h' }
);

let pass = 0, fail = 0;
const results = [];

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}  ${detail ? JSON.stringify(detail).slice(0, 300) : ''}`); }
}

async function crud(label, path, createBody, patchBody, expectFields = []) {
  results.push(`\n== ${label} (${path}) ==`);
  const list0 = await api('GET', path);
  check(`${label} list`, list0.status === 200 && Array.isArray(list0.json), list0);
  const created = await api('POST', path, createBody);
  check(`${label} create`, created.status === 201 && created.json && (created.json.id || created.json._id), created);
  if (created.status !== 201) return null;
  const id = created.json.id || created.json._id;
  for (const f of expectFields) {
    const got = created.json[f];
    const want = createBody[f];
    let ok = Array.isArray(got) && Array.isArray(want) && got.length === want.length;
    if (ok) {
      ok = want.every((w, i) => Object.keys(w).every((k) => JSON.stringify(got[i][k]) === JSON.stringify(w[k])));
    }
    check(`${label} create persists ${f} (${Array.isArray(got) ? got.length : '?'} rows)`, ok, { got, want });
  }
  const got = await api('GET', `${path}/${id}`);
  check(`${label} get by id`, got.status === 200 && (got.json.id === id || got.json._id === id), got);
  if (patchBody) {
    const upd = await api('PUT', `${path}/${id}`, { ...createBody, ...patchBody });
    check(`${label} update`, upd.status === 200, upd);
    const key = Object.keys(patchBody)[0];
    check(`${label} update applied (${key})`, upd.json && JSON.stringify(upd.json[key]) === JSON.stringify(patchBody[key]), { got: upd.json && upd.json[key], want: patchBody[key] });
  }
  const del = await api('DELETE', `${path}/${id}`);
  check(`${label} delete`, del.status === 200, del);
  const gone = await api('GET', `${path}/${id}`);
  check(`${label} get after delete = 404`, gone.status === 404, gone);
  return id;
}

(async () => {
  const health = await api('GET', '/health');
  check('health', health.status === 200 && health.json.db === 'postgres', health);

  await crud('expenses', '/api/expenses',
    { description: 'SMOKE electricity', category: 'Utilities', amount: 1234.5, date: '2026-09-04', paymentMode: 'Cash', expenseType: 'Indirect' },
    { amount: 999 });

  await crud('schemes', '/api/schemes',
    { schemeNo: 'SMK-SCH-1', date: '2026-09-04', customerName: 'Smoke Cust', planName: '11+1', monthlyAmount: 5000, tenureMonths: 11 },
    { paidMonths: 3 });

  await crud('advances', '/api/advances',
    { date: '2026-09-04', customerName: 'Smoke Adv', customerMobile: '9990001111', metal: 'Gold', purity: '22K', ratePerGram: 6500, amount: 65000, weightLocked: 10 },
    { status: 'Redeemed' });

  await crud('gold-rates', '/api/gold-rates',
    { gold24: 7100, gold22: 6600, gold20: 6000, gold18: 5400, silver: 92 },
    { silver: 95 });

  await crud('employees', '/api/employees',
    { name: 'Smoke Emp', role: 'Sales', salary: 25000, joinDate: '2026-01-01', phone: '9998887777', payments: [{ date: '2026-02-01', amount: 25000 }] },
    { salary: 27000 },
    ['payments']);

  await crud('orders', '/api/orders',
    { orderNo: 'SMK-ORD-1', date: '2026-09-04', customerName: 'Smoke Ord', itemDescription: 'Custom ring', metal: 'Gold', purity: '22K', estimatedTotalAmount: 45000 },
    { status: 'In Progress' });

  await crud('repairs', '/api/repairs',
    { ticketNo: 'SMK-RPR-1', date: '2026-09-04T00:00:00.000Z', customerName: 'Smoke Rpr', metal: 'Gold', itemDescription: 'Chain solder', estimatedCost: 500 },
    { status: 'Ready' });

  await crud('sales', '/api/sales',
    { customerId: 'cust_smoke_1', totalAmount: 3000, status: 'pending', paymentStatus: 'pending', notes: 'smoke', items: [{ itemName: 'Ring', quantity: 1, rate: 3000, amount: 3000 }] },
    { status: 'completed' },
    ['items']);

  await crud('girvi', '/api/girvi',
    { date: '2026-09-04', loanNo: 'SMK-GIRVI-1', customerName: 'Smoke Girvi', customerMobile: '9995554444', loanAmount: 20000, interestPct: 2, status: 'Active',
      items: [{ itemType: 'Gold', itemDescription: 'Bangle', grossWeight: 15, netWeight: 14, purity: '22K' }] },
    { status: 'Closed' },
    ['items']);

  // sales-returns: standalone (no invoiceId), create + get + delete (no PUT route)
  results.push(`\n== sales-returns (/api/sales-returns) ==`);
  const srList = await api('GET', '/api/sales-returns');
  check('sales-returns list', srList.status === 200 && Array.isArray(srList.json), srList);
  const srCreate = await api('POST', '/api/sales-returns', {
    date: '2026-09-04', customerName: 'Smoke SR', customerMobile: '9994443333',
    subtotal: 1000, gstAmount: 30, totalRefund: 1030, refundMode: 'Cash', reason: 'smoke',
    items: [{ productId: 'MANUAL_SMOKE', name: 'Returned ring', netWeight: 5, ratePerGram: 6000, qty: 1, returnAmount: 1030 }],
  });
  check('sales-returns create', srCreate.status === 201 && /^SR-\d+/.test(srCreate.json.returnNo || ''), srCreate);
  if (srCreate.status === 201) {
    const srId = srCreate.json.id || srCreate.json._id;
    const srGet = await api('GET', `/api/sales-returns/${srId}`);
    check('sales-returns get by id', srGet.status === 200 && Array.isArray(srGet.json.items) && srGet.json.items.length === 1, srGet);
    const srDel = await api('DELETE', `/api/sales-returns/${srId}`);
    check('sales-returns delete', srDel.status === 200, srDel);
  }

  // purchases: CRUD + approve/reject/receive
  results.push(`\n== purchases (/api/purchases) ==`);
  const pBody = {
    billNo: 'SMK-PUR-1', date: '2026-09-04', supplierName: 'Smoke Supplier', metal: 'Gold', purity: '22K',
    weight: 50, ratePerGram: 6400, total: 320000, paymentMode: 'Cash', docType: 'Entry', category: 'Metal', status: 'Completed',
    items: [{ name: 'Gold bar', metal: 'Gold', purity: '24K', grossWeight: 50, netWeight: 50, ratePerGram: 6400, makingChargeType: 'fixed', total: 320000 }],
  };
  const pList = await api('GET', '/api/purchases');
  check('purchases list', pList.status === 200 && Array.isArray(pList.json), pList);
  const pCreate = await api('POST', '/api/purchases', pBody);
  check('purchases create', pCreate.status === 201 && Array.isArray(pCreate.json.items) && pCreate.json.items.length === 1, pCreate);
  const pId = pCreate.json && (pCreate.json.id || pCreate.json._id);
  if (pId) {
    const pUpd = await api('PUT', `/api/purchases/${pId}`, { ...pBody, note: 'edited' });
    check('purchases update', pUpd.status === 200 && pUpd.json.note === 'edited', pUpd);
    const pDel = await api('DELETE', `/api/purchases/${pId}`);
    check('purchases delete', pDel.status === 200, pDel);
  }
  // approve/reject/receive on an Order
  const ordCreate = await api('POST', '/api/purchases', { ...pBody, billNo: 'SMK-PUR-ORD-1', docType: 'Order', status: 'Pending', needsApproval: true });
  const ordId = ordCreate.json && (ordCreate.json.id || ordCreate.json._id);
  check('purchases order create', ordCreate.status === 201 && !!ordId, ordCreate);
  if (ordId) {
    const appr = await api('PATCH', `/api/purchases/${ordId}/approve`);
    check('purchases approve', appr.status === 200 && appr.json.status === 'Approved' && appr.json.approvedBy === 'demog', appr);
    const recv = await api('POST', `/api/purchases/${ordId}/receive`);
    check('purchases receive -> new Entry', recv.status === 201 && recv.json.docType === 'Entry' && recv.json.status === 'Completed' && recv.json.linkedDocId === ordId, recv);
    check('purchases receive copies items', recv.json && Array.isArray(recv.json.items) && recv.json.items.length === 1, recv.json && recv.json.items);
    const ordAfter = await api('GET', `/api/purchases/${ordId}`);
    check('purchases order now Received', ordAfter.json && ordAfter.json.status === 'Received', ordAfter.json && ordAfter.json.status);
    // reject path on a fresh order
    const ord2 = await api('POST', '/api/purchases', { ...pBody, billNo: 'SMK-PUR-ORD-2', docType: 'Order', status: 'Pending', needsApproval: true });
    const ord2Id = ord2.json && (ord2.json.id || ord2.json._id);
    const rej = await api('PATCH', `/api/purchases/${ord2Id}/reject`, { reason: 'smoke reject' });
    check('purchases reject', rej.status === 200 && rej.json.status === 'Rejected' && rej.json.rejectionReason === 'smoke reject', rej);
    // cleanup
    for (const cid of [ordId, ord2Id]) if (cid) await api('DELETE', `/api/purchases/${cid}`);
    if (recv.json && (recv.json.id || recv.json._id)) await api('DELETE', `/api/purchases/${recv.json.id || recv.json._id}`);
  }

  console.log(results.join('\n'));
  console.log(`\n────────────\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
