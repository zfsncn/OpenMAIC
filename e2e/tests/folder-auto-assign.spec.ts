import { test, expect } from '../fixtures/base';
import type { Page, Request } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { installMaterialsKvStub } from '../fixtures/materials-kv';
import { retireServerDocument } from '../fixtures/server-seed';

/**
 * A course generated from inside a folder is filed into that folder, and one
 * generated from the root is not.
 *
 * The filing is a second write — `POST /api/folders/members` — issued after the
 * stage has been saved, so the two properties worth proving on a real browser
 * are (a) the order, because the filing is an UPDATE that matches zero rows
 * until the save has INSERTed the row, and (b) that the folder the user was
 * looking at is the one that comes out, not whichever folder happens to be
 * active by the time the async generation settles.
 *
 * ## Data
 *
 * Folders and stages are real, on the dev database: the filing path only means
 * anything against a server that can actually refuse it. Every row this spec
 * creates is deleted in `afterEach` — note that retiring a course is a
 * tombstone, so the `document_stages` rows themselves survive it; a run that
 * has to leave the database byte-identical needs the SQL sweep the skill
 * documents. The chapter directory is faked in the browser
 * (`installMaterialsKvStub`) because it is one global key shared with whoever
 * is using the app, and the course list is stubbed so the folder tiles are the
 * only thing on screen — a real list would make "which folder did the course
 * land in" depend on data this spec did not create.
 */

const SETTINGS_STORAGE = createSettingsStorage({ webSearchEnabled: false });

/**
 * Prefix only — every run appends a suffix. Folder names are unique per owner
 * (the same rule the new-folder dialog enforces), so a fixed name would make
 * this spec fail on the leftovers of a run that was interrupted before its
 * cleanup, which reads as a product break and is not one.
 */
const FOLDER_NAME_PREFIX = 'E2E 归档';
const PROMPT = '从零学 python';

const createdStages: string[] = [];
let createdFolderId: string | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ settings }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      // The bundled Chromium reports `navigator.language` as en-US; the flow
      // below is driven by a Chinese composer, so the locale is pinned.
      localStorage.setItem('locale', 'zh-CN');
    },
    { settings: SETTINGS_STORAGE },
  );
  await installMaterialsKvStub(page);
});

test.afterEach(async ({ page }) => {
  // `E2E_KEEP_EVIDENCE=1` leaves the rows in place so the filing can be read
  // straight out of `document_stages`, which is the one claim the browser
  // cannot make for itself. Off by default: a normal run cleans up after itself.
  if (process.env.E2E_KEEP_EVIDENCE === '1') {
    console.log(
      `[evidence] folder=${createdFolderId ?? '(none)'} stages=${createdStages.join(',') || '(none)'}`,
    );
    createdStages.length = 0;
    createdFolderId = null;
    return;
  }
  while (createdStages.length > 0) {
    await retireServerDocument(page, createdStages.pop()!);
  }
  if (createdFolderId) {
    await page.request.delete(`/api/folders/${encodeURIComponent(createdFolderId)}`);
    createdFolderId = null;
  }
});

interface E2EFolder {
  readonly id: string;
  readonly name: string;
}

/** Create the folder the course should end up in, and make it the only one on screen. */
async function createFolder(page: Page): Promise<E2EFolder> {
  const name = `${FOLDER_NAME_PREFIX}-${crypto.randomUUID().slice(0, 8)}`;
  const res = await page.request.post('/api/folders', { data: { name } });
  expect(res.status(), 'creating the e2e folder must succeed').toBeLessThan(300);
  const body = (await res.json()) as { folder: { id: string } };
  const folder: E2EFolder = { id: body.folder.id, name };
  createdFolderId = folder.id;

  await page.route('**/api/folders', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        folders: [
          {
            id: folder.id,
            name: folder.name,
            order: 1,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            userKey: 'e2e',
          },
        ],
      }),
    });
  });
  return folder;
}

/** The course list is not this spec's subject — keep the folder tiles alone. */
const stubEmptyCourseList = (page: Page) =>
  page.route('**/api/stages', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ stages: [] }),
    });
  });

interface FilingWatch {
  readonly order: string[];
  readonly filing: { body: Record<string, unknown> | null };
}

/**
 * Record — in arrival order — the two writes under test: the stage save and the
 * filing. Playwright's request events see the app's own outgoing requests; the
 * body is read off the request rather than intercepted, so nothing about the
 * app's behaviour changes.
 */
