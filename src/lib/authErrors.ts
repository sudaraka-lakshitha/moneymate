/**
 * OAuth failures come back as query/hash parameters on the redirect, not as a
 * thrown error. Nothing read them, so a failed Google sign-in dumped the user
 * back on the login screen with no explanation — indistinguishable from the
 * button doing nothing.
 */

export interface OAuthCallbackError {
  code: string;
  message: string;
}

const paramsFrom = (source: string): URLSearchParams =>
  new URLSearchParams(source.startsWith('#') || source.startsWith('?') ? source.slice(1) : source);

/** Reads an OAuth error from either the hash (implicit) or query (PKCE) callback. */
export const readOAuthError = (): OAuthCallbackError | null => {
  if (typeof window === 'undefined') return null;

  for (const source of [window.location.hash, window.location.search]) {
    if (!source) continue;
    const params = paramsFrom(source);
    const code = params.get('error_code') || params.get('error');
    if (!code) continue;

    const description = params.get('error_description') || '';
    return { code, message: describeOAuthError(code, description) };
  }
  return null;
};

const describeOAuthError = (code: string, description: string): string => {
  const readable = description.replace(/\+/g, ' ').trim();
  const haystack = `${code} ${readable}`.toLowerCase();

  if (haystack.includes('provider is not enabled') || haystack.includes('unsupported provider')) {
    return 'Google sign-in is not enabled for this project yet. Enable it in Supabase → Authentication → Providers → Google.';
  }
  if (haystack.includes('redirect_uri_mismatch') || haystack.includes('redirect')) {
    return 'This site\'s address is not in the allowed redirect list. Add it under Supabase → Authentication → URL Configuration.';
  }
  if (haystack.includes('access_denied')) {
    return 'Google sign-in was cancelled.';
  }
  if (haystack.includes('server_error') || haystack.includes('unexpected_failure')) {
    return 'Google could not complete the sign-in. Check that the Client ID and Secret in Supabase match your Google Cloud credentials.';
  }
  return readable || 'Google sign-in failed. Please try again.';
};

/**
 * Strips auth parameters from the address bar once they have been consumed.
 * Call this only AFTER supabase-js has resolved the session, otherwise the
 * PKCE code is removed before it can be exchanged.
 */
export const clearAuthParamsFromUrl = (): void => {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  const noisy = ['code', 'state', 'error', 'error_code', 'error_description', 'provider_token'];
  let changed = false;

  for (const key of noisy) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  // The implicit flow returns tokens in the hash.
  if (url.hash && /access_token|error|refresh_token/.test(url.hash)) {
    url.hash = '';
    changed = true;
  }

  if (changed) {
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }
};

/** Turns a Supabase auth exception into something worth showing a user. */
export const friendlyAuthError = (error: unknown): string => {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
  const haystack = raw.toLowerCase();

  if (haystack.includes('provider is not enabled') || haystack.includes('unsupported provider')) {
    return 'Google sign-in is not enabled for this project yet. Enable it in Supabase → Authentication → Providers → Google.';
  }
  if (haystack.includes('invalid login credentials')) {
    return 'That email and password do not match an account.';
  }
  if (haystack.includes('email not confirmed')) {
    return 'Please confirm your email address first — check your inbox for the verification link.';
  }
  if (haystack.includes('user already registered') || haystack.includes('already been registered')) {
    return 'An account with that email already exists. Try signing in instead.';
  }
  if (haystack.includes('password should be at least')) {
    return 'Password is too short — use at least 6 characters.';
  }
  if (haystack.includes('rate limit') || haystack.includes('too many requests')) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (haystack.includes('failed to fetch') || haystack.includes('networkerror')) {
    return 'Cannot reach the server. Check your internet connection.';
  }
  if (haystack.includes('infinite recursion')) {
    return 'The database security policies need updating — re-run supabase_schema.sql in the Supabase SQL editor.';
  }
  return raw || 'Something went wrong. Please try again.';
};

/** Shared wording for non-auth Supabase failures. */
export const friendlyDbError = (error: unknown, fallback: string): string => {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
  const haystack = raw.toLowerCase();

  if (haystack.includes('infinite recursion')) {
    return 'Database policies are out of date — re-run supabase_schema.sql in the Supabase SQL editor.';
  }
  if (haystack.includes('row-level security') || haystack.includes('violates row-level')) {
    return 'You do not have permission to do that.';
  }
  if (haystack.includes('could not find the function') || haystack.includes('does not exist')) {
    return 'This feature needs the latest database schema — re-run supabase_schema.sql in the Supabase SQL editor.';
  }
  if (haystack.includes('failed to fetch') || haystack.includes('networkerror')) {
    return 'Cannot reach the server. Check your internet connection.';
  }
  return raw || fallback;
};
