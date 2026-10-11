import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COSYVOICE_NO_SYSTEM_VOICE,
  COSYVOICE_TTS_VOICE_CLONE_MODEL,
  ignoresTTSRate,
  isCosyVoiceCloneVoice,
  resolveTTSModelForVoice,
  TTS_PROVIDERS,
} from '@/lib/audio/constants';
import {
  cosyVoiceExists,
  CosyVoiceError,
  deleteCosyVoice,
  downloadAudio,
  INLINE_AUDIO_MIME,
  preferredVoiceName,
  queryCosyVoice,
  registerCosyVoice,
  synthesizeCosyVoice,
  toCosyVoiceAudioSource,
} from '@/lib/audio/cosyvoice-voice-clone';
import {
  clearCosyVoiceRegistrationMemoForTests,
  cosyVoiceRegistrationAdapter,
} from '@/lib/audio/cosyvoice-registration';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import {
  getEnabledProvidersWithVoices,
  resolveAgentVoice,
  resolveNarratorVoiceForGeneration,
} from '@/lib/audio/voice-resolver';
import { generateTTS } from '@/lib/audio/tts-providers';

// Same transport double as the Qwen clone tests: the helpers go through
// undici's fetch (pinned dispatcher), while the audio download keeps using the
// global fetch. One shared double covers both.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
vi.stubGlobal('fetch', fetchMock);

const dnsMocks = vi.hoisted(() => ({ promisesLookup: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: dnsMocks.promisesLookup } };
});

const BASE = 'https://dashscope.example.com/api/v1';
const CONFIG = {
  apiKey: 'sk-cosy',
  baseUrl: BASE,
  targetModel: COSYVOICE_TTS_VOICE_CLONE_MODEL,
};

/** MP3 bytes: an ID3v2 header keeps the payload identifiable without an encoder. */
function mp3Bytes(length = 1024): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x49, 0x44, 0x33], 0); // "ID3"
  for (let i = 3; i < length; i++) bytes[i] = (i * 7) % 251;
  return bytes;
}

