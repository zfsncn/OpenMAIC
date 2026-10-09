/**
 * Where the browser remembers an extraction that did not finish, so the next
 * attempt can resume it instead of starting over.
 *
 * ## Why the digest is the key
 *
 * A remote extraction job is identified by the bytes it was submitted for, and
 * the browser already names those bytes by their content digest (computed at
 * upload, stored on the session source). Keying by digest — rather than by
 * file name, which two different files can share — means a resume handle can
 * only ever be handed back for the exact content it belongs to: a re-upload of
 * the *same* file finds it, a different file with the same name does not.
 *
 * ## Why the extractor is part of the entry
 *
 * A handle is opaque to everyone except the extractor that issued it: it names
 * something in that provider's own namespace, nowhere else. Handing one back to
 * a different extractor is not a near miss, it is a handle to nothing — and the
 * failure it produces re-arms itself, because the resulting error still carries
 * a handle, which the next attempt hands to the same wrong extractor. Switching
 * parsers mid-file (exactly what someone does when the current parser is having
 * an outage) is therefore enough to strand a file, so the issuer is recorded
 * with the handle and only that issuer is ever given it back.
 *
 * ## Why session storage, and why a deadline
 *
 * The handle only matters within the browsing session that hit the failure:
 * the user retries, or leaves and comes back to the same tab. A new tab or a
 * browser restart starts clean, which is right — the job has almost certainly
 * finished or been reaped by then, and a stale handle would make the next
 * attempt resume something the service no longer knows about. The deadline is
 * the second half of the same idea, for a tab left open for days.
 *
 * Every operation is best-effort: a browser with storage disabled, in a
 * private mode, or over quota simply gets the old "start over" behaviour.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('ExtractionResumeStore');

const STORAGE_PREFIX = 'openmaic.course-material-extraction-resume.';
/** How long a remembered handle stays usable. */
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** A handle is an opaque upstream id; bound it before it is written or read. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface StoredResume {
  token: string;
  /** The extractor that issued the handle — the only one that can honour it. */
  extractorId: string;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Access itself throws when storage is blocked by policy.
    return null;
  }
}

function keyFor(contentDigest: string): string {
  return `${STORAGE_PREFIX}${contentDigest}`;
}

/**
 * A usable key is only ever a digest-shaped non-empty string.
 */
function isUsableDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16,128}$/i.test(value);
}

/** An issuer is an extractor id: a non-empty, reasonably short token. */
function isUsableExtractorId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

/**
 * Remember that `contentDigest` has an in-flight extraction on `extractorId`,
 * named by `resumeToken`. Ignores anything that is not a usable
 * digest/handle/extractor triple — an unattributable handle is one nothing can
 * ever be given back, so storing it would only be dead weight.
 */
export function rememberExtractionResume(
  contentDigest: string | undefined,
  resumeToken: string,
  extractorId: string | undefined,
): void {
  if (!isUsableDigest(contentDigest) || !isUsableExtractorId(extractorId)) return;
  if (!TOKEN_PATTERN.test(resumeToken)) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      keyFor(contentDigest),
      JSON.stringify({
        token: resumeToken,
        extractorId,
        savedAt: Date.now(),
      } satisfies StoredResume),
    );
  } catch (error) {
    log.debug('Could not remember an extraction resume handle:', error);
  }
}

/**
 * The handle of the extraction `contentDigest` is already waiting on, if there
 * is one that is still worth resuming *by `extractorId`*. Expired or unreadable
 * entries are dropped as they are found, so the store cannot accumulate dead
 * handles.
 *
 * An entry belonging to a different extractor is left where it is rather than
 * deleted: it still names a real job that its own extractor could still resume,
 * and switching parsers is not the same as abandoning that job.
 */
export function recallExtractionResume(
  contentDigest: string | undefined,
  extractorId: string | undefined,
): string | undefined {
  if (!isUsableDigest(contentDigest)) return undefined;
  const store = storage();
  if (!store) return undefined;
  const key = keyFor(contentDigest);
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const parsed = ((): StoredResume | null => {
    try {
      const value = JSON.parse(raw) as Partial<StoredResume>;
      return typeof value.token === 'string' &&
        typeof value.savedAt === 'number' &&
        typeof value.extractorId === 'string'
        ? { token: value.token, extractorId: value.extractorId, savedAt: value.savedAt }
        : null;
    } catch {
      return null;
    }
  })();
  if (!parsed || Date.now() - parsed.savedAt > MAX_AGE_MS) {
    forgetExtractionResume(contentDigest);
    return undefined;
  }
  if (!TOKEN_PATTERN.test(parsed.token)) {
    forgetExtractionResume(contentDigest);
    return undefined;
  }
  if (!isUsableExtractorId(extractorId) || parsed.extractorId !== extractorId) return undefined;
  return parsed.token;
}

/** Drop the remembered handle for `contentDigest` (on success, or on expiry). */
export function forgetExtractionResume(contentDigest: string | undefined): void {
  if (!isUsableDigest(contentDigest)) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(contentDigest));
  } catch (error) {
    log.debug('Could not clear an extraction resume handle:', error);
  }
}
