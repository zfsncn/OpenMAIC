import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import {
  installMaterialsKvStub,
  seedMaterialsKv,
  type MaterialsKvStub,
} from '../fixtures/materials-kv';
import { retireServerDocument, seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * "Back to home" is one gesture with one outcome: a clean composer.
 *
 * It used to be seven gestures with two outcomes. Clicking the same-labeled
 * button from a classroom came back empty, while leaving a folder came back
 * holding the sentence written for the chapter the user had just selected —
 * which, since a chapter filed in a folder has no row in the root view, named
 * something that was no longer on screen.
 *
 * Three things must go, and each has its own assertion below because they live
 * in three different places: the composer's text (React state), the draft cache
 * that would restore it (`localStorage`), and the selected chapter (server-side
 * KV, which is why clearing it in React alone would not stick).
 *
 * ## What this spec does not touch
 *
 * The chapter directory is real user data under one global key, so it is faked
 * in the browser by `installMaterialsKvStub` and never reaches the API. Folders
 * are stubbed for the same reason. The one course this seeds is prefixed and
 * randomly suffixed, and is retired in `afterEach`.
 */

const SETTINGS_STORAGE = createSettingsStorage({
  // Nothing here generates; a search provider would only add latency.
  webSearchEnabled: false,
});

const CHAPTERS = ['01-第一章-舆论的定义.pdf', '02-第二章-方法.pdf'] as const;
const FIRST_SENTENCE = '开始 1 第一章-舆论的定义 的课程学习';
const TYPED_PROMPT = '只讲第一章的重点，配三个思考题';

const FOLDER_ID = 'e2e-return-home-folder';
const FOLDER_NAME = 'E2E 归档';

const seededStages: string[] = [];

test.afterEach(async ({ page }) => {
  while (seededStages.length > 0) {
    await retireServerDocument(page, seededStages.pop()!);
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ settings }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      // The bundled Chromium reports `navigator.language` as en-US, so the
      // Chinese sentence asserted below has to be pinned.
      localStorage.setItem('locale', 'zh-CN');
    },
    { settings: SETTINGS_STORAGE },
  );
});

// The deployment is single-owner, so anything shared is global. This spec keeps
// its own state fake; serial ordering just removes the question.
test.describe.configure({ mode: 'serial' });

/** Seed one ordinary slide course, so the classroom has a header to return from. */
async function seedSlideClassroom(page: Page): Promise<string> {
  const stageId = uniqueStageId('e2e-return-home');
  seededStages.push(stageId);
  const now = Date.now();

  await seedServerDocument(page, {
    stage: { id: stageId, name: '返回首页 e2e', description: '', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        type: 'slide',
        title: '第一页',
        order: 1,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#5b9bd5'],
              fontColor: '#333333',
              fontName: 'Microsoft Yahei',
            },
            elements: [],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    // Scene and outline orders must agree and the deck must be marked complete:
    // the classroom pairs them by order and quietly generates whatever looks
    // missing, which would put a model call in the middle of this test.
    outline: {
      outlines: [{ id: 'scene_1', type: 'slide', order: 1, title: '第一页', keyPoints: [] }],
      generationComplete: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  return stageId;
}

/** Open the home page with the given chapters in place and hand back its composer. */
async function openHome(
  page: Page,
  stub: MaterialsKvStub,
  folderId?: string,
): Promise<{
  readonly textarea: ReturnType<Page['locator']>;
  readonly send: ReturnType<Page['locator']>;
  readonly chapters: ReturnType<Page['locator']>;
}> {
  await page.goto('/', { waitUntil: 'networkidle' });
  seedMaterialsKv(stub, CHAPTERS, folderId);
  await page.reload({ waitUntil: 'networkidle' });

  const composer = page.locator('[data-pro-morph="composer"]');
  await expect(composer).toBeVisible();

  return {
    textarea: composer.locator('textarea'),
    send: composer.locator('[data-composer-submit]'),
    chapters: page.locator('[data-chapter-directory] [role="radio"]'),
  };
}

const draftCache = (page: Page) => page.evaluate(() => localStorage.getItem('requirementDraft'));
const storedSelection = (stub: MaterialsKvStub) =>
  (stub.value as { selectedMaterialId?: string | null } | null)?.selectedMaterialId ?? null;

/**
 * One folder exists, and the caller files every chapter in it: at the root there
 * is then no chapter list at all, which is exactly the state the user reported
 * coming back to with the sentence still in the box.
 */
const stubFolders = (page: Page) =>
  page.route('**/api/folders', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        folders: [
          {
            id: FOLDER_ID,
            name: FOLDER_NAME,
            order: 1,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            userKey: 'e2e',
          },
        ],
      }),
    });
  });

