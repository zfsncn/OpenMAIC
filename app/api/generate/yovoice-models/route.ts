/**
 * Server-side proxy for the yovoice model inventory (installed check).
 *
 * Same discipline as the voices proxy: the target is the operator's local
 * yovoice by definition, so the route always uses the built-in default
 * endpoint and inherits the operator's ALLOW_LOCAL_NETWORKS opt-in — never
 * request input. The token arrives in the `x-yovoice-key` header from the
 * settings panel (client BYOK config), never persisted server-side.
 *
 *   GET /api/generate/yovoice-models → { success, installed: string[] }
 *
 * Only ids present in the upstream `installed` array are returned: a model
 * id that merely exists in the static catalog cannot generate (yovoice
 * answers modelRequired), so the settings panel hides it.
 */
import { NextRequest, NextResponse } from 'next/server';

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { audioProviderFetch } from '@/lib/server/audio-provider-fetch';

export async function GET(request: NextRequest) {
  const key = request.headers.get('x-yovoice-key')?.trim();
  if (!key) {
    return NextResponse.json(
      { success: false, errorCode: 'YOVOICE_CONFIG_MISSING', error: 'access token required' },
      { status: 400 },
    );
  }
  const base = (TTS_PROVIDERS['yovoice-tts'].defaultBaseUrl || '').replace(/\/+$/u, '');
  try {
    const response = await audioProviderFetch(`${base}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return NextResponse.json(
        { success: false, errorCode: 'YOVOICE_HTTP_ERROR', error: detail.slice(0, 300) },
        { status: response.status },
      );
    }
    const data = (await response.json().catch(() => null)) as {
      installed?: Array<{ id?: string }>;
    } | null;
    const installed = Array.isArray(data?.installed)
      ? data.installed
          .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
          .filter((id) => id.length > 0)
      : [];
    return NextResponse.json({ success: true, installed });
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'YOVOICE_TRANSPORT_ERROR', error: 'yovoice is unreachable' },
      { status: 502 },
    );
  }
}
