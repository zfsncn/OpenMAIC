/**
 * yovoice TTS adapter contract: one synchronous POST /v1/generate with
 * `{text, modelId, voiceId}` and a Bearer token, WAV bytes back. The server
 * is single-task — 409 is retried with backoff before surfacing YOVOICE_BUSY;
 * auth failures map to a named code. A sentinel/stale voice is rejected
 * client-side without a network round trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same transport double as the MiMo/CosyVoice tests: audioProviderFetch goes
// through undici's fetch (pinned dispatcher), and the SSRF guard consults dns.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
vi.stubGlobal('fetch', fetchMock);
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: { ...actual.promises, lookup: vi.fn().mockResolvedValue({ address: '1.2.3.4' }) },
  };
});

import { generateYovoiceTTS, setBusyRetryBackoffForTests } from '@/lib/audio/yovoice-tts';

function wavResponse() {
  const bytes = new Uint8Array(44);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  });
}

const CONFIG = {
  providerId: 'yovoice-tts' as const,
  voice: '9cacfff39ac22e0c5c853bb192a75e90',
  apiKey: 'token-123',
  baseUrl: 'http://127.0.0.1:8080',
  // Loopback targets are only legal under the managed/operator policy.
  managed: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(wavResponse());
});

afterEach(() => {
  setBusyRetryBackoffForTests(2000);
});

describe('generateYovoiceTTS', () => {
  it('posts text/model/voice to /v1/generate with a Bearer token and returns wav bytes', async () => {
    const result = await generateYovoiceTTS(
      { ...CONFIG, modelId: 'voxcpm2-orig' } as never,
      '你好，欢迎收听。',
      new AbortController().signal,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/generate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    expect(JSON.parse(String(init.body))).toEqual({
      text: '你好，欢迎收听。',
      modelId: 'voxcpm2-orig',
      voiceId: '9cacfff39ac22e0c5c853bb192a75e90',
    });
    expect(result.format).toBe('wav');
    expect(Array.from(result.audio.slice(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  it('rejects a sentinel voice before any network call', async () => {
    await expect(
      generateYovoiceTTS(
        { ...CONFIG, voice: '__yovoice_requires_voice__' } as never,
        'text',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'YOVOICE_CONFIG_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 401 to a named auth error', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await expect(
      generateYovoiceTTS(CONFIG as never, 'text', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'YOVOICE_HTTP_ERROR', status: 401 });
  });

  it('retries a busy (409) server and succeeds on a later attempt', async () => {
    setBusyRetryBackoffForTests(1);
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 409 }))
      .mockResolvedValueOnce(wavResponse());

    const result = await generateYovoiceTTS(CONFIG as never, 'text', new AbortController().signal);
    expect(result.format).toBe('wav');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retries and reports YOVOICE_BUSY', async () => {
    setBusyRetryBackoffForTests(1);
    fetchMock.mockResolvedValue(new Response('busy', { status: 409 }));

    await expect(
      generateYovoiceTTS(CONFIG as never, 'text', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'YOVOICE_BUSY' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
