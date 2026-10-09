/**
 * Turning a generated case payload into scene content.
 *
 * Kept out of the renderer so it can be unit tested without mounting a scene —
 * the quiz view's equivalent lives inline, but this one carries two rules worth
 * locking down (the discriminant, and never carrying an analysis over).
 */

import type { CaseContent, CaseQuestion, CaseSourceRef } from '@/lib/types/stage';
import type { GeneratedCaseContent } from '@/lib/types/generation';

/**
 * Stamp a generated case payload as scene content.
 *
 * The content route answers with the *generated* payload, which carries **no
 * `type` discriminant** — that is stamped later, when the scene is assembled
 * (`buildCompleteScene` in `@openmaic/generation`). So checking
 * `content.type === 'case'` would reject every successful regeneration, and
 * writing the raw payload back would produce a scene the renderer cannot
 * narrow. The payload has to be read structurally, with the discriminant added
 * here.
 *
 * A payload with no title or no narrative is rejected rather than written back:
 * a failed generation must not replace the case the learner is currently
 * reading with an empty one.
 *
 * `analysis` is never carried over. A regenerated case is a *different event*,
 * so an analysis explaining the previous one is not merely stale — it is wrong,
 * and it would read as an analysis of the new case.
 */
export function caseContentFromGeneratedContent(generated: unknown): CaseContent | null {
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) return null;
  const payload = generated as GeneratedCaseContent;

  const caseTitle = typeof payload.caseTitle === 'string' ? payload.caseTitle.trim() : '';
  const narrative = typeof payload.narrative === 'string' ? payload.narrative.trim() : '';
  if (!caseTitle || !narrative) return null;

  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';

  const knowledgePoints = (payload.knowledgePoints ?? [])
    .filter((point) => typeof point === 'string' && point.trim().length > 0)
    .map((point) => point.trim());

  const discussionQuestions: CaseQuestion[] = (payload.discussionQuestions ?? [])
    .filter(
      (question) => typeof question?.question === 'string' && question.question.trim().length > 0,
    )
    .map((question, index) => {
      const point = typeof question.point === 'string' ? question.point.trim() : '';
      const id =
        typeof question.id === 'string' && question.id.trim()
          ? question.id.trim()
          : `cq_${index + 1}`;
      return { id, question: question.question.trim(), ...(point ? { point } : {}) };
    });

  // Shape only: the server already dropped every URL that was not in the
  // research whitelist, so there is nothing left to verify here.
  const sources: CaseSourceRef[] = (payload.sources ?? [])
    .filter((source) => typeof source?.url === 'string' && /^https?:\/\//i.test(source.url.trim()))
    .map((source) => {
      const url = source.url.trim();
      const title = typeof source.title === 'string' ? source.title.trim() : '';
      return { title: title || url, url };
    });

  return {
    type: 'case',
    caseTitle,
    ...(summary ? { summary } : {}),
    knowledgePoints,
    narrative,
    discussionQuestions,
    ...(sources.length > 0 ? { sources } : {}),
  };
}
