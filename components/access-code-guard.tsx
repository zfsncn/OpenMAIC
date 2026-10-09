'use client';

import { useEffect, useState, ReactNode } from 'react';
import { AccessCodeModal } from '@/components/access-code-modal';
import { useSettingsStore } from '@/lib/store/settings';
import { LIBRARY_CHANGED_EVENT } from '@/lib/utils/stage-storage';

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<{
    enabled: boolean;
    authenticated: boolean;
    loading: boolean;
  }>({ enabled: false, authenticated: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/access-code/status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setStatus({
            enabled: data.enabled,
            authenticated: data.authenticated,
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Default to requiring auth on error — safer than silently disabling
          setStatus({ enabled: true, authenticated: false, loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsAuth = !status.loading && status.enabled && !status.authenticated;

  return (
    <>
      {needsAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => {
            setStatus((s) => ({ ...s, authenticated: true }));
            // ServerProvidersInit runs on mount, which on an ACCESS_CODE-gated
            // deployment is before any access cookie exists: the middleware
            // answers 401 and the store silently keeps its blank defaults.
            // Nothing re-fetches afterwards, so every server-configured
            // provider reads as unconfigured until a manual reload. Re-fetch
            // now that the request will be authorized.
            void useSettingsStore.getState().fetchServerProviders();
            // The library load is caught by the very same 401, for the very
            // same reason: the home page's mount effect runs before the cookie
            // exists, and nothing asks again — so an unlocked browser still
            // showed an empty library (no folders) until a manual reload.
            // Broadcasting "library changed" makes it list courses, thumbnails
            // and folders again; the home page already listens for this event,
            // so no new coupling is introduced.
            window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
          }}
        />
      )}
      {children}
    </>
  );
}
