/**
 * MiMo-V2.5-TTS provider metadata (Xiaomi MiMo platform).
 *
 * Module shape mirrors `voxcpm.ts`: provider-neutral metadata that BOTH the
 * client (voice pickers, IndexedDB profile codecs) and the server (synthesis
 * adapter) import, so the voiceId namespace can never drift between the two
 * sides of the wire.
 *
 * Unlike CosyVoice/Qwen (register-in-cloud → persistent voice_id), MiMo is
 * STATELESS like VoxCPM: every synthesis request carries its voice material
 * inline — a preset name, a text description, or a base64 sample. There is no
 * enrollment API to write against; "cloning" happens per request. The browser
 * profile store (IndexedDB `voiceProfiles`) is therefore the ONLY persistence,
 * and deleting a profile is complete (no cloud-side cleanup, no quota).
 *
 * Three models, selected by the SHAPE of the chosen voice:
 *   mimo-v2.5-tts              preset catalog voices (8 names)      + singing/tags
 *   mimo-v2.5-tts-voicedesign  voice description text (user msg)
 *   mimo-v2.5-tts-voiceclone   reference audio sample (data URI)
 * `resolveTTSModelForVoice`-style routing lives in the client option builder
 * (getMiMoProviderOptions) — the model is a per-request decision, not a stored
 * field, because profiles are local and their kind never changes remotely.
 */

import type { TTSVoiceInfo } from '@/lib/audio/types';

/** kind of a local MiMo voice profile: text description vs audio sample. */
export type MimoProfileKind = 'prompt' | 'clone';

export const MIMO_TTS_PROVIDER_ID = 'mimo-tts' as const;

export const MIMO_TTS_CATALOG_MODEL = 'mimo-v2.5-tts';
export const MIMO_TTS_VOICE_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign';
export const MIMO_TTS_VOICE_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone';

export const MIMO_TTS_MODELS = [
  { id: MIMO_TTS_CATALOG_MODEL, name: 'MiMo-V2.5-TTS' },
  { id: MIMO_TTS_VOICE_DESIGN_MODEL, name: 'MiMo-V2.5-TTS-VoiceDesign' },
  { id: MIMO_TTS_VOICE_CLONE_MODEL, name: 'MiMo-V2.5-TTS-VoiceClone' },
] as const;

/** Namespace for browser-local MiMo voice profiles (see VoiceProfileRecord). */
export const MIMO_PROFILE_VOICE_PREFIX = 'mimo:profile:';

export function getMiMoProfileVoiceId(profileId: string): string {
  return `${MIMO_PROFILE_VOICE_PREFIX}${profileId}`;
}

export function getMiMoProfileIdFromVoiceId(voiceId: string): string | null {
  return voiceId.startsWith(MIMO_PROFILE_VOICE_PREFIX)
    ? voiceId.slice(MIMO_PROFILE_VOICE_PREFIX.length)
    : null;
}

/** True for ids that reference a local design/clone profile. */
export function isMiMoProfileVoice(voiceId?: string): boolean {
  return !!voiceId && voiceId.startsWith(MIMO_PROFILE_VOICE_PREFIX);
}

/**
 * Preset catalog (measured live 2026-10-12): Chinese presets on the China
 * cluster, English ones selectable from any cluster. Names are passed through
 * verbatim as `audio.voice` — MiMo accepts the display names as voice ids.
 * Presets belong to the catalog model only; design/clone models speak local
 * profiles exclusively (a preset name there is rejected or ignored).
 */
const PRESET_COMPAT = [MIMO_TTS_CATALOG_MODEL];
export const MIMO_PRESET_VOICES: TTSVoiceInfo[] = [
  {
    id: '冰糖',
    name: '冰糖 (Bīngtáng)',
    language: 'zh',
    gender: 'female',
    compatibleModels: PRESET_COMPAT,
  },
  {
    id: '茉莉',
    name: '茉莉 (Mòlì)',
    language: 'zh',
    gender: 'female',
    compatibleModels: PRESET_COMPAT,
  },
  {
    id: '苏打',
    name: '苏打 (Sūdǎ)',
    language: 'zh',
    gender: 'male',
    compatibleModels: PRESET_COMPAT,
  },
  {
    id: '白桦',
    name: '白桦 (Báihuà)',
    language: 'zh',
    gender: 'male',
    compatibleModels: PRESET_COMPAT,
  },
  { id: 'Mia', name: 'Mia', language: 'en', gender: 'female', compatibleModels: PRESET_COMPAT },
  { id: 'Chloe', name: 'Chloe', language: 'en', gender: 'female', compatibleModels: PRESET_COMPAT },
  { id: 'Milo', name: 'Milo', language: 'en', gender: 'male', compatibleModels: PRESET_COMPAT },
  { id: 'Dean', name: 'Dean', language: 'en', gender: 'male', compatibleModels: PRESET_COMPAT },
];

export function isMiMoCatalogVoice(voiceId?: string): boolean {
  return !!voiceId && MIMO_PRESET_VOICES.some((voice) => voice.id === voiceId);
}

/**
 * Per-request voice payload, transported via `ttsProviderOptions` exactly like
 * VoxCPM's options object (client reads the profile from IndexedDB at the last
 * moment; heavy bytes NEVER enter the settings store or the voiceId string).
 */
export type MimoVoiceMode = 'preset' | 'design' | 'clone';

export interface MimoProviderOptions {
  /** Which model this request routes to (derived from the profile kind). */
  mimoModel?: string;
  voiceMode?: MimoVoiceMode;
  /** design: the voice description placed in the `user` message. */
  voicePrompt?: string;
  /** design profile: let MiMo polish/adapt the target text itself. */
  optimizeTextPreview?: boolean;
  /** clone: bare base64 of the sample (data URI is assembled server-side). */
  referenceAudioBase64?: string;
  referenceAudioMimeType?: string;
  /** clone: optional style instruction for the `user` message. */
  styleInstruction?: string;
}
