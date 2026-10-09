import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * Admitting the browser has to make the library appear.
 *
 * The access gate renders its children unconditionally, so the home page
 * mounts — and fires its one-shot library load — before any access cookie
 * exists. The middleware answers that first load with 401, and nothing asks
 * again on its own. The gate fixes this the same way it already fixed the
 * server-provider list: by re-fetching on success. The failure this guards
 * against is silent — an empty library that looks like an empty library
 * rather than a locked one — so it is asserted at the source, where the
 * ordering and the listener both live.
 */
describe('access gate library reload', () => {
  const guard = () => source('components/access-code-guard.tsx');

  it('broadcasts that the library changed once the code is accepted', () => {
    // The home page subscribes to this event, so the gate broadcasts rather
    // than duplicating the home page's loading logic here.
    expect(guard()).toContain('window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));');
  });

  it('imports the broadcast from the module that owns it', () => {
    // Dispatch and subscribe must name the same string. Sharing the constant
    // is what makes that a fact rather than a coincidence.
    expect(guard()).toContain("import { LIBRARY_CHANGED_EVENT } from '@/lib/utils/stage-storage';");
  });

  it('broadcasts after the provider re-fetch, not instead of it', () => {
    // Both 401s are the same 401. Ordering is the intent: the gate is saying
    // "two things you asked for before are now answerable", and a future
    // edit that drops one of them should fail here.
    const text = guard();
    const providers = text.indexOf('void useSettingsStore.getState().fetchServerProviders();');
    const broadcast = text.indexOf('window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));');
    expect(providers, 'the provider re-fetch must exist').toBeGreaterThan(-1);
    expect(broadcast, 'the broadcast must exist').toBeGreaterThan(-1);
    expect(broadcast, 'the broadcast must follow the provider re-fetch').toBeGreaterThan(providers);
  });

  it('has a listener on the home page for the broadcast to land on', () => {
    // The positive counterpart to the broadcast: without this subscription
    // the dispatch above would be a no-op and the test would still pass.
    const home = source('app/page.tsx');
    expect(home).toContain('window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);');
    expect(home).toContain('void Promise.all([loadClassrooms(), loadFolders()]);');
  });

  it('re-reads the chapter directory on the same broadcast', () => {
    // The chapter directory is a third read caught by the same 401 — it runs
    // on mount too, so a folder opened right after unlocking reported "no
    // chapters yet" until a reload. Reloading the course list alone would
    // show the folder and then leave it empty, which is worse than not
    // showing it.
    const home = source('app/page.tsx');
    const start = home.indexOf('const restoreDirectory = async () => {');
    expect(start, 'the directory restore must exist').toBeGreaterThan(-1);
    const branch = home.slice(start, start + 2500);
    expect(branch).toContain('const onLibraryChanged = () => {');
    expect(branch).toContain('void restoreDirectory();');
    expect(branch).toContain('window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);');
    expect(branch).toContain(
      'window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);',
    );
  });

  it('does not report a locked library as a broken one', () => {
    // The mount-time load hits the same 401. Reporting "persistence is
    // unavailable" beside the gate modal reads as a corrupted library, so the
    // 401 is left to the gate and only real failures raise the toast.
    const home = source('app/page.tsx');
    expect(home).toContain("if (!String(err).includes('HTTP 401')) {");
    expect(home).toContain(
      "toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');",
    );
  });
});