test.describe('returning to the home page', () => {
  let materialsStub: MaterialsKvStub;

  test.beforeEach(async ({ page }) => {
    materialsStub = await installMaterialsKvStub(page);
  });

  test('clears a hand-typed prompt and the selected chapter, from a classroom', async ({
    page,
  }) => {
    const { textarea, send, chapters } = await openHome(page, materialsStub);

    // A prompt the user typed, plus a chapter selected next to it. The selection
    // is what makes the KV assertion below meaningful: without it, "cleared"
    // would be indistinguishable from "never set".
    await textarea.fill(TYPED_PROMPT);
    await chapters.first().click();
    await expect(textarea).toHaveValue(TYPED_PROMPT);
    await expect(chapters.first()).toHaveAttribute('aria-checked', 'true');

    // The control for the cache assertion further down: the draft cache does
    // work, so "nothing in it" afterwards is the reset and not a broken key.
    await page.waitForTimeout(700);
    expect(await draftCache(page)).toBe(JSON.stringify(TYPED_PROMPT));

    const stageId = await seedSlideClassroom(page);
    await page.goto(`/classroom/${stageId}`);
    await page.getByText('Loading classroom...').waitFor({ state: 'hidden', timeout: 30_000 });

    const backHome = page.locator('header button[title="返回首页"]');
    await expect(backHome).toBeVisible();
    await backHome.click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-pro-morph="composer"]')).toBeVisible();

    // All three layers, because they fail independently: the page can look
    // clean while the cache restores the text on the next mount, and the
    // selection lives on the server where React never reaches.
    await expect(textarea).toHaveValue('');
    await expect(send).toBeDisabled();
    expect(await draftCache(page)).toBeNull();
    await expect(page.locator('[data-chapter-directory] [role="radio"]')).toHaveCount(0);
    await expect
      .poll(() => storedSelection(materialsStub), {
        timeout: 15_000,
        message: 'the chapter selection must be cleared where it is stored, not only on screen',
      })
      .toBeNull();
  });

  test('clears the composer when a folder is left, and only then', async ({ page }) => {
    await stubFolders(page);

    const { textarea, send, chapters } = await openHome(page, materialsStub, FOLDER_ID);

    // Root view: the filed chapters are not on screen, so there is nothing to
    // select and no panel to select from.
    await expect(page.locator('[data-chapter-directory]')).toHaveCount(0);

    // Into the folder, where the chapters are.
    await page.getByText(FOLDER_NAME, { exact: true }).click();
    await expect(chapters).toHaveCount(CHAPTERS.length);
    await chapters.first().click();
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    // Leaving the folder is the gesture under test, and it is now its own
    // labelled control — the disclosure sitting next to it no longer does this.
    // It resets, because the sentence names a chapter with no row in the view it
    // returns to.
    await page.locator('[data-home-back-button]').click();

    await expect(page.locator('[data-chapter-directory]')).toHaveCount(0);
    await expect(textarea).toHaveValue('');
    await expect(send).toBeDisabled();
    await expect
      .poll(() => storedSelection(materialsStub), {
        timeout: 15_000,
        message: 'leaving a folder must drop the stored selection too',
      })
      .toBeNull();
  });

  test('leaves the composer alone when the recent panel is only collapsed', async ({ page }) => {
    // At the root the "recent" control is a disclosure toggle, not a navigation:
    // nothing unmounts, nothing is orphaned, and a reset here would silently eat
    // a prompt for no reason.
    const { textarea, chapters } = await openHome(page, materialsStub);

    // No folder to leave, so there is no exit control to offer in the first
    // place — a disabled "back to home" at the root would be noise.
    await expect(page.locator('[data-home-back-button]')).toHaveCount(0);

    await chapters.first().click();
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    const trigger = page.getByRole('button', { name: /最近学习/ });
    await trigger.click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('recentClassroomsOpen')))
      .toBe('false');
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    await trigger.click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('recentClassroomsOpen')))
      .toBe('true');
    await expect(textarea).toHaveValue(FIRST_SENTENCE);
  });

  test('keeps the folder exit and the disclosure as two different gestures', async ({ page }) => {
    // Inside a folder both controls are on screen at once. They must stay
    // separable there: collapsing the panel is not leaving the folder, and the
    // whole point of the split is that neither can quietly do the other's job.
    await stubFolders(page);
    const { textarea, chapters } = await openHome(page, materialsStub, FOLDER_ID);

    await page.getByText(FOLDER_NAME, { exact: true }).click();
    await expect(chapters).toHaveCount(CHAPTERS.length);
    await chapters.first().click();
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    // The disclosure collapses, and nothing else happens.
    await page.getByRole('button', { name: /最近学习/ }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('recentClassroomsOpen')))
      .toBe('false');
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    // Reopening it proves we are still inside the folder: the same chapters come
    // back, and the exit control is still waiting next to the label.
    await page.getByRole('button', { name: /最近学习/ }).click();
    await expect(page.locator('[data-home-back-button]')).toBeVisible();
    await expect(chapters).toHaveCount(CHAPTERS.length);
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    // Now the actual exit, from the control that advertises it.
    await page.locator('[data-home-back-button]').click();
    await expect(textarea).toHaveValue('');
    await expect(page.locator('[data-home-back-button]')).toHaveCount(0);
    await expect(page.locator('[data-chapter-directory]')).toHaveCount(0);
  });
});
