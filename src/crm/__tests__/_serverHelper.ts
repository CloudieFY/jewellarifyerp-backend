/**
 * Spins up the real CRM Express router on an ephemeral port for DB-backed
 * route tests. It exercises the true middleware chain
 * (requirePgTenantAuth -> requireCrmPermission -> withTenant -> RLS).
 *
 * The CRM request path talks to PostgreSQL through the singleton pool in
 * src/config/postgres.ts, which reads `DATABASE_URL` once at import time.
 * These tests point everything at the throw-away test database, so we copy
 * `TEST_DATABASE_URL` onto `DATABASE_URL` BEFORE the router (and therefore
 * config/postgres) is first imported — hence the dynamic import inside
 * `startCrmServer()`.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

export interface CrmTestServer {
  base: string;
  close: () => Promise<void>;
}

export async function startCrmServer(): Promise<CrmTestServer> {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  // Dynamic: defers config/postgres evaluation until after DATABASE_URL is set.
  const { default: crmRouter } = await import('../routes');
  const { default: crmAdminRouter } = await import('../routes/admin');

  const app = express();
  app.use(express.json());
  app.use('/api/crm', crmRouter);
  app.use('/api/superadmin/crm', crmAdminRouter);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export interface ApiResponse {
  status: number;
  body: any;
}

/** Tiny fetch wrapper: `api(base, token, 'POST', '/api/crm/leads', { ... })`. */
export async function api(
  base: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}
