import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(() => false),
  resolveManagedAliDocMindCredentials: vi.fn(() => undefined),
  resolvePDFApiKey: vi.fn((_providerId: string, clientKey?: string) => clientKey || ''),
  resolvePDFBaseUrl: vi.fn((_providerId: string, clientBaseUrl?: string) => clientBaseUrl),
  parsePDF: vi.fn(),
  resolveServerAsset: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

// The only remote document extractor left is AliDocMind, which reaches the
// vendor through `parsePDF` (lib/pdf/pdf-providers). Mocking that seam keeps
// the route's provider-config forwarding observable without any network call.
vi.mock('@/lib/pdf/pdf-providers', () => ({
  parsePDF: mocks.parsePDF,
}));

vi.mock('@/lib/persistence/resolve-server-asset', () => ({
  resolveServerAsset: mocks.resolveServerAsset,
}));

async function postExtractDocument(input: {
  file: File;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}) {
  const { POST } = await import('@/app/api/extract-document/route');
  const formData = new FormData();
  formData.append('file', input.file);
  if (input.providerId) formData.append('providerId', input.providerId);
  if (input.apiKey) formData.append('apiKey', input.apiKey);
  if (input.baseUrl) formData.append('baseUrl', input.baseUrl);
  if (input.accessKeyId) formData.append('accessKeyId', input.accessKeyId);
  if (input.accessKeySecret) formData.append('accessKeySecret', input.accessKeySecret);

  const request = new Request('http://localhost/api/extract-document', {
    method: 'POST',
    body: formData,
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/extract-document', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolveManagedAliDocMindCredentials.mockReturnValue(undefined);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientKey?: string) => clientKey || '',
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
    mocks.parsePDF.mockReset();
    mocks.parsePDF.mockResolvedValue({
      text: 'ali parsed text',
      images: [],
      metadata: {
        pageCount: 1,
        parser: 'alidocmind',
      },
    });
    mocks.resolveServerAsset.mockReset();
  });

  it.each([
    ['missing', 404],
    ['too_large', 413],
    ['unauthenticated', 401],
  ] as const)(
    'carries the owner resolution cookies on an asset-id answer (%s)',
    async (status, httpStatus) => {
      const renewal =
        'anonymous_id=44444444-4444-4444-8444-444444444444; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000';
      mocks.resolveServerAsset.mockResolvedValue({ status, setCookies: [renewal] });
      const { POST } = await import('@/app/api/extract-document/route');
      const res = await POST(
        new Request('http://localhost/api/extract-document', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assetId: 'ast_1', fileName: 'a.pdf' }),
        }) as unknown as NextRequest,
      );
      expect(res.status).toBe(httpStatus);
      expect(res.headers.getSetCookie()).toEqual([renewal]);
    },
  );

  it('returns 400 for unsupported course material MIME types', async () => {
    const res = await postExtractDocument({
      file: new File(['x,y'], 'sheet.csv', { type: 'text/csv' }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
  });

  it("keeps the registry's interpolated MIME in the 400 for an unsupported MIME on the multipart byte form", async () => {
    const probeMime = 'application/x-echo-probe';
    const res = await postExtractDocument({
      file: new File(['probe bytes'], 'probe.bin', { type: probeMime }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    // Multipart is frozen: the extractor-selection error message (which
    // carries the caller's MIME type) is returned verbatim.
    expect(json.error).toContain(probeMime);
  });

  it('returns 413 before extraction when the file exceeds the per-file size limit', async () => {
    const res = await postExtractDocument({
      file: new File([new Uint8Array(51 * 1024 * 1024)], 'large.pdf', {
        type: 'application/pdf',
      }),
      providerId: 'alidocmind',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    });
    const json = await res.json();

    expect(res.status).toBe(413);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('Maximum size is 50MB');
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown requested provider', async () => {
    const res = await postExtractDocument({
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      providerId: 'missing-provider',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Unknown document extractor provider: missing-provider',
    });
  });

  it('treats an incompatible preferred provider as a hint and falls back by MIME type', async () => {
    const res = await postExtractDocument({
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      providerId: 'unpdf',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'hello',
        metadata: {
          mimeType: 'text/plain',
          parser: 'plain-text',
        },
      },
    });
  });

  it('runs an AliDocMind PDF extraction and forwards its config and options', async () => {
    const res = await postExtractDocument({
      file: new File(['%PDF-1.4'], 'lesson.pdf', { type: 'application/pdf' }),
      providerId: 'alidocmind',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'ali parsed text',
        metadata: {
          parser: 'alidocmind',
          mimeType: 'application/pdf',
        },
      },
    });
    // The extractor receives the resolved config plus the per-run extras
    // (file name + MIME). No progress/resume hooks exist for this call, so the
    // options object carries only those two keys.
    expect(mocks.parsePDF).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'alidocmind',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      }),
      expect.any(Buffer),
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );
  });

  it('auto-selects AliDocMind for a DOCX upload (the only Office-capable extractor)', async () => {
    const res = await postExtractDocument({
      file: new File(['not really docx'], 'lesson.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'ali parsed text',
        metadata: {
          parser: 'alidocmind',
        },
      },
    });
    expect(mocks.parsePDF).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'alidocmind' }),
      expect.any(Buffer),
      {
        fileName: 'lesson.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    );
  });
});

