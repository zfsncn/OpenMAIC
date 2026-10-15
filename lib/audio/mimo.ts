/**
 * MiMo-V2.5-TTS provider metadata (Xiaomi MiMo platform).
 *
 * Module shape mirrors `voxcpm.ts`: provider-neutral metadata that BOTH the
 * client (voice pickers, IndexedDB profile codecs) and the server (synthesis
 * adapter) import, so the voiceId namespace can never drift between the two
 * sides of the wire.
 *
 * CLONE-ONLY (2026-10-15 decision): the preset catalog and the
 * voicedesign model were removed. MiMo is STATELESS like VoxCPM — every
 * synthesis request carries its voice material inline as a base64 sample.
 * There is no enrollment API to write against; "cloning" happens per request.
 * The browser profile store (IndexedDB `voiceProfiles`, kind='clone') is
 * therefore the ONLY persistence, and deleting a profile is complete (no
 * cloud-side cleanup, no quota).
 *
 * One model remains: `mimo-v2.5-tts-voiceclone`, which takes the reference
 * audio as a data URI in `audio.voice`. Model routing is no longer a
 * per-request decision — there is exactly one model, so nothing to route.
 */

/**
 * Kind of a local MiMo voice profile. Only 'clone' is created anymore; rows
 * with the legacy 'prompt' kind (voice-design profiles, retired 2026-10-15)
 * are ignored by every read path and surfaced as retired rows in settings so
 * the user can delete them.
 */
export type MimoProfileKind = 'clone';

export const MIMO_TTS_PROVIDER_ID = 'mimo-tts' as const;

export const MIMO_TTS_VOICE_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone';

export const MIMO_TTS_MODELS = [
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

/** True for ids that reference a local clone profile. */
export function isMiMoProfileVoice(voiceId?: string): boolean {
  return !!voiceId && voiceId.startsWith(MIMO_PROFILE_VOICE_PREFIX);
}

/**
 * Per-request voice payload, transported via `ttsProviderOptions` exactly like
 * VoxCPM's options object (client reads the profile from IndexedDB at the last
 * moment; heavy bytes NEVER enter the settings store or the voiceId string).
 */
export type MimoVoiceMode = 'clone';

export interface MimoProviderOptions {
  /** Which model this request routes to (always the clone model). */
  voiceMode?: MimoVoiceMode;
  /** clone: bare base64 of the sample (data URI is assembled server-side). */
  referenceAudioBase64?: string;
  referenceAudioMimeType?: string;
  /** clone: optional style instruction for the `user` message. */
  styleInstruction?: string;
}
