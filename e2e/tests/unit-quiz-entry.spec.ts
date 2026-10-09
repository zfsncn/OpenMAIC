import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { QuizQuestion } from '../../lib/types/stage';
import {
  readServerDocument,
  retireServerDocument,
  seedServerDocument,
  uniqueStageId,
} from '../fixtures/server-seed';
import {
  fakeDigest,
  installMaterialsKvStub,
  seedMaterialsKv,
  type MaterialsKvStub,
} from '../fixtures/materials-kv';

const SETTINGS_STORAGE = createSettingsStorage();

/**
 * The same settings with web search on.
 *
 * Case research is gated on the search toggle as well as the lesson kind: it
 * calls `/api/web-search`, so a deployment with no provider configured would
 * only produce one error per knowledge point. The provider key here is a dummy
 * — the route is stubbed in every test that uses these settings, so nothing ever
 * reaches a provider.
 */
const CASE_SEARCH_SETTINGS = createSettingsStorage({
  webSearchEnabled: true,
  webSearchProviderId: 'tavily',
  webSearchProvidersConfig: { tavily: { apiKey: 'test-key' } },
});

/**
 * The unit-quiz / case-teaching entry points.
 *
 * Two surfaces are covered:
 *
 *  A. The home page's chapter directory grew an action row ("unit quiz" /
 *     "case teaching"). It is an action row, not a mode switch: each button
 *     generates its own kind of classroom straight away, and each stays
 *     disabled until a chapter is selected. The row must sit OUTSIDE the list's
 *     scroll container, or a long chapter list would push it below a fixed
 *     panel that can never scroll into view.
 *
 *  B. The two directory-driven lesson kinds:
 *    - A unit-quiz classroom (`lessonKind: 'unitQuiz'`) offers "shuffle a fresh
 *      set" on the quiz cover. It regenerates the quiz scene from its persisted
 *      outline with a bumped `attempt` counter, and writes the result back.
 *      An ordinary lesson's quiz scene must NOT offer it.
 *    - Case teaching (`lessonKind: 'caseTeaching'`) produces exactly ONE scene,
 *      of type `case`, built around the selected chapter's knowledge points.
 *      It renders as a reading scene: title, knowledge-point tags, narrative,
 *      sources, and the discussion questions.
 *
 * ## The chapter directory is real user data, so the tests never write it
 *
 * It is faked in the browser by `installMaterialsKvStub`; the reasoning — and
 * the one-global-key, one-account hazard behind it — lives in
 * `../fixtures/materials-kv.ts`.
 *
 * The courses, by contrast, are seeded through the app's own endpoints with
 * `page.request` — they are namespaced (`e2e-*`) and retired after each test,
 * so they never reach the deployment's course list.
 */

/** One quiz outline, shaped like the one `enforceUnitQuizOutline` persists. */
function unitQuizOutline() {
  return {
    id: 'scene-quiz',
    type: 'quiz',
    title: 'Unit quiz',
    description: 'Check the unit.',
    keyPoints: ['Key idea'],
    order: 1,
    quizConfig: {
      questionCount: 11,
      difficulty: 'medium',
      questionTypes: ['single', 'multiple', 'text'],
      questionMix: [
        { type: 'single', count: 5 },
        { type: 'multiple', count: 5 },
        { type: 'text', count: 1 },
      ],
      optionCount: 5,
    },
  };
}

const SEEDED_QUESTIONS: QuizQuestion[] = [
  {
    id: 'q-seed-1',
    type: 'single',
    question: 'Seeded first question?',
    options: [
      { label: 'Yes', value: 'A' },
      { label: 'No', value: 'B' },
    ],
    answer: ['A'],
    points: 1,
  },
];

const REGENERATED_QUESTIONS: QuizQuestion[] = [
  {
    id: 'q-new-1',
    type: 'single',
    question: 'Regenerated first question?',
    options: [
      { label: 'Alpha', value: 'A' },
      { label: 'Beta', value: 'B' },
    ],
    answer: ['A'],
    points: 1,
  },
];

interface SeededQuizOptions {
  readonly lessonKind?: 'unitQuiz';
  readonly outlines: readonly unknown[];
}

/** One case outline, shaped like the one `enforceCaseTeachingOutline` persists. */
function caseOutline() {
  return {
    id: 'scene-case',
    type: 'case',
    title: 'Case study',
    description: 'Study a documented pollution incident through the externality lens.',
    keyPoints: ['Environmental externality', 'Pigouvian tax', 'Regulatory failure'],
    order: 1,
    caseConfig: { questionCount: 2 },
  };
}

