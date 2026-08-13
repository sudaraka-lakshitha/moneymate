import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

/** How often a visible screen refetches even when the socket says nothing. */
const POLL_MS = 15000;

/** Backoff between resubscribe attempts after the channel drops. */
const RETRY_MS = [1000, 2000, 5000, 10000, 20000];

/**
 * Keeps a screen current without the user pulling to refresh.
 *
 * Four triggers, because no single one is reliable on a phone:
 *
 *  - Postgres change events, so somebody else adding a bill shows up while you
 *    are looking at the screen.
 *  - A poll while the tab is visible. This is the one that makes the difference
 *    in practice: a websocket can be alive as far as the client is concerned and
 *    still be delivering nothing — a proxy quietly dropped it, the row failed a
 *    realtime authorisation check, the table was not in the publication. Polling
 *    puts a ceiling on how stale a screen can get regardless of any of that.
 *  - A refetch when the tab or app returns to the foreground. Mobile browsers
 *    suspend timers and sockets in the background, so a phone that has been in a
 *    pocket reconnects with no idea what it missed.
 *  - Coming back online.
 *
 * The subscription also watches its own status and rebuilds itself when the
 * channel errors, times out or closes. Without that, one dropped socket meant
 * the screen was dead until a manual refresh — which looks exactly like realtime
 * having never worked at all.
 *
 * Callbacks are held in a ref so a caller passing an inline arrow function does
 * not tear down and rebuild the subscription on every render.
 */
export const useLiveRefresh = (
  channelName: string,
  tables: string[],
  onChange: () => void,
  enabled = true
): void => {
  const handler = useRef(onChange);
  handler.current = onChange;

  const tableKey = tables.join(',');

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let debounce: number | undefined;
    let poll: number | undefined;
    let retry: number | undefined;
    let attempt = 0;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // A single save writes the expense, its splits and two ledger rows, which
    // arrive as separate events. Without coalescing, one action would trigger
    // four refetches.
    const fire = () => {
      if (disposed) return;
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        if (!disposed) handler.current();
      }, 250);
    };

    const subscribe = () => {
      if (disposed) return;

      // A fresh name per attempt: reusing one the server still considers open
      // is how a "reconnect" ends up silently joined to nothing.
      channel = supabase.channel(`${channelName}-${Date.now()}`);
      for (const table of tableKey.split(',')) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
      }

      channel.subscribe((status) => {
        if (disposed) return;

        if (status === 'SUBSCRIBED') {
          attempt = 0;
          // Catch up on whatever changed while the channel was down.
          fire();
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
          attempt += 1;
          const dying = channel;
          channel = null;
          if (dying) void supabase.removeChannel(dying);
          window.clearTimeout(retry);
          retry = window.setTimeout(subscribe, wait);
        }
      });
    };

    subscribe();

    // The floor. Only while the screen is actually being looked at — polling a
    // backgrounded tab burns a phone's battery for data nobody is reading.
    const startPolling = () => {
      window.clearInterval(poll);
      poll = window.setInterval(() => {
        if (document.visibilityState === 'visible') handler.current();
      }, POLL_MS);
    };
    startPolling();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        fire();
        // A suspended tab's interval is unreliable; restart it from now.
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', fire);
    window.addEventListener('online', fire);

    return () => {
      disposed = true;
      window.clearTimeout(debounce);
      window.clearTimeout(retry);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', fire);
      window.removeEventListener('online', fire);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [channelName, tableKey, enabled]);
};
