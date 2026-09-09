import { pgPool } from '../config/postgres';
import { generateId } from '../utils/id';

export interface ShopRow {
  id: string;
  slug: string;
  shop_name: string;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  logo_url: string | null;
  address: string | null;
  gst_number: string | null;
  number_of_shop_owner: string | null;
  insta_id: string | null;
  fb_id: string | null;
  terms_and_conditions: string | null;
  invoice_settings: Record<string, unknown>;
  plan: string;
  status: string;
  subscription_start_date: Date;
  subscription_end_date: Date;
  initial_admin_username: string;
  initial_operator_username: string | null;
  legacy_db_name: string | null;
  notes: string | null;
  allowed_modules: string[];
  allowed_pages: string[];
  created_at: Date;
  updated_at: Date;
}

export async function findShopBySlug(slug: string): Promise<ShopRow | null> {
  const result = await pgPool.query<ShopRow>(
    `
    SELECT *
    FROM shops
    WHERE slug = $1
    LIMIT 1
    `,
    [slug]
  );

  return result.rows[0] ?? null;
}

export async function findShopById(id: string): Promise<ShopRow | null> {
  const result = await pgPool.query<ShopRow>(
    `
    SELECT *
    FROM shops
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function listShops(): Promise<ShopRow[]> {
  const result = await pgPool.query<ShopRow>(
    `
    SELECT *
    FROM shops
    ORDER BY created_at DESC
    `
  );

  return result.rows;
}

export async function createShop(input: {
  id?: string;
  slug: string;
  shopName: string;
  ownerName?: string;
  email?: string;
  phone?: string;
  logoUrl?: string;
  address?: string;
  gstNumber?: string;
  plan?: string;
  subscriptionStartDate: Date;
  subscriptionEndDate: Date;
  initialAdminUsername: string;
  initialOperatorUsername?: string;
  legacyDbName?: string;
  notes?: string;
  allowedModules?: string[];
  allowedPages?: string[];
}): Promise<ShopRow> {
  const id = input.id ?? generateId('shop');

  const result = await pgPool.query<ShopRow>(
    `
    INSERT INTO shops (
      id,
      slug,
      shop_name,
      owner_name,
      email,
      phone,
      logo_url,
      address,
      gst_number,
      plan,
      status,
      subscription_start_date,
      subscription_end_date,
      initial_admin_username,
      initial_operator_username,
      legacy_db_name,
      notes,
      allowed_modules,
      allowed_pages
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, 'active', $11, $12, $13, $14, $15, $16, $17, $18
    )
    RETURNING *
    `,
    [
      id,
      input.slug,
      input.shopName,
      input.ownerName ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.logoUrl ?? null,
      input.address ?? null,
      input.gstNumber ?? null,
      input.plan ?? 'trial',
      input.subscriptionStartDate,
      input.subscriptionEndDate,
      input.initialAdminUsername,
      input.initialOperatorUsername ?? null,
      input.legacyDbName ?? null,
      input.notes ?? null,
      Array.isArray(input.allowedModules) ? input.allowedModules : [],
      Array.isArray(input.allowedPages) ? input.allowedPages : [],
    ]
  );

  return result.rows[0];
}

export async function updateShop(
  id: string,
  updates: Record<string, unknown>
): Promise<ShopRow | null> {
  const allowed: Record<string, string> = {
    shopName: 'shop_name',
    ownerName: 'owner_name',
    email: 'email',
    phone: 'phone',
    logoUrl: 'logo_url',
    address: 'address',
    gstNumber: 'gst_number',
    numberOfShopOwner: 'number_of_shop_owner',
    instaId: 'insta_id',
    fbId: 'fb_id',
    termsAndConditions: 'terms_and_conditions',
    invoiceSettings: 'invoice_settings',
    plan: 'plan',
    status: 'status',
    subscriptionStartDate: 'subscription_start_date',
    subscriptionEndDate: 'subscription_end_date',
    initialAdminUsername: 'initial_admin_username',
    initialOperatorUsername: 'initial_operator_username',
    notes: 'notes',
    allowedModules: 'allowed_modules',
    allowedPages: 'allowed_pages',
  };

  const entries = Object.entries(updates)
    .filter(([key]) => allowed[key] && updates[key] !== undefined);

  if (!entries.length) {
    return findShopById(id);
  }

  const values: unknown[] = [];
  const setters = entries.map(([key, value], index) => {
    values.push(value);
    return `${allowed[key]} = $${index + 1}`;
  });

  values.push(id);

  const result = await pgPool.query<ShopRow>(
    `
    UPDATE shops
    SET ${setters.join(', ')}, updated_at = NOW()
    WHERE id = $${values.length}
    RETURNING *
    `,
    values
  );

  return result.rows[0] ?? null;
}

export async function updateShopSlug(
  id: string,
  slug: string
): Promise<ShopRow | null> {
  const result = await pgPool.query<ShopRow>(
    `
    UPDATE shops
    SET slug = $1, updated_at = NOW()
    WHERE id = $2
    RETURNING *
    `,
    [slug, id]
  );

  return result.rows[0] ?? null;
}

export async function updateShopStatus(
  id: string,
  status: 'active' | 'suspended' | 'expired'
): Promise<ShopRow | null> {
  const result = await pgPool.query<ShopRow>(
    `
    UPDATE shops
    SET status = $1, updated_at = NOW()
    WHERE id = $2
    RETURNING *
    `,
    [status, id]
  );

  return result.rows[0] ?? null;
}

export async function deleteShop(id: string): Promise<ShopRow | null> {
  const result = await pgPool.query<ShopRow>(
    `
    DELETE FROM shops
    WHERE id = $1
    RETURNING *
    `,
    [id]
  );

  return result.rows[0] ?? null;
}
