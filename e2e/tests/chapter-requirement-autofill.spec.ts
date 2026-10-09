import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import {
  installMaterialsKvStub,
  seedMaterialsKv,
  type MaterialsKvStub,
} from '../fixtures/materials-kv';

const SETTINGS_STORAGE = createSettingsStorage();

/**
 * Selecting a chapter writes the composer's requirement.
 *
 * The click is a *suggestion*, never a submission: it fills the box, the send
 * button turns from disabled to enabled, and the user still presses it. So
 * "the button is enabled" and "nothing was sent" are asserted together — a
 * revision that submitted on selection would pass the first assertion alone.
 *
 * The write is conditional, so a chapter click can never eat a prompt the user
 * typed. Each rule has its own test below; the rules themselves live in
 * `applyChapterSelection` in `app/page.tsx`.
 *
 * Two things this spec deliberately does not touch:
 *
 * - the chapter directory, which is real user data — it is faked in the
 *   browser by `installMaterialsKvStub` and never goes near the API;
 * - and any course document. The stub holds file names no classroom matches,
 *   which exercises the fallback title (from the file name). The course-name
 *   branch is a pure function, covered branch by branch in
 *   `tests/utils/chapter-naming.test.ts`; seeding a course here would only
 *   re-test the digest plumbing that spec already reads.
 */

// Serial for the same reason the sibling directory spec is: the deployment
// runs a single owner, so any shared state is global. This spec keeps its own
// state fake, but the ordering removes the question.
test.describe.configure({ mode: 'serial' });

const CHAPTERS = ['01-第一章-舆论的定义.pdf', '02-第二章-方法.pdf'] as const;

const FIRST_SENTENCE = '开始 1 第一章-舆论的定义 的课程学习';
const SECOND_SENTENCE = '开始 2 第二章-方法 的课程学习';

/** The user's own prompt, used wherever a test must prove it survives. */
const TYPED_PROMPT = '只讲第一章的重点，配三个思考题';

interface ComposerHarness {
  readonly textarea: ReturnType<Page['locator']>;
  readonly send: ReturnType<Page['locator']>;
  readonly chapters: ReturnType<Page['locator']>;
}

/** Load the home page holding two chapters, and hand back its composer. */
async function openHomeWithChapters(page: Page, stub: MaterialsKvStub): Promise<ComposerHarness> {
  await page.goto('/', { waitUntil: 'networkidle' });
  seedMaterialsKv(stub, CHAPTERS);
  await page.reload({ waitUntil: 'networkidle' });

  const composer = page.locator('[data-pro-morph="composer"]');
  await expect(composer).toBeVisible();

  return {
    textarea: composer.locator('textarea'),
    send: composer.locator('[data-composer-submit]'),
    chapters: page.locator('[data-chapter-directory] [role="radio"]'),
  };
}

test.describe('chapter selection pre-fills the composer', () => {
  let materialsStub: MaterialsKvStub;

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      // The bundled Chromium reports `navigator.language` as en-US, which the
      // i18n provider adopts on hydration — so the sentence would come back in
      // English. Pin the locale the assertions below are written in: what is
      // being verified is the Chinese sentence the feature ships.
      localStorage.setItem('locale', 'zh-CN');
    }, SETTINGS_STORAGE);
    materialsStub = await installMaterialsKvStub(page);
  });

  test('writes the sentence and arms the button without submitting', async ({ page }) => {
    const generationCalls: string[] = [];
    await page.route('**/api/generate/**', async (route) => {
      generationCalls.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 500, body: 'the composer must not submit on its own' });
    });

    const { textarea, send, chapters } = await openHomeWithChapters(page, materialsStub);

    // The pre-existing gate: an empty composer cannot generate.
    await expect(textarea).toHaveValue('');
    await expect(send).toBeDisabled();

    await chapters.first().click();

    await expect(textarea).toHaveValue(FIRST_SENTENCE);
    await expect(send).toBeEnabled();

    // "Armed" is not "sent": no generation was requested and the page is still
    // the composer's own. This is the assertion that pins the requirement down.
    expect(generationCalls).toEqual([]);
    await expect(page).toHaveURL(/\/$/);
  });

  test('replaces its own sentence, and clears it when the chapter is deselected', async ({
    page,
  }) => {
    const { textarea, send, chapters } = await openHomeWithChapters(page, materialsStub);

    await chapters.first().click();
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    // Another chapter: the sentence written here last is replaced, not kept.
    await chapters.nth(1).click();
    await expect(textarea).toHaveValue(SECOND_SENTENCE);
    await expect(send).toBeEnabled();

    // Clicking the selected row again deselects it — and the sentence leaves
    // with the selection it was written for.
    await chapters.nth(1).click();
    await expect(textarea).toHaveValue('');
    await expect(send).toBeDisabled();
  });

  test('never overwrites a prompt the user typed, and never clears it', async ({ page }) => {
    const { textarea, chapters } = await openHomeWithChapters(page, materialsStub);

    await textarea.fill(TYPED_PROMPT);

    // Selecting a chapter leaves a typed prompt alone — including on a later
    // click on a different chapter, which is the state most likely to be
    // written over by a careless revision.
    await chapters.first().click();
    await expect(textarea).toHaveValue(TYPED_PROMPT);

    await chapters.nth(1).click();
    await expect(textarea).toHaveValue(TYPED_PROMPT);

    // And deselecting does not clear what this helper never wrote.
    await chapters.nth(1).click();
    await expect(textarea).toHaveValue(TYPED_PROMPT);
  });

  test('does not write the draft cache', async ({ page }) => {
    const { textarea, chapters } = await openHomeWithChapters(page, materialsStub);

    await chapters.first().click();
    await expect(textarea).toHaveValue(FIRST_SENTENCE);

    // The cache debounces its write by 500ms, so wait past it: what is asserted
    // is that nothing lands there, not that nothing has landed yet.
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => localStorage.getItem('requirementDraft'))).toBeNull();
  });

  test('the user’s own typing still reaches the draft cache', async ({ page }) => {
    // The control for the test above: the same probe, on a path that must
    // write. Without it, "nothing in the cache" would pass even if the draft
    // cache were broken or the key had moved.
    const { textarea } = await openHomeWithChapters(page, materialsStub);

    await textarea.fill(TYPED_PROMPT);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => localStorage.getItem('requirementDraft'))).toBe(
      JSON.stringify(TYPED_PROMPT),
    );
  });
});
