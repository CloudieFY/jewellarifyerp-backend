import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pgPool } from '../config/postgres';
import { withTransaction } from '../utils/db';
import { generateId } from '../utils/id';
import { requirePgTenantAuth } from '../middleware/authPg';
import { encryptPassword, decryptPassword } from '../utils/passwordCrypto';
import { apiToColumns, rowToApi, placeholders } from '../db/mapping';
import { findUserByUsername } from '../repositories/userRepository';

/**
 * PostgreSQL port of `routes/karigars.ts`.
 *
 * A karigar row optionally has a linked tenant `users` row (role 'karigar',
 * `karigar_ref_id` = karigar id) that lets them log into the karigar portal.
 * GET responses splice the login `username` and the decrypted `password` onto
 * the karigar object, exactly like the Mongo version did.
 */

const router = Router();
router.use(requirePgTenantAuth());

interface KarigarUserInfo {
  username: string;
  password?: string;
}

async function linkedUsersByKarigar(shopId: string): Promise<Map<string, KarigarUserInfo>> {
  const { rows } = await pgPool.query(
    `SELECT username, password_encrypted, karigar_ref_id
       FROM users
      WHERE shop_id = $1 AND role = 'karigar' AND karigar_ref_id IS NOT NULL`,
    [shopId]
  );
  const map = new Map<string, KarigarUserInfo>();
  for (const r of rows) {
    let password: string | undefined;
    if (r.password_encrypted) {
      try {
        password = decryptPassword(r.password_encrypted);
      } catch {
        /* ignore */
      }
    }
    map.set(String(r.karigar_ref_id), { username: r.username, password });
  }
  return map;
}

function withCreds(karigar: any, info?: KarigarUserInfo): any {
  const obj = rowToApi<any>(karigar)!;
  if (info) {
    if (!obj.username) obj.username = info.username;
    if (info.password) obj.password = info.password;
  }
  return obj;
}

async function findKarigarUserRow(shopId: string, karigarId: string) {
  const { rows } = await pgPool.query(
    `SELECT * FROM users WHERE shop_id = $1 AND karigar_ref_id = $2 LIMIT 1`,
    [shopId, karigarId]
  );
  return rows[0] ?? null;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const { rows } = await pgPool.query(
      `SELECT * FROM karigars WHERE shop_id = $1 ORDER BY name ASC`,
      [shopId]
    );
    const userMap = await linkedUsersByKarigar(shopId);
    res.json(rows.map((k) => withCreds(k, userMap.get(String(k.id)))));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch karigars' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const { rows } = await pgPool.query(
      `SELECT * FROM karigars WHERE shop_id = $1 AND id = $2`,
      [shopId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Karigar not found' });

    const userRow = await findKarigarUserRow(shopId, req.params.id);
    let info: KarigarUserInfo | undefined;
    if (userRow) {
      info = { username: userRow.username };
      if (userRow.password_encrypted) {
        try {
          info.password = decryptPassword(userRow.password_encrypted);
        } catch {
          /* ignore */
        }
      }
    }
    res.json(withCreds(rows[0], info));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch karigar' });
  }
});

const KARIGAR_FIELDS = [
  'name', 'mobile', 'companyName', 'email', 'category',
  'specialty', 'gstNumber', 'address', 'note',
];

