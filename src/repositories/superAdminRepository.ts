import { pgPool } from '../config/postgres';
import { generateId } from '../utils/id';

export interface SuperAdminRow {
  id: string;
  username: string;
  password_hash: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export async function findSuperAdminByUsername(
  username: string
): Promise<SuperAdminRow | null> {
  const result = await pgPool.query<SuperAdminRow>(
    `
    SELECT *
    FROM superadmins
    WHERE username = $1
    LIMIT 1
    `,
    [username]
  );

  return result.rows[0] ?? null;
}

export async function findSuperAdminById(
  id: string
): Promise<SuperAdminRow | null> {
  const result = await pgPool.query<SuperAdminRow>(
    `
    SELECT *
    FROM superadmins
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

export async function createSuperAdmin(input: {
  username: string;
  passwordHash: string;
  name: string;
}): Promise<SuperAdminRow> {
  const result = await pgPool.query<SuperAdminRow>(
    `
    INSERT INTO superadmins (
      id,
      username,
      password_hash,
      name
    )
    VALUES ($1,$2,$3,$4)
    RETURNING *
    `,
    [
      generateId('admin'),
      input.username,
      input.passwordHash,
      input.name,
    ]
  );

  return result.rows[0];
}

export async function updateSuperAdmin(
  id: string,
  passwordHash: string,
  name: string
): Promise<SuperAdminRow | null> {
  const result = await pgPool.query<SuperAdminRow>(
    `
    UPDATE superadmins
    SET password_hash = $1,
        name = $2,
        updated_at = NOW()
    WHERE id = $3
    RETURNING *
    `,
    [passwordHash, name, id]
  );

  return result.rows[0] ?? null;
}
