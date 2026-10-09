/**
 * The browser's store for an interrupted extraction's resume handle.
 *
 * Three properties matter and are easy to get wrong: a handle may only ever
 * come back for the exact content it was stored for (which is why the digest,
 * not the file name, is the key), only back to the extractor that issued it
 * (a handle means nothing in another provider's namespace, and the failure of
 * handing it over anyway re-arms itself), and it must expire — a stale handle
 * would make the next attempt resume a job the service no longer knows about.
 *
 * Every path is best-effort, so the storage-unavailable cases are asserted
 * rather than assumed: a browser with storage disabled must get the old
 * "start over" behaviour, not an exception.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  forgetExtractionResume,
  recallExtractionResume,
  rememberExtractionResume,
} from '@/lib/document/extraction-resume-store';

/** A `Storage` the test owns, so entries can be inspected and corrupted. */
class MemoryStorage {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
/** The extractor that issued the handles in these tests. */
const EXTRACTOR = 'alidocmind';
/** A different extractor that must never be given the same handle. */
const OTHER_EXTRACTOR = 'unpdf';

describe('extraction resume store', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    storage = new MemoryStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('round-trips a handle for the digest it belongs to, and no other', () => {
    rememberExtractionResume(DIGEST, 'batch-1', EXTRACTOR);

    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBe('batch-1');
    // Two files can share a name; only the bytes decide which job a handle
    // belongs to, so a different digest must not find it.
    expect(recallExtractionResume(OTHER_DIGEST, EXTRACTOR)).toBeUndefined();
  });

  it('will not release a handle to an extractor that did not issue it', () => {
    rememberExtractionResume(DIGEST, 'job-1', OTHER_EXTRACTOR);

    // A handle names something in its issuer's namespace and nothing anywhere
    // else, so the other extractor must start over...
    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBeUndefined();
    // ...and the entry is left where it is: it still names a real job that its
    // own extractor could resume, and switching parsers is not abandoning it.
    expect(recallExtractionResume(DIGEST, OTHER_EXTRACTOR)).toBe('job-1');
  });

  it('will not release a handle to a caller that names no extractor', () => {
    rememberExtractionResume(DIGEST, 'batch-1', EXTRACTOR);

    expect(recallExtractionResume(DIGEST, undefined)).toBeUndefined();
  });

  it('forgets a handle that is older than a day, and drops it as it is found', () => {
    rememberExtractionResume(DIGEST, 'batch-1', EXTRACTOR);
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));

    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  it('ignores anything that is not a usable digest, handle and issuer triple', () => {
    rememberExtractionResume(undefined, 'batch-1', EXTRACTOR);
    rememberExtractionResume('not-a-digest', 'batch-1', EXTRACTOR);
    rememberExtractionResume(DIGEST, '../../etc/passwd', EXTRACTOR);
    rememberExtractionResume(DIGEST, '', EXTRACTOR);
    // Without an issuer the handle could never be handed back to anyone, so
    // storing it would only be dead weight.
    rememberExtractionResume(DIGEST, 'batch-1', undefined);
    rememberExtractionResume(DIGEST, 'batch-1', '');

    expect(storage.length).toBe(0);
  });

  it('clears the handle once the job is no longer in flight', () => {
    rememberExtractionResume(DIGEST, 'batch-1', EXTRACTOR);
    forgetExtractionResume(DIGEST);

    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  it('drops an entry written before the issuer was recorded', () => {
    // An entry from the previous shape names a handle with no way to tell whose
    // it is. Guessing would reintroduce exactly the cross-extractor hand-off
    // this guards against, so it is dropped and the next attempt starts over.
    storage.setItem(
      `openmaic.course-material-extraction-resume.${DIGEST}`,
      JSON.stringify({ token: 'batch-1', savedAt: Date.now() }),
    );

    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  it('degrades to "start over" when storage is blocked', () => {
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('storage is blocked by policy');
      },
    });

    expect(() => rememberExtractionResume(DIGEST, 'batch-1', EXTRACTOR)).not.toThrow();
    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBeUndefined();
    expect(() => forgetExtractionResume(DIGEST)).not.toThrow();
  });

  it('drops an entry it cannot read', () => {
    rememberExtractionResume(DIGEST, 'batch-1', EXTRACTOR);
    const key = storage.key(0);
    expect(key).not.toBeNull();
    storage.setItem(key as string, '{ not json');

    expect(recallExtractionResume(DIGEST, EXTRACTOR)).toBeUndefined();
    expect(storage.length).toBe(0);
  });
});
