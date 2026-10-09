import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PersistedCourseMaterial,
  PersistedHomeMaterials,
} from '@/lib/document/course-material-persistence';
import type { SelectedCourseMaterial } from '@/lib/types/generation';

const harness = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  loadPdfBlob: vi.fn(),
  /** When set, the stub's reads throw it: an outage, not an empty store. */
  readError: null as Error | null,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// A KV store that is just a map, so the tests are about the directory's shape
// and not about the wire. The module caches its client and its availability
// probe for the tab's lifetime, so every test re-imports it (see `loadModule`).
vi.mock('@openmaic/storage', () => ({
  BrowserKVStore: class {},
  HttpKVStore: class {
    async get(key: string): Promise<unknown> {
      if (harness.readError) throw harness.readError;
      return harness.rows.get(key) ?? null;
    }
    async set(key: string, value: unknown): Promise<void> {
      harness.rows.set(key, value);
    }
    async remove(key: string): Promise<void> {
      harness.rows.delete(key);
    }
  },
}));

vi.mock('@/lib/utils/image-storage', () => ({
  loadPdfBlob: harness.loadPdfBlob,
}));

type MaterialsModule = typeof import('@/lib/document/course-material-persistence');

/** A stored row. Also assignable to `SelectedCourseMaterial`, which is how the
 * in-memory side is built without a second factory. */
function row(id: string, order: number, folderId?: string): PersistedCourseMaterial {
  return {
    id,
    name: `${id}.md`,
    size: 10,
    lastModified: 1000,
    type: 'text/markdown',
    order,
    ...(folderId ? { folderId } : {}),
    storageKey: `key-${id}`,
  };
}

function payload(materials: PersistedCourseMaterial[]): PersistedHomeMaterials {
  return { version: 2, materials, selectedMaterialId: null };
}

async function loadModule(): Promise<MaterialsModule> {
  vi.resetModules();
  return import('@/lib/document/course-material-persistence');
}

let mod: MaterialsModule;

beforeEach(async () => {
  harness.rows.clear();
  harness.readError = null;
  harness.loadPdfBlob.mockReset();
  harness.loadPdfBlob.mockResolvedValue(null);
  // The module refuses to build a KV client outside a browser.
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: {} }));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ persistence: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  mod = await loadModule();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toPersistedMaterials', () => {
  it('carries the folder an entry is filed under, and omits the field when unfiled', () => {
    const persisted = mod.toPersistedMaterials([row('a', 1), row('b', 1, 'folder-a')]);

    // An unfiled row must not gain an empty-string folder: that would be a
    // folder id nothing can match, i.e. a row no view can reach.
    expect('folderId' in persisted[0]).toBe(false);
    expect(persisted.map((entry) => entry.folderId)).toEqual([undefined, 'folder-a']);
  });

  it('groups by folder, because order counts within a folder', () => {
    const persisted = mod.toPersistedMaterials([
      row('b1', 1, 'folder-b'),
      row('a2', 2, 'folder-a'),
      row('a1', 1, 'folder-a'),
      row('root', 1),
    ]);

    expect(persisted.map((entry) => entry.id)).toEqual(['root', 'a1', 'a2', 'b1']);
    // Two folders may both have a first chapter.
    expect(persisted.map((entry) => entry.order)).toEqual([1, 1, 2, 1]);
  });

  it('still drops entries whose bytes were never cached', () => {
    const noBytes: SelectedCourseMaterial = {
      id: 'c',
      name: 'c.md',
      size: 1,
      lastModified: 1,
      type: 'text/markdown',
      order: 1,
      folderId: 'folder-a',
    };
    expect(mod.toPersistedMaterials([noBytes])).toEqual([]);
  });
});