describe('CosyVoice voice cloning', () => {
  beforeEach(() => {
    clearCosyVoiceRegistrationMemoForTests();
    fetchMock.mockReset();
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is registered as a built-in, clone-only provider with no catalog voices', () => {
    const provider = TTS_PROVIDERS['cosyvoice-tts'];
    expect(provider).toBeDefined();
    expect(provider.voices).toEqual([]);
    expect(provider.requiresRegisteredVoice).toBe(true);
    expect(provider.defaultModelId).toBe(COSYVOICE_TTS_VOICE_CLONE_MODEL);
    expect(provider.defaultBaseUrl).toBe('https://dashscope.aliyuncs.com/api/v1');
    // The registration seam must resolve to the CosyVoice adapter.
    expect(getVoiceRegistrationAdapter('cosyvoice-tts')).toBe(cosyVoiceRegistrationAdapter);
  });

  it('inlines reference audio as audio/mp3 (the only MIME the endpoint accepts)', () => {
    const bytes = mp3Bytes(64);
    const source = toCosyVoiceAudioSource(bytes, 'audio/mpeg');
    expect(source.startsWith(`data:${INLINE_AUDIO_MIME};base64,`)).toBe(true);
    expect(source.slice(source.indexOf(',') + 1)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('keeps audio/wav as-is when the caller declares it (no silent relabelling)', () => {
    const source = toCosyVoiceAudioSource(mp3Bytes(32), 'audio/wav');
    expect(source.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('posts create_voice with prefix + url and reads output.voice_id', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ output: { voice_id: 'cosyvoice-v3.5-plus-teacher-abcd1234' } }),
        { status: 200 },
      ),
    );

    const result = await registerCosyVoice(CONFIG, { name: 'Sample Teacher', audio: mp3Bytes() });

    expect(result.voiceId).toBe('cosyvoice-v3.5-plus-teacher-abcd1234');
    expect(result.targetModel).toBe(COSYVOICE_TTS_VOICE_CLONE_MODEL);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/services/audio/tts/customization`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-cosy');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('voice-enrollment');
    expect(body.input.action).toBe('create_voice');
    expect(body.input.target_model).toBe(COSYVOICE_TTS_VOICE_CLONE_MODEL);
    // CosyVoice takes NO transcript — the endpoint ASRs the clip itself.
    expect(body.input.text).toBeUndefined();
    expect(body.input.audio).toBeUndefined();
    expect(body.input.url).toMatch(new RegExp(`^data:${INLINE_AUDIO_MIME};base64,`));
    expect(body.input.prefix).toMatch(/^[a-z][a-z0-9]{0,9}$/u);
  });

  it('produces a stable, cosyvoice-legal prefix (letters+digits only, <=10 chars)', () => {
    const first = preferredVoiceName('窦老师', mp3Bytes(64));
    const second = preferredVoiceName('窦老师', mp3Bytes(64));
    expect(first).toBe(second);
    // The endpoint rejects separators outright:
    // `InvalidParameter | prefix should be english letter and number`.
    expect(first).toMatch(/^[a-z][a-z0-9]*$/u);
    expect(first.length).toBeLessThanOrEqual(10);
    // Two Chinese names must not collapse to the same id.
    expect(preferredVoiceName('刘老师', mp3Bytes(64))).not.toBe(first);
  });

  it('never emits an underscore or a digit-leading prefix', () => {
    for (const name of ['A Name With Spaces', '窦老师', '123abc', '___', 'Ünïcodé']) {
      const id = preferredVoiceName(name, mp3Bytes(32));
      expect(id).toMatch(/^[a-z][a-z0-9]*$/u);
      expect(id).not.toContain('_');
      expect(id.length).toBeLessThanOrEqual(10);
    }
  });

  it('maps an OpenAI-compatible base URL onto the native api root', async () => {
    // The console's copy button yields `.../compatible-mode/v1`; the speech
    // endpoints live under `/api/v1` on the same host, so the copied value must
    // still resolve (a verbatim paste used to 404 with an empty body).
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { voice_id: 'v' } }), { status: 200 }),
    );
    await registerCosyVoice(
      { ...CONFIG, baseUrl: 'https://llm-ws.example.com/compatible-mode/v1' },
      { name: 'Teacher', audio: mp3Bytes() },
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://llm-ws.example.com/api/v1/services/audio/tts/customization',
    );
  });

  it('keeps a bare-host base URL working (no api/v1 suffix at all)', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { voice_id: 'v' } }), { status: 200 }),
    );
    await registerCosyVoice(
      { ...CONFIG, baseUrl: 'https://llm-ws.example.com' },
      { name: 'Teacher', audio: mp3Bytes() },
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://llm-ws.example.com/api/v1/services/audio/tts/customization',
    );
  });

  it('labels a non-JSON error response with the operation that failed', async () => {
    fetchMock.mockResolvedValue(new Response('<html>404</html>', { status: 404 }));
    await expect(registerCosyVoice(CONFIG, { name: 'x', audio: mp3Bytes() })).rejects.toMatchObject(
      { code: 'COSYVOICE_HTTP_ERROR', httpStatus: 404, operation: 'enrollment' },
    );
  });

  it('sends a non-ASCII name to a hashed prefix instead of collapsing to "v"', () => {
    const name = preferredVoiceName('窦老师', mp3Bytes(64));
    expect(name.startsWith('u')).toBe(true);
  });

  it('polls query_voice and reports the provider status', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { status: 'OK' } }), { status: 200 }),
    );
    const status = await queryCosyVoice(CONFIG, 'cosyvoice-v3.5-plus-x-1');
    expect(status).toBe('OK');
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.input).toEqual({ action: 'query_voice', voice_id: 'cosyvoice-v3.5-plus-x-1' });
  });

  it('maps UNDEPLOYED to a terminal status (clip failed verification)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { status: 'UNDEPLOYED' } }), { status: 200 }),
    );
    expect(await queryCosyVoice(CONFIG, 'v1')).toBe('UNDEPLOYED');
  });

  it('looks voices up through list_voice (not the Qwen line\'s "list")', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            voice_list: [
              { voice_id: 'wanted', target_model: COSYVOICE_TTS_VOICE_CLONE_MODEL, status: 'OK' },
            ],
            total_count: 1,
          },
        }),
        { status: 200 },
      ),
    );
    expect(await cosyVoiceExists(CONFIG, 'wanted')).toBe(true);
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.input.action).toBe('list_voice');
  });

  it('treats a same-id voice bound to a different target model as absent', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            voice_list: [{ voice_id: 'wanted', target_model: 'some-other-model', status: 'OK' }],
            total_count: 1,
          },
        }),
        { status: 200 },
      ),
    );
    expect(await cosyVoiceExists(CONFIG, 'wanted')).toBe(false);
  });

  it('deletes a voice via delete_voice', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: {} }), { status: 200 }),
    );
    await deleteCosyVoice(CONFIG, 'cosyvoice-v3.5-plus-x-1');
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.input).toEqual({ action: 'delete_voice', voice_id: 'cosyvoice-v3.5-plus-x-1' });
  });

  it('surfaces the provider rejection reason from a failed enrollment', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'InternalError', message: 'request asr failed, http code: 400' }),
        { status: 500 },
      ),
    );
    await expect(
      registerCosyVoice(CONFIG, { name: 'Bad Clip', audio: mp3Bytes() }),
    ).rejects.toMatchObject({
      code: 'COSYVOICE_RESPONSE_VOICE_MISSING',
      vendorMessage: 'request asr failed, http code: 400',
    });
  });

  it('synthesizes through SpeechSynthesizer and prefers the inline data field', async () => {
    const audio = mp3Bytes(200);
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: { audio: { data: Buffer.from(audio).toString('base64'), format: 'mp3' } },
        }),
        { status: 200 },
      ),
    );

    const result = await synthesizeCosyVoice(CONFIG, '今天天气怎么样？', 'cosyvoice-v3.5-plus-x-1');

    expect(result.format).toBe('mp3');
    expect(Buffer.from(result.audio).equals(Buffer.from(audio))).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/services/audio/tts/SpeechSynthesizer`);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(COSYVOICE_TTS_VOICE_CLONE_MODEL);
    expect(body.input.voice).toBe('cosyvoice-v3.5-plus-x-1');
    // One request only — the inline bytes mean no follow-up download.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to downloading the OSS url when no inline data is present', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.mp3' },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from(mp3Bytes(128)), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      );

    const result = await synthesizeCosyVoice(CONFIG, 'hi', 'v1');
    expect(result.format).toBe('mp3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an untrusted audio host on download', async () => {
    await expect(downloadAudio('https://evil.example.com/a.mp3')).rejects.toBeInstanceOf(
      CosyVoiceError,
    );
  });

  it('routes providerId cosyvoice-tts through the synthesis branch', async () => {
    const audio = mp3Bytes(96);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ output: { audio: { data: Buffer.from(audio).toString('base64') } } }),
        { status: 200 },
      ),
    );

    const result = await generateTTS(
      {
        providerId: 'cosyvoice-tts',
        apiKey: 'sk-cosy',
        baseUrl: BASE,
        voice: 'cosyvoice-v3.5-plus-x-1',
        modelId: COSYVOICE_TTS_VOICE_CLONE_MODEL,
      },
      '测试',
    );
    expect(result.format).toBe('mp3');
    // The model follows the clone target regardless of the caller's hint.
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe(COSYVOICE_TTS_VOICE_CLONE_MODEL);
  });

  it('drops the cosyvoice adapter when registration bootstrapping is requested', async () => {
    expect(cosyVoiceRegistrationAdapter.supportsBootstrapReferenceClip).toBe(false);
    await expect(
      cosyVoiceRegistrationAdapter.bootstrapReferenceClip(
        { baseUrl: BASE, apiKey: 'k', model: COSYVOICE_TTS_VOICE_CLONE_MODEL },
        { design: { name: 'x' } as never },
      ),
    ).rejects.toMatchObject({ code: 'COSYVOICE_BOOTSTRAP_UNSUPPORTED' });
  });

  it('advertises the provider with only enrolled profile voices', () => {
    const providers = getEnabledProvidersWithVoices({
      'cosyvoice-tts': { apiKey: 'sk-cosy', baseUrl: '', enabled: true },
    });
    const entry = providers.find((p) => p.providerId === 'cosyvoice-tts');
    // Enabled + clone-only: present even though its catalog is empty.
    expect(entry).toBeDefined();
    expect(entry?.voices).toEqual([]);
    expect(entry?.modelGroups[0]?.modelId).toBe(COSYVOICE_TTS_VOICE_CLONE_MODEL);

    const withProfile = getEnabledProvidersWithVoices(
      { 'cosyvoice-tts': { apiKey: 'sk-cosy', baseUrl: '', enabled: true } },
      [
        {
          id: 'cosyvoice-v3.5-plus-x-1',
          providerId: 'cosyvoice-tts',
          name: '窦老师',
          kind: 'clone',
        },
      ],
    );
    const bound = withProfile.find((p) => p.providerId === 'cosyvoice-tts');
    expect(bound?.voices.map((v) => v.id)).toEqual(['cosyvoice-v3.5-plus-x-1']);
    expect(bound?.modelGroups[0]?.voices.map((v) => v.id)).toEqual(['cosyvoice-v3.5-plus-x-1']);
  });

  it('pins the clone model for every voice and marks the path as rate-less', () => {
    expect(resolveTTSModelForVoice('cosyvoice-tts', 'any-enrolled-id', 'ignored')).toBe(
      COSYVOICE_TTS_VOICE_CLONE_MODEL,
    );
    expect(isCosyVoiceCloneVoice('cosyvoice-v3.5-plus-x-1')).toBe(true);
    // The sentinel means "nothing enrolled yet", not a speakable voice.
    expect(isCosyVoiceCloneVoice(COSYVOICE_NO_SYSTEM_VOICE)).toBe(false);
    expect(ignoresTTSRate('cosyvoice-tts', 'cosyvoice-v3.5-plus-x-1')).toBe(true);
  });

  it('refuses to treat the no-voice sentinel as a bindable voice', () => {
    // Passing it through would reach the engine as an unknown speaker (418).
    expect(
      resolveNarratorVoiceForGeneration('cosyvoice-tts', COSYVOICE_NO_SYSTEM_VOICE, {
        baseUrl: '',
        apiKey: 'sk-cosy',
        enabled: true,
      }),
    ).toBeUndefined();
    expect(
      resolveAgentVoice(
        { id: 'teacher', name: 'T', voiceConfig: undefined } as never,
        0,
        [
          {
            providerId: 'cosyvoice-tts',
            providerName: 'CosyVoice',
            voices: [],
            modelGroups: [],
          },
        ],
        {
          teacher: {
            providerId: 'cosyvoice-tts',
            voiceId: COSYVOICE_NO_SYSTEM_VOICE,
          },
        },
      ),
    ).toBeNull();
    // A real enrolled id still binds, and carries the clone model.
    expect(
      resolveNarratorVoiceForGeneration('cosyvoice-tts', 'cosyvoice-v3.5-plus-x-1', {
        baseUrl: '',
        apiKey: 'sk-cosy',
        enabled: true,
      }),
    ).toEqual({
      providerId: 'cosyvoice-tts',
      voiceId: 'cosyvoice-v3.5-plus-x-1',
      modelId: COSYVOICE_TTS_VOICE_CLONE_MODEL,
    });
  });
});
