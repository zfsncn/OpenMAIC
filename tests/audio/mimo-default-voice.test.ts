/**
 * MiMo clone-only default voice: a provider whose only voices are local clone
 * profiles must still have a usable default. Whatever is not a live clone
 * profile (the no-system-voice sentinel, a stale non-profile id, a deleted
 * profile, a retired design profile) resolves to the NEWEST live clone
 * profile's sample; with zero clone profiles the options degrade to
 * `voiceMode:'clone'` without a sample, which the route pre-check turns into
 * a named 400.
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { getMiMoProfileVoiceId } from '@/lib/audio/mimo';
import { MIMO_NO_SYSTEM_VOICE } from '@/lib/audio/constants';
import { getMiMoProviderOptions } from '@/lib/audio/voxcpm-voices';
import { db, type VoiceProfileRecord } from '@/lib/device-storage/database';

// Vitest's node environment does not ship FileReader; blobToBase64 only uses
// readAsDataURL, so a 10-line stand-in is enough (pure Node Buffer math).
if (typeof globalThis.FileReader === 'undefined') {
  class FileReaderStub {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    readAsDataURL(blob: Blob) {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`;
          this.onload?.();
        })
        .catch((error) => this.onerror?.(error));
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = FileReaderStub;
}

const PROVIDER = 'mimo-tts';

function cloneProfile(overrides: Partial<VoiceProfileRecord>): VoiceProfileRecord {
  const now = overrides.createdAt ?? 1_000;
  return {
    id: overrides.id || `profile-${Math.random().toString(36).slice(2)}`,
    providerId: PROVIDER,
    kind: 'clone',
    name: overrides.name || 'clone',
    referenceAudio: overrides.referenceAudio ?? new Blob(['fake-bytes'], { type: 'audio/mpeg' }),
    referenceAudioMimeType: 'audio/mpeg',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.voiceProfiles.clear();
});

describe('getMiMoProviderOptions default-voice fallback', () => {
  it('resolves the no-system-voice sentinel to the newest clone profile', async () => {
    const older = await db.voiceProfiles.add(
      cloneProfile({ id: 'older', name: 'older', createdAt: 1_000, updatedAt: 1_000 }),
    );
    const newer = await db.voiceProfiles.add(
      cloneProfile({ id: 'newer', name: 'newer', createdAt: 2_000, updatedAt: 2_000 }),
    );
    expect(older).toBeTruthy();
    expect(newer).toBeTruthy();

    const options = await getMiMoProviderOptions(MIMO_NO_SYSTEM_VOICE);

    expect(options.voiceMode).toBe('clone');
    expect(options.referenceAudioBase64).toBe(Buffer.from('fake-bytes').toString('base64'));
    expect(options.referenceAudioMimeType).toBe('audio/mpeg');
  });

  it('falls back from a stale non-profile id and from a retired design profile', async () => {
    await db.voiceProfiles.add(
      cloneProfile({ id: 'live', name: 'live', createdAt: 3_000, updatedAt: 3_000 }),
    );

    const stale = await getMiMoProviderOptions('totally-not-a-voice-id');
    expect(stale.voiceMode).toBe('clone');
    expect(stale.referenceAudioBase64).toBe(Buffer.from('fake-bytes').toString('base64'));

    await db.voiceProfiles.add({
      id: 'retired',
      providerId: PROVIDER,
      kind: 'prompt',
      name: 'retired design',
      voicePrompt: 'a warm narrator',
      createdAt: 4_000,
      updatedAt: 4_000,
    });
    const retired = await getMiMoProviderOptions(getMiMoProfileVoiceId('retired'));
    expect(retired.voiceMode).toBe('clone');
    expect(retired.referenceAudioBase64).toBe(Buffer.from('fake-bytes').toString('base64'));
  });

  it('keeps an explicit live profile authoritative over the fallback', async () => {
    await db.voiceProfiles.add(
      cloneProfile({ id: 'default-newest', createdAt: 9_000, updatedAt: 9_000 }),
    );
    await db.voiceProfiles.add(
      cloneProfile({
        id: 'pinned',
        name: 'pinned',
        referenceAudio: new Blob(['pinned-bytes'], { type: 'audio/wav' }),
        referenceAudioMimeType: 'audio/wav',
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    );

    const options = await getMiMoProviderOptions(getMiMoProfileVoiceId('pinned'));

    expect(options.referenceAudioBase64).toBe(Buffer.from('pinned-bytes').toString('base64'));
    expect(options.referenceAudioMimeType).toBe('audio/wav');
  });

  it('degrades to a sample-less clone payload when no clone profile exists', async () => {
    await db.voiceProfiles.add({
      id: 'only-design',
      providerId: PROVIDER,
      kind: 'prompt',
      name: 'only design',
      voicePrompt: 'a warm narrator',
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const options = await getMiMoProviderOptions(MIMO_NO_SYSTEM_VOICE);

    expect(options.voiceMode).toBe('clone');
    expect(options.referenceAudioBase64).toBeUndefined();
    expect(options.referenceAudioMimeType).toBeUndefined();
  });
});
