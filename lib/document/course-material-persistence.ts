/**
 * The homepage's course-material directory, persisted across devices.
 *
 * The directory used to live only in the page's React state, so entering the
 * classroom (and the unmount that follows) took it with it; a reload took it
 * too. This module keeps the *list* — which chapters, in which order, with
 * their names and sizes — in the `account` scope of the KV store, which a
 * server-backed deployment syncs across devices.
 *
 * ## The list and the bytes are two different things
 *
 * The bytes stay where they have always been: IndexedDB, local to this device
 * (`storePdfBlob`). Only the list travels. That split is what makes one stored
 * list serve both cases without a second code path:
 *
 * - **Same device.** The `storageKey` still resolves to the file's bytes, so
 *   the entry is rebuilt into a real `File` and the chapter is as usable as it
 *   was before the reload.
 * - **Another device.** The key resolves to nothing, so the entry keeps its
 *   place in the directory with `file` absent — visible, but marked as needing
 *   the file selected again before it can be generated from.
 *
 * A browser with no server (no `DATABASE_URL`) simply never syncs: the probe
 * reports persistence unavailable and every call here is a no-op, leaving the
 * in-memory directory exactly as it behaves today.
 *
 * ## One list, many folders
 *
 * Folders group the homepage's *generated courses*, and the chapter directory
 * follows them: opening a folder shows that folder's materials. The list stays
 * single, though — each entry carries the `folderId` it is filed under, and the
 * active folder is applied as a filter over the whole list (`courseMaterialsInView`).
 *
 * Keeping one record is what makes the feature cheap and safe. Nothing has to
 * be read from a *different* key when the view changes, so the restore still
 * runs once on mount, `order` still means "position in the list being shown",
 * and a folder that was never opened has no stored state to get wrong. Only
 * the empty case needs care: an empty list means "no directory", which is why
 * a folder's last chapter being removed is not the same event as the whole
 * directory being emptied (see `persistHomeMaterials`).
 *
 * ## An empty list is two different facts
 *
 * "The user's directory is empty" and "this tab has not read the directory
 * yet" both arrive here as a list of length zero, and they must not be spelled
 * the same way. The store replaces the whole record on every write, so an
 * empty list being taken for the first when it is really the second deletes
 * the directory outright — the user's chapter list vanishes, and neither
 * reloading nor reopening the folder brings it back, because the bytes are
 * gone from the store rather than hidden from the view.
 *
 * So erasure is asked for, never inferred: `writeHomeMaterials` refuses an
 * empty list unless the caller passes `allowEmpty`, and the caller may only
 * pass it once `readHomeMaterialsResult` has reported `answered`. Reading is
 * where the two facts come apart — see `HomeMaterialsReadResult`.
 *
 * An empty payload is a third thing again, and it is refused outright: a row
 * whose bytes have not finished being captured has no `storageKey` and does not
 * survive serialization, so attaching a chapter produces a write whose payload
 * is empty while the directory is not. Erasing there would delete the record
 * and rebuild it from a later write — or lose it, if that write never lands.
 *
 * What that covers is the two facts a list cannot tell apart on its own. It
 * does not make the record concurrency-safe: a tab that read the directory as
 * empty and later attaches and removes a chapter still writes its own (now
 * empty) list over one another device wrote in between. That is this record's
 * last-writer-wins property rather than an erasure bug — the same tab would
 * have overwritten the directory the moment it attached anything — and closing
 * it takes a revision stamp on the record, not a stricter empty case.
 *
 * ## Keys and shape
 *
 * The key is versioned in its own name (`…v1`), so a future shape change adds
 * a key rather than migrating this one in place. What comes back off the wire
 * is `unknown` and is validated field by field before it reaches React: a
 * stored value is written by whatever version of the app wrote it last, and a
 * row that failed validation must degrade to "nothing stored", never to a
 * half-built chapter list.
 */
'use client';

import { BrowserKVStore, HttpKVStore } from '@openmaic/storage';

import { createLogger } from '@/lib/logger';
import type { SelectedCourseMaterial } from '@/lib/types/generation';
import { loadPdfBlob } from '@/lib/utils/image-storage';

const log = createLogger('HomeMaterials');