/**
 * The *generated* case payload — no `type` discriminant, exactly as
 * `generateCaseContent` returns it and the scene-content route forwards it.
 * One source is deliberately unusable (a title with no URL) so the assertion
 * proves the drop happens on the real path instead of only in unit tests.
 */
const GENERATED_CASE = {
  caseTitle: 'Dyeing wastewater discharged into a tributary',
  summary: 'A textile mill released untreated dyeing wastewater after dark.',
  knowledgePoints: ['Environmental externality', 'Pigouvian tax'],
  narrative:
    'The mill opened its discharge valve after dark.\n\nBy morning the tributary ran violet for a kilometre.',
  discussionQuestions: [
    {
      id: 'cq_1',
      question: 'Who ends up paying for the damage?',
      point: 'Environmental externality',
    },
    { id: 'cq_2', question: 'Why did the tax fail to bite?', point: 'Pigouvian tax' },
  ],
  sources: [
    { title: 'Official investigation report', url: 'https://example.gov.cn/report' },
    { title: 'Title with no URL at all' },
  ],
};

/** A fully-assembled case scene, the shape `buildCompleteScene` produces. */
const ASSEMBLED_CASE_SCENE_CONTENT = {
  type: 'case',
  caseTitle: GENERATED_CASE.caseTitle,
  summary: GENERATED_CASE.summary,
  knowledgePoints: GENERATED_CASE.knowledgePoints,
  narrative: GENERATED_CASE.narrative,
  discussionQuestions: GENERATED_CASE.discussionQuestions,
  // Only the openable source survived; the title-only one was dropped.
  sources: [{ title: 'Official investigation report', url: 'https://example.gov.cn/report' }],
};

/**
 * The analysis the (stubbed) case-analysis route answers with: one entry per
 * knowledge point the case claims to demonstrate.
 */
const CASE_ANALYSIS = {
  entries: [
    {
      point: 'Environmental externality',
      bearing: 'The mill paid nothing for the kilometre of tributary it dyed.',
    },
    {
      point: 'Pigouvian tax',
      bearing: 'The levy was set below the cost of treatment, so discharging stayed cheaper.',
    },
  ],
};

/**
 * The replacement case a swap produces — deliberately a *different* event, so
 * the assertions cannot pass by re-rendering the original.
 */
const SECOND_CASE = {
  caseTitle: 'A levy set too low to change behaviour',
  summary: 'A regional effluent levy left discharge cheaper than treatment.',
  knowledgePoints: ['Pigouvian tax', 'Regulatory failure'],
  narrative:
    'The levy was set below the cost of treating the effluent.\n\nDischarges continued for two more years.',
  discussionQuestions: [
    { id: 'cq_1', question: 'Why did the levy not bite?', point: 'Pigouvian tax' },
  ],
  sources: [{ title: 'Report on the levy', url: 'https://news.example.com/pigouvian' }],
};

/** Courses seeded by the current test, taken back out in `afterEach`. */
const seededStageIds: string[] = [];

async function seedQuizStage(
  page: Page,
  prefix: string,
  { lessonKind, outlines }: SeededQuizOptions,
): Promise<string> {
  const stageId = uniqueStageId(prefix);
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Unit quiz deck',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
      ...(lessonKind ? { lessonKind } : {}),
      sourceDigests: [fakeDigest('a')],
    },
    scenes: [
      {
        id: 'scene-quiz',
        stageId,
        type: 'quiz',
        title: 'Unit quiz',
        order: 1,
        content: { type: 'quiz', questions: SEEDED_QUESTIONS },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines, generationComplete: true, createdAt: now, updatedAt: now },
  });
  seededStageIds.push(stageId);
  return stageId;
}

interface SeededCaseOptions {
  readonly lessonKind?: 'caseTeaching';
  readonly outlines: readonly unknown[];
  readonly content?: unknown;
}

/** Seed a course whose only scene is a case, the way the path persists one. */
async function seedCaseStage(
  page: Page,
  prefix: string,
  { lessonKind, outlines, content }: SeededCaseOptions,
): Promise<string> {
  const stageId = uniqueStageId(prefix);
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Case teaching deck',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
      ...(lessonKind ? { lessonKind } : {}),
      sourceDigests: [fakeDigest('a')],
    },
    scenes: [
      {
        id: 'scene-case',
        stageId,
        type: 'case',
        title: 'Case study',
        order: 1,
        content: content ?? ASSEMBLED_CASE_SCENE_CONTENT,
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines, generationComplete: true, createdAt: now, updatedAt: now },
  });
  seededStageIds.push(stageId);
  return stageId;
}

