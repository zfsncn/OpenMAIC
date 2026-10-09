import { describe, expect, it, vi } from 'vitest';

import type { AICallFn, SceneContentFailure } from '@openmaic/generation';
import {
  buildCompleteScene,
  generateSceneActions,
  generateSceneContent,
} from '@openmaic/generation';
import { caseOutline, validCaseResponse } from './scene-fixtures.js';

/**
 * The case payload is a union member whose every field is optional on the wire,
 * so the tests read it structurally instead of importing the generated shape.
 */
interface CasePayload {
  caseTitle?: string;
  summary?: string;
  knowledgePoints?: string[];
  narrative?: string;
  discussionQuestions?: { id: string; question: string; point?: string }[];
  sources?: { title: string; url: string }[];
}

const asCase = (value: unknown): CasePayload => value as CasePayload;

async function generateCase(aiCall: AICallFn, failures: SceneContentFailure[] = []) {
  return asCase(
    await generateSceneContent(caseOutline(), aiCall, {
      languageDirective: 'Teach in English.',
      onFailure: (failure) => failures.push(failure),
    }),
  );
}

/** Same, with research material attached — the post-search path. */
async function generateCaseWithResearch(
  aiCall: AICallFn,
  options: { caseContext?: string; caseSources?: { title: string; url: string }[] },
) {
  return asCase(
    await generateSceneContent(caseOutline(), aiCall, {
      languageDirective: 'Teach in English.',
      ...options,
    }),
  );
}

const RESEARCHED = [
  { title: 'Tributary investigation', url: 'https://example.gov.cn/report' },
  { title: 'Mill fined', url: 'https://news.example.com/fine' },
];

/** A payload that is complete everywhere except its `sources`. */
function casePayloadWithSources(sources: unknown) {
  return JSON.stringify({
    caseTitle: 'T',
    narrative: 'N',
    discussionQuestions: [{ question: 'Q?' }],
    sources,
  });
}

