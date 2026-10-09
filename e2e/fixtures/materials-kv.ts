import type { Page } from '@playwright/test';

/**
 * The home page's chapter directory, faked **in the browser** for e2e tests.
 *
 * ## Why the directory is never seeded through the API
 *
 * The directory is stored under ONE global key (`home.courseMaterials.v2`), in
 * the `account` scope, and a deployment that runs single-user has exactly one
 * account. Seeding it through the API therefore overwrites the directory of
 * whoever is using the app, and clearing it through the API **deletes their
 * uploaded chapter list** — an unattended test that eats user data. (That is
 * not hypothetical: an earlier revision of one spec did exactly that.)
 *
 * So the directory is served from an in-memory stub via `page.route`, and the
 * requests never reach the server. Every other request passes through
 * untouched, and the app under test still believes persistence is on, because
 * that probe (`/api/agent/runtime`) is a read.
 *
 * Installing the stub is only half of it: visiting `/` is enough on its own to
 * write the key back (the home page holds the whole list in memory and stores
 * it), so a spec that skipped the stub would perform a same-value overwrite of
 * the deployment user's chapter list. Install it in `beforeEach`, before the
 * first navigation, so the read that mounts the panel is already fake.
 */

export const MATERIALS_KV_KEY = 'home.courseMaterials.v2';
export const MATERIALS_KV_KEY_V1 = 'home.courseMaterials.v1';

/** A 64-hex digest; enough for `isCourseMaterialUsable` with no bytes present. */
export function fakeDigest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

/** The stub's whole state: the value the key currently holds. */
export interface MaterialsKvStub {
  value: unknown;
}

/**
 * Serve (and swallow) the chapter-directory key from memory, for the lifetime
 * of the page. Installed before the first navigation so the initial read is
 * already fake.
 */
export async function installMaterialsKvStub(page: Page): Promise<MaterialsKvStub> {
  const stub: MaterialsKvStub = { value: null };
  await page.route('**/api/kv/entries/**', async (route) => {
    const request = route.request();
    const key = decodeURIComponent(
      new URL(request.url()).pathname.split('/api/kv/entries/')[1] ?? '',
    );
    // Any other key belongs to some other feature; it is not this spec's
    // business and must behave exactly as it would without the stub.
    if (key !== MATERIALS_KV_KEY && key !== MATERIALS_KV_KEY_V1) return route.fallback();

    switch (request.method()) {
      case 'GET':
        if (stub.value === null) {
          return route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'KEY_NOT_FOUND', message: 'no value is stored under this key' },
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ value: stub.value }),
        });
      case 'PUT':
        stub.value = (request.postDataJSON() as { value: unknown }).value;
        return route.fulfill({ status: 204, body: '' });
      case 'DELETE':
        stub.value = null;
        return route.fulfill({ status: 204, body: '' });
      default:
        return route.fulfill({ status: 405, body: '' });
    }
  });
  return stub;
}

/** Put a directory in the stub. The page must be reloaded to read it again. */
export function seedMaterialsKv(
  stub: MaterialsKvStub,
  names: readonly string[],
  /**
   * File every seeded chapter under this folder. Filed chapters are hidden at
   * the root (`courseMaterialsInView` shows unfiled ones), so this is the only
   * way to reach the "selected a chapter inside a folder" state — which is
   * where the composer's reset rules diverge.
   */
  folderId?: string,
): void {
  stub.value = {
    version: 2,
    selectedMaterialId: null,
    materials: names.map((name, index) => ({
      id: `material-${index + 1}`,
      name,
      size: 1024 * (index + 1),
      lastModified: 1_700_000_000_000 + index,
      type: 'text/markdown',
      order: index + 1,
      ...(folderId ? { folderId } : {}),
      storageKey: `storage-${index + 1}`,
      contentDigest: fakeDigest(`${index + 1}`),
    })),
  };
}