describe('reading and writing the directory', () => {
  it('keeps every folder in the one record', async () => {
    await mod.writeHomeMaterials({
      materials: [row('a', 1), row('b', 1, 'folder-a')],
      selectedMaterialId: null,
    });

    // One record, not one per folder: opening a folder filters this list, it
    // never reads a different key.
    expect([...harness.rows.keys()]).toEqual([mod.HOME_MATERIALS_KV_KEY]);

    const stored = await mod.readHomeMaterials();
    expect(stored?.materials.map((entry) => [entry.id, entry.folderId])).toEqual([
      ['a', undefined],
      ['b', 'folder-a'],
    ]);
  });

  it('drops an entry whose folder id is empty instead of filing it nowhere', async () => {
    harness.rows.set(
      mod.HOME_MATERIALS_KV_KEY,
      payload([row('a', 1), { ...row('b', 1), folderId: '' }]),
    );
    const stored = await mod.readHomeMaterials();
    expect(stored?.materials.map((entry) => entry.id)).toEqual(['a']);
  });

  it('reports no directory at all when every stored entry was unreadable', async () => {
    harness.rows.set(mod.HOME_MATERIALS_KV_KEY, payload([{ ...row('a', 1), folderId: '' }]));
    expect(await mod.readHomeMaterials()).toBeNull();
  });

  it('reads a row written before folders existed as unfiled', async () => {
    harness.rows.set(mod.HOME_MATERIALS_KV_KEY_V1, { ...payload([row('legacy', 1)]), version: 1 });
    const stored = await mod.readHomeMaterials();
    expect(stored?.materials).toHaveLength(1);
    expect(stored?.materials[0].folderId).toBeUndefined();
  });

  it('removes the record once the whole directory is empty, when told the read happened', async () => {
    await mod.writeHomeMaterials({
      materials: [row('a', 1, 'folder-a')],
      selectedMaterialId: null,
    });
    expect(harness.rows.has(mod.HOME_MATERIALS_KV_KEY)).toBe(true);

    // Emptying a folder is not this: the caller passes the whole directory, so
    // only the last row of the last folder reaches this branch. `allowEmpty` is
    // the caller's claim that it read the stored directory first, which is what
    // makes an empty list mean "the user emptied it".
    await mod.writeHomeMaterials({ materials: [], selectedMaterialId: null }, { allowEmpty: true });
    expect(harness.rows.has(mod.HOME_MATERIALS_KV_KEY)).toBe(false);
  });

  it('keeps the record when an empty list was never confirmed by a read', async () => {
    await mod.writeHomeMaterials({
      materials: [row('a', 1, 'folder-a')],
      selectedMaterialId: null,
    });

    // The same call as above but without the claim. An empty in-memory list is
    // also what a page looks like before it has read the store, and erasing on
    // that reading is unrecoverable — the bytes live in the store, not on the
    // device, so no reload brings the directory back.
    await mod.writeHomeMaterials({ materials: [], selectedMaterialId: null });

    expect(harness.rows.has(mod.HOME_MATERIALS_KV_KEY)).toBe(true);
    const stored = await mod.readHomeMaterials();
    expect(stored?.materials.map((entry) => entry.id)).toEqual(['a']);
  });

  it('treats a chapter whose bytes are not captured yet as a pending write, not an empty directory', async () => {
    await mod.writeHomeMaterials({
      materials: [row('stored', 1)],
      selectedMaterialId: null,
    });

    // Attaching a chapter updates the list before its bytes land in IndexedDB,
    // so for one render the directory holds a row with no `storageKey` — which
    // `toPersistedMaterials` drops. The payload is empty; the directory is not.
    const uncaptured: SelectedCourseMaterial = {
      id: 'fresh',
      name: 'fresh.md',
      size: 10,
      lastModified: 1000,
      type: 'text/markdown',
      order: 1,
    };
    await mod.writeHomeMaterials(
      { materials: [uncaptured], selectedMaterialId: null },
      { allowEmpty: true },
    );

    // Nothing was stored, because there was nothing storable — but nothing was
    // erased either: the write that arrives once the key lands is the one that
    // carries this chapter.
    expect(harness.rows.has(mod.HOME_MATERIALS_KV_KEY)).toBe(true);
    const stored = await mod.readHomeMaterials();
    expect(stored?.materials.map((entry) => entry.id)).toEqual(['stored']);
  });

  it('drops the superseded pre-digest record once the current one lands', async () => {
    harness.rows.set(mod.HOME_MATERIALS_KV_KEY_V1, { ...payload([row('legacy', 1)]), version: 1 });
    await mod.writeHomeMaterials({ materials: [row('a', 1)], selectedMaterialId: null });
    expect(harness.rows.has(mod.HOME_MATERIALS_KV_KEY_V1)).toBe(false);
  });
});