describe('case content generation', () => {
  it('normalizes a recoverable payload and drops unopenable sources', async () => {
    const failures: SceneContentFailure[] = [];
    const aiCall: AICallFn = vi.fn(async () => validCaseResponse());

    const content = await generateCase(aiCall, failures);

    expect(failures).toEqual([]);
    expect(content.caseTitle).toBe('Dyeing wastewater discharged into a tributary');
    expect(content.knowledgePoints).toEqual([
      'Environmental externality',
      'Pigouvian tax',
      'Regulatory failure',
    ]);
    expect(content.discussionQuestions).toEqual([
      {
        id: 'q_externality',
        question: 'Who ends up paying for the damage, and who priced it in?',
        point: 'Environmental externality',
      },
      // No id on the wire, and the blank-stemmed question ahead of it is gone,
      // so the fallback id is positional among the survivors.
      { id: 'cq_2', question: 'Why did the tax fail to bite?', point: 'Pigouvian tax' },
    ]);
    // A title-only or relative-URL source is dropped rather than kept as
    // unverifiable evidence; an untitled absolute URL becomes its own label.
    expect(content.sources).toEqual([
      { title: 'Official investigation report', url: 'https://example.gov.cn/report' },
      { title: 'http://news.example.com/story', url: 'http://news.example.com/story' },
    ]);
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('omits sources entirely when none survive normalization', async () => {
    const content = await generateCase(
      vi.fn(async () =>
        JSON.stringify({
          caseTitle: 'T',
          narrative: 'N',
          discussionQuestions: [{ question: 'Q?' }],
          sources: [{ title: 'no url' }, { url: 'ftp://example.com/x' }],
        }),
      ),
    );

    // Absent, not an empty array: the renderer's "no sources" warning keys off
    // presence, and an empty array would claim sources were found.
    expect(content.sources).toBeUndefined();
  });

  it.each([
    ['a missing case title', { narrative: 'N', discussionQuestions: [{ question: 'Q?' }] }],
    [
      'a blank narrative',
      { caseTitle: 'T', narrative: '   ', discussionQuestions: [{ question: 'Q' }] },
    ],
    ['no discussion questions', { caseTitle: 'T', narrative: 'N', discussionQuestions: [] }],
    [
      'only blank-stemmed questions',
      { caseTitle: 'T', narrative: 'N', discussionQuestions: [{ question: '  ' }] },
    ],
  ])('reports invalid-model-output for %s', async (_label, payload) => {
    const failures: SceneContentFailure[] = [];
    const aiCall: AICallFn = vi.fn(async () => JSON.stringify(payload));

    // A case without a narrative or without a question to pose is not a case,
    // and half of one renders as a blank page.
    expect(await generateCase(aiCall, failures)).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  it('tolerates an empty knowledge-point list', async () => {
    const failures: SceneContentFailure[] = [];
    const content = await generateCase(
      vi.fn(async () =>
        JSON.stringify({
          caseTitle: 'T',
          narrative: 'N',
          knowledgePoints: [],
          discussionQuestions: [{ question: 'Q?' }],
        }),
      ),
      failures,
    );

    // The prompt's honesty rule prefers an under-covered case over a fabricated
    // one, so this is the single tolerated shortfall.
    expect(failures).toEqual([]);
    expect(content.knowledgePoints).toEqual([]);
  });
});

/**
 * Once research has run, the caller knows which URLs the case may legitimately
 * cite — they are exactly the pages the search returned. These tests pin the two
 * things that knowledge buys: a URL outside that set can never ship, and a case
 * built from research never claims to have none.
 */
describe('case sources against researched material', () => {
  it('drops a model-cited URL that the research never returned', async () => {
    const content = await generateCaseWithResearch(
      vi.fn(async () =>
        casePayloadWithSources([
          { title: 'Tributary investigation', url: 'https://example.gov.cn/report' },
          // Well-formed, plausible, and about the right subject — which is
          // exactly why shape validation alone cannot catch it. The model was
          // never given this URL, so it cannot have read the page.
          { title: 'Looks official', url: 'https://example.gov.cn/not-in-results' },
        ]),
      ),
      { caseContext: 'search material', caseSources: RESEARCHED },
    );

    expect(content.sources).toEqual([RESEARCHED[0]]);
  });

  it('falls back to the researched sources when the model cites none', async () => {
    const content = await generateCaseWithResearch(
      vi.fn(async () => casePayloadWithSources([])),
      { caseContext: 'search material', caseSources: RESEARCHED },
    );

    // Not an empty list: the case really was written from these pages, so a
    // reader deciding how far to trust it is better served by the material than
    // by the "written from general knowledge" notice, which would be false.
    expect(content.sources).toEqual(RESEARCHED);
  });

  it('falls back too when the model cites only pages outside the research', async () => {
    const content = await generateCaseWithResearch(
      vi.fn(async () =>
        casePayloadWithSources([{ title: 'Invented', url: 'https://made-up.example/x' }]),
      ),
      { caseContext: 'search material', caseSources: RESEARCHED },
    );

    expect(content.sources).toEqual(RESEARCHED);
  });

  it('caps the fallback list rather than shipping the whole research', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.com/${index + 1}`,
    }));

    const content = await generateCaseWithResearch(
      vi.fn(async () => casePayloadWithSources([])),
      {
        caseContext: 'search material',
        caseSources: many,
      },
    );

    // "The material behind this case", not a bibliography — six knowledge
    // points times a handful of pages each would read as padding.
    expect(content.sources).toHaveLength(5);
    expect(content.sources).toEqual(many.slice(0, 5));
  });

  it('takes the model at face value when no research backed it', async () => {
    const content = await generateCaseWithResearch(
      vi.fn(async () =>
        casePayloadWithSources([{ title: 'Self-cited', url: 'https://example.org/self' }]),
      ),
      {},
    );

    // Without a research list there is nothing to check against, so the
    // existing shape-only filter is the whole contract.
    expect(content.sources).toEqual([{ title: 'Self-cited', url: 'https://example.org/self' }]);
  });

  it('spells the citable URLs out in the prompt so copying is followable', async () => {
    const aiCall = vi.fn(async () => casePayloadWithSources([]));

    await generateCaseWithResearch(aiCall, {
      caseContext: 'search material',
      caseSources: RESEARCHED,
    });

    const [systemPrompt, userPrompt] = aiCall.mock.calls[0] as unknown as [string, string];
    expect(userPrompt).toContain(RESEARCHED[0].url);
    expect(userPrompt).toContain(RESEARCHED[1].url);
    // The rule has to be stated in the system prompt too, or the list reads as
    // context rather than as the permitted set.
    expect(systemPrompt).toContain('character for character');
  });

  it('omits the citable list entirely when there is no research', async () => {
    const aiCall = vi.fn(async () => casePayloadWithSources([]));

    await generateCaseWithResearch(aiCall, {});

    const [, userPrompt] = aiCall.mock.calls[0] as unknown as [string, string];
    expect(userPrompt).not.toContain('Citable Sources');
  });
});

describe('case scene assembly', () => {
  it('builds a persisted case scene from the generated payload', async () => {
    const content = await generateCase(vi.fn(async () => validCaseResponse()));
    const actions = await generateSceneActions(
      caseOutline(),
      content,
      vi.fn(async () => 'unused'),
    );

    const scene = buildCompleteScene(caseOutline(), content, actions, 'stage-1', {
      sceneId: 'scene-1',
    });

    expect(scene).toMatchObject({
      id: 'scene-1',
      outlineId: 'case-1',
      stageId: 'stage-1',
      type: 'case',
      title: 'Externality: the dyeing-wastewater case',
      order: 5,
      content: {
        type: 'case',
        caseTitle: 'Dyeing wastewater discharged into a tributary',
        summary: 'A textile mill released untreated dyeing wastewater after dark.',
        knowledgePoints: ['Environmental externality', 'Pigouvian tax', 'Regulatory failure'],
        narrative: expect.stringContaining('tributary'),
        discussionQuestions: [
          {
            id: 'q_externality',
            question: 'Who ends up paying for the damage, and who priced it in?',
            point: 'Environmental externality',
          },
          { id: 'cq_2', question: 'Why did the tax fail to bite?', point: 'Pigouvian tax' },
        ],
        sources: [
          { title: 'Official investigation report', url: 'https://example.gov.cn/report' },
          { title: 'http://news.example.com/story', url: 'http://news.example.com/story' },
        ],
      },
    });
    // The analysis pass has not run yet — the scene ships revealable, not
    // pre-analysed.
    expect((scene?.content as { analysis?: unknown }).analysis).toBeUndefined();
  });

  it('refuses to assemble a case scene with no narrative', () => {
    expect(
      buildCompleteScene(
        caseOutline(),
        { caseTitle: 'T', discussionQuestions: [{ id: 'q1', question: 'Q?' }] },
        [],
        'stage-1',
      ),
    ).toBeNull();
  });

  it('frames a case scene without generating narration over the case text', async () => {
    const aiCall: AICallFn = vi.fn(async () => 'unused');

    const actions = await generateSceneActions(
      caseOutline(),
      await generateCase(vi.fn(async () => validCaseResponse())),
      aiCall,
    );

    // No action prompt runs for a case: the scene owns its own pacing, so a
    // narration summarising the case would pre-empt the discussion questions.
    expect(aiCall).not.toHaveBeenCalled();
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('speech');
  });
});