// Serial: every test shares the `OWNER_SINGLE_USER` owner, so the KV directory
// is global state and parallel tests would race over it.
test.describe.configure({ mode: 'serial' });

test.describe('unit-quiz entry points', () => {
  // Installed for EVERY test, before the first navigation, so the read that
  // mounts the panel is already fake — and so no test can rewrite the real
  // directory. Visiting `/` is enough on its own to write it: the home page
  // holds the whole list in memory and stores it back, so a test that skipped
  // the stub would perform a same-value overwrite of the deployment user's
  // chapter list.
  let materialsStub: MaterialsKvStub;

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, SETTINGS_STORAGE);
    materialsStub = await installMaterialsKvStub(page);
  });

  // A local run points at the deployment's real database (`reuseExistingServer`
  // reuses whatever holds 3002), so the seeded courses are guests there. Retire
  // them afterwards, whatever the test did, so they never show up in the
  // library the deployment's own user is browsing.
  test.afterEach(async ({ page }) => {
    for (const stageId of seededStageIds.splice(0)) {
      try {
        await retireServerDocument(page, stageId);
      } catch (error) {
        console.warn(`Could not clean up the seeded course ${stageId}:`, error);
      }
    }
  });

  test('home chapter directory: actions are pinned outside the list and gated on a selection', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // No materials → the whole panel stays out of the way (pre-existing rule).
    await expect(page.locator('[data-chapter-directory]')).toHaveCount(0);

    seedMaterialsKv(materialsStub, ['第一章-导论.md', '第二章-方法.md', '第三章-结论.md']);
    await page.reload({ waitUntil: 'networkidle' });

    const panel = page.locator('[data-chapter-directory]');
    await expect(panel).toBeVisible();

    const unitQuiz = page.locator('[data-chapter-action="unit-quiz"]');
    const caseTeaching = page.locator('[data-chapter-action="case-teaching"]');
    await expect(unitQuiz).toBeVisible();
    await expect(caseTeaching).toBeVisible();

    // Both are scoped to one chapter: disabled until a chapter is selected.
    await expect(unitQuiz).toBeDisabled();
    await expect(caseTeaching).toBeDisabled();

    // The action row is a sibling of the scroll container, never inside it: the
    // panel is fixed, so anything inside the scroll region past its max height
    // would be unreachable. The list itself is the only scrollable part.
    await expect
      .poll(() =>
        unitQuiz.evaluate((element) => element.closest('#chapter-directory-list') !== null),
      )
      .toBe(false);
    await expect
      .poll(() =>
        page
          .locator('#chapter-directory-list')
          .evaluate((element) => getComputedStyle(element).overflowY),
      )
      .toBe('auto');

    // Select a chapter → both directory-driven actions become available.
    await panel.locator('[role="radio"]').first().click();
    await expect(unitQuiz).toBeEnabled();
    await expect(unitQuiz).toHaveAttribute('data-chapter-action', 'unit-quiz');
    await expect(caseTeaching).toBeEnabled();
    await expect(caseTeaching).toHaveAttribute('data-chapter-action', 'case-teaching');

    // Nothing to clean up: the directory the test read and wrote was the stub's,
    // and the real one was never sent a request.
  });

  test('unit-quiz classroom offers a fresh set, and regenerates with a bumped attempt', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const stageId = await seedQuizStage(page, 'e2e-unit-quiz', {
      lessonKind: 'unitQuiz',
      outlines: [unitQuizOutline()],
    });

    let sceneContentBody: { outline?: { quizConfig?: { attempt?: number } } } | null = null;
    await page.route('**/api/generate/scene-content', async (route) => {
      sceneContentBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          // Shape copied verbatim from the real route: `content` is the
          // *generated* payload (`GeneratedQuizContent`), which carries NO
          // `type` discriminant — that is stamped later, by
          // `buildCompleteScene`, when the scene is assembled. A stub that adds
          // `type: 'quiz'` here would let a consumer that requires it pass in
          // tests and fail against the deployment.
          content: { questions: REGENERATED_QUESTIONS },
        }),
      });
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    // The cover is the first surface; it shows the counts, not the questions.
    const changeSet = page.locator('[data-quiz-action="change-set"]');
    await expect(changeSet).toBeVisible();
    await expect(changeSet).toBeEnabled();
    await expect(page.locator('[data-quiz-action="start"]')).toBeVisible();

    // The swap is not finished when the generation request resolves: the new
    // content is then written back through the document store and the runtime
    // attempt is rolled over. Starting the quiz before that settles would have
    // the rollover reset the phase back to the cover, so wait for the write.
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes('/api/persistence/documents/'),
      { timeout: 20_000 },
    );

    await changeSet.click();

    // The first shuffle is attempt 1, and it carries the fixed mix/option
    // contract the outline persists.
    await expect.poll(() => sceneContentBody?.outline?.quizConfig?.attempt ?? null).toBe(1);

    const savedBody = (await saved).request().postDataJSON() as {
      scenes?: { id: string; content?: { type?: string; questions?: unknown[] } }[];
    };
    await expect(changeSet).toBeEnabled({ timeout: 20_000 });

    // What lands in the store is a complete scene content, `type` included. The
    // generated payload has none, so writing it back unchanged would persist a
    // quiz scene whose content silently lost its discriminant.
    const persisted = savedBody?.scenes?.find((scene) => scene.id === 'scene-quiz');
    expect(persisted?.content?.type).toBe('quiz');
    expect(persisted?.content?.questions).toHaveLength(REGENERATED_QUESTIONS.length);

    // The regenerated set replaces the seeded one.
    await page.locator('[data-quiz-action="start"]').click();
    await expect(page.getByText('Regenerated first question?')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Seeded first question?')).toHaveCount(0);
  });

  test('an ordinary lesson quiz scene does not offer a fresh set', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const stageId = await seedQuizStage(page, 'e2e-plain-quiz', {
      outlines: [unitQuizOutline()],
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await expect(page.locator('[data-quiz-action="change-set"]')).toHaveCount(0);

    // Still a playable quiz scene — the absence above is about the lesson kind,
    // not about the scene failing to render.
    await page.locator('[data-quiz-action="start"]').click();
    await expect(page.getByText('Seeded first question?')).toBeVisible();
  });
});

