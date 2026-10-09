import { describe, expect, test } from 'vitest';

import { createDefaultCaseContent } from '@/lib/api/stage-api-defaults';
import { getDocumentStore } from '@/lib/document-store/store';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import { validateAppScene } from '@/lib/document-store/validators';
import { inMemoryDocumentStore } from '@/tests/helpers/in-memory-document-store';

/**
 * The document write barrier accepts a scene type by comparing literal strings
 * (`validateAppScene`), so it is the ONE dispatch site the DSL's compile-time
 * exhaustiveness check cannot find when a `SceneType` is added. Missing it does
 * not fail any type check or any other test: the store answers
 * `400 VALIDATION_FAILED` and `/api/persistence/**` only logs `status >= 500`,
 * so the write is dropped with nothing in the container logs. That happened
 * once (adding `case`), and this file is the guard against it happening again —
 * both as a direct unit assertion and as a store round-trip.
 */

function caseScene(content: unknown = createDefaultCaseContent()) {
  return {
    id: 'scene-case',
    stageId: 'stage-1',
    type: 'case',
    title: 'Externality: the dyeing-wastewater case',
    order: 1,
    content,
    createdAt: 1,
    updatedAt: 1,
  };
}

function reasonsFor(scene: unknown): string[] {
  const result = validateAppScene(scene);
  if (result.valid) return [];
  return (result.errors ?? []).map((issue) => `${issue.path}: ${issue.message}`);
}