/**
 * Versioned in the key: a shape change gets a new key, not a migration.
 *
 * `v2` is the digest generation. It is a new key rather than a new field on the
 * old one because the two directions differ:
 *
 * - **Reading** is a chain: `v2` first, then `v1`. A directory written before
 *   this version is still a directory, and its entries are still valid rows
 *   (the only thing they lack is a digest), so the fallback keeps a user's
 *   chapters instead of appearing to lose them.
 * - **Writing** is `v2` only, and the `v1` row is dropped once `v2` lands. So
 *   the old key cannot linger as a stale duplicate that a later read would
 *   prefer.
 */
export const HOME_MATERIALS_KV_KEY = 'home.courseMaterials.v2';

/** The pre-digest key. Read as a fallback; never written. */
export const HOME_MATERIALS_KV_KEY_V1 = 'home.courseMaterials.v1';

/** One entry as it travels: everything the directory renders, plus the key. */
export interface PersistedCourseMaterial {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  order: number;
  /**
   * The folder this entry is filed under, or absent for an unfiled one.
   *
   * Optional, and that is load-bearing in both directions: a row written
   * before folders existed is an unfiled row, which is exactly what it was, so
   * no list has to be migrated and no new key version is needed. A reader that
   * does not know about this field ignores it and shows every entry unfiled —
   * a degraded view, never a broken one.
   */
  folderId?: string;
  storageKey: string;
  /**
   * SHA-256 (hex) of this entry's bytes. Optional because a `v1` row — or a
   * device in a non-secure context, where `crypto.subtle` is unavailable —
   * carries none, and the directory must survive that.
   */
  contentDigest?: string;
}

export interface PersistedHomeMaterials {
  version: 2;
  materials: PersistedCourseMaterial[];
  selectedMaterialId: string | null;
}

let kvStore: HttpKVStore | null = null;

/**
 * The KV client. Same-origin, so the base URL is a bare path — and it is the
 * root *before* the contract's own `/kv/...` paths, not the `/kv` prefix
 * itself (`HttpAccountKV` appends `/kv/entries/{key}`). `device` is routed to
 * browser storage and is never used here: this module only touches `account`.
 */
function getKvStore(): HttpKVStore | null {
  if (typeof window === 'undefined') return null;
  kvStore ??= new HttpKVStore({ baseUrl: '/api', deviceStore: new BrowserKVStore() });
  return kvStore;
}

let persistenceProbe: Promise<boolean> | null = null;

/** The probe's outcome: did the server answer, and what did it say? */
interface PersistenceProbeOutcome {
  /** False when the request was refused or never arrived — not an answer. */
  answered: boolean;
  available: boolean;
}

async function probePersistence(): Promise<PersistenceProbeOutcome> {
  try {
    const response = await fetch('/api/agent/runtime');
    if (!response.ok) return { answered: false, available: false };
    const body = (await response.json()) as { persistence?: unknown } | null;
    return { answered: true, available: body?.persistence === true };
  } catch {
    return { answered: false, available: false };
  }
}

/**
 * Whether this deployment syncs `account` values. Memoized so the tab asks
 * once, but **only a definitive answer is kept**: on an access-code-gated
 * deployment this probe runs before the browser holds its access cookie, the
 * middleware refuses it with 401, and remembering that refusal as "this
 * deployment has no persistence" would hide the stored chapter directory for
 * the rest of the session — even after the gate admits the browser and
 * re-runs the read. An unanswered probe is therefore asked again, so the
 * answer can still change from no to yes within one page's lifetime.
 *
 * This is asked before any KV call rather than inferred from a failed one. A
 * read that fails is not a read that found nothing — the two must not be
 * spelled the same way, or an outage on a server-backed deployment would look
 * exactly like "you never had a chapter list" and quietly erase the user's
 * directory on the next write.
 */
export function homeMaterialsSyncAvailable(): Promise<boolean> {
  persistenceProbe ??= probePersistence().then((probe) => {
    if (!probe.answered) persistenceProbe = null;
    return probe.available;
  });
  return persistenceProbe;
}

function isPersistedMaterial(value: unknown): value is PersistedCourseMaterial {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    typeof entry.lastModified === 'number' &&
    Number.isFinite(entry.lastModified) &&
    typeof entry.type === 'string' &&
    typeof entry.order === 'number' &&
    Number.isFinite(entry.order) &&
    typeof entry.storageKey === 'string' &&
    entry.storageKey !== '' &&
    // Optional, but if it is present it has to name a folder: an empty string
    // would be indistinguishable from "unfiled" at every later comparison, and
    // would put the row in a view that can never be reached.
    (entry.folderId === undefined ||
      (typeof entry.folderId === 'string' && entry.folderId !== '')) &&
    // Optional, but if it is present it has to be a digest: an empty string
    // would be indistinguishable from "unknown" at every later comparison.
    (entry.contentDigest === undefined ||
      (typeof entry.contentDigest === 'string' && entry.contentDigest !== ''))
  );
}

