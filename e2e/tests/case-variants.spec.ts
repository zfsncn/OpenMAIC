import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import {
  readServerDocument,
  retireServerDocument,
  seedServerDocument,
  uniqueStageId,
} from '../fixtures/server-seed';
import type { Page } from '@playwright/test';

/**
 * The three-case cache behind a case-teaching scene.
 *
 * ## What this spec is protecting
 *
 * "换一个案例" used to replace the case in place, so a chapter could only ever
 * hold one — every swap threw the previous one away. It now appends while there
 * is room and rotates once there is not, which is what lets a learner come back
 * to a case they liked without paying for another generation.
 *
 * The load-bearing assertion is therefore **the generation count does not rise
 * once three cases exist**. On its own that is not enough: an implementation
 * that never generated anything would satisfy it, so the same counter is
 * asserted to *rise* on the swaps below the cap. Both halves are required.
 *
 * ## Why this does not touch the deployment's own data
 *
 * The course is seeded through the app's own endpoint under a `e2e-` prefixed,
 * randomly suffixed id (courses are global on the server, so a fixed id would
 * collide across runs) and retired in `afterEach`. The chapter directory is
 * never involved, and `/` is never visited — that navigation alone rewrites the
 * directory of whoever is using the deployment.
 *
 * Every generation call is stubbed, so no model is ever called.
 */

const STAGE_PREFIX = 'e2e-case-variants';
const SEED_TITLE = '章节样本案例';
const SEED_NARRATIVE = '样本案例的案情正文。';
const KNOWLEDGE_POINTS = ['舆情的流动性', '民意的隐性形态'];

const SETTINGS_STORAGE = createSettingsStorage({
  // Research runs before a swap only when search is on, and it would put a
  // `/api/web-search` call in the middle of a test about the model call.
  webSearchEnabled: false,
});

/** Titles the stubbed model hands back, in order. */
const generatedTitle = (index: number) => `生成案例 ${index}`;
const generatedNarrative = (index: number) => `第 ${index} 个案例的案情正文。`;

const seededStages: string[] = [];

test.afterEach(async ({ page }) => {
  while (seededStages.length > 0) {
    await retireServerDocument(page, seededStages.pop()!);
  }
});

test.beforeEach(async ({ page }) => {
  // Before the first navigation, so the classroom reads them on mount.
  await page.addInitScript(
    ({ settings }) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'zh-CN');
    },
    { settings: SETTINGS_STORAGE },
  );
});

/** Counts how many times the model was asked for a case. */
interface GenerationCounter {
  count: number;
}

async function stubCaseGeneration(page: Page): Promise<GenerationCounter> {
  const counter: GenerationCounter = { count: 0 };
  await page.route('**/api/generate/scene-content', async (route) => {
    counter.count += 1;
    const index = counter.count;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        content: {
          caseTitle: generatedTitle(index),
          summary: `第 ${index} 个案例的一句话概述`,
          knowledgePoints: KNOWLEDGE_POINTS,
          narrative: generatedNarrative(index),
          discussionQuestions: [{ id: `q_${index}`, question: `第 ${index} 个讨论题？` }],
        },
      }),
    });
  });
  return counter;
}

async function stubCaseAnalysis(page: Page): Promise<GenerationCounter> {
  const counter: GenerationCounter = { count: 0 };
  await page.route('**/api/generate/case-analysis', async (route) => {
    counter.count += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        analysis: { entries: [{ point: KNOWLEDGE_POINTS[0], bearing: '解析内容' }] },
      }),
    });
  });
  return counter;
}

