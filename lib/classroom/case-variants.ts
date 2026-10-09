/**
 * Case variants — the three-case cache behind a case-teaching scene.
 *
 * A case classroom starts with one case and can hold up to
 * {@link CASE_VARIANT_LIMIT} of them. "换一个案例" appends while there is room
 * and rotates once there is not, so a learner can come back to a case they
 * liked without paying for another generation.
 *
 * ⚠️ This module is the ONLY writer of {@link CaseContent}'s variant fields.
 * `CaseContent` carries both the fields a reader already knows (`caseTitle`,
 * `narrative`, …) *and* a `caseVariants` list, with the former mirroring one
 * entry of the latter. Two representations of one fact can drift, so every
 * write goes through {@link applyVariant} / {@link appendVariant} here, and
 * both of them update the mirror and the list together or not at all. A unit
 * test pins the invariant down.
 *
 * Absence is meaningful rather than corrupt: a document written before variants
 * existed has no `caseVariants` and holds exactly one case, expressed by the
 * fields above. {@link readVariants} is the single place that is resolved, so
 * no caller has to remember it.
 */

import type { CaseContent, CaseVariant } from '@/lib/types/stage';

/** How many cases one chapter keeps. Reached, the swap action rotates. */
export const CASE_VARIANT_LIMIT = 3;

/** The case currently on screen, lifted out of the content it is mirrored into. */
export function toVariant(content: CaseContent): CaseVariant {
  return {
    caseTitle: content.caseTitle,
    ...(content.summary !== undefined ? { summary: content.summary } : {}),
    knowledgePoints: content.knowledgePoints,
    narrative: content.narrative,
    discussionQuestions: content.discussionQuestions,
    ...(content.sources !== undefined ? { sources: content.sources } : {}),
    ...(content.analysis !== undefined ? { analysis: content.analysis } : {}),
    ...(content.analysisHidden !== undefined ? { analysisHidden: content.analysisHidden } : {}),
  };
}

/**
 * Every saved case, oldest first.
 *
 * A legacy or freshly generated document — no `caseVariants` — is one case,
 * not zero, so it is reported as `[the case the fields above describe]`. An
 * empty list is treated the same way: an empty array is what a half-written
 * document looks like, and reporting "no cases" would make the renderer
 * disappear rather than showing the case that is plainly there.
 */
export function readVariants(content: CaseContent): CaseVariant[] {
  if (content.caseVariants && content.caseVariants.length > 0) return content.caseVariants;
  return [toVariant(content)];
}

/**
 * Index of the case on screen, clamped into range.
 *
 * Tolerating an out-of-range index rather than trusting it matters after a
 * document is hand-edited or a variant list shrinks: an index that points past
 * the end would mirror `undefined` into the fields every reader depends on.
 */
export function activeVariantIndex(content: CaseContent): number {
  const total = readVariants(content).length;
  const index = content.activeVariantIndex ?? 0;
  return Number.isInteger(index) && index >= 0 && index < total ? index : 0;
}

/** Whether another case can still be generated for this chapter. */
export function isAtCap(content: CaseContent): boolean {
  return readVariants(content).length >= CASE_VARIANT_LIMIT;
}

/**
 * The index the swap action moves to: the next one, wrapping at the end.
 *
 * Sequential rather than random on purpose. A learner who liked the second
 * case has to be able to reach it again; a random pick cannot promise that,
 * and costs the same nothing either way.
 */
export function nextVariantIndex(content: CaseContent): number {
  return (activeVariantIndex(content) + 1) % readVariants(content).length;
}

/**
 * Put variant `index` on screen.
 *
 * Builds the result field by field from the variant rather than spreading the
 * previous content over it: the optional fields are *per case* (`summary`,
 * `sources`, `analysis`), so a field the chosen case does not have must
 * disappear rather than survive from the one it replaced. An `analysis` left
 * behind would be an explanation of a different event.
 */
export function applyVariant(content: CaseContent, index: number): CaseContent {
  const variants = readVariants(content);
  const safe = Number.isInteger(index) && index >= 0 && index < variants.length ? index : 0;
  return {
    type: 'case',
    ...variants[safe],
    caseVariants: variants,
    activeVariantIndex: safe,
  };
}

/**
 * Save a newly generated case and put it on screen.
 *
 * Refuses at the cap and returns the content untouched — the caller's job is
 * to rotate instead, and silently dropping a fourth case would make the button
 * look like it worked while nothing changed.
 */
export function appendVariant(content: CaseContent, variant: CaseVariant): CaseContent {
  const variants = readVariants(content);
  if (variants.length >= CASE_VARIANT_LIMIT) return content;
  return applyVariant({ ...content, caseVariants: [...variants, variant] }, variants.length);
}

/**
 * Patch the case on screen — the list entry and the mirror together.
 *
 * ⚠️ A patch has to land on the *variant*, not on the top-level fields.
 * {@link applyVariant} rebuilds those from `caseVariants[i]`, so a change made
 * only to the mirror survives exactly until the next re-mirror (a rotation, an
 * append, a reload through `readVariants`) and then silently disappears. That
 * is why callers get this helper instead of spreading the content themselves.
 */
export function updateActiveVariant(
  content: CaseContent,
  patch: Partial<CaseVariant>,
): CaseContent {
  const variants = readVariants(content);
  const index = activeVariantIndex(content);
  const next = variants.map((variant, at) => (at === index ? { ...variant, ...patch } : variant));
  return applyVariant({ ...content, caseVariants: next }, index);
}
