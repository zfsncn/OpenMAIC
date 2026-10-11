/**
 * CosyVoice voice-registration adapter.
 *
 * CosyVoice enrollment is asynchronous: `create_voice` returns a `voice_id`
 * immediately while the clip is still being verified, and synthesis of that id
 * only works once `query_voice` reports `OK`. This adapter therefore polls for
 * readiness before reporting success, so a caller that registers and then
 * synthesizes does not race the provider.
 *
 * Unlike the Qwen line, CosyVoice needs NO transcript — the endpoint ASRs the
 * clip itself — so `refText` is accepted and ignored.
 */

import { createHash } from 'node:crypto';

import {
  CosyVoiceError,
  cosyVoiceExists,
  deleteCosyVoice,
  queryCosyVoice,
  registerCosyVoice,
} from '@/lib/audio/cosyvoice-voice-clone';
import { COSYVOICE_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import { resolveCosyVoiceVoiceCloneModel } from '@/lib/server/provider-config';
import type {
  VoiceRegistrationAdapter,
  VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

const REGISTRATION_MEMO_TTL_MS = 60 * 60 * 1000;
const REGISTRATION_MEMO_MAX_ENTRIES = 256;
/** Readiness polling budget. The provider turned a short clip over in seconds. */
const READY_POLL_ATTEMPTS = 12;
const READY_POLL_INTERVAL_MS = 2_000;

const inFlightRegistrations = new Map<string, Promise<string>>();
const registrations = new Map<string, { voiceId: string; expiresAt: number; configKey: string }>();
const registrationKeysByVoice = new Map<string, Set<string>>();

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function registrationConfigKey(cfg: VoiceRegistrationConfig): string {
  return createHash('sha256')
    .update(cfg.baseUrl)
    .update('\0')
    .update(cfg.apiKey || '')
    .update('\0')
    .update(cfg.model || '')
    .update('\0')
    .update(cfg.publicOnly ? 'public-only' : cfg.managed ? 'managed' : 'server-policy')
    .digest('hex');
}

function registrationKey(
  configKey: string,
  params: { voiceId: string; referenceAudioBase64: string },
): string {
  return createHash('sha256')
    .update(configKey)
    .update('\0')
    .update(params.voiceId)
    .update('\0')
    .update(params.referenceAudioBase64)
    .digest('hex');
}

/**
 * Wait until the provider reports the new voice as `OK`.
 *
 * `UNDEPLOYED` is the provider's terminal failure state (the clip failed
 * verification), so it must fail fast rather than burn the whole budget.
 */
async function waitUntilReady(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < READY_POLL_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason;
    const status = await queryCosyVoice(cfg, voiceId, signal);
    if (status === 'OK') return voiceId;
    if (status === 'UNDEPLOYED') {
      throw new CosyVoiceError(
        'COSYVOICE_VOICE_NOT_READY',
        502,
        undefined,
        'the provider rejected the reference audio',
        'enrollment',
      );
    }
    if (attempt < READY_POLL_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
  }
  throw new CosyVoiceError(
    'COSYVOICE_VOICE_NOT_READY',
    504,
    undefined,
    'the voice was still being prepared when the deadline passed',
    'enrollment',
  );
}

async function registerVoice(
  cfg: VoiceRegistrationConfig,
  params: {
    voiceId: string;
    referenceAudioBase64: string;
    mimeType?: string;
    refText?: string;
  },
  signal?: AbortSignal,
): Promise<string> {
  const configKey = registrationConfigKey(cfg);
  const key = registrationKey(configKey, params);
  const memoized = registrations.get(key);
  if (memoized) {
    if (memoized.expiresAt > Date.now()) {
      registrations.delete(key);
      registrations.set(key, memoized);
      return memoized.voiceId;
    }
    removeRegistrationKey(key, memoized.voiceId);
  }

  const existing = inFlightRegistrations.get(key);
  if (existing) return waitForRegistration(existing, signal);

  const pending = (async () => {
    const audio = decodeBase64(params.referenceAudioBase64);
    if (!audio.byteLength) {
      throw new CosyVoiceError('COSYVOICE_CONFIG_MISSING', 400);
    }
    const registrationCfg: VoiceRegistrationConfig = {
      ...cfg,
      model: cfg.model || COSYVOICE_TTS_VOICE_CLONE_MODEL,
    };
    const result = await registerCosyVoice(
      {
        apiKey: registrationCfg.apiKey,
        baseUrl: registrationCfg.baseUrl,
        targetModel: registrationCfg.model,
        publicOnly: registrationCfg.publicOnly,
        managed: registrationCfg.managed,
      },
      { name: params.voiceId, audio, mimeType: params.mimeType },
      signal,
    );
    const readyId = await waitUntilReady(registrationCfg, result.voiceId, signal);
    rememberRegistration(key, configKey, readyId);
    return readyId;
  })().finally(() => inFlightRegistrations.delete(key));
  inFlightRegistrations.set(key, pending);
  return waitForRegistration(pending, signal);
}

function waitForRegistration(pending: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(
      (voiceId) => {
        signal.removeEventListener('abort', aborted);
        resolve(voiceId);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function rememberRegistration(key: string, configKey: string, voiceId: string): void {
  registrations.delete(key);
  registrations.set(key, { voiceId, expiresAt: Date.now() + REGISTRATION_MEMO_TTL_MS, configKey });
  const keys = registrationKeysByVoice.get(voiceId) ?? new Set<string>();
  keys.add(key);
  registrationKeysByVoice.set(voiceId, keys);
  while (registrations.size > REGISTRATION_MEMO_MAX_ENTRIES) {
    const oldestKey = registrations.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = registrations.get(oldestKey);
    if (oldest) removeRegistrationKey(oldestKey, oldest.voiceId);
  }
}

function removeRegistrationKey(key: string, voiceId: string): void {
  registrations.delete(key);
  const keys = registrationKeysByVoice.get(voiceId);
  keys?.delete(key);
  if (keys?.size === 0) registrationKeysByVoice.delete(voiceId);
}

/**
 * Query the provider rather than trusting the memo. The memo is process-local:
 * it coalesces concurrent enrollment and retains up to 256 successful
 * registrations for one hour, but is neither durable nor shared across replicas.
 */
async function voiceExists(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<boolean | 'unknown'> {
  const result = await cosyVoiceExists(
    {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      targetModel: cfg.model || COSYVOICE_TTS_VOICE_CLONE_MODEL,
      publicOnly: cfg.publicOnly,
      managed: cfg.managed,
    },
    voiceId,
    signal,
  );
  if (result !== 'unknown') return result;

  const configKey = registrationConfigKey(cfg);
  const keys = registrationKeysByVoice.get(voiceId);
  if (!keys) return result;
  for (const key of [...keys]) {
    const registration = registrations.get(key);
    if (!registration || registration.expiresAt <= Date.now()) {
      removeRegistrationKey(key, voiceId);
      continue;
    }
    if (registration.configKey === configKey) return true;
  }
  return result;
}

async function deleteVoice(
  cfg: VoiceRegistrationConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await deleteCosyVoice(
    {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      targetModel: cfg.model || COSYVOICE_TTS_VOICE_CLONE_MODEL,
      publicOnly: cfg.publicOnly,
      managed: cfg.managed,
    },
    voiceId,
    signal,
  );
  evictCosyVoiceRegistrationMemo(voiceId);
}

/** CosyVoice clones from a caller-supplied sample; it cannot design one. */
async function bootstrapReferenceClip(): Promise<never> {
  throw new CosyVoiceError('COSYVOICE_BOOTSTRAP_UNSUPPORTED', 400);
}

/** Enrollment targets the server-resolved clone model, not the synthesis model. */
function resolveRegistrationModel(): string {
  return resolveCosyVoiceVoiceCloneModel();
}

export const cosyVoiceRegistrationAdapter: VoiceRegistrationAdapter = {
  supportsRegistration: () => true,
  supportsBootstrapReferenceClip: false,
  resolveRegistrationModel,
  voiceExists,
  registerVoice,
  deleteVoice,
  bootstrapReferenceClip,
};

export function clearCosyVoiceRegistrationMemoForTests(): void {
  inFlightRegistrations.clear();
  registrations.clear();
  registrationKeysByVoice.clear();
}

/** Evict process-local registration entries after the provider reports a missing voice. */
export function evictCosyVoiceRegistrationMemo(voiceId: string): void {
  const keys = registrationKeysByVoice.get(voiceId);
  if (!keys) return;
  for (const key of keys) registrations.delete(key);
  registrationKeysByVoice.delete(voiceId);
}
