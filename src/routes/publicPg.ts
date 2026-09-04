import { Router, Request, Response } from 'express';
import { pgPool } from '../config/postgres';
import { rowToApi } from '../db/mapping';

/**
 * PostgreSQL port of the unauthenticated `/api/public/*` catalog + invoice
 * share routes from `src/index.ts` (WhatsApp product / bill links).
 *
 * In the single-DB PG model there is no per-shop database, so the old Mongo
 * "loop every shop" fan-out collapses to one indexed lookup. Legacy links that
 * carry a `:dbName` segment are still honoured by mapping it to
 * `shops.legacy_db_name` (falling back to `slug`).
 *
 * NOTE (carried-over risk, tracked separately): the by-id routes let an
 * unauthenticated caller resolve any shop's item/invoice by guessing an id,
 * barcode or invoice number. Hardening (per-document share token) is a
 * separate task; this file only restores the existing behaviour on PG.
 */

const router = Router();

const SHOP_PUBLIC_COLS = `
  id, slug, shop_name, phone, address, logo_url, gst_number, invoice_settings
`;

const shopInfo = (row: any) => ({
  shopName: row?.shop_name || 'Jewellery Shop',
  phone: row?.phone || '',
  address: row?.address || '',
  logoUrl: row?.logo_url || '',
  gstNumber: row?.gst_number || '',
  invoiceSettings: row?.invoice_settings || {},
});

/** Resolve a legacy `:dbName` path segment to a shop row. */
async function shopByLegacyName(dbName: string): Promise<any | null> {
  const { rows } = await pgPool.query(
    `SELECT ${SHOP_PUBLIC_COLS} FROM shops
      WHERE legacy_db_name = $1 OR slug = $1
      LIMIT 1`,
    [dbName]
  );
  return rows[0] ?? null;
}

async function findInventory(idOrCode: string, shopId?: string): Promise<any | null> {
  const params: any[] = [idOrCode];
  let scope = '';
  if (shopId) {
    params.push(shopId);
    scope = ` AND shop_id = $2`;
  }
  const { rows } = await pgPool.query(
    `SELECT * FROM inventory
      WHERE (id::text = $1 OR barcode = $1 OR sku = $1 OR item_code = $1 OR huid = $1)${scope}
      LIMIT 1`,
    params
  );
  return rows[0] ?? null;
}

async function findInvoice(idOrNumber: string, shopId?: string): Promise<any | null> {
  const params: any[] = [idOrNumber, idOrNumber.toUpperCase()];
  let scope = '';
  if (shopId) {
    params.push(shopId);
    scope = ` AND shop_id = $3`;
  }
  const { rows } = await pgPool.query(
    `SELECT * FROM invoices
      WHERE (id::text = $1 OR number = $1 OR number = $2)${scope}
      LIMIT 1`,
    params
  );
  return rows[0] ?? null;
}

async function serializeInvoice(row: any): Promise<any> {
  const obj = rowToApi<any>(row)!;
  const [items, payments] = await Promise.all([
    pgPool.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC`, [String(row.id)]),
    pgPool.query(`SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY payment_date ASC, id ASC`, [String(row.id)]),
  ]);
  obj.items = items.rows.map((r) => rowToApi(r));
  obj.payments = payments.rows.map((r) => {
    const p = rowToApi<any>(r)!;
    p.date = p.paymentDate;
    return p;
  });
  return obj;
}

async function shopById(shopId: string): Promise<any | null> {
  const { rows } = await pgPool.query(
    `SELECT ${SHOP_PUBLIC_COLS} FROM shops WHERE id = $1 LIMIT 1`,
    [shopId]
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Catalog image (legacy dbName form) — serves a stored data: URI as   */
/* binary. MIME is whitelisted (SEC-7 hardening) and sniffing blocked. */
/* ------------------------------------------------------------------ */

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

router.get('/inventory-image/:dbName/:inventoryId', async (req, res) => {
  try {
    const shop = await shopByLegacyName(req.params.dbName);
    const item = await findInventory(req.params.inventoryId, shop?.id);
    const img: string | undefined = item?.image_url;
    if (!item || !img) return res.status(404).send('Image not found');

    if (img.startsWith('data:')) {
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        const mime = m[1].toLowerCase();
        if (!ALLOWED_IMAGE_MIME.has(mime)) return res.status(415).send('Unsupported image type');
        res.setHeader('Content-Type', mime === 'image/jpg' ? 'image/jpeg' : mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(Buffer.from(m[2], 'base64'));
      }
    } else if (img.startsWith('http://') || img.startsWith('https://')) {
      return res.redirect(img);
    }
    return res.status(404).send('Invalid image format');
  } catch (err) {
    console.error('[public/inventory-image] error:', err);
    return res.status(500).send('Error serving image');
  }
});

/* ------------------------------------------------------------------ */
/* Product viewer                                                      */
/* ------------------------------------------------------------------ */

router.get('/inventory-item/:dbName/:inventoryId', async (req, res) => {
  try {
    const shop = await shopByLegacyName(req.params.dbName);
    const item = await findInventory(req.params.inventoryId, shop?.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const shopRow = shop ?? (await shopById(item.shop_id));
    return res.json({ item: rowToApi(item), shop: shopInfo(shopRow) });
  } catch (err) {
    console.error('[public/inventory-item] error:', err);
    return res.status(500).json({ error: 'Error fetching product' });
  }
});

router.get('/inventory-item-by-id/:inventoryId', async (req, res) => {
  try {
    if (!req.params.inventoryId) return res.status(400).json({ error: 'Item ID is required' });
    const item = await findInventory(req.params.inventoryId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    return res.json({ item: rowToApi(item), shop: shopInfo(await shopById(item.shop_id)) });
  } catch (err) {
    console.error('[public/inventory-item-by-id] error:', err);
    return res.status(500).json({ error: 'Error fetching product' });
  }
});

/* ------------------------------------------------------------------ */
/* Invoice viewer                                                      */
/* ------------------------------------------------------------------ */

router.get('/invoice/:dbName/:invoiceId', async (req, res) => {
  try {
    if (!req.params.invoiceId || !req.params.dbName) {
      return res.status(400).json({ error: 'DB Name & Invoice ID required' });
    }
    const shop = await shopByLegacyName(req.params.dbName);
    const inv = await findInvoice(req.params.invoiceId, shop?.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const shopRow = shop ?? (await shopById(inv.shop_id));
    return res.json({ invoice: await serializeInvoice(inv), shop: shopInfo(shopRow) });
  } catch (err) {
    console.error('[public/invoice/:dbName] error:', err);
    return res.status(500).json({ error: 'Error fetching invoice' });
  }
});

router.get('/invoice/:invoiceId', async (req, res) => {
  try {
    if (!req.params.invoiceId) return res.status(400).json({ error: 'Invoice ID is required' });
    const inv = await findInvoice(req.params.invoiceId);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    return res.json({ invoice: await serializeInvoice(inv), shop: shopInfo(await shopById(inv.shop_id)) });
  } catch (err) {
    console.error('[public/invoice] error:', err);
    return res.status(500).json({ error: 'Error fetching invoice' });
  }
});

export default router;
