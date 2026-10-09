import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-scene-generator', () => ({
  // The real header builder reads the settings store and the model config, then
  // drags the audio stack in behind it. None of that is under test here: what
  // matters is that the request is built at all and carries the provider branch
  // the settings imply.
  getApiHeaders: () => ({ 'Content-Type': 'application/json' }),
  withThinkingConfig: (body: unknown) => body,
}));

import { createCaseWebSearchFn } from '@/lib/classroom/case-web-search';

const SOURCE = {
  title: 'Official report',
  url: 'https://example.gov.cn/report',
  content: 'The mill discharged dye after dark.',
  score: 1,
};

function stubFetch(response: { ok?: boolean; status?: number; body?: unknown } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.body ?? { answer: 'Reported.', sources: [SOURCE] },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const call = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return {
    url: call[0],
    init: call[1],
    body: JSON.parse(String(call[1].body)) as Record<string, unknown>,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('case web search transport', () => {
  it('posts the query and the provider credentials to the search route', async () => {
    const fetchMock = stubFetch();
    const search = createCaseWebSearchFn({ providerId: 'tavily', apiKey: 'k-1' });

    const result = await search('Pigouvian tax real incident');

    const { url, init, body } = requestOf(fetchMock);
    expect(url).toBe('/api/web-search');
    expect(init.method).toBe('POST');
    expect(body).toMatchObject({
      query: 'Pigouvian tax real incident',
      providerId: 'tavily',
      apiKey: 'k-1',
    });
    expect(result.answer).toBe('Reported.');
    expect(result.sources).toEqual([SOURCE]);
  });

  it('omits the base URL for searxng but sends it for everyone else', async () => {
    const first = stubFetch();
    await createCaseWebSearchFn({ providerId: 'searxng', baseUrl: 'https://searx.local' })('q');
    expect(requestOf(first).body.baseUrl).toBeUndefined();

    const second = stubFetch();
    await createCaseWebSearchFn({ providerId: 'tavily', baseUrl: 'https://proxy.local' })('q');
    expect(requestOf(second).body.baseUrl).toBe('https://proxy.local');
  });

  it('sends the baidu sub-source toggles only to baidu', async () => {
    const baiduSubSources = { webSearch: true, baike: false, scholar: true };

    const baidu = stubFetch();
    await createCaseWebSearchFn({ providerId: 'baidu', baiduSubSources })('q');
    expect(requestOf(baidu).body.baiduSubSources).toEqual(baiduSubSources);

    const other = stubFetch();
    await createCaseWebSearchFn({ providerId: 'tavily', baiduSubSources })('q');
    expect(requestOf(other).body.baiduSubSources).toBeUndefined();
  });

  it('sends the claude model id only to claude', async () => {
    const claude = stubFetch();
    await createCaseWebSearchFn({ providerId: 'claude', claudeModelId: 'claude-sonnet-4-6' })('q');
    expect(requestOf(claude).body.claudeModelId).toBe('claude-sonnet-4-6');

    const other = stubFetch();
    await createCaseWebSearchFn({ providerId: 'tavily', claudeModelId: 'claude-sonnet-4-6' })('q');
    expect(requestOf(other).body.claudeModelId).toBeUndefined();
  });

  it('throws on a non-2xx response so the fan-out can degrade that point', async () => {
    stubFetch({ ok: false, status: 429, body: {} });
    const search = createCaseWebSearchFn({ providerId: 'tavily' });

    await expect(search('q')).rejects.toThrow('web search failed with 429');
  });

  it('accumulates de-duplicated sources across queries for the progress callback', async () => {
    const fetchMock = stubFetch({
      body: {
        answer: '',
        sources: [SOURCE, { ...SOURCE, title: 'Duplicate' }],
      },
    });
    const sightings: { title: string; url: string }[][] = [];
    const search = createCaseWebSearchFn(
      { providerId: 'tavily' },
      { onSources: (sources) => sightings.push(sources) },
    );

    await search('first');
    await search('second');

    // Reported once per query, and the duplicate URL never reappears.
    expect(sightings).toHaveLength(2);
    expect(sightings[1]).toEqual([{ title: 'Official report', url: SOURCE.url }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the URL as a title when the provider omits one', async () => {
    stubFetch({ body: { answer: '', sources: [{ url: 'https://news.example.com/x' }] } });
    const sightings: { title: string; url: string }[][] = [];

    await createCaseWebSearchFn(
      { providerId: 'tavily' },
      { onSources: (sources) => sightings.push(sources) },
    )('q');

    expect(sightings[0]).toEqual([
      { title: 'https://news.example.com/x', url: 'https://news.example.com/x' },
    ]);
  });

  it('works without a progress callback', async () => {
    stubFetch();
    const search = createCaseWebSearchFn({ providerId: 'tavily' });

    await expect(search('q')).resolves.toMatchObject({ answer: 'Reported.' });
  });
});
