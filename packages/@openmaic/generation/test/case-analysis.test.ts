import { describe, expect, it } from 'vitest';

import type { AICallFn, SceneContentFailure } from '@openmaic/generation';
import { generateCaseAnalysis } from '@openmaic/generation';

const POINTS = ['Environmental externality', 'Regulatory failure', 'Public opinion pressure'];

/**
 * Read the analysis structurally rather than through the DSL type: these tests
 * are about what survives normalization, including what is *omitted* — an
 * optional field that is present-but-empty is the failure mode this module is
 * supposed to prevent.
 */
interface AnalysisPayload {
  entries?: { point: string; bearing: string }[];
  closing?: string;
}

interface CapturedCall {
  system: string;
  user: string;
}

async function analyse(
  response: string,
  options: {
    knowledgePoints?: string[];
    failures?: SceneContentFailure[];
    languageDirective?: string;
  } = {},
): Promise<{
  analysis: AnalysisPayload | null;
  failures: SceneContentFailure[];
  calls: CapturedCall[];
}> {
  const failures = options.failures ?? [];
  const calls: CapturedCall[] = [];
  const aiCall: AICallFn = async (system, user) => {
    calls.push({ system, user });
    return response;
  };

  const analysis = await generateCaseAnalysis(
    {
      caseTitle: 'The mill that dyed the river',
      narrative: 'A mill discharged dye after dark.\n\nThe tributary ran red for a week.',
      knowledgePoints: options.knowledgePoints ?? POINTS,
    },
    aiCall,
    {
      languageDirective: options.languageDirective ?? 'Teach in English.',
      onFailure: (failure) => failures.push(failure),
    },
  );

  return { analysis: analysis as AnalysisPayload | null, failures, calls };
}

describe('case analysis generation', () => {
  it('emits entries in the chapter order even when the model reorders them', async () => {
    const { analysis, failures } = await analyse(
      JSON.stringify({
        analysis: {
          entries: [
            { point: 'Regulatory failure', bearing: 'Inspections signed off for a week.' },
            { point: 'Environmental externality', bearing: 'The mill paid nothing for the river.' },
          ],
        },
      }),
    );

    expect(failures).toEqual([]);
    expect(analysis?.entries?.map((entry) => entry.point)).toEqual([
      'Environmental externality',
      'Regulatory failure',
    ]);
  });

  it('matches a re-cased, re-spaced point but emits the chapter wording', async () => {
    // Also the bare-object tolerance: no `analysis` wrapper here.
    const { analysis } = await analyse(
      JSON.stringify({
        entries: [{ point: '  regulatory   FAILURE ', bearing: 'Inspectors signed off anyway.' }],
      }),
    );

    expect(analysis?.entries).toEqual([
      { point: 'Regulatory failure', bearing: 'Inspectors signed off anyway.' },
    ]);
  });

  it('drops an entry naming a point the chapter does not have', async () => {
    const { analysis } = await analyse(
      JSON.stringify({
        analysis: {
          entries: [
            { point: 'Environmental externality', bearing: 'The river carried the cost.' },
            { point: 'Tragedy of the commons', bearing: 'A fabricated connection.' },
          ],
        },
      }),
    );

    expect(analysis?.entries).toEqual([
      { point: 'Environmental externality', bearing: 'The river carried the cost.' },
    ]);
  });

  it('rejects the whole analysis when every entry names an unknown point', async () => {
    const failures: SceneContentFailure[] = [];
    const { analysis } = await analyse(
      JSON.stringify({
        analysis: { entries: [{ point: 'Tragedy of the commons', bearing: 'X' }] },
      }),
      { failures },
    );

    expect(analysis).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  it('keeps a partial analysis rather than discarding it', async () => {
    const { analysis, failures } = await analyse(
      JSON.stringify({
        analysis: {
          entries: [{ point: 'Environmental externality', bearing: 'The river carried the cost.' }],
        },
      }),
    );

    expect(failures).toEqual([]);
    expect(analysis?.entries).toHaveLength(1);
  });

  it('drops a blank bearing', async () => {
    const { analysis } = await analyse(
      JSON.stringify({
        analysis: {
          entries: [
            { point: 'Environmental externality', bearing: '   ' },
            { point: 'Regulatory failure', bearing: 'The permit was renewed regardless.' },
          ],
        },
      }),
    );

    expect(analysis?.entries).toEqual([
      { point: 'Regulatory failure', bearing: 'The permit was renewed regardless.' },
    ]);
  });

  it('ignores a duplicate point instead of rendering the heading twice', async () => {
    const { analysis } = await analyse(
      JSON.stringify({
        analysis: {
          entries: [
            { point: 'Regulatory failure', bearing: 'First.' },
            { point: 'Regulatory failure', bearing: 'Second.' },
          ],
        },
      }),
    );

    expect(analysis?.entries).toEqual([{ point: 'Regulatory failure', bearing: 'First.' }]);
  });

  it('omits a blank closing and trims a real one', async () => {
    const entries = [{ point: 'Regulatory failure', bearing: 'The permit was renewed.' }];

    const blank = await analyse(JSON.stringify({ analysis: { entries, closing: '   ' } }));
    expect(Object.keys(blank.analysis ?? {})).toEqual(['entries']);

    const real = await analyse(
      JSON.stringify({ analysis: { entries, closing: '  Price it or ban it.  ' } }),
    );
    expect(real.analysis?.closing).toBe('Price it or ban it.');
  });

  it.each([
    ['a bare array', '[]'],
    ['a string', '"nope"'],
    ['an object with no entries', JSON.stringify({ analysis: { closing: 'x' } })],
    ['entries of the wrong shape', JSON.stringify({ analysis: { entries: ['a', 3, null] } })],
  ])('rejects %s as an invalid model output', async (_label, payload) => {
    const failures: SceneContentFailure[] = [];
    const { analysis } = await analyse(payload, { failures });

    expect(analysis).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  it('fails as a missing input — without calling the model — when the chapter has no points', async () => {
    const failures: SceneContentFailure[] = [];
    const { analysis, calls } = await analyse(JSON.stringify({ analysis: { entries: [] } }), {
      knowledgePoints: [],
      failures,
    });

    expect(analysis).toBeNull();
    expect(failures).toEqual([{ code: 'missing-input' }]);
    expect(calls).toEqual([]);
  });

  it('sends the case, the normalized points and the language directive to the model', async () => {
    const { calls } = await analyse(JSON.stringify({ analysis: { entries: [] } }), {
      knowledgePoints: ['  Pigouvian   tax ', 'Regulatory failure'],
      languageDirective: 'Teach in German.',
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.system).toContain('Case Analysis Generator');
    expect(call.user).toContain('The mill that dyed the river');
    expect(call.user).toContain('A mill discharged dye after dark.');
    // Normalized before it reaches the model, so the numbering lines up with the
    // tags the learner sees.
    expect(call.user).toContain('1. Pigouvian tax');
    expect(call.user).toContain('2. Regulatory failure');
    expect(call.user).toContain('Teach in German.');
  });
});