test.describe('case-teaching entry point', () => {
  let materialsStub: MaterialsKvStub;

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    }, SETTINGS_STORAGE);
    materialsStub = await installMaterialsKvStub(page);
  });

  test.afterEach(async ({ page }) => {
    for (const stageId of seededStageIds.splice(0)) {
      try {
        await retireServerDocument(page, stageId);
      } catch (error) {
        console.warn(`Could not clean up the seeded course ${stageId}:`, error);
      }
    }
  });

  test('one click on the chapter builds exactly one case scene, and it renders', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    seedMaterialsKv(materialsStub, ['第一章-导论.md']);
    await page.reload({ waitUntil: 'networkidle' });

    // The stubbed chapter has a digest but no bytes on this device — the
    // "restored from another device" case — so the pipeline reads the server's
    // derivation archive instead of parsing. The deployment has no row for a
    // synthetic digest, so answer it here, in the real route's envelope:
    // `{ success, data: { text, metadata } }` (`readArchivedExtraction`).
    await page.route('**/api/material-extraction**', async (route) => {
      const digest = new URL(route.request().url()).searchParams.get('digest') ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          success: true,
          data: {
            text: '# 第一章 导论\n\n外部性问题与环境规制的基本概念。',
            metadata: {
              pageCount: 1,
              extractionCache: {
                digest,
                extractorId: 'plain-text',
                extractorVersion: '1',
                hit: true,
              },
            },
          },
        }),
      });
    });

    let outlinesBody: {
      requirements?: { requirement?: string; lessonKind?: string };
    } | null = null;
    await page.route('**/api/generate/scene-outlines-stream', async (route) => {
      outlinesBody = route.request().postDataJSON();
      const outline = caseOutline();
      const events = `data: ${JSON.stringify({ type: 'outline', data: outline, index: 0 })}\n\n`;
      const done = `data: ${JSON.stringify({
        type: 'done',
        outlines: [outline],
        courseTitle: 'Case deck',
      })}\n\n`;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: events + done,
      });
    });

    let contentBody: { outline?: { type?: string } } | null = null;
    await page.route('**/api/generate/scene-content', async (route) => {
      contentBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Shape copied verbatim from the real route: `content` is the
        // *generated* payload (`GeneratedCaseContent`), which carries NO `type`
        // discriminant — that is stamped later, by `buildCompleteScene`, when
        // scene-actions assembles the scene. A stub that added `type: 'case'`
        // here would let a consumer that requires it pass in tests and fail
        // against the deployment.
        body: JSON.stringify({ success: true, content: GENERATED_CASE }),
      });
    });

    await page.route('**/api/generate/scene-actions', async (route) => {
      const body = route.request().postDataJSON() as { stageId?: string };
      const now = Date.now();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // The assembled scene, `content.type` included — the shape the real
        // route returns from `buildCompleteScene`.
        body: JSON.stringify({
          success: true,
          scene: {
            id: 'scene-case',
            outlineId: 'scene-case',
            stageId: body?.stageId ?? 'e2e-case',
            type: 'case',
            title: 'Case study',
            order: 1,
            content: ASSEMBLED_CASE_SCENE_CONTENT,
            actions: [
              {
                id: 'action-case',
                type: 'speech',
                agent: 'teacher',
                text: 'Let us read a real case first.',
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
          previousSpeeches: [],
        }),
      });
    });

    const panel = page.locator('[data-chapter-directory]');
    await panel.locator('[role="radio"]').first().click();
    const caseTeaching = page.locator('[data-chapter-action="case-teaching"]');
    await expect(caseTeaching).toBeEnabled();
    await caseTeaching.click();

    // The click carries the lesson kind and a requirement naming the chapter —
    // the case path has no composer, so this text IS the whole statement of
    // intent the outline step receives.
    await page.waitForURL(/\/generation-preview/, { timeout: 20_000 });
    await expect.poll(() => outlinesBody?.requirements?.lessonKind ?? null).toBe('caseTeaching');
    await expect
      .poll(() => outlinesBody?.requirements?.requirement ?? '')
      .toContain('第一章-导论.md');

    // The case outline reaches the per-type content route (`scene-content:case`,
    // which had to be routed for this path to resolve a model at all).
    await expect.poll(() => contentBody?.outline?.type ?? null).toBe('case');

    await page.waitForURL(/\/classroom\//, { timeout: 60_000 });
    const createdStageId = decodeURIComponent(
      new URL(page.url()).pathname.split('/classroom/')[1]?.replace(/\/$/, '') ?? '',
    );
    expect(createdStageId).not.toBe('');

    // The reading scene renders: title, the chapter's knowledge points as tags,
    // the narrative, the discussion questions, and one openable source.
    await expect(page.getByRole('heading', { name: GENERATED_CASE.caseTitle })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Chapter knowledge points')).toBeVisible();
    await expect(page.getByText('Environmental externality').first()).toBeVisible();
    await expect(
      page.getByText('By morning the tributary ran violet for a kilometre.'),
    ).toBeVisible();
    await expect(page.getByText('Who ends up paying for the damage?')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Official investigation report' })).toHaveAttribute(
      'href',
      'https://example.gov.cn/report',
    );
    // The title-only source never reaches the page — a citation a reader cannot
    // open is worse than no citation.
    await expect(page.getByText('Title with no URL at all')).toHaveCount(0);

    // What the server stored is case-typed: the generated payload has no
    // discriminant, so writing it back unchanged would persist a scene whose
    // content silently lost its `type`. The write trails the redirect (the
    // classroom renders from the in-memory store first), so poll for it.
    await expect
      .poll(async () => ((await readServerDocument(page, createdStageId))?.scenes ?? []).length, {
        timeout: 20_000,
      })
      .toBe(1);

    const document = await readServerDocument(page, createdStageId);
    const scenes = (document?.scenes ?? []) as Array<{
      type?: string;
      content?: { type?: string };
    }>;
    expect(scenes[0]?.type).toBe('case');
    expect(scenes[0]?.content?.type).toBe('case');

    seededStageIds.push(createdStageId);
  });

  test('a case with no usable source says so instead of showing an empty list', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    // Same payload as the assembled case above, minus its `sources` — a case the
    // model wrote without citing anything openable.
    const { sources: _dropped, ...withoutSources } = ASSEMBLED_CASE_SCENE_CONTENT;
    const stageId = await seedCaseStage(page, 'e2e-case-nosource', {
      lessonKind: 'caseTeaching',
      outlines: [caseOutline()],
      content: withoutSources,
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await expect(
      page.getByRole('heading', { name: ASSEMBLED_CASE_SCENE_CONTENT.caseTitle }),
    ).toBeVisible();
    // Said out loud rather than left blank: a case with no citation is written
    // from the model's own knowledge, and a reader deciding how much of it to
    // trust needs to know that.
    await expect(page.getByText(/this case was written from general knowledge/i)).toBeVisible();
    await expect(page.locator('a[href^="https://example.gov.cn"]')).toHaveCount(0);
  });

  test('writes the analysis on request and keeps the rest of the case intact', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    const stageId = await seedCaseStage(page, 'e2e-case-analysis', {
      lessonKind: 'caseTeaching',
      outlines: [caseOutline()],
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    // The analysis is written on demand, so what is on screen before the click
    // is the *button* — not an empty analysis section.
    const analyseButton = page.getByRole('button', { name: /analyse this case/i });
    await expect(analyseButton).toBeVisible();

    const analysisRequest = { caseTitle: '', narrative: '', knowledgePoints: [] as string[] };
    await page.route('**/api/generate/case-analysis', async (route) => {
      const body = route.request().postDataJSON() as typeof analysisRequest;
      analysisRequest.caseTitle = body.caseTitle;
      analysisRequest.narrative = body.narrative;
      analysisRequest.knowledgePoints = body.knowledgePoints;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, analysis: CASE_ANALYSIS }),
      });
    });

    await analyseButton.click();

    // The request carries the case **as rendered**, not the outline: the analysis
    // has to explain the case the learner read.
    await expect.poll(() => analysisRequest.caseTitle).toBe(ASSEMBLED_CASE_SCENE_CONTENT.caseTitle);
    expect(analysisRequest.narrative).toBe(ASSEMBLED_CASE_SCENE_CONTENT.narrative);
    expect(analysisRequest.knowledgePoints).toEqual(ASSEMBLED_CASE_SCENE_CONTENT.knowledgePoints);

    await expect(page.getByText(CASE_ANALYSIS.entries[0].bearing)).toBeVisible();

    // ⚠️ The write-back has to keep everything else. Scene content is replaced
    // **wholesale** for every kind except PBL (`mergeSceneContentForUpdate`), so a
    // write that forgot to spread the current content would persist a case whose
    // narrative and questions are gone — and it would still render, because the
    // in-memory store is what is on screen.
    await expect
      .poll(
        async () => {
          const document = await readServerDocument(page, stageId);
          const content = (document?.scenes ?? [])[0]?.content as
            | Record<string, unknown>
            | undefined;
          return {
            hasAnalysis: Boolean(content?.analysis),
            narrative: content?.narrative,
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({
        hasAnalysis: true,
        narrative: ASSEMBLED_CASE_SCENE_CONTENT.narrative,
      });

    const document = await readServerDocument(page, stageId);
    const content = (document?.scenes ?? [])[0]?.content as Record<string, unknown>;
    expect(content.discussionQuestions).toHaveLength(2);
    expect(content.sources).toHaveLength(1);
    expect(content.type).toBe('case');
  });

  test('swaps in a different case, re-researching it and dropping the stale analysis', async ({
    page,
  }) => {
    // The swap re-runs the research, which is gated on the search toggle exactly
    // as the generation flow's `case-search` step is — so this test needs it on.
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
    }, CASE_SEARCH_SETTINGS);

    await page.goto('/', { waitUntil: 'networkidle' });
    const stageId = await seedCaseStage(page, 'e2e-case-swap', {
      lessonKind: 'caseTeaching',
      outlines: [caseOutline()],
      // Seeded WITH an analysis on purpose: the swap has to clear it, because an
      // analysis explains one specific event and that event is about to change.
      content: { ...ASSEMBLED_CASE_SCENE_CONTENT, analysis: CASE_ANALYSIS },
    });

    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();
    await expect(page.getByText(CASE_ANALYSIS.entries[0].bearing)).toBeVisible();

    // The real search is never run: it costs quota and its results are not
    // reproducible.
    const searchQueries: string[] = [];
    await page.route('**/api/web-search', async (route) => {
      const body = route.request().postDataJSON() as { query?: string };
      const query = body?.query ?? '';
      searchQueries.push(query);
      const slug =
        query
          .split(' ')[0]
          ?.toLowerCase()
          .replace(/[^a-z]+/g, '-') ?? 'point';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          answer: `Reported event for ${slug}.`,
          sources: [
            {
              title: `Report ${slug}`,
              url: `https://news.example.com/${slug}`,
              content: `${slug} was reported in the press.`,
              score: 1,
            },
          ],
          context: '',
          query,
          responseTime: 1,
        }),
      });
    });

    const contentRequests: {
      caseContext?: string;
      caseSources?: unknown[];
      attempt?: number;
    }[] = [];
    await page.route('**/api/generate/scene-content', async (route) => {
      const body = route.request().postDataJSON() as {
        outline?: { caseConfig?: { attempt?: number } };
        caseContext?: string;
        caseSources?: unknown[];
      };
      contentRequests.push({
        caseContext: body.caseContext,
        caseSources: body.caseSources,
        attempt: body.outline?.caseConfig?.attempt,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Still the generated payload, with no `type` discriminant.
        body: JSON.stringify({ success: true, content: SECOND_CASE }),
      });
    });

    await page.getByRole('button', { name: /try another case/i }).click();

    await expect(page.getByRole('heading', { name: SECOND_CASE.caseTitle })).toBeVisible({
      timeout: 30_000,
    });

    // One query per outline knowledge point — the swap researches *before* it
    // writes, which is what keeps the replacement sourced rather than degrading
    // every swapped case to "written from general knowledge".
    await expect.poll(() => searchQueries.length, { timeout: 30_000 }).toBe(3);
    expect(contentRequests).toHaveLength(1);
    expect(contentRequests[0]?.attempt).toBe(1);
    expect(contentRequests[0]?.caseContext).toBeTruthy();
    expect(contentRequests[0]?.caseSources).toHaveLength(3);

    // The previous analysis is gone — it explained the previous event.
    await expect(page.getByText(CASE_ANALYSIS.entries[0].bearing)).toHaveCount(0);
    // The new case renders its own content, not the old one.
    await expect(page.getByText(/below the cost of treating the effluent/i)).toBeVisible();

    await expect
      .poll(
        async () => {
          const document = await readServerDocument(page, stageId);
          const content = (document?.scenes ?? [])[0]?.content as
            | Record<string, unknown>
            | undefined;
          return { title: content?.caseTitle, hasAnalysis: Boolean(content?.analysis) };
        },
        { timeout: 20_000 },
      )
      .toEqual({ title: SECOND_CASE.caseTitle, hasAnalysis: false });
  });

  /**
   * Case research, with the search toggle on.
   *
   * Nested so the outer `beforeEach` still installs the material-directory stub
   * and the cleanup still runs; this hook seeds the settings again *after* it,
   * which is what turns the `case-search` step on.
   */
  test.describe('with web search enabled', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((settings) => {
        localStorage.setItem('maic:account:settings-storage', settings);
      }, CASE_SEARCH_SETTINGS);
    });

    test('researches every knowledge point and hands the material to the content step', async ({
      page,
    }) => {
      await page.goto('/', { waitUntil: 'networkidle' });
      seedMaterialsKv(materialsStub, ['第一章-导论.md']);
      await page.reload({ waitUntil: 'networkidle' });

      // The stubbed chapter has a digest but no bytes on this device, so the
      // pipeline reads the server's archive instead of parsing.
      await page.route('**/api/material-extraction**', async (route) => {
        const digest = new URL(route.request().url()).searchParams.get('digest') ?? '';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            success: true,
            data: {
              text: '# 第一章 导论\n\n外部性问题与环境规制的基本概念。',
              metadata: {
                pageCount: 1,
                extractionCache: {
                  digest,
                  extractorId: 'plain-text',
                  extractorVersion: '1',
                  hit: true,
                },
              },
            },
          }),
        });
      });

      await page.route('**/api/generate/scene-outlines-stream', async (route) => {
        const outline = caseOutline();
        const events = `data: ${JSON.stringify({ type: 'outline', data: outline, index: 0 })}\n\n`;
        const done = `data: ${JSON.stringify({
          type: 'done',
          outlines: [outline],
          courseTitle: 'Case deck',
        })}\n\n`;
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
          body: events + done,
        });
      });

      // The real search is never run: it costs quota, and its results are not
      // reproducible. Everything the case step depends on is the *shape* the
      // route returns, so that is what gets stubbed — the same envelope the
      // route builds with `apiSuccess({ answer, sources, context, query,
      // responseTime })`.
      const searchQueries: string[] = [];
      const KNOWN_POINTS = caseOutline().keyPoints;
      await page.route('**/api/web-search', async (route) => {
        const body = route.request().postDataJSON() as { query?: string };
        const query = body?.query ?? '';
        searchQueries.push(query);
        const point = KNOWN_POINTS.find((known) => query.startsWith(known));
        const slug = point
          ? point
              .toLowerCase()
              .replace(/[^a-z]+/g, '-')
              .replace(/^-|-$/g, '')
          : 'requirement';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            answer: `Reported event for ${slug}.`,
            sources: [
              {
                title: `Report ${slug}`,
                url: `https://news.example.com/${slug}`,
                content: `${slug} was reported in the press.`,
                score: 1,
              },
            ],
            context: '',
            query,
            responseTime: 1,
          }),
        });
      });

      let contentBody: {
        outline?: { type?: string };
        caseContext?: string;
        caseSources?: { title: string; url: string }[];
      } | null = null;
      await page.route('**/api/generate/scene-content', async (route) => {
        contentBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          // Still the generated payload, with no `type` discriminant.
          body: JSON.stringify({ success: true, content: GENERATED_CASE }),
        });
      });

      await page.route('**/api/generate/scene-actions', async (route) => {
        const body = route.request().postDataJSON() as { stageId?: string };
        const now = Date.now();
        // The server is what turns the citable list into the scene's sources, so
        // the stub echoes whatever list it was handed: that is what makes the
        // rendered-link assertion below test the whole loop (research → content
        // request → scene → page) instead of the stub's own fixture.
        const researched = (contentBody?.caseSources ?? []).map((source) => ({
          title: source.title,
          url: source.url,
        }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            scene: {
              id: 'scene-case',
              outlineId: 'scene-case',
              stageId: body?.stageId ?? 'e2e-case-search',
              type: 'case',
              title: 'Case study',
              order: 1,
              content: {
                ...ASSEMBLED_CASE_SCENE_CONTENT,
                ...(researched.length > 0 ? { sources: researched } : {}),
              },
              actions: [
                {
                  id: 'action-case',
                  type: 'speech',
                  agent: 'teacher',
                  text: 'Let us read a real case first.',
                },
              ],
              createdAt: now,
              updatedAt: now,
            },
            previousSpeeches: [],
          }),
        });
      });

      const panel = page.locator('[data-chapter-directory]');
      await panel.locator('[role="radio"]').first().click();
      await page.locator('[data-chapter-action="case-teaching"]').click();

      await page.waitForURL(/\/generation-preview/, { timeout: 20_000 });

      // The toggle also activates the pre-outline `web-search` step, so the
      // route sees one more call than the case step makes — that one searches
      // the raw requirement and never carries the research hint. Filtering by
      // "starts with a knowledge point" is what separates the two.
      const caseQueries = () =>
        searchQueries.filter((query) => KNOWN_POINTS.some((point) => query.startsWith(point)));

      // One query per knowledge point — the outline's three. A single combined
      // query would make the provider answer for whichever point it prefers and
      // silently drop the rest, which is the failure this fan-out exists to
      // avoid.
      await expect.poll(caseQueries, { timeout: 30_000 }).toHaveLength(KNOWN_POINTS.length);
      expect(caseQueries().some((query) => query.startsWith(KNOWN_POINTS[0]))).toBe(true);
      // The research preference travels in the query itself: the providers
      // return no date or region metadata, so there is nothing to filter on.
      expect(caseQueries().every((query) => query.includes('real incident'))).toBe(true);

      // What the search returned reaches the content step, both as prose the
      // case is written from and as the list of URLs it may cite.
      await expect
        .poll(() => (contentBody?.caseContext ?? '').length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(contentBody?.caseContext).toContain('### Environmental externality');
      expect(contentBody?.caseContext).toContain('Reported event for');
      expect((contentBody?.caseSources ?? []).map((source) => source.url).sort()).toEqual(
        KNOWN_POINTS.map(
          (point) => `https://news.example.com/${point.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        ).sort(),
      );

      await page.waitForURL(/\/classroom\//, { timeout: 60_000 });
      const createdStageId = decodeURIComponent(
        new URL(page.url()).pathname.split('/classroom/')[1]?.replace(/\/$/, '') ?? '',
      );
      expect(createdStageId).not.toBe('');
      seededStageIds.push(createdStageId);

      // The researched case renders with the pages the search found, and the
      // "written from general knowledge" notice is gone — the observable point
      // of the whole step.
      await expect(page.getByRole('heading', { name: GENERATED_CASE.caseTitle })).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        page.getByRole('link', { name: 'Report environmental-externality' }),
      ).toHaveAttribute('href', 'https://news.example.com/environmental-externality');
      await expect(page.getByText(/this case was written from general knowledge/i)).toHaveCount(0);
    });
  });
});
