import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

/**
 * Keeps a screen current without the user pulling to refresh.
 *
 * Two triggers, because neither alone is enough:
 *
 *  - Postgres change events, so somebody else adding a bill shows up while you
 *    are looking at the screen.
 *  - A refetch when the tab or app is brought back to the foreground. Mobile
 *    browsers suspend timers and sockets in the background, so a phone that has
 *    been in a pocket reconnects with no idea what it missed. This is what makes
 *    reopening the app feel current rather than stale.
 *
 * Callbacks are held in a ref so a caller passing an inline arrow function does
 * not tear down and rebuild the subscription on every render — doing so is what
 * turns "live" into a reconnect loop that updates more slowly than not
 * subscribing at all.
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

    let debounce: number | undefined;
    // A single save writes the expense, its splits and two ledger rows, which
    // arrive as separate events. Without coalescing, one action would trigger
    // four refetches.
    const fire = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => handler.current(), 250);
    };

    const channel = supabase.channel(channelName);
    for (const table of tableKey.split(',')) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
    }
    channel.subscribe();

    const onVisible = () => {
      if (document.visibilityState === 'visible') fire();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', fire);
    window.addEventListener('online', fire);

    return () => {
      window.clearTimeout(debounce);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', fire);
      window.removeEventListener('online', fire);
      void supabase.removeChannel(channel);
    };
  }, [channelName, tableKey, enabled]);
};