describe('case scene write barrier', () => {
  test('accepts a scene the API just created, empty text and all', () => {
    // `createDefaultCaseContent()` is structurally complete with empty strings,
    // the same way an empty slide is. Rejecting it would make "add a case
    // scene" produce a scene the store refuses to save.
    expect(validateAppScene(caseScene())).toEqual({ valid: true });
  });

  test('accepts a fully populated case, sources and analysis included', () => {
    const scene = caseScene({
      type: 'case',
      caseTitle: 'Dyeing wastewater discharged into a tributary',
      summary: 'A textile mill released untreated dyeing wastewater after dark.',
      knowledgePoints: ['Environmental externality', 'Pigouvian tax'],
      narrative: 'The mill opened its discharge valve after dark.',
      discussionQuestions: [
        { id: 'cq_1', question: 'Who pays?', point: 'Environmental externality' },
      ],
      sources: [{ title: 'Official investigation report', url: 'https://example.gov.cn/report' }],
      analysis: {
        entries: [{ point: 'Environmental externality', bearing: 'The villagers bore the cost.' }],
        closing: 'The tax arrived four years late.',
      },
    });

    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  test('tolerates an absent sources array — that is how "no citation" is expressed', () => {
    const scene = caseScene({
      type: 'case',
      caseTitle: 'T',
      knowledgePoints: [],
      narrative: 'N',
      discussionQuestions: [],
    });

    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  test('still rejects a scene type the contract does not know', () => {
    const reasons = reasonsFor({ ...caseScene(), type: 'notes' });

    expect(reasons.join('\n')).toContain('unknown app scene type');
  });

  test('rejects a content discriminant that disagrees with the scene type', () => {
    const reasons = reasonsFor({ ...caseScene(), content: { type: 'quiz', questions: [] } });

    expect(reasons.join('\n')).toContain('/content/type');
  });

  test('rejects a case with no content object', () => {
    expect(reasonsFor({ ...caseScene(), content: undefined }).join('\n')).toContain('/content');
  });

  test.each([
    [
      'a non-string caseTitle',
      { ...createDefaultCaseContent(), caseTitle: 7 },
      '/content/caseTitle',
    ],
    [
      'a non-string narrative',
      { ...createDefaultCaseContent(), narrative: [] },
      '/content/narrative',
    ],
    ['a non-string summary', { ...createDefaultCaseContent(), summary: 1 }, '/content/summary'],
    [
      'a non-array knowledgePoints',
      { ...createDefaultCaseContent(), knowledgePoints: 'point' },
      '/content/knowledgePoints',
    ],
    [
      'a non-array discussionQuestions',
      { ...createDefaultCaseContent(), discussionQuestions: {} },
      '/content/discussionQuestions',
    ],
    [
      'a non-array sources',
      { ...createDefaultCaseContent(), sources: 'https://example.com' },
      '/content/sources',
    ],
    [
      'a knowledge point that is not a string',
      { ...createDefaultCaseContent(), knowledgePoints: ['ok', 3] },
      '/content/knowledgePoints/1',
    ],
    [
      'a non-boolean analysisHidden',
      { ...createDefaultCaseContent(), analysisHidden: 'yes' },
      '/content/analysisHidden',
    ],
  ])('rejects %s', (_label, content, path) => {
    expect(reasonsFor(caseScene(content)).join('\n')).toContain(path);
  });

  test('accepts the hidden flag on the case and on every variant', () => {
    // The renderer tests `=== true`, so a string would silently read as "shown"
    // and a number as "hidden" — which is why this is shape-checked rather than
    // coerced. Both places it can appear have to be accepted as written.
    const scene = caseScene({
      type: 'case',
      caseTitle: 'T',
      knowledgePoints: [],
      narrative: 'N',
      discussionQuestions: [],
      analysisHidden: true,
      caseVariants: [
        { caseTitle: 'T', knowledgePoints: [], narrative: 'N', discussionQuestions: [] },
        {
          caseTitle: 'U',
          knowledgePoints: [],
          narrative: 'M',
          discussionQuestions: [],
          analysisHidden: false,
        },
      ],
      activeVariantIndex: 1,
    });

    expect(validateAppScene(scene)).toEqual({ valid: true });
  });

  test('rejects a hidden flag buried in a variant, naming its position', () => {
    // Without the per-variant pass the whole list is one unvalidated blob, and
    // `applyVariant` mirrors whichever entry is active — so a bad value there
    // reaches the renderer without ever passing this boundary.
    const reasons = reasonsFor(
      caseScene({
        type: 'case',
        caseTitle: 'T',
        knowledgePoints: [],
        narrative: 'N',
        discussionQuestions: [],
        caseVariants: [
          { caseTitle: 'T', knowledgePoints: [], narrative: 'N', discussionQuestions: [] },
          {
            caseTitle: 'U',
            knowledgePoints: [],
            narrative: 'M',
            discussionQuestions: [],
            analysisHidden: 1,
          },
        ],
      }),
    );

    expect(reasons.join('\n')).toContain('/content/caseVariants/1/analysisHidden');
  });

  test('requires the shared scene fields like every other type', () => {
    const reasons = reasonsFor({ ...caseScene(), id: '', title: '' });

    expect(reasons.join('\n')).toContain('/id');
    expect(reasons.join('\n')).toContain('/title');
  });
});

describe('case scene store round-trip', () => {
  test('a case scene the barrier accepts survives save and load', async () => {
    const store = getDocumentStore({ store: inMemoryDocumentStore('case-scene-roundtrip') });
    const document: AppDocument = {
      stage: {
        id: 'stage-1',
        name: 'Case deck',
        createdAt: 1,
        updatedAt: 1,
      },
      scenes: [
        {
          ...caseScene({
            type: 'case',
            caseTitle: 'Dyeing wastewater discharged into a tributary',
            knowledgePoints: ['Environmental externality'],
            narrative: 'The mill opened its discharge valve after dark.',
            discussionQuestions: [{ id: 'cq_1', question: 'Who pays?' }],
            sources: [{ title: 'Report', url: 'https://example.gov.cn/report' }],
          }),
          type: 'case',
        },
      ],
    } as unknown as AppDocument;

    await store.saveDocument(document);

    const loaded = await store.loadDocument('stage-1');
    expect(loaded?.scenes).toHaveLength(1);
    expect(loaded?.scenes[0].type).toBe('case');
    expect((loaded?.scenes[0].content as { caseTitle?: string }).caseTitle).toBe(
      'Dyeing wastewater discharged into a tributary',
    );
  });
});