router.post('/', async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const { name, mobile, pendingWeight, username, password } = req.body;
    if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile are required' });

    const cleanUsername = username ? String(username).toLowerCase().trim() : '';
    if (cleanUsername) {
      if (!password || String(password).trim().length < 6) {
        return res.status(400).json({
          error: 'Password (at least 6 characters) is required when enabling Karigar portal login.',
        });
      }
      const existing = await findUserByUsername(shopId, cleanUsername);
      if (existing) {
        return res.status(409).json({ error: `Username '${cleanUsername}' is already taken in this shop.` });
      }
    }

    const body: Record<string, any> = {};
    for (const f of KARIGAR_FIELDS) if (req.body[f] !== undefined) body[f] = req.body[f];
    body.pendingWeight = Number(pendingWeight) || 0;
    body.username = cleanUsername || null;

    const karigar = await withTransaction(async (client) => {
      const { columns, values } = await apiToColumns('karigars', body, {
        shop_id: shopId,
        id: generateId('karigar'),
      });
      const { rows } = await client.query(
        `INSERT INTO karigars (${columns.join(', ')}) VALUES (${placeholders(values.length)}) RETURNING *`,
        values
      );
      const created = rows[0];

      if (cleanUsername && password) {
        await client.query(
          `INSERT INTO users (id, shop_id, username, password_hash, password_encrypted, name, role, karigar_ref_id, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,'karigar',$7,true)`,
          [
            generateId('user'),
            shopId,
            cleanUsername,
            await bcrypt.hash(password, 10),
            encryptPassword(password),
            name,
            String(created.id),
          ]
        );
      }
      return created;
    });

    res.status(201).json(rowToApi(karigar));
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Username is already taken in this shop.' });
    }
    console.error('[POST /karigars] failed:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to create karigar' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const id = req.params.id;
    const { username, password, pendingWeight } = req.body;

    const existing = await pgPool.query(
      `SELECT * FROM karigars WHERE shop_id = $1 AND id = $2`,
      [shopId, id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Karigar not found' });
    const current = existing.rows[0];

    const cleanUsername =
      username !== undefined ? String(username).toLowerCase().trim() : (current.username || '');

    const linkedUser = await findKarigarUserRow(shopId, id);

    if (cleanUsername) {
      const clash = await pgPool.query(
        `SELECT 1 FROM users WHERE shop_id = $1 AND username = $2 AND id <> $3 LIMIT 1`,
        [shopId, cleanUsername, linkedUser ? linkedUser.id : '']
      );
      if (clash.rows.length > 0) {
        return res.status(409).json({ error: `Username '${cleanUsername}' is already taken.` });
      }
    }

    const body: Record<string, any> = {};
    for (const f of KARIGAR_FIELDS) if (req.body[f] !== undefined) body[f] = req.body[f];
    if (pendingWeight !== undefined) body.pendingWeight = Number(pendingWeight) || 0;
    if (username !== undefined) body.username = cleanUsername || null;

    const updated = await withTransaction(async (client) => {
      const { columns, values } = await apiToColumns('karigars', body);
      let row = current;
      if (columns.length > 0) {
        const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
        const result = await client.query(
          `UPDATE karigars SET ${setClause}, updated_at = NOW()
            WHERE shop_id = $${columns.length + 1} AND id = $${columns.length + 2} RETURNING *`,
          [...values, shopId, id]
        );
        row = result.rows[0];
      }

      if (cleanUsername) {
        const newName = body.name ?? row.name;
        if (linkedUser) {
          const sets = ['name = $1', 'username = $2'];
          const params: any[] = [newName, cleanUsername];
          if (password && String(password).trim().length >= 6) {
            params.push(await bcrypt.hash(password, 10), encryptPassword(password));
            sets.push(`password_hash = $${params.length - 1}`, `password_encrypted = $${params.length}`);
          }
          params.push(shopId, linkedUser.id);
          await client.query(
            `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
              WHERE shop_id = $${params.length - 1} AND id = $${params.length}`,
            params
          );
        } else {
          if (!password || String(password).trim().length < 6) {
            throw Object.assign(
              new Error('Password (at least 6 characters) is required to create a login account for this karigar.'),
              { statusCode: 400 }
            );
          }
          await client.query(
            `INSERT INTO users (id, shop_id, username, password_hash, password_encrypted, name, role, karigar_ref_id, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,'karigar',$7,true)`,
            [
              generateId('user'),
              shopId,
              cleanUsername,
              await bcrypt.hash(password, 10),
              encryptPassword(password),
              newName,
              id,
            ]
          );
        }
      }
      return row;
    });

    res.json(rowToApi(updated));
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Username is already taken.' });
    }
    console.error('[PUT /karigars/:id] failed:', err?.message || err);
    res.status(err?.statusCode || 400).json({ error: err?.message || 'Failed to update karigar' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const shopId = req.pgTenant!.shopId;
    const id = req.params.id;

    const done = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id FROM karigars WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
        [shopId, id]
      );
      if (found.rows.length === 0) return false;
      await client.query(`DELETE FROM users WHERE shop_id = $1 AND karigar_ref_id = $2`, [shopId, id]);
      await client.query(`DELETE FROM karigars WHERE shop_id = $1 AND id = $2`, [shopId, id]);
      return true;
    });

    if (!done) return res.status(404).json({ error: 'Karigar not found' });
    res.json({ message: 'Karigar and user account deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to delete karigar' });
  }
});

export default router;
