/**
 * The browser-side transport for case research.
 *
 * `case-research.ts` owns the fan-out (one query per knowledge point, failures
 * degrading per point) and is deliberately transport-free so it can be unit
 * tested without a server. This module is the transport half: the one place that
 * knows how to turn a query into an `/api/web-search` request.
 *
 * It lives beside the fan-out rather than inside a component because two very
 * different callers need it — the generation flow (which shows the pages as they
 * arrive beside a step indicator) and the classroom's "different case" button
 * (which shows them behind a spinner on the scene itself). Duplicating the
 * request shape would mean a provider added to one path silently missing from
 * the other.
 *
 * Provider credentials come from the user's web-search settings and travel with
 * the request: the route is a proxy, so they reach the provider they belong to
 * and nothing else.
 */

import { getApiHeaders, withThinkingConfig } from '@/lib/hooks/use-scene-generator';
// Type-only, so the provider implementations (which hold API keys and are
// server-only in practice) are erased at build time.
import type { BaiduSubSources } from '@/lib/web-search/types';
import type { WebSearchSource } from '@/lib/types/web-search';
import type { CaseResearchSource, CaseSearchFn } from './case-research';

/** The slice of the user's web-search settings a case search needs. */
export interface CaseWebSearchConfig {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  baiduSubSources?: BaiduSubSources;
  claudeModelId?: string;
}

/**
 * Build the `search` function `collectCaseResearch` expects.
 *
 * `onSources` fires as each query lands rather than once at the end. A six-point
 * fan-out takes long enough that a caller with nothing to show reads as hung,
 * and the pages are the only progress signal available.
 */
export function createCaseWebSearchFn(
  config: CaseWebSearchConfig,
  options: {
    signal?: AbortSignal;
    onSources?: (sources: CaseResearchSource[]) => void;
  } = {},
): CaseSearchFn {
  const seen = new Set<string>();
  const collected: CaseResearchSource[] = [];

  return async (query) => {
    const res = await fetch('/api/web-search', {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify(
        withThinkingConfig({
          query,
          providerId: config.providerId,
          apiKey: config.apiKey || undefined,
          // searxng is addressed by deployment-level configuration, so a
          // user-supplied base URL is meaningless for it.
          baseUrl: config.providerId === 'searxng' ? undefined : config.baseUrl || undefined,
          baiduSubSources: config.providerId === 'baidu' ? config.baiduSubSources : undefined,
          claudeModelId:
            config.providerId === 'claude' ? config.claudeModelId || undefined : undefined,
        }),
      ),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`web search failed with ${res.status}`);
    }

    const data = (await res.json()) as { answer?: unknown; sources?: unknown };
    // Passed through as-is: `collectCaseResearch` does its own URL filtering, and
    // a second filter here would be a second place for the rule to live.
    const sources = (Array.isArray(data.sources) ? data.sources : []) as WebSearchSource[];

    if (options.onSources) {
      for (const source of sources) {
        const url = typeof source?.url === 'string' ? source.url.trim() : '';
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        const title = typeof source?.title === 'string' ? source.title.trim() : '';
        collected.push({ title: title || url, url });
      }
      if (collected.length > 0) options.onSources([...collected]);
    }

    return { answer: typeof data.answer === 'string' ? data.answer : '', sources };
  };
}
