/**
 * "Back to home" is one gesture with one outcome: the composer starts clean.
 *
 * The home composer has no single owner to reset. Its text is `useState` on the
 * home page; its selected chapter is server state in the KV directory; and its
 * draft cache is a `localStorage` row. A return-to-home can be issued from six
 * different routes — the classroom's logo and header arrow, the edit rail's
 * logo and command bar, the generation preview's two back buttons, and the
 * classroom's not-found link — and every one of them has to produce the same
 * visible result. Doing that per button is how the six drifted apart in the
 * first place (a classroom return came back clean, a folder return did not), so
 * the reset lives here and each entry point calls exactly one function.
 *
 * ## Three things have to be cleared, and only one of them is React state
 *
 * - **The draft cache** (`localStorage['requirementDraft']`) is the only reason
 *   text survives a route change. Removing the row before navigating is enough:
 *   the next mount hydrates from nothing.
 * - **The chapter selection** is stored on the server, so it has to be cleared
 *   there too — clearing it in React alone would be undone by the next restore.
 *   That write is fire-and-forget (`clearStoredHomeSelection`) and can lose a
 *   race against the home page's own mount-time restore, which is what the
 *   pending flag below exists for.
 * - **The live composer**, when the user never left the home page — leaving a
 *   folder is a view change, not a route change, so nothing remounts and the
 *   stale sentence would just stay on screen. The event below is how a mounted
 *   page hears about it.
 *
 * ## The pending flag is not bookkeeping — it is the fix for a real race
 *
 * `clearStoredHomeSelection` reads the stored directory and writes it back with
 * the selection dropped, so it cannot land instantly. Navigating happens right
 * away, which means the home page's restore can read the row *before* that
 * write arrives and bring the old selection back — a bug that shows up as "the
 * reset works, except when the server is quick". The flag records the intent
 * synchronously, and the restore prefers it over the stored value, so the
 * outcome no longer depends on which request won.
 *
 * A mounted page consumes the flag itself: it handled the reset in place, so no
 * later mount should replay it.
 */
'use client';

import { clearStoredHomeSelection } from '@/lib/document/course-material-persistence';

/** The draft-cache key the composer hydrates from (`useDraftCache`). */
export const COMPOSER_DRAFT_KEY = 'requirementDraft';

/** Dispatched on `window` so a *mounted* home page resets in place. */
export const HOME_COMPOSER_RESET_EVENT = 'openmaic:home-composer-reset';

/**
 * Set when a reset is issued from another route, consumed by the next home
 * mount. Per tab, and surviving a reload, because both are things the gesture
 * has to outlive: the user asked for a clean home, not for a clean home until
 * the next hard refresh.
 */
const PENDING_RESET_KEY = 'openmaic:home-composer-reset-pending';

function readSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Private mode, or a context without storage. The reset still works for the
    // rest of this page's life; only the cross-route carry stops working.
    return null;
  }
}

function clearComposerDraft(): void {
  try {
    window.localStorage.removeItem(COMPOSER_DRAFT_KEY);
  } catch {
    /* ignore — nothing was cached, or storage is unavailable */
  }
}

/**
 * Reset the home composer to its pristine state.
 *
 * Safe to call from any route and any entry point, before the navigation. It
 * never awaits: navigation must not wait on a network write, and a failed write
 * degrades to "the selection comes back on a later mount", never to a blocked
 * back button.
 */
export function resetHomeComposer(): void {
  if (typeof window === 'undefined') return;
  clearComposerDraft();
  readSessionStorage()?.setItem(PENDING_RESET_KEY, '1');
  window.dispatchEvent(new Event(HOME_COMPOSER_RESET_EVENT));
  void clearStoredHomeSelection();
}

/**
 * Whether a reset is owed to the page being mounted now, clearing the flag.
 *
 * Consumed rather than read so one gesture resets one home view: a user who
 * returns home, picks a chapter, and leaves again gets that chapter back.
 */
export function consumePendingHomeComposerReset(): boolean {
  const storage = readSessionStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(PENDING_RESET_KEY) === null) return false;
    storage.removeItem(PENDING_RESET_KEY);
    return true;
  } catch {
    return false;
  }
}