describe('telling a read that found nothing from a read that never happened', () => {
  it('reports an answer, with nothing in it, when the store holds no directory', async () => {
    const result = await mod.readHomeMaterialsResult();

    // A store that replied "no directory" has been read. Collapsing that into
    // the same shape as a refusal is what would let the next write erase a
    // directory the store never got to describe.
    expect(result).toEqual({ answered: true, stored: null });
  });

  it('reports what it found, and an answer', async () => {
    harness.rows.set(mod.HOME_MATERIALS_KV_KEY, payload([row('a', 1)]));
    const result = await mod.readHomeMaterialsResult();

    expect(result.answered).toBe(true);
    expect(result.stored?.materials.map((entry) => entry.id)).toEqual(['a']);
  });

  it('reports no answer when the store refused the read', async () => {
    // The access gate answers the probe with 401 until the browser holds its
    // access cookie, so the very first read of a page is refused, not empty.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    const fresh = await loadModule();

    expect(await fresh.readHomeMaterialsResult()).toEqual({ answered: false, stored: null });
  });

  it('reports no answer when the read itself fails, even with a row present', async () => {
    harness.rows.set(mod.HOME_MATERIALS_KV_KEY, payload([row('a', 1)]));
    // The store answers the availability probe but throws on the read: an
    // outage must not be reported as "this directory is empty", or the next
    // write would make that reading come true.
    harness.readError = new Error('the store is unreachable');

    expect(await mod.readHomeMaterialsResult()).toEqual({ answered: false, stored: null });
  });
});

describe('restoreCourseMaterials', () => {
  it('keeps each chapter in its folder while its bytes stay missing', async () => {
    const restored = await mod.restoreCourseMaterials(payload([row('a', 1, 'folder-a')]));

    expect(restored).toHaveLength(1);
    expect(restored[0].folderId).toBe('folder-a');
    expect(restored[0].file).toBeUndefined();
  });
});

describe('the persistence probe remembers only a definitive answer', () => {
  it('asks again after a refusal, so a gated browser is not left thinking there is no persistence', async () => {
    // The access gate answers the probe route with 401 until the browser holds
    // its access cookie. Remembering that refusal as "this deployment has no
    // persistence" would hide the stored chapter directory for the rest of the
    // session — including after the gate admits the browser and re-runs the
    // read, which is the whole point of the re-run.
    const calls: unknown[] = [];
    let authorized = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(input);
        return authorized
          ? new Response(JSON.stringify({ persistence: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('', { status: 401 });
      }),
    );
    const fresh = await loadModule();

    expect(await fresh.homeMaterialsSyncAvailable()).toBe(false);
    expect(calls).toHaveLength(1);

    // The gate admits the browser: the same tab asks again and gets the truth.
    authorized = true;
    expect(await fresh.homeMaterialsSyncAvailable()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('remembers a definitive no, so a deployment without persistence is asked once', async () => {
    // The opposite half of the same rule: an answer that arrived is an answer,
    // and re-asking it on every write would be a request per keystroke.
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(input);
        return new Response(JSON.stringify({ persistence: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const fresh = await loadModule();

    expect(await fresh.homeMaterialsSyncAvailable()).toBe(false);
    expect(await fresh.homeMaterialsSyncAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
