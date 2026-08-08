import { useEffect, useState } from 'react';
import { supabase } from './supabase';

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

/* ------------------------------------------------------------------------ */
/* Write queue                                                               */
/* ------------------------------------------------------------------------ */

const QUEUE_KEY = 'moneymate.queue';

export interface QueuedWrite {
  id: string;
  /**
   * Only personal tracker rows are queued. Group expenses go through server
   * functions that validate splits and post ledger entries against balances
   * other people are changing too — replaying those blind would corrupt a
   * shared ledger, so they require a live connection.
   */
  table: 'daily_expenses';
  payload: Record<string, unknown>;
  createdAt: number;
}

const readQueue = (): QueuedWrite[] => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as QueuedWrite[];
  } catch {
    return [];
  }
};

const writeQueue = (queue: QueuedWrite[]): void => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // ignore
  }
};

export const queueWrite = (table: QueuedWrite['table'], payload: Record<string, unknown>): QueuedWrite => {
  const entry: QueuedWrite = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    table,
    payload,
    createdAt: Date.now(),
  };
  writeQueue([...readQueue(), entry]);
  return entry;
};

export const pendingWrites = (): QueuedWrite[] => readQueue();

export const pendingCount = (): number => readQueue().length;

/**
 * Sends everything queued while offline. Entries are dropped only on success
 * or on a permanent rejection — a transient network failure keeps them queued
 * for the next attempt.
 */
export const flushQueue = async (): Promise<{ sent: number; failed: number }> => {
  const queue = readQueue();
  if (queue.length === 0) return { sent: 0, failed: 0 };

  const remaining: QueuedWrite[] = [];
  let sent = 0;
  let failed = 0;

  for (const entry of queue) {
    try {
      const { error } = await supabase.from(entry.table).insert(entry.payload);
      if (error) {
        // 4xx-class problems will never succeed on retry; anything else might.
        const permanent = /violates|invalid|constraint|permission|row-level/i.test(error.message);
        if (permanent) failed += 1;
        else remaining.push(entry);
      } else {
        sent += 1;
      }
    } catch {
      remaining.push(entry);
    }
  }

  writeQueue(remaining);
  return { sent, failed };
};

/** Flushes on reconnect and once on mount; reports how many rows went out. */
export const useQueueFlush = (onFlushed?: (sent: number) => void): number => {
  const online = useOnline();
  const [count, setCount] = useState(pendingCount);

  useEffect(() => {
    let cancelled = false;

    const attempt = async () => {
      if (!navigator.onLine) {
        setCount(pendingCount());
        return;
      }
      const { sent } = await flushQueue();
      if (cancelled) return;
      setCount(pendingCount());
      if (sent > 0) onFlushed?.(sent);
    };

    void attempt();
    return () => {
      cancelled = true;
    };
    // Re-run whenever connectivity returns.
  }, [online, onFlushed]);

  return count;
};