async function postExtractDocumentByAssetId(input: Record<string, unknown>) {
  const { POST } = await import('@/app/api/extract-document/route');
  const request = new Request('http://localhost/api/extract-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/extract-document (asset-id form)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolveManagedAliDocMindCredentials.mockReturnValue(undefined);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientKey?: string) => clientKey || '',
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
    mocks.parsePDF.mockReset();
    mocks.parsePDF.mockResolvedValue({
      text: 'ali parsed text',
      images: [],
      metadata: {
        pageCount: 1,
        parser: 'alidocmind',
      },
    });
    mocks.resolveServerAsset.mockReset();
  });

  it('extracts a resolved server asset through the document extractor', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('hello from asset'),
      mimeType: 'text/plain',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'hello from asset',
        metadata: {
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          parser: 'plain-text',
        },
      },
    });
    expect(mocks.resolveServerAsset).toHaveBeenCalledWith(
      'ast_abc',
      expect.anything(),
      50 * 1024 * 1024,
    );
  });

  it('passes the requested provider and its config through for asset-id extraction', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
      providerId: 'alidocmind',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'ali parsed text',
        metadata: {
          parser: 'alidocmind',
        },
      },
    });
    expect(mocks.parsePDF).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'alidocmind',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      }),
      expect.any(Buffer),
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );
  });

  it('returns 404 when the asset id resolves to nothing', async () => {
    mocks.resolveServerAsset.mockResolvedValue({ status: 'missing' });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_missing',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'ASSET_NOT_FOUND',
    });
    // The response must stay generic — the caller-controlled asset id is not
    // echoed back into the body.
    expect(json.error).toContain('No course material asset');
    expect(json.error).not.toContain('ast_missing');
  });

  it('returns 500 when the server asset store fails (generic 500 message, real error logged only)', async () => {
    mocks.resolveServerAsset.mockRejectedValue(new Error('db connection refused'));

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'The server asset store is unavailable. Please try again later.',
    });
    expect(json.error).not.toContain('db connection refused');
  });

  it('returns 400 for a wrong-typed asset id instead of 500', async () => {
    const res = await postExtractDocumentByAssetId({
      assetId: 123,
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELD',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for a wrong-typed mimeType instead of 500', async () => {
    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 42,
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for a wrong-typed fileName instead of 500', async () => {
    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: { not: 'a string' },
      mimeType: 'text/plain',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for a wrong-typed provider config field instead of 500', async () => {
    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      apiKey: ['not', 'a', 'string'],
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('rejects a client-supplied JSON path baseUrl pointing at a private address in any environment', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'false');
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
      providerId: 'alidocmind',
      baseUrl: 'http://192.168.1.10/v1/',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
    });
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('rejects a client-supplied local baseUrl when ALLOW_LOCAL_NETWORKS is unset', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
      providerId: 'alidocmind',
      baseUrl: 'http://127.0.0.1:8000/v1/',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
    });
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('rejects a non-official base URL even when ALLOW_LOCAL_NETWORKS=true (AliDocMind is official-endpoint-only)', async () => {
    // AliDocMind's SDK builds its own agent, so a client endpoint can never be
    // pinned to a validated address — only the official regional host is
    // accepted, and the ALLOW_LOCAL_NETWORKS opt-in does not relax that.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
      providerId: 'alidocmind',
      baseUrl: 'http://192.168.1.10/v1/',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_URL',
    });
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('accepts an official AliDocMind host as a client base URL', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
      providerId: 'alidocmind',
      baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true });
    expect(mocks.parsePDF).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'alidocmind',
        // The endpoint guard normalizes to the bare host.
        baseUrl: 'docmind-api.cn-hangzhou.aliyuncs.com',
      }),
      expect.any(Buffer),
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );
  });

  it('returns 413 when the resolved server asset exceeds the 50 MB cap (post-resolve backstop)', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.alloc(51 * 1024 * 1024),
      mimeType: 'application/pdf',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_huge',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
    });
    const json = await res.json();

    expect(res.status).toBe(413);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('Maximum size is 50MB');
    expect(mocks.parsePDF).not.toHaveBeenCalled();
    // The route passes its size cap to the resolver so the store can reject
    // from the recorded length without ever materializing the bytes.
    expect(mocks.resolveServerAsset).toHaveBeenCalledWith(
      'ast_huge',
      expect.anything(),
      50 * 1024 * 1024,
    );
  });

  it('returns 413 when the asset store reports an oversized asset before materializing it', async () => {
    mocks.resolveServerAsset.mockResolvedValue({ status: 'too_large' });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_huge',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
    });
    const json = await res.json();

    expect(res.status).toBe(413);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('Maximum size is 50MB');
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown provider on the JSON path without echoing the provider id', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('hello'),
      mimeType: 'text/plain',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      providerId: 'bogus-provider',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    // Generic static message — the offending provider id is never echoed.
    expect(json.error).not.toContain('bogus-provider');
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('answers an unsupported MIME with a generic 400 that never echoes the caller MIME type', async () => {
    const probeMime = 'application/x-echo-probe';
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('probe bytes'),
      mimeType: 'application/octet-stream',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_probe',
      fileName: 'probe.bin',
      mimeType: probeMime,
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    // With no provider hint, extractor selection throws the registry's
    // interpolated message (which carries the caller's MIME type); the
    // asset-id form must answer with a generic static message instead.
    expect(json.error).not.toContain(probeMime);
    expect(mocks.parsePDF).not.toHaveBeenCalled();
  });

  it('treats a known document provider that cannot extract the MIME as a hint and auto-selects by MIME type', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('hello from asset'),
      mimeType: 'text/markdown',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.md',
      mimeType: 'text/markdown',
      // unpdf is PDF-only; the JSON form must mirror multipart's hint
      // semantics and let the shared path auto-select `plain-text`.
      providerId: 'unpdf',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      data: {
        text: 'hello from asset',
        metadata: {
          fileName: 'notes.md',
          mimeType: 'text/markdown',
          parser: 'plain-text',
        },
      },
    });
  });

  it('keeps a generic 400 for a media MIME with a provider that cannot extract it', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('media bytes'),
      mimeType: 'audio/mpeg',
    });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lecture.mp3',
      mimeType: 'audio/mpeg',
      // unpdf is a document-only provider; the media branch must stay
      // pre-blocked with a generic message (never echoing the provider id).
      providerId: 'unpdf',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).not.toContain('unpdf');
    expect(json.error).not.toContain('lecture.mp3');
  });

  it('returns a generic 500 on the JSON path when the provider extractor rejects', async () => {
    mocks.resolveServerAsset.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
    });
    mocks.parsePDF.mockRejectedValue(new Error('upstream extractor exploded'));

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'lesson.pdf',
      mimeType: 'application/pdf',
      providerId: 'alidocmind',
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'PARSE_FAILED',
    });
    // The raw extractor error message must not reach the caller on the JSON
    // form; multipart keeps its current behavior.
    expect(json.error).not.toContain('upstream extractor exploded');
  });

  it('returns 503 when server persistence is not configured', async () => {
    mocks.resolveServerAsset.mockResolvedValue({ status: 'unconfigured' });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
  });

  it('returns 401 when the server persistence credential is missing', async () => {
    mocks.resolveServerAsset.mockResolvedValue({ status: 'unauthenticated' });

    const res = await postExtractDocumentByAssetId({
      assetId: 'ast_abc',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'UNAUTHENTICATED',
    });
  });

  it('returns 400 when no asset id is provided', async () => {
    const res = await postExtractDocumentByAssetId({
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELD',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const { POST } = await import('@/app/api/extract-document/route');
    const request = new Request('http://localhost/api/extract-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });

    const res = await POST(request as unknown as NextRequest);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for a JSON null body instead of 500 with raw internal text', async () => {
    const { POST } = await import('@/app/api/extract-document/route');
    const request = new Request('http://localhost/api/extract-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });

    const res = await POST(request as unknown as NextRequest);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    // The raw V8 TypeError text must never reach the caller.
    expect(json.error).not.toContain('TypeError');
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for a JSON array body instead of 500', async () => {
    const { POST } = await import('@/app/api/extract-document/route');
    const request = new Request('http://localhost/api/extract-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });

    const res = await POST(request as unknown as NextRequest);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });

  it('does not consult the server asset store for the multipart byte form', async () => {
    const res = await postExtractDocument({
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    });

    expect(res.status).toBe(200);
    expect(mocks.resolveServerAsset).not.toHaveBeenCalled();
  });
});