/** Narrow the stored value to something the directory can render, or `null`. */
function parsePersistedHomeMaterials(raw: unknown): PersistedHomeMaterials | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.materials)) return null;
  const materials = value.materials.filter(isPersistedMaterial);
  // A list that was entirely unreadable is not a list; report "nothing here"
  // rather than an empty directory the user cannot explain.
  if (materials.length === 0 && value.materials.length > 0) {
    log.warn('The stored chapter list had no readable entries; ignoring it');
    return null;
  }
  const selected = value.selectedMaterialId;
  return {
    version: 2,
    materials,
    selectedMaterialId: typeof selected === 'string' ? selected : null,
  };
}

/**
 * The entries to store for the current directory.
 *
 * `order` counts within a folder rather than across the whole list, so the
 * sort groups by folder first — otherwise every folder's first chapter would
 * be written together, then every folder's second, and the stored array would
 * bear no resemblance to any view. Row order in the stored array is cosmetic,
 * not load-bearing: each entry carries its own `order`, and that is what every
 * reader uses.
 */
export function toPersistedMaterials(
  materials: readonly SelectedCourseMaterial[],
): PersistedCourseMaterial[] {
  return [...materials]
    .sort((a, b) => {
      const folderA = a.folderId ?? '';
      const folderB = b.folderId ?? '';
      if (folderA !== folderB) return folderA < folderB ? -1 : 1;
      return a.order - b.order;
    })
    .filter((material): material is SelectedCourseMaterial & { storageKey: string } =>
      Boolean(material.storageKey),
    )
    .map((material) => ({
      id: material.id,
      name: material.name,
      size: material.size,
      lastModified: material.lastModified,
      type: material.type,
      order: material.order,
      ...(material.folderId ? { folderId: material.folderId } : {}),
      storageKey: material.storageKey,
      ...(material.contentDigest ? { contentDigest: material.contentDigest } : {}),
    }));
}

/**
 * What a read found, and whether the store was in a position to say.
 *
 * `answered` is the field that matters, and it is deliberately not derivable
 * from `stored`: a read that was refused (no access cookie yet), that timed out,
 * or that hit a server error comes back with no directory exactly as a read of
 * an empty store does. Code that only ever looks at `stored` cannot tell "there
 * is nothing there" from "I could not find out", and the write path needs the
 * difference — it is the difference between erasing a directory and leaving one
 * alone.
 */
export interface HomeMaterialsReadResult {
  /** True only when the store was consulted and replied. */
  answered: boolean;
  /** What it said: the directory, or `null` when it holds none. */
  stored: PersistedHomeMaterials | null;
}

/**
 * Read the stored directory, or `null` when there is none (or no sync).
 *
 * Loses `answered`; prefer {@link readHomeMaterialsResult} where the difference
 * matters (i.e. anywhere the result may lead to a write).
 */
export async function readHomeMaterials(): Promise<PersistedHomeMaterials | null> {
  return (await readHomeMaterialsResult()).stored;
}

/**
 * Read the stored directory, keeping the answer apart from the absence.
 *
 * A deployment that does not sync `account` values reports `answered: false`
 * rather than "yes, it is empty". It could argue the other way — such a
 * deployment has no directory and never grows one — but calling that an answer
 * would make `answered` mean two unrelated things, and it buys nothing: a write
 * on such a deployment already returns early at the availability check, so
 * nothing downstream behaves differently. Keeping the field to one meaning is
 * what lets callers treat it as a fact rather than a hint.
 */
export async function readHomeMaterialsResult(): Promise<HomeMaterialsReadResult> {
  if (!(await homeMaterialsSyncAvailable())) return { answered: false, stored: null };
  const kv = getKvStore();
  if (!kv) return { answered: false, stored: null };
  try {
    // The digest generation first, then the pre-digest one it replaced: a
    // directory stored before this version is still a directory. Both keys
    // answered, so a store holding nothing is a store that said so.
    const current = await kv.get<unknown>(HOME_MATERIALS_KV_KEY, 'account');
    const parsed = parsePersistedHomeMaterials(current);
    if (parsed) return { answered: true, stored: parsed };
    const legacy = await kv.get<unknown>(HOME_MATERIALS_KV_KEY_V1, 'account');
    return { answered: true, stored: parsePersistedHomeMaterials(legacy) };
  } catch (error) {
    // A read that failed is not an empty directory: say nothing and leave the
    // in-memory list alone, so a transient failure cannot look like data loss.
    log.warn('Could not read the stored chapter list:', error);
    return { answered: false, stored: null };
  }
}

