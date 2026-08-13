import { useEffect, useState } from 'react';

/* ------------------------------------------------------------------------ */
/* Connectivity                                                              */
/* ------------------------------------------------------------------------ */

export const useOnline = (): boolean => {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
};

/* ------------------------------------------------------------------------ */
/* Read cache                                                                */
/* ------------------------------------------------------------------------ */

const CACHE_PREFIX = 'moneymate.cache.';

interface CacheEnvelope<T> {
  at: number;
  value: T;
}

/**
 * Last-known-good snapshot of a screen's data, so an offline launch shows real
 * numbers instead of empty states. Reads are never blocked on this being fresh
 * — the live fetch overwrites it as soon as it lands.
 */
export const writeCache = <T,>(key: string, value: T): void => {
  try {
    const envelope: CacheEnvelope<T> = { at: Date.now(), value };
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(envelope));
  } catch {
    // Quota or private mode — caching is best-effort by design.
  }
};

export const readCache = <T,>(key: string): { value: T; at: number } | null => {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as CacheEnvelope<T>;
    return { value: envelope.value, at: envelope.at };
  } catch {
    return null;
  }
};

export const clearCache = (): void => {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(CACHE_PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // ignore
  }
};