function watchFiling(page: Page): FilingWatch {
  const order: string[] = [];
  const filing: { body: Record<string, unknown> | null } = { body: null };

  page.on('request', (request: Request) => {
    const url = request.url();
    if (url.includes('/api/persistence/documents/') && request.method() === 'PUT') {
      order.push('save');
      return;
    }
    if (url.includes('/api/folders/members') && request.method() === 'POST') {
      order.push('file');
      try {
        filing.body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        filing.body = null;
      }
    }
  });

  return { order, filing };
}

const stageIdFromUrl = (page: Page): string =>
  page.url().split('/classroom/')[1]?.split(/[?#]/)[0] ?? '';

/** The stage's folder as the server sees it — the only assertion that proves the row. */
async function folderIdOnServer(page: Page, stageId: string): Promise<string | null> {
  const res = await page.request.get('/api/stages');
  const body = (await res.json()) as { stages?: Array<{ id: string; folderId?: string }> };
  const stage = (body.stages ?? []).find((item) => item.id === stageId);
  expect(stage, `stage ${stageId} must be listed for this owner`).toBeDefined();
  return stage?.folderId ?? null;
}

/** Type a fresh prompt into the home composer and press "enter classroom". */
async function generateFromHome(page: Page): Promise<string> {
  const composer = page.locator('[data-pro-morph="composer"]');
  await expect(composer).toBeVisible();
  await composer.locator('textarea').fill(PROMPT);
  await expect(composer.locator('[data-composer-submit]')).toBeEnabled();
  await composer.locator('[data-composer-submit]').click();
  await page.waitForURL(/\/classroom\//, { timeout: 90_000 });
  return stageIdFromUrl(page);
}

test.describe('generated-course folder filing', () => {
  test('files the course into the folder the user generated from', async ({ page, mockApi }) => {
    await mockApi.setupGenerationMocks();
    await stubEmptyCourseList(page);
    const folder = await createFolder(page);
    const watch = watchFiling(page);

    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByText(folder.name, { exact: true })).toBeVisible();
    await page.getByText(folder.name, { exact: true }).click();

    const stageId = await generateFromHome(page);

    // Filed with the folder the user was standing in…
    await expect
      .poll(() => watch.filing.body?.folderId ?? null, { timeout: 15_000 })
      .toBe(folder.id);
    expect(watch.filing.body?.stageId).toBe(stageId);

    // …after the save, never before: the filing UPDATE matches zero rows until
    // the save has INSERTed the row.
    const firstSave = watch.order.indexOf('save');
    const firstFile = watch.order.indexOf('file');
    expect(firstSave, 'the stage save must have gone out').toBeGreaterThan(-1);
    expect(firstFile, 'the filing must have gone out').toBeGreaterThan(-1);
    expect(firstSave, 'the filing must follow the save').toBeLessThan(firstFile);

    // And the row itself carries it — the page being right is not the claim.
    await expect.poll(() => folderIdOnServer(page, stageId), { timeout: 15_000 }).toBe(folder.id);

    createdStages.push(stageId);
  });

  test('leaves a root-view course unfiled and sends no filing at all', async ({
    page,
    mockApi,
  }) => {
    await mockApi.setupGenerationMocks();
    await stubEmptyCourseList(page);
    const folder = await createFolder(page);
    const watch = watchFiling(page);

    await page.goto('/', { waitUntil: 'networkidle' });
    // Root view: the folder is a tile to click, not a place we are standing in.
    await expect(page.getByText(folder.name, { exact: true })).toBeVisible();

    const stageId = await generateFromHome(page);

    // Positive controls first: the course really was created and saved, so the
    // absence assertions below are "nothing filed" and not "nothing ran".
    await expect.poll(() => watch.order.includes('save'), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => folderIdOnServer(page, stageId), { timeout: 15_000 }).toBeNull();

    // The filing is issued (or not) before the classroom navigation — the
    // handler awaits it — so by now the decision is settled. The bounded settle
    // covers only Playwright's request-event dispatch lag.
    await page.waitForTimeout(500);
    expect(watch.order.filter((step) => step === 'file')).toHaveLength(0);
    expect(watch.filing.body, 'a root-view generation must not file').toBeNull();

    createdStages.push(stageId);
  });
});
