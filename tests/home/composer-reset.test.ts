// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stored selection is written through the real persistence module in
 * production; here only the call has to be observed, so the module is replaced
 * wholesale. `vi.hoisted` keeps the spy reachable from the factory, which
 * vitest lifts above the imports.
 */
const { clearStoredHomeSelection } = vi.hoisted(() => ({
  clearStoredHomeSelection: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('@/lib/document/course-material-persistence', () => ({ clearStoredHomeSelection }));

import {
  COMPOSER_DRAFT_KEY,
  HOME_COMPOSER_RESET_EVENT,
  consumePendingHomeComposerReset,
  resetHomeComposer,
} from '@/lib/home/composer-reset';

const PENDING_KEY = 'openmaic:home-composer-reset-pending';

describe('resetHomeComposer', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearStoredHomeSelection.mockReset();
    clearStoredHomeSelection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('drops the draft cache, which is the only reason text survives a route change', () => {
    localStorage.setItem(COMPOSER_DRAFT_KEY, JSON.stringify('a prompt the user typed'));

    resetHomeComposer();

    expect(localStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();
  });

  it('clears the stored chapter selection too, because React state alone would not stick', () => {
    resetHomeComposer();

    expect(clearStoredHomeSelection).toHaveBeenCalledTimes(1);
  });

  it('tells a mounted composer to reset without waiting for the server write', () => {
    // The write is fire-and-forget by design: navigation must not wait on the
    // network. The in-page reset therefore cannot be behind it.
    let releaseWrite: () => void = () => {};
    clearStoredHomeSelection.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseWrite = () => resolve();
      }),
    );
    const seen: string[] = [];
    window.addEventListener(HOME_COMPOSER_RESET_EVENT, () => seen.push('reset'));

    resetHomeComposer();

    expect(seen).toEqual(['reset']);
    releaseWrite();
  });

  it('owes one reset to one mount: the flag is consumed, not read', () => {
    resetHomeComposer();

    expect(consumePendingHomeComposerReset()).toBe(true);
    // A user who returns home, picks a chapter, and leaves again must get that
    // chapter back — so the gesture cannot still be pending the second time.
    expect(consumePendingHomeComposerReset()).toBe(false);
  });

  it('has nothing to repay when no reset was asked for', () => {
    expect(consumePendingHomeComposerReset()).toBe(false);
  });

  it('survives a reload, so a hard refresh is not an escape hatch', async () => {
    // The flag lives in the tab, not in this module's memory. A reload between
    // the click and the home mount is exactly the case a module-level flag
    // would silently lose, so it is asserted against a fresh module instance.
    resetHomeComposer();
    vi.resetModules();
    const reloaded = await import('@/lib/home/composer-reset');

    expect(reloaded.consumePendingHomeComposerReset()).toBe(true);
  });

  it('leaves no pending flag behind once a mounted page has handled it', () => {
    // A mounted page consumes the flag itself — it reset in place, so no later
    // mount should replay the gesture.
    const handleReset = () => consumePendingHomeComposerReset();
    window.addEventListener(HOME_COMPOSER_RESET_EVENT, handleReset);

    resetHomeComposer();

    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    window.removeEventListener(HOME_COMPOSER_RESET_EVENT, handleReset);
  });
});
