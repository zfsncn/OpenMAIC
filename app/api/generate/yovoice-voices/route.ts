/**
 * Server-side proxy for the yovoice voice registry (list + upload).
 *
 * Why a proxy: yovoice refuses cross-origin browser calls, and its token must
 * not leak into the page. Why no client-supplied base URL: the target is the
 * operator's local yovoice by definition, so the route always uses the
 * built-in default endpoint and inherits the operator's ALLOW_LOCAL_NETWORKS
 * opt-in — never request input (same discipline as the TTS route).
 *
 *   GET  /api/generate/yovoice-voices        → list saved voices
 *   POST /api/generate/yovoice-voices?name=… → upload a reference sample
 *        (binary audio body, 1–60 s / ≤20 MB per yovoice docs)
 *
 * The yovoice access token arrives in the `x-yovoice-key` header from the
 * settings panel (client BYOK config), never persisted server-side.
 */
import { NextRequest, NextResponse } from 'next/server';

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { audioProviderFetch } from '@/lib/server/audio-provider-fetch';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function resolveTarget(): { base: string; headers: Record<string, string> } {
  const base = (TTS_PROVIDERS['yovoice-tts'].defaultBaseUrl || '').replace(/\/+$/u, '');
  return { base, headers: {} };
}

async function proxyFetch(path: string, init: RequestInit): Promise<NextResponse> {
  const { base, headers } = resolveTarget();
  try {
    const response = await audioProviderFetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return NextResponse.json(
        { success: false, errorCode: 'YOVOICE_HTTP_ERROR', error: detail.slice(0, 300) },
        { status: response.status },
      );
    }
    const data = await response.json().catch(() => []);
    return NextResponse.json({ success: true, voices: data });
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'YOVOICE_TRANSPORT_ERROR', error: 'yovoice is unreachable' },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  const key = request.headers.get('x-yovoice-key')?.trim();
  if (!key) {
    return NextResponse.json(
      { success: false, errorCode: 'YOVOICE_CONFIG_MISSING', error: 'access token required' },
      { status: 400 },
    );
  }
  return proxyFetch('/v1/voices', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
}

export async function POST(request: NextRequest) {
  const key = request.headers.get('x-yovoice-key')?.trim();
  if (!key) {
    return NextResponse.json(
      { success: false, errorCode: 'YOVOICE_CONFIG_MISSING', error: 'access token required' },
      { status: 400 },
    );
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'empty audio body' },
      { status: 400 },
    );
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'reference audio exceeds 20 MB' },
      { status: 413 },
    );
  }
  const name = (request.nextUrl.searchParams.get('name') || 'voice').slice(0, 60);
  return proxyFetch(`/v1/voices?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/octet-stream',
    },
    body: Buffer.from(bytes),
  });
}
