import { describe, expect, it } from 'vitest';
import {
  CASE_VARIANT_LIMIT,
  activeVariantIndex,
  appendVariant,
  applyVariant,
  isAtCap,
  nextVariantIndex,
  readVariants,
  toVariant,
  updateActiveVariant,
} from '@/lib/classroom/case-variants';
import type { CaseContent, CaseVariant } from '@/lib/types/stage';

function variant(caseTitle: string, overrides: Partial<CaseVariant> = {}): CaseVariant {
  return {
    caseTitle,
    knowledgePoints: [`point for ${caseTitle}`],
    narrative: `narrative for ${caseTitle}`,
    discussionQuestions: [{ id: `q_${caseTitle}`, question: `question for ${caseTitle}` }],
    ...overrides,
  };
}

/** A one-case document: the shape every case has on the day it is generated. */
function one(overrides: Partial<CaseContent> = {}): CaseContent {
  return { type: 'case', ...variant('First'), ...overrides };
}

const two = () => appendVariant(one(), variant('Second'));
const three = () => appendVariant(two(), variant('Third'));

describe('case variants', () => {
  it('reads a document with no list as its single case, not as none', () => {
    // A case generated before this field existed holds exactly one case, and it
    // is the one the top-level fields describe. Reading it as "no cases" would
    // blank every classroom that predates the feature.
    const legacy = one();

    expect(readVariants(legacy)).toHaveLength(1);
    expect(readVariants(legacy)[0]).toEqual(toVariant(legacy));
  });

  it('treats an empty list the same way as an absent one', () => {
    const empty = one({ caseVariants: [] });

    expect(readVariants(empty)).toHaveLength(1);
    expect(readVariants(empty)[0].caseTitle).toBe('First');
  });

  it('clamps an out-of-range active index back onto the first case', () => {
    // Hand-edited or shrunk documents must not mirror `undefined` into
    // `caseTitle`, which would render a blank page with no error anywhere.
    const full = three();

    expect(activeVariantIndex({ ...full, activeVariantIndex: 9 })).toBe(0);
    expect(activeVariantIndex({ ...full, activeVariantIndex: -1 })).toBe(0);
    expect(activeVariantIndex({ ...full, activeVariantIndex: 1.5 })).toBe(0);
    expect(activeVariantIndex({ ...full, activeVariantIndex: 1 })).toBe(1);
  });

  it('reads a missing index as the first case', () => {
    // One-case documents carry no index at all, and a hand-edited one may carry
    // none over a list of three. Both must resolve rather than mirror
    // `undefined` into `caseTitle`.
    expect(activeVariantIndex(one())).toBe(0);
    expect(activeVariantIndex({ ...three(), activeVariantIndex: undefined })).toBe(0);
  });

  it('reports the cap only once the third case is saved', () => {
    expect(isAtCap(one())).toBe(false);
    expect(isAtCap(two())).toBe(false);
    expect(isAtCap(three())).toBe(true);
  });

  it('appends a new case and puts it on screen', () => {
    const grown = appendVariant(one(), variant('Second'));

    expect(readVariants(grown)).toHaveLength(2);
    expect(grown.caseTitle).toBe('Second');
    expect(grown.activeVariantIndex).toBe(1);
  });

  it('refuses a fourth case and returns the content untouched', () => {
    // Returning a fresh but equivalent object would let a caller believe the
    // save happened; returning the same reference cannot be mistaken for one.
    const full = three();

    expect(appendVariant(full, variant('Fourth'))).toBe(full);
    expect(readVariants(appendVariant(full, variant('Fourth')))).toHaveLength(CASE_VARIANT_LIMIT);
  });

  it('rotates to the next case, wrapping at the end', () => {
    // Appending puts the newest case on screen, so after the third is saved the
    // third is active and the first swap wraps round to the first case.
    const full = three();

    expect(activeVariantIndex(full)).toBe(2);
    expect(nextVariantIndex(full)).toBe(0);
    expect(nextVariantIndex(applyVariant(full, 0))).toBe(1);
    expect(nextVariantIndex(applyVariant(full, 1))).toBe(2);
  });

  it('mirrors the chosen case into the fields a reader uses', () => {
    const rotated = applyVariant(three(), 1);

    expect(rotated.caseTitle).toBe('Second');
    expect(rotated.narrative).toBe('narrative for Second');
    expect(rotated.discussionQuestions).toEqual([
      { id: 'q_Second', question: 'question for Second' },
    ]);
    expect(rotated.activeVariantIndex).toBe(1);
  });

  it('drops the optional fields the chosen case does not have', () => {
    // `summary` and `analysis` belong to a case, not to the scene. Carrying
    // them across a rotation would print the first case's summary — and, worse,
    // its analysis — under the second case's narrative.
    const analysed: CaseContent = one({
      summary: 'Summary of the first case.',
      analysis: { entries: [{ point: 'point for First', bearing: 'how it bears' }] },
    });
    const both = appendVariant(analysed, variant('Second'));

    const back = applyVariant(both, 0);
    expect(back.summary).toBe('Summary of the first case.');
    expect(back.analysis).toBeDefined();

    const forward = applyVariant(both, 1);
    expect(forward).not.toHaveProperty('summary');
    expect(forward).not.toHaveProperty('analysis');
    expect(forward.caseTitle).toBe('Second');
  });

  it('keeps the mirror and the list in agreement after every write', () => {
    // The invariant the whole module exists for: two representations of one
    // fact. Any write that updates one without the other is caught here.
    let value = one();

    for (const caseTitle of ['Second', 'Third', 'Fourth']) {
      value = appendVariant(value, variant(caseTitle));
      expect(toVariant(value)).toEqual(readVariants(value)[activeVariantIndex(value)]);
    }
    expect(readVariants(value)).toHaveLength(CASE_VARIANT_LIMIT);

    for (let step = 0; step < CASE_VARIANT_LIMIT + 1; step += 1) {
      value = applyVariant(value, nextVariantIndex(value));
      expect(toVariant(value)).toEqual(readVariants(value)[activeVariantIndex(value)]);
    }

    value = updateActiveVariant(value, { analysisHidden: true });
    expect(toVariant(value)).toEqual(readVariants(value)[activeVariantIndex(value)]);
  });

  it('carries the hidden flag into the variant it lifts out', () => {
    // `toVariant` is both the fallback `readVariants` uses for a document with
    // no list and the shape an append stores. A flag it forgot would vanish the
    // first time the document is re-read — and the analysis would be back on
    // screen with nothing to explain why.
    const hidden = one({ analysis: { entries: [] }, analysisHidden: true });

    expect(toVariant(hidden).analysisHidden).toBe(true);
    expect(readVariants(hidden)[0].analysisHidden).toBe(true);
  });

  it('writes onto the case, not only onto the mirror', () => {
    // Why `updateActiveVariant` exists. `applyVariant` rebuilds the top-level
    // fields from `caseVariants[i]`, so a flag set on the mirror alone is
    // discarded the next time anything re-mirrors (a rotation, a reload through
    // `readVariants`) — while still looking correct on screen the whole time.
    // One case has no list, so the mirror *is* the source and the naive write
    // happens to work; the trap only opens once a second case is saved.
    const naive = { ...two(), analysisHidden: true };
    expect(applyVariant(naive, 1).analysisHidden).toBeUndefined();

    const written = updateActiveVariant(two(), { analysisHidden: true });
    expect(written.analysisHidden).toBe(true);
    expect(readVariants(written)[1].analysisHidden).toBe(true);
    expect(applyVariant(written, 1).analysisHidden).toBe(true);
  });

  it('materialises the list when the hidden flag is the first write', () => {
    // A one-case document has no `caseVariants`, and hiding must not depend on
    // one existing first.
    const updated = updateActiveVariant(one(), { analysisHidden: true });

    expect(updated.caseVariants).toHaveLength(1);
    expect(updated.caseTitle).toBe('First');
    expect(updated.analysisHidden).toBe(true);
  });

  it('keeps the hidden state of one case out of the others', () => {
    // Hiding is per case: rotating onto the second case must reveal *its*
    // analysis, and coming back to the third must find it still collapsed.
    let value = three();
    value = updateActiveVariant(value, { analysisHidden: true });
    expect(activeVariantIndex(value)).toBe(2);

    expect(applyVariant(value, 0).analysisHidden).toBeUndefined();

    let forward = applyVariant(value, 1);
    expect(forward.analysisHidden).toBeUndefined();

    forward = applyVariant(forward, 2);
    expect(forward.analysisHidden).toBe(true);
  });

  it('does not make a newly generated case start out hidden', () => {
    // A generated payload never carries the flag, and it must not inherit it
    // from the case it is appended to: the new case has no analysis yet, so
    // there is nothing hidden about it.
    const collapsed = updateActiveVariant(one(), { analysisHidden: true });
    const grown = appendVariant(collapsed, variant('Second'));

    expect(grown.analysisHidden).toBeUndefined();
    expect(readVariants(grown)[1]).not.toHaveProperty('analysisHidden');
  });
});
