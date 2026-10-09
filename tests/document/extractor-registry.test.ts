import { describe, expect, it } from 'vitest';

import {
  getDocumentExtractorProvider,
  getDocumentExtractorProviders,
  getMediaExtractorProviders,
  selectDocumentExtractorProvider,
} from '@/lib/document';
import {
  getDocumentExtractorManifestEntries,
  getMediaExtractorManifestEntries,
} from '@/lib/document/extractors/manifest';
import { PROVIDER_SUPPORTED_MIME_TYPES } from '@/lib/document/mime';

describe('document extractor registry', () => {
  it('declares a non-empty version on every registered document and media provider', () => {
    const providers = [...getDocumentExtractorProviders(), ...getMediaExtractorProviders()];

    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.version, `provider ${provider.id} must declare a version`).toBeTruthy();
    }
  });
  it('exposes existing PDF providers through the document extractor boundary', () => {
    const providers = getDocumentExtractorProviders();

    expect(providers.map((provider) => provider.id)).toEqual(['plain-text', 'unpdf', 'alidocmind']);
    expect(providers.every((provider) => provider.supportedMimeTypes)).toBe(true);
    expect(
      providers
        .filter((provider) => provider.id !== 'plain-text')
        .every((provider) => provider.supportedMimeTypes.includes('application/pdf')),
    ).toBe(true);
  });

  it('exposes a local plain-text extractor for TXT and Markdown', () => {
    const plainText = getDocumentExtractorProvider('plain-text');

    expect(plainText).toBeDefined();
    expect(plainText?.supportedMimeTypes).toEqual([
      'text/plain',
      'text/markdown',
      'text/x-markdown',
    ]);
    expect(plainText?.capabilities).toMatchObject({
      text: true,
      images: false,
      tables: false,
      formulas: false,
      layout: false,
      ocr: false,
      async: false,
    });
  });

  it('selects a preferred provider only when it supports the requested MIME type', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        preferredProviderId: 'alidocmind',
      }).id,
    ).toBe('alidocmind');

    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        preferredProviderId: 'alidocmind',
      }).id,
    ).toBe('alidocmind');

    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        preferredProviderId: 'unpdf',
      }),
    ).toThrow(/does not support MIME type/);
  });

  it('can select by required capabilities', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        requiredCapabilities: { tables: true, formulas: true },
      }).id,
    ).toBe('alidocmind');

    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'application/pdf',
        preferredProviderId: 'unpdf',
        requiredCapabilities: { tables: true },
      }),
    ).toThrow(/requested capabilities/);
  });

  it('returns a clear error when no provider supports the MIME type', () => {
    expect(() =>
      selectDocumentExtractorProvider({
        mimeType: 'application/x-shockwave-flash',
      }),
    ).toThrow(/No document extractor supports MIME type/);
  });

  it('can capability-match Office course material to AliDocMind', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        requiredCapabilities: { text: true },
      }).id,
    ).toBe('alidocmind');

    expect(
      selectDocumentExtractorProvider({
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        preferredProviderId: 'alidocmind',
        requiredCapabilities: { text: true },
      }).id,
    ).toBe('alidocmind');
  });

  it('can capability-match text course material locally', () => {
    expect(
      selectDocumentExtractorProvider({
        mimeType: 'text/markdown',
        requiredCapabilities: { text: true },
      }).id,
    ).toBe('plain-text');
  });

  it('keeps PROVIDER_SUPPORTED_MIME_TYPES in sync with the extractor registry', () => {
    // Drift guard: mime.ts (client-safe, drives the upload UI) and the registry
    // (server-side extractors) must advertise the same MIME lists per provider.
    for (const provider of getDocumentExtractorProviders()) {
      expect(PROVIDER_SUPPORTED_MIME_TYPES[provider.id]).toEqual(provider.supportedMimeTypes);
    }
  });

  it('exposes AliDocMind with pdf/office/image support and async OCR capability', () => {
    const alidocmind = getDocumentExtractorProvider('alidocmind');
    expect(alidocmind).toBeDefined();
    expect(alidocmind?.displayName).toBe('AliDocMind');
    expect(alidocmind?.supportedMimeTypes).toContain('application/pdf');
    expect(alidocmind?.supportedMimeTypes).toContain('image/png');
    // Official image contract is JPG/JPEG/PNG/BMP/GIF — no WebP or JP2, which
    // no registered extractor accepts. Guards against re-advertising
    // unsupported formats.
    expect(alidocmind?.supportedMimeTypes).not.toContain('image/webp');
    expect(alidocmind?.supportedMimeTypes).not.toContain('image/jp2');
    expect(alidocmind?.capabilities).toMatchObject({
      text: true,
      tables: true,
      formulas: true,
      ocr: true,
      async: true,
    });
  });

  it('keeps the client-safe manifest in exact sync with both registries (RFC #1153 part 1)', () => {
    // The derivation cache resolves the expected extractor client-side from
    // the browser-safe manifest (`lib/document/extractors/manifest.ts`) so the
    // provider implementations (and their server-only dependency chains) never
    // enter the client bundle. The implementations spread their manifest
    // entries, so drift is impossible by construction — this test pins BOTH
    // directions anyway: every registered provider has an exact manifest
    // entry, and the manifest declares no orphan entries. Document and media
    // are compared per-domain because `alidocmind` legitimately exists in both
    // registries at the same version.
    interface IdentityFields {
      id: string;
      displayName: string;
      version: string;
      supportedMimeTypes: readonly string[];
      capabilities: unknown;
    }
    const expectExactSync = (
      providers: IdentityFields[],
      manifest: IdentityFields[],
      domain: string,
    ) => {
      const manifestById = new Map(manifest.map((entry) => [entry.id, entry]));
      for (const provider of providers) {
        const entry = manifestById.get(provider.id);
        expect(
          entry,
          `[${domain}] manifest must declare an entry for registered provider ${provider.id}`,
        ).toBeDefined();
        expect(
          {
            id: entry!.id,
            displayName: entry!.displayName,
            version: entry!.version,
            supportedMimeTypes: entry!.supportedMimeTypes,
            capabilities: entry!.capabilities,
          },
          `[${domain}] manifest entry for ${provider.id} must match the registered provider exactly`,
        ).toEqual({
          id: provider.id,
          displayName: provider.displayName,
          version: provider.version,
          supportedMimeTypes: provider.supportedMimeTypes,
          capabilities: provider.capabilities,
        });
      }
      const registeredIds = new Set(providers.map((provider) => provider.id));
      for (const entry of manifest) {
        expect(
          registeredIds.has(entry.id),
          `[${domain}] manifest entry ${entry.id} must be backed by a registered provider (no orphans)`,
        ).toBe(true);
      }
    };

    expectExactSync(
      getDocumentExtractorProviders(),
      getDocumentExtractorManifestEntries(),
      'document',
    );
    expectExactSync(getMediaExtractorProviders(), getMediaExtractorManifestEntries(), 'media');
  });
});