/**
 * Serialize writes. Every change issues one, and they are issued in render
 * order but would travel concurrently — attaching several files updates the
 * list once per file as each one's bytes land, and the contract is
 * last-writer-wins per *request*, so an earlier snapshot arriving late would
 * become the stored value and silently undo a later edit. One chain keeps
 * arrival order equal to issue order.
 *
 * `state.materials` must be the **whole** directory, never the folder on
 * screen. Writes replace the stored list, so handing this a filtered subset
 * would delete every other folder's rows — and an empty subset would erase the
 * record outright, once the caller has opted into that (see
 * `WriteHomeMaterialsOptions`). The caller holds the unfiltered list; filtering
 * is a view concern and does not reach this module.
 */
let writeChain: Promise<void> = Promise.resolve();

/** Options for {@link writeHomeMaterials}. */
export interface WriteHomeMaterialsOptions {
  /**
   * Whether an empty list may **erase** the stored directory. Default `false`.
   *
   * Opt in only when the stored directory has been read on this page (see
   * `readHomeMaterialsResult`) and the empty list is therefore the user's own
   * doing — the last chapter of the last folder being removed. A page that has
   * not read the store cannot make that claim, and an accidental deletion here
   * is unrecoverable: the bytes live in the store, not on the device, so no
   * reload can bring the directory back.
   */
  allowEmpty?: boolean;
}

/**
 * Store the current directory. Best-effort: a failure never blocks the UI.
 *
 * An empty `materials` is refused by default — see `WriteHomeMaterialsOptions`.
 */
export function writeHomeMaterials(
  state: {
    materials: readonly SelectedCourseMaterial[];
    selectedMaterialId: string | null;
  },
  options?: WriteHomeMaterialsOptions,
): Promise<void> {
  const allowEmpty = options?.allowEmpty === true;
  const next = writeChain.then(
    () => persistHomeMaterials(state, allowEmpty),
    () => persistHomeMaterials(state, allowEmpty),
  );
  writeChain = next.catch(() => undefined);
  return next;
}

async function persistHomeMaterials(
  state: {
    materials: readonly SelectedCourseMaterial[];
    selectedMaterialId: string | null;
  },
  allowEmpty: boolean,
): Promise<void> {
  if (!(await homeMaterialsSyncAvailable())) return;
  const kv = getKvStore();
  if (!kv) return;
  const payload: PersistedHomeMaterials = {
    version: 2,
    materials: toPersistedMaterials(state.materials),
    selectedMaterialId: state.selectedMaterialId,
  };
  if (payload.materials.length === 0) {
    // An empty **payload** is not an empty **directory**, and only the second
    // one may erase anything. A row whose bytes are still being captured has no
    // `storageKey` yet and is filtered out by `toPersistedMaterials`, so a
    // batch attach reaches here with a list of one and a payload of none. There
    // is nothing to store — the row is written again a moment later, once its
    // key lands — but there is also nothing to erase, and treating this as "the
    // user emptied the directory" deletes the record and leaves the directory
    // to be rebuilt from whichever write arrives next. If that write never
    // lands, the directory is simply gone.
    if (state.materials.length > 0) return;
    // Nothing to remember, so the rows are dropped rather than left stale: an
    // empty directory is the pristine homepage, which is the absence of a saved
    // list, not a list of zero chapters.
    //
    // But "empty" is also what a list looks like before the stored one has been
    // read, and the two are indistinguishable from here — which is why the
    // erasure is asked for rather than inferred. A caller that skipped the read
    // gets a warning and keeps its (stale) row; the cost is a directory that
    // outlives its last chapter by one successful read, against a directory
    // that cannot be recovered at all.
    if (!allowEmpty) {
      log.warn(
        'Refusing to erase the stored chapter directory: the in-memory list is empty and ' +
          'the stored directory was not read first. Pass `allowEmpty` once the read has ' +
          'answered (see readHomeMaterialsResult).',
      );
      return;
    }
    await removeStoredHomeMaterials(kv);
    return;
  }
  try {
    await kv.set(HOME_MATERIALS_KV_KEY, payload, 'account');
    // The pre-digest row is superseded the moment `v2` lands; leaving it would
    // let a later read find a stale duplicate. Best-effort: a failure here
    // costs a redundant row, never a directory.
    await kv.remove(HOME_MATERIALS_KV_KEY_V1, 'account').catch((error: unknown) => {
      log.warn('Could not clear the superseded chapter list:', error);
    });
  } catch (error) {
    log.warn('Could not store the chapter list:', error);
  }
}

