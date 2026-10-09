import { describe, expect, it, vi } from 'vitest';

import {
  CASE_RESEARCH_MAX_QUERIES,
  buildCaseSearchQuery,
  collectCaseResearch,
} from '@/lib/classroom/case-research';
import type { WebSearchResult } from '@/lib/types/web-search';

type SearchPayload = Pick<WebSearchResult, 'answer' | 'sources'>;

function result(payload: Partial<SearchPayload> = {}): SearchPayload {
  return { answer: payload.answer ?? '', sources: payload.sources ?? [] };
}

function source(title: string, url: string) {
  return { title, url, content: `${title} body`, score: 1 };
}

describe('buildCaseSearchQuery', () => {
  it('appends the research preference to a Chinese knowledge point', () => {
    const query = buildCaseSearchQuery('环境外部性');

    // Recency, jurisdiction and provenance are stated in the query itself: the
    // providers here return no date or region metadata, so a post-filter would
    // have nothing to filter on.
    expect(query.startsWith('环境外部性 ')).toBe(true);
    expect(query).toContain('真实事件');
    expect(query).toContain('近三年');
    expect(query).toContain('中国');
  });

  it('uses the English hint for a non-CJK knowledge point', () => {
    const query = buildCaseSearchQuery('Environmental externality');

    // Mixing scripts in one query degrades it more than the hint helps.
    expect(query.startsWith('Environmental externality ')).toBe(true);
    expect(query).toContain('real incident');
    expect(query).not.toContain('真实事件');
  });

  it('collapses whitespace and returns empty for a blank point', () => {
    const query = buildCaseSearchQuery('  Pigouvian \n tax  ');

    expect(query.startsWith('Pigouvian tax ')).toBe(true);
    expect(query).not.toContain('\n');
    expect(buildCaseSearchQuery('   ')).toBe('');
  });

  it('accepts an explicit hint override', () => {
    expect(buildCaseSearchQuery('环境外部性', 'CUSTOM HINT')).toBe('环境外部性 CUSTOM HINT');
  });
});

describe('collectCaseResearch', () => {
  it('searches every knowledge point and keeps the sources in discovery order', async () => {
    const search = vi.fn(async (query: string) =>
      query.startsWith('Point A')
        ? result({ answer: 'A answer', sources: [source('A page', 'https://a.example/1')] })
        : result({ answer: 'B answer', sources: [source('B page', 'https://b.example/1')] }),
    );

    const outcome = await collectCaseResearch({
      knowledgePoints: ['Point A', 'Point B'],
      search,
    });

    // One query per point is the whole point: a combined query makes the engine
    // answer for whichever point it prefers and silently drops the rest.
    expect(search).toHaveBeenCalledTimes(2);
    expect(outcome.searchedPoints).toBe(2);
    expect(outcome.answeredPoints).toBe(2);
    expect(outcome.failedPoints).toBe(0);
    expect(outcome.caseContext).toContain('### Point A');
    expect(outcome.caseContext).toContain('A answer');
    expect(outcome.caseContext).toContain('### Point B');
    expect(outcome.sources).toEqual([
      { title: 'A page', url: 'https://a.example/1' },
      { title: 'B page', url: 'https://b.example/1' },
    ]);
  });

  it('returns an empty context when there are no knowledge points', async () => {
    const search = vi.fn(async () => result({ answer: 'never' }));

    const outcome = await collectCaseResearch({ knowledgePoints: [], search });

    expect(search).not.toHaveBeenCalled();
    expect(outcome.caseContext).toBe('');
    expect(outcome.sources).toEqual([]);
    expect(outcome.searchedPoints).toBe(0);
  });

  it('caps the fan-out at the knowledge-point ceiling', async () => {
    const search = vi.fn(async () => result({ sources: [source('P', 'https://p.example/1')] }));

    const outcome = await collectCaseResearch({
      knowledgePoints: Array.from({ length: 10 }, (_, index) => `Point ${index + 1}`),
      search,
    });

    expect(search).toHaveBeenCalledTimes(CASE_RESEARCH_MAX_QUERIES);
    expect(outcome.searchedPoints).toBe(CASE_RESEARCH_MAX_QUERIES);
  });

  it('degrades a failed search without failing the research', async () => {
    const search = vi.fn(async (query: string) => {
      if (query.startsWith('Point B')) throw new Error('provider exploded');
      return result({ answer: 'A answer', sources: [source('A page', 'https://a.example/1')] });
    });

    const outcome = await collectCaseResearch({
      knowledgePoints: ['Point A', 'Point B', 'Point C'],
      search,
    });

    // A thinner case beats no case: four grounded points out of five still
    // teaches the chapter.
    expect(outcome.searchedPoints).toBe(3);
    expect(outcome.answeredPoints).toBe(2);
    expect(outcome.failedPoints).toBe(1);
    expect(outcome.sources).toEqual([{ title: 'A page', url: 'https://a.example/1' }]);
  });

  it('marks an unresearched knowledge point instead of hiding it', async () => {
    const search = vi.fn(async (query: string) =>
      query.startsWith('Point A')
        ? result({ sources: [source('A page', 'https://a.example/1')] })
        : result({ answer: '   ' }),
    );

    const outcome = await collectCaseResearch({
      knowledgePoints: ['Point A', 'Point B'],
      search,
    });

    expect(outcome.caseContext).toContain('### Point B');
    expect(outcome.caseContext).toContain('No usable material');
    // The gap has to be visible in the prompt: leaving the section out would let
    // the model quietly fill it from memory, which is the failure research is
    // here to prevent.
    expect(outcome.failedPoints).toBe(1);
  });

  it('drops a source without an openable URL and deduplicates the rest', async () => {
    const search = vi.fn(async () =>
      result({
        sources: [
          source('No link', 'not-a-url'),
          source('Shared page', 'https://shared.example/1'),
          source('Shared page again', 'https://shared.example/1'),
        ],
      }),
    );

    const outcome = await collectCaseResearch({ knowledgePoints: ['Point A'], search });

    expect(outcome.sources).toEqual([{ title: 'Shared page', url: 'https://shared.example/1' }]);
  });

  it('labels an untitled page with its own URL', async () => {
    const search = vi.fn(async () =>
      result({ sources: [{ title: '  ', url: 'https://bare.example/1', content: '', score: 1 }] }),
    );

    const outcome = await collectCaseResearch({ knowledgePoints: ['Point A'], search });

    expect(outcome.sources).toEqual([
      { title: 'https://bare.example/1', url: 'https://bare.example/1' },
    ]);
  });
});
