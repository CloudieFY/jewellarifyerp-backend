import { pgPool } from '../config/postgres';
import { generateId } from '../utils/id';

export interface UserRow {
  id: string;
  shop_id: string;
  username: string;
  password_hash: string;
  password_encrypted: string | null;
  name: string;
  role: 'owner' | 'operator' | 'karigar';
  karigar_ref_id: string | null;
  is_active: boolean;
  preferred_language: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function findUserByUsername(
  shopId: string,
  username: string
): Promise<UserRow | null> {
  const result = await pgPool.query<UserRow>(
    `
    SELECT *
    FROM users
    WHERE shop_id = $1
      AND username = $2
    LIMIT 1
    `,
    [shopId, username]
  );

  return result.rows[0] ?? null;
}

export async function findUserById(
  shopId: string,
  id: string
): Promise<UserRow | null> {
  const result = await pgPool.query<UserRow>(
    `
    SELECT *
    FROM users
    WHERE shop_id = $1
      AND id = $2
    LIMIT 1
    `,
    [shopId, id]
  );

  return result.rows[0] ?? null;
}

export async function listUsers(shopId: string): Promise<UserRow[]> {
  const result = await pgPool.query<UserRow>(
    `
    SELECT *
    FROM users
    WHERE shop_id = $1
    ORDER BY created_at DESC
    `,
    [shopId]
  );

  return result.rows;
}

export async function createUser(input: {
  id?: string;
  shopId: string;
  username: string;
  passwordHash: string;
  passwordEncrypted?: string;
  name: string;
  role: 'owner' | 'operator' | 'karigar';
  karigarRefId?: string;
  isActive?: boolean;
  preferredLanguage?: string;
}): Promise<UserRow> {
  const id = input.id ?? generateId('user');

  const result = await pgPool.query<UserRow>(
    `
    INSERT INTO users (
      id,
      shop_id,
      username,
      password_hash,
      password_encrypted,
      name,
      role,
      karigar_ref_id,
      is_active,
      preferred_language
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
    `,
    [
      id,
      input.shopId,
      input.username,
      input.passwordHash,
      input.passwordEncrypted ?? null,
      input.name,
      input.role,
      input.karigarRefId ?? null,
      input.isActive ?? true,
      input.preferredLanguage ?? 'en',
    ]
  );

  return result.rows[0];
}

export async function updateUser(
  shopId: string,
  id: string,
  updates: Record<string, unknown>
): Promise<UserRow | null> {
  const allowed: Record<string, string> = {
    username: 'username',
    name: 'name',
    role: 'role',
    karigarRefId: 'karigar_ref_id',
    isActive: 'is_active',
    preferredLanguage: 'preferred_language',
    passwordHash: 'password_hash',
    passwordEncrypted: 'password_encrypted',
  };

  const entries = Object.entries(updates)
    .filter(([key, value]) => allowed[key] && value !== undefined);

  if (!entries.length) {
    return findUserById(shopId, id);
  }

  const values: unknown[] = [];
  const setters = entries.map(([key, value], index) => {
    values.push(value);
    return `${allowed[key]} = $${index + 1}`;
  });

  values.push(shopId);
  values.push(id);

  const result = await pgPool.query<UserRow>(
    `
    UPDATE users
    SET ${setters.join(', ')}, updated_at = NOW()
    WHERE shop_id = $${values.length - 1}
      AND id = $${values.length}
    RETURNING *
    `,
    values
  );

  return result.rows[0] ?? null;
}

export async function updateUserPasswordByUsername(
  shopId: string,
  username: string,
  passwordHash: string,
  passwordEncrypted: string
): Promise<UserRow | null> {
  const result = await pgPool.query<UserRow>(
    `
    UPDATE users
    SET password_hash = $1, password_encrypted = $2, updated_at = NOW()
    WHERE shop_id = $3
      AND username = $4
    RETURNING *
    `,
    [passwordHash, passwordEncrypted, shopId, username]
  );

  return result.rows[0] ?? null;
}

export async function deleteUser(
  shopId: string,
  id: string
): Promise<UserRow | null> {
  const result = await pgPool.query<UserRow>(
    `
    DELETE FROM users
    WHERE shop_id = $1
      AND id = $2
    RETURNING *
    `,
    [shopId, id]
  );

  return result.rows[0] ?? null;
}