/**
 * Drop the stored chapter *selection*, keeping the directory itself.
 *
 * The directory is written whole (`writeHomeMaterials` replaces the stored
 * list), so "clear the selection" cannot be expressed as a field write — it is
 * a read-modify-write, and it has to go through `writeChain` for the same
 * reason every other write does: hand the store a snapshot taken before a
 * concurrent edit and that edit is silently undone.
 *
 * Reads with `readHomeMaterials`, so a directory stored under the pre-digest
 * key is carried forward rather than dropped, and the superseded row is removed
 * once the new one lands — exactly as `persistHomeMaterials` does it.
 */
export function clearStoredHomeSelection(): Promise<void> {
  const next = writeChain.then(persistClearedSelection, persistClearedSelection);
  writeChain = next.catch(() => undefined);
  return next;
}

async function persistClearedSelection(): Promise<void> {
  if (!(await homeMaterialsSyncAvailable())) return;
  const kv = getKvStore();
  if (!kv) return;
  try {
    const stored = await readHomeMaterials();
    // Nothing selected, nothing to clear: writing anyway would be a no-op that
    // still costs a request, and would rewrite a directory we did not change.
    if (!stored || stored.selectedMaterialId === null) return;
    await kv.set(HOME_MATERIALS_KV_KEY, { ...stored, selectedMaterialId: null }, 'account');
    await kv.remove(HOME_MATERIALS_KV_KEY_V1, 'account').catch((error: unknown) => {
      log.warn('Could not clear the superseded chapter list:', error);
    });
  } catch (error) {
    // Best-effort, like every write here: a failure costs a stale selection,
    // never a directory.
    log.warn('Could not clear the stored chapter selection:', error);
  }
}

/** Remove both the current and the pre-digest rows. */
async function removeStoredHomeMaterials(kv: HttpKVStore): Promise<void> {
  for (const key of [HOME_MATERIALS_KV_KEY, HOME_MATERIALS_KV_KEY_V1]) {
    try {
      await kv.remove(key, 'account');
    } catch (error) {
      log.warn('Could not clear the stored chapter list:', error);
    }
  }
}

/** Remove the stored directory. */
export async function clearHomeMaterials(): Promise<void> {
  if (!(await homeMaterialsSyncAvailable())) return;
  const kv = getKvStore();
  if (!kv) return;
  await removeStoredHomeMaterials(kv);
}

/**
 * Rebuild the directory from a stored list: every entry keeps its place, and
 * each one recovers its `File` from this device's IndexedDB when the bytes are
 * still here.
 *
 * A `file` that cannot be recovered is not an error — it is the cross-device
 * case the list exists for, and the row stays visible without one.
 */
export async function restoreCourseMaterials(
  stored: PersistedHomeMaterials,
): Promise<SelectedCourseMaterial[]> {
  const restored = await Promise.all(
    stored.materials.map(async (entry): Promise<SelectedCourseMaterial> => {
      const base = {
        id: entry.id,
        name: entry.name,
        size: entry.size,
        lastModified: entry.lastModified,
        type: entry.type,
        order: entry.order,
        ...(entry.folderId ? { folderId: entry.folderId } : {}),
        storageKey: entry.storageKey,
        ...(entry.contentDigest ? { contentDigest: entry.contentDigest } : {}),
      };
      try {
        const blob = await loadPdfBlob(entry.storageKey);
        if (!blob) return base;
        return {
          ...base,
          // Rebuild a real `File` so a restored chapter is byte-identical to
          // the one that was uploaded, and generation proceeds with no
          // re-upload on this device.
          file: new File([blob], entry.name, {
            type: entry.type || blob.type,
            lastModified: entry.lastModified,
          }),
        };
      } catch (error) {
        log.warn(`Could not restore the bytes for ${entry.name}:`, error);
        return base;
      }
    }),
  );
  return restored;
}
