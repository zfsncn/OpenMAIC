import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/stages` carries each course's `sourceDigests` — the link between a
 * classroom and the materials it was generated from.
 *
 * The home page reads that link off the course list it already holds, to tell
 * "the user re-uploaded a file that already has a classroom" apart from "the
 * user wants a new course": the first must open the existing classroom (or
 * fill in the derivation its chapters read from), never build a second course
 * from the same material. Without the field on the summary that check would
 * need a document read per listed course.
 *
 * Exercised on the real route, the real owner-bound store and an in-memory
 * PostgreSQL, because the field has no column — it lives in the stage JSONB
 * and is projected by the PG store's list query. An in-memory double would
 * assert the mapping without ever running the projection.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const ALICE_COOKIE = '11111111-1111-4111-8111-111111111111';
const ALICE = `anon:${ALICE_COOKIE}`;
const NOW = 1_800_000_000_000;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function courseDocument(stageId: string, stageFields: Record<string, unknown> = {}) {
  return {
    stage: {
      id: stageId,
      name: `Course ${stageId}`,
      createdAt: NOW,
      updatedAt: NOW,
      ...stageFields,
    },
    scenes: [],
    outline: {
      outlines: [],
      requirement: stageId,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe('course list source digests', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://source-digests-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);

    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const alice = await getOwnerScopedDocumentStore(ALICE);
    await alice.saveDocument(
      courseDocument('stage-linked', { sourceDigests: [DIGEST_A, DIGEST_B] }) as never,
    );
    await alice.saveDocument(courseDocument('stage-unlinked') as never);
    // Written by hand rather than through a type that forbids them: an older or
    // foreign writer can put anything in the JSONB, and the listing must not be
    // the thing that breaks when it does.
    await alice.saveDocument(courseDocument('stage-empty', { sourceDigests: [] }) as never);
    await alice.saveDocument(
      courseDocument('stage-mixed', { sourceDigests: [DIGEST_A, 7, null, DIGEST_B] }) as never,
    );
    await alice.saveDocument(courseDocument('stage-corrupt', { sourceDigests: 'nope' }) as never);
    // Seeding went through the store, which sealed the (empty) registration;
    // each test registers its own, as a fresh process would.
    resetPersistenceHooksForTests();
  });

  afterEach(async () => {
    const { resetPersistenceHooksForTests } =
      await import('@/lib/server/persistence-hooks/registry');
    resetPersistenceHooksForTests();
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function listAsAlice(): Promise<{ status: number; stages: Record<string, unknown>[] }> {
    const { GET } = await import('@/app/api/stages/route');
    const response = await GET(
      new NextRequest('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ALICE_COOKIE}` },
      }),
    );
    const body = (await response.json()) as { stages: Record<string, unknown>[] };
    return { status: response.status, stages: body.stages };
  }

  function byId(stages: Record<string, unknown>[], id: string): Record<string, unknown> {
    const found = stages.find((stage) => stage.id === id);
    if (!found) throw new Error(`stage ${id} is missing from the listing`);
    return found;
  }

  it('carries the materials a course was generated from', async () => {
    const { status, stages } = await listAsAlice();
    expect(status).toBe(200);
    expect(byId(stages, 'stage-linked')).toEqual(
      expect.objectContaining({ sourceDigests: [DIGEST_A, DIGEST_B] }),
    );
  });

  it('omits the field entirely for a course that names no materials', async () => {
    const { stages } = await listAsAlice();
    // Absence is the one shape for "unknown" — a course from before the link
    // existed and a course that legitimately names nothing read the same, and
    // a caller cannot tell them apart because nothing needs to.
    expect(byId(stages, 'stage-unlinked')).not.toHaveProperty('sourceDigests');
    expect(byId(stages, 'stage-empty')).not.toHaveProperty('sourceDigests');
  });

  it('drops entries that are not digests instead of failing the listing', async () => {
    const { status, stages } = await listAsAlice();
    expect(status).toBe(200);
    // The two real digests survive; the number and the null do not, so a
    // caller comparing against upload digests can never match a non-string.
    expect(byId(stages, 'stage-mixed')).toEqual(
      expect.objectContaining({ sourceDigests: [DIGEST_A, DIGEST_B] }),
    );
    // A value that is not a list at all degrades to "names no materials"
    // rather than to an error in the course picker.
    expect(byId(stages, 'stage-corrupt')).not.toHaveProperty('sourceDigests');
  });

  it('carries them through the host library-provider path too', async () => {
    const { configurePersistenceHooks } = await import('@/lib/server/persistence-hooks');
    configurePersistenceHooks({
      name: 'test-host',
      library: {
        name: 'saved-courses',
        list: async () => ['stage-linked'],
      },
    });

    const { status, stages } = await listAsAlice();
    expect(status).toBe(200);
    expect(stages).toEqual([expect.objectContaining({ id: 'stage-linked' })]);
    expect(byId(stages, 'stage-linked')).toEqual(
      expect.objectContaining({ sourceDigests: [DIGEST_A, DIGEST_B] }),
    );
  });
});