/** Seed one case classroom holding exactly one case, and return its id. */
async function seedCaseClassroom(page: Page): Promise<string> {
  // A classroom route the app cannot have a course for: it mints the owner
  // cookie that `page.request` then seeds with, without visiting the home page.
  await page.goto('/classroom/warmup-case-variants');

  const stageId = uniqueStageId(STAGE_PREFIX);
  seededStages.push(stageId);
  const now = Date.now();

  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: '案例多变体 e2e',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: 'scene-case',
        stageId,
        type: 'case',
        title: '案例教学',
        // Must match the outline's `order` below. The classroom pairs scenes to
        // outlines by order, and a deck that looks incomplete is quietly
        // patched by generating the missing scene — which would spend one of
        // the swaps this spec is counting.
        order: 1,
        content: {
          type: 'case',
          caseTitle: SEED_TITLE,
          knowledgePoints: KNOWLEDGE_POINTS,
          narrative: SEED_NARRATIVE,
          discussionQuestions: [{ id: 'q_seed', question: '样本讨论题？' }],
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    // Shaped like a real generated case classroom: one outline at order 1, and
    // the deck marked complete so nothing is resumed on open.
    outline: {
      outlines: [
        {
          id: 'scene_1',
          type: 'case',
          order: 1,
          title: '案例教学',
          keyPoints: KNOWLEDGE_POINTS,
          caseConfig: { questionCount: 1 },
        },
      ],
      generationComplete: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  return stageId;
}

const changeCaseButton = (page: Page) => page.getByRole('button', { name: '换一个案例' });
const analyseButton = (page: Page) => page.getByRole('button', { name: '案例解析' });
const hideAnalysisButton = (page: Page) => page.getByRole('button', { name: '解析隐藏' });
const caseTitle = (page: Page) => page.locator('article h1');

/**
 * "案例 n / total" — which of the saved cases is on screen, and how many there
 * are. The denominator is how many exist, not the cap: after generating the
 * second case the badge reads `2 / 2`, because claiming a third existed would
 * be the one thing this badge must not do.
 */
const variantBadge = (page: Page) => page.getByText(/^案例 \d+ \/ \d+$/);

async function openClassroom(page: Page, stageId: string): Promise<void> {
  await page.goto(`/classroom/${stageId}`);
  await page.getByText('Loading classroom...').waitFor({ state: 'hidden', timeout: 30_000 });
}

test('saves three cases and rotates instead of generating a fourth', async ({ page }) => {
  test.setTimeout(180_000);
  const stageId = await seedCaseClassroom(page);
  const generation = await stubCaseGeneration(page);
  await openClassroom(page, stageId);

  // One case, so there is nothing to rotate between and no badge.
  await expect(caseTitle(page)).toHaveText(SEED_TITLE);
  await expect(changeCaseButton(page)).toBeVisible();
  await expect(variantBadge(page)).toHaveCount(0);

  // Below the cap the swap generates. Without these two, "never generate"
  // would satisfy the assertion further down.
  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(generatedTitle(1));
  await expect(variantBadge(page)).toHaveText('案例 2 / 2');
  expect(generation.count, 'the first swap must generate a case').toBe(1);

  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(generatedTitle(2));
  await expect(variantBadge(page)).toHaveText('案例 3 / 3');
  expect(generation.count, 'the second swap must generate a case').toBe(2);

  // At the cap. The third swap rotates back to the first case and, crucially,
  // makes no request at all.
  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(SEED_TITLE);
  await expect(variantBadge(page)).toHaveText('案例 1 / 3');
  expect(generation.count, 'a swap at the cap must not generate').toBe(2);

  // Rounding the horn returns the cases in the order they were saved, and the
  // case's own narrative comes back with it — the card is not being reused.
  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(generatedTitle(1));
  await expect(page.getByText(generatedNarrative(1))).toBeVisible();
  expect(generation.count, 'rotating must never generate').toBe(2);

  // It has to be in the store, not just on screen: read it back the way the
  // app persists it. A rotation that only changed local state would look
  // identical here and lose the other two cases on the next visit.
  //
  // The write is asynchronous and the click resolves as soon as it is
  // dispatched, so this polls instead of sampling once — a single read races
  // the save and would report whichever rotation landed last.
  const storedCase = async () => {
    const stored = await readServerDocument(page, stageId);
    const scene = stored?.scenes.find((candidate) => candidate.type === 'case');
    return scene?.content as
      | { caseTitle?: string; caseVariants?: { narrative?: string }[] }
      | undefined;
  };

  await expect
    .poll(async () => (await storedCase())?.caseTitle ?? null, {
      timeout: 15_000,
      message: 'the case on screen must reach the store, not just the page',
    })
    .toBe(generatedTitle(1));

  const content = await storedCase();
  expect(content?.caseVariants, 'all three cases must be persisted').toHaveLength(3);
  expect(content?.caseVariants?.map((variant) => variant.narrative)).toEqual([
    SEED_NARRATIVE,
    generatedNarrative(1),
    generatedNarrative(2),
  ]);

  // A fresh page reads the cache rather than regenerating.
  await openClassroom(page, stageId);
  await expect(caseTitle(page)).toHaveText(generatedTitle(1));
  await expect(variantBadge(page)).toHaveText('案例 2 / 3');
  expect(generation.count, 'reopening the classroom must not generate').toBe(2);
});

test('keeps each analysis with the case it explains', async ({ page }) => {
  test.setTimeout(180_000);
  const stageId = await seedCaseClassroom(page);
  await stubCaseGeneration(page);
  const analysis = await stubCaseAnalysis(page);
  await openClassroom(page, stageId);

  // The first case gets an analysis.
  await expect(analyseButton(page)).toBeVisible();
  await analyseButton(page).click();
  await expect(page.getByText('解析内容')).toBeVisible();
  expect(analysis.count).toBe(1);

  // Filling the remaining two slots. A freshly written case has no analysis,
  // so the button has to come back — carrying the previous case's explanation
  // across would print an analysis of a different event.
  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(generatedTitle(1));
  await expect(page.getByText('解析内容')).toHaveCount(0);
  await expect(analyseButton(page)).toBeVisible();

  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(generatedTitle(2));
  await expect(page.getByText('解析内容')).toHaveCount(0);

  // Rotating back to the first case brings its own analysis back, without
  // asking for it again.
  await changeCaseButton(page).click();
  await expect(caseTitle(page)).toHaveText(SEED_TITLE);
  await expect(page.getByText('解析内容')).toBeVisible();
  expect(analysis.count, 'a stored analysis must not be regenerated').toBe(1);
});

test('hides a revealed analysis and brings it back without generating', async ({ page }) => {
  test.setTimeout(180_000);
  const stageId = await seedCaseClassroom(page);
  await stubCaseGeneration(page);
  const analysis = await stubCaseAnalysis(page);
  await openClassroom(page, stageId);

  // Hide only means something once there is something to hide.
  await analyseButton(page).click();
  await expect(page.getByText('解析内容')).toBeVisible();
  expect(analysis.count).toBe(1);

  // Hiding puts the page back where it was before the reveal — the same
  // button, ready to bring the analysis back.
  await hideAnalysisButton(page).click();
  await expect(page.getByText('解析内容')).toHaveCount(0);
  await expect(analyseButton(page)).toBeVisible();

  // The store is what has to change, not just the page: a display-only toggle
  // looks identical here and is undone by the next load.
  const storedHidden = async () => {
    const stored = await readServerDocument(page, stageId);
    const scene = stored?.scenes.find((candidate) => candidate.type === 'case');
    return (scene?.content as { analysisHidden?: boolean } | undefined)?.analysisHidden ?? null;
  };
  await expect
    .poll(storedHidden, {
      timeout: 15_000,
      message: 'the hidden flag must reach the store, not just the page',
    })
    .toBe(true);

  // Persisting it is the point: a reload comes back still collapsed.
  await openClassroom(page, stageId);
  await expect(page.getByText('解析内容')).toHaveCount(0);
  await expect(analyseButton(page)).toBeVisible();

  // Bringing it back is a flag flip. The analysis never left the document, so
  // the model must not be asked for it a second time — routing this through
  // the generate path would either call the API again or, because that path
  // bails out when an analysis already exists, do nothing at all.
  await analyseButton(page).click();
  await expect(page.getByText('解析内容')).toBeVisible();
  expect(analysis.count, 'revealing a stored analysis must not generate').toBe(1);
});
