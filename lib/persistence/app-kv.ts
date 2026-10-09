/**
 * Owner-scoped key/value rows — the server half of the KV HTTP contract
 * (`packages/@openmaic/storage/docs/kv-http-contract.md`).
 *
 * `@openmaic/storage` ships a `KVStore` with a browser backend and an HTTP
 * *client* (`HttpAccountKV` / `HttpKVStore`), but no server implementation:
 * the contract's reference server is test-only. This table is the real
 * deployment's server side, so the app's `account`-scope values can survive a
 * device change.
 *
 * The contract fixes what has to be true here, and each rule has a reason:
 *
 * - **Every operation is scoped to one owner.** The principal is derived from
 *   the authenticated session at the route, never sent by the client, and the
 *   `(owner_id, key)` pair is the row's primary key — so a listing can never
 *   cross owners and a write can never land in someone else's partition.
 * - **A key is opaque.** No length cap, no character ban, no parsing: it is a
 *   bound parameter here, never a path or a fragment of SQL.
 * - **The prefix match is literal.** `LIKE`'s own metacharacters (`%`, `_`)
 *   and the escape character itself are escaped before the comparison, or a
 *   prefix would silently become a pattern. The escape character is `!` rather
 *   than the more usual backslash, whose meaning depends on
 *   `standard_conforming_strings`.
 * - **Last writer wins per key.** There is no CAS in the contract, so a plain
 *   upsert is the whole of the concurrency story.
 *
 * Writes take the owner's identity lock first ({@link fenceOwnerWrite}), like
 * every other owner-keyed store, so a write racing a claim either lands before
 * it (and is moved by the claim participant in `./owner-claims.ts`) or is
 * refused — never left under a retired id.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { fenceOwnerWrite } from './owner-merges';

export const APP_KV_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_kv (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE INDEX IF NOT EXISTS app_kv_owner_idx ON app_kv (owner_id);
`;

export async function ensureAppKvSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(APP_KV_SCHEMA)) {
    await queryable.query(statement);
  }
}

interface RawAppKvRow extends Record<string, unknown> {
  value: unknown;
}

/** Read one value, or `null` when this owner holds no entry under `key`. */
export async function readAppKvEntry(
  queryable: Queryable,
  ownerId: string,
  key: string,
): Promise<unknown | null> {
  const result = await queryable.query<RawAppKvRow>(
    'SELECT value FROM app_kv WHERE owner_id = $1 AND key = $2',
    [ownerId, key],
  );
  // `null` and "no row" are both `null` to a KV caller (the contract says so),
  // and a stored JSON `null` arrives as a row whose `value` is null.
  return result.rows.length === 0 ? null : (result.rows[0]?.value ?? null);
}

/** Write one value, replacing any existing one (last writer wins). */
export async function writeAppKvEntry(
  queryable: ConnectableQueryable,
  ownerId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const withTransaction = nodePostgresTransaction(queryable);
  await withTransaction(async (tx) => {
    // The identity lock first, as every owner write takes it.
    await fenceOwnerWrite(tx, ownerId);
    await tx.query(
      `INSERT INTO app_kv (owner_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (owner_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [ownerId, key, encodeJson(value, `app kv value for key ${JSON.stringify(key)}`), Date.now()],
    );
  });
}

/** Delete one value. Absent keys succeed, like the contract's `DELETE`. */
export async function deleteAppKvEntry(
  queryable: ConnectableQueryable,
  ownerId: string,
  key: string,
): Promise<void> {
  const withTransaction = nodePostgresTransaction(queryable);
  await withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, ownerId);
    await tx.query('DELETE FROM app_kv WHERE owner_id = $1 AND key = $2', [ownerId, key]);
  });
}

/**
 * The escape character of the prefix comparison. Not a backslash: its meaning
 * depends on `standard_conforming_strings`, which a deployment can change.
 */
const LIKE_ESCAPE = '!';

/** Escape `LIKE`'s metacharacters, plus the escape character itself, literally. */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[!%_]/g, (match) => `${LIKE_ESCAPE}${match}`);
}

/** List this owner's keys, optionally restricted to those starting with `prefix`. */
export async function listAppKvKeys(
  queryable: Queryable,
  ownerId: string,
  prefix = '',
): Promise<string[]> {
  if (prefix === '') {
    const all = await queryable.query<{ key: string } & Record<string, unknown>>(
      'SELECT key FROM app_kv WHERE owner_id = $1 ORDER BY key',
      [ownerId],
    );
    return all.rows.map((row) => row.key);
  }
  const pattern = `${escapeLikeLiteral(prefix)}%`;
  const result = await queryable.query<{ key: string } & Record<string, unknown>>(
    `SELECT key FROM app_kv
      WHERE owner_id = $1 AND key LIKE $2 ESCAPE '${LIKE_ESCAPE}'
      ORDER BY key`,
    [ownerId, pattern],
  );
  return result.rows.map((row) => row.key);
}
