/**
 * Case-teaching research: turning a chapter's knowledge points into the
 * material a case is written from.
 *
 * Case teaching is the one lesson kind whose quality collapses without outside
 * material. A slide can be written from the chapter, a quiz can be written from
 * the chapter, but a case study has to be a *real event* — and asking a model to
 * recall one produces confident fiction about people and dates that never
 * existed. So the research runs first, in the client, and the case is then
 * written against what the search actually returned.
 *
 * This module is deliberately transport-free: `search` is injected so the
 * caller keeps ownership of the HTTP call (headers, provider settings, abort
 * wiring), and the fan-out can be unit-tested without a server.
 *
 * Lives here rather than in `lib/web-search/` because it must stay safe to
 * import from the browser bundle — `lib/web-search` pulls in the provider
 * implementations, which hold API keys and are server-only in practice.
 */

import { formatSearchResultsAsContext } from '@/lib/web-search/format';
import type { WebSearchResult } from '@/lib/types/web-search';

/**
 * How many knowledge points get their own search.
 *
 * One query per knowledge point is the point of the exercise: a single combined
 * query makes the engine pick whichever point it likes best and return results
 * for only that one, so the narrative silently covers a third of the chapter.
 * The cap matches the outline step's knowledge-point ceiling (six), which is
 * what keeps the worst case bounded — six searches plus the rewrite call.
 */
export const CASE_RESEARCH_MAX_QUERIES = 6;

/**
 * What "a good case" means for this deployment, appended to each query.
 *
 * Recency, jurisdiction and provenance are stated in the query rather than
 * filtered afterwards, because the search providers here return ranked results
 * with no reliable date or jurisdiction metadata — a filter would have nothing
 * to filter on. Asking for them in the query at least tilts the ranking, and a
 * result that ignores the hint costs nothing but a slightly wider net.
 *
 * Two variants because the hint has to match the query's language: a Chinese
 * phrase appended to an English knowledge point makes the query itself
 * incoherent and degrades the result more than the hint helps.
 */
const CASE_RESEARCH_HINT_CJK = '真实事件 案例 近三年 中国 权威媒体报道';
const CASE_RESEARCH_HINT_LATIN =
  'real incident case study last three years authoritative news report';

/** CJK ideographs — the test for which hint variant a knowledge point needs. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** A page the case may cite. Mirrors the shape the renderer links. */
export interface CaseResearchSource {
  title: string;
  url: string;
}

export interface CaseResearchOutcome {
  /** Rendered research material for the prompt. Empty when nothing was found. */
  caseContext: string;
  /** Every usable page found, deduplicated by URL, in discovery order. */
  sources: CaseResearchSource[];
  /** Knowledge points that were searched. */
  searchedPoints: number;
  /** Knowledge points whose search returned something usable. */
  answeredPoints: number;
  /** Knowledge points whose search failed or came back empty. */
  failedPoints: number;
}

/** The search transport the caller supplies. */
export type CaseSearchFn = (query: string) => Promise<Pick<WebSearchResult, 'answer' | 'sources'>>;

/**
 * Turn one knowledge point into a search query.
 *
 * The knowledge points produced by the outline step are already required to
 * stand alone as search queries, so this only normalises whitespace and appends
 * the research preference. It is intentionally *not* run through the server's
 * query-rewrite model: that rewrite exists to compress a long requirement, and a
 * knowledge point is already short — rewriting it would only add a round trip
 * and a chance to drift off the point.
 */
export function buildCaseSearchQuery(point: string, hint?: string): string {
  const normalized = point.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const suffix =
    hint ?? (CJK_PATTERN.test(normalized) ? CASE_RESEARCH_HINT_CJK : CASE_RESEARCH_HINT_LATIN);
  return `${normalized} ${suffix}`;
}

/**
 * Search every knowledge point and assemble the result for the content step.
 *
 * Failures degrade per point rather than as a whole: six points where two
 * searches failed still yield a case grounded in the other four, and the
 * narrative prompt handles a point with no material by telling the model to
 * cover honestly what it can (see `templates/case-content`). Failing the step
 * instead would trade a slightly thinner case for no case at all.
 *
 * A point that came back empty is still written into `caseContext`, explicitly
 * marked as unresearched. Leaving it out would hide the gap and let the model
 * quietly fill it from memory — which is the exact failure this module exists to
 * prevent.
 */
export async function collectCaseResearch(params: {
  knowledgePoints: readonly string[];
  search: CaseSearchFn;
  maxQueries?: number;
}): Promise<CaseResearchOutcome> {
  const { knowledgePoints, search } = params;
  const maxQueries = params.maxQueries ?? CASE_RESEARCH_MAX_QUERIES;

  const points = knowledgePoints
    .map((point) => point.replace(/\s+/g, ' ').trim())
    .filter((point) => point.length > 0)
    .slice(0, maxQueries);

  const blocks: string[] = [];
  const sourcesByUrl = new Map<string, CaseResearchSource>();
  let answeredPoints = 0;
  let failedPoints = 0;

  const results = await Promise.all(
    points.map(async (point) => {
      const query = buildCaseSearchQuery(point);
      try {
        const result = await search(query);
        return { point, answer: result.answer ?? '', sources: result.sources ?? [] };
      } catch {
        return { point, answer: '', sources: [], failed: true };
      }
    }),
  );

  for (const result of results) {
    const usable = result.sources.filter((source) => /^https?:\/\//i.test(source.url ?? ''));
    // The answer is trimmed before the emptiness test: a provider that returns
    // whitespace is reporting "nothing", and a whitespace-only block would
    // otherwise pass as material and hide the unresearched marker.
    const context = formatSearchResultsAsContext({
      answer: result.answer.trim(),
      sources: usable,
      query: '',
      responseTime: 0,
    });

    if (context) {
      answeredPoints += 1;
      blocks.push(`### ${result.point}\n\n${context}`);
      for (const source of usable) {
        const url = source.url.trim();
        if (!sourcesByUrl.has(url)) {
          const title = source.title?.trim();
          sourcesByUrl.set(url, { title: title || url, url });
        }
      }
    } else {
      failedPoints += 1;
      blocks.push(
        `### ${result.point}\n\nNo usable material was found for this knowledge point. Do not invent one.`,
      );
    }
  }

  return {
    caseContext: blocks.join('\n\n'),
    sources: [...sourcesByUrl.values()],
    searchedPoints: points.length,
    answeredPoints,
    failedPoints,
  };
}
