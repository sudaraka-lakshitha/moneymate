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

/**
 * Pulls a human-readable message out of anything Supabase might throw or
 * return as `{ error }`.
 *
 * supabase-js is inconsistent here: auth failures (`AuthError`) do extend
 * `Error`, but query and RPC failures (`PostgrestError`, from `.from(...)` and
 * `.rpc(...)`) are plain `{ message, details, hint, code }` objects — not
 * `Error` instances. Checking only `instanceof Error` falls through to
 * `String(error)` for every one of those, which stringifies an object as the
 * literal text "[object Object]" instead of its message.
 */
export const messageFrom = (error: unknown): string => {
  if (error instanceof Error) return error.message;

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error_description', 'msg', 'hint', 'details']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // Circular or non-serializable — fall through to String() below.
    }
  }

  return String(error ?? '');
};

/** Turns a Supabase auth exception into something worth showing a user. */
export const friendlyAuthError = (error: unknown): string => {
  const raw = messageFrom(error).trim();
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
    return 'Something went wrong on our side. Please try again in a moment.';
  }
  return raw || 'Something went wrong. Please try again.';
};

/**
 * Database plumbing that means nothing to the person holding the phone.
 *
 * The server raises its own refusals in plain English — "Only a group admin can
 * remove members" — and those are worth showing verbatim. Postgres's own errors
 * are not: constraint names and column types are for us, in the console. Anything
 * matching here falls back to the caller's wording instead.
 */
const INTERNAL_ERROR = new RegExp(
  [
    'violates',
    'constraint',
    'duplicate key',
    'null value in column',
    'invalid input syntax',
    'syntax error',
    'permission denied for',
    'relation "',
    'column "',
    'operator does not exist',
    'out of range',
    'pgrst',
    'jwt',
  ].join('|'),
  'i'
);

/** Shared wording for non-auth Supabase failures. */
export const friendlyDbError = (error: unknown, fallback: string): string => {
  const raw = messageFrom(error).trim();
  const haystack = raw.toLowerCase();

  if (haystack.includes('infinite recursion')) {
    return 'Something went wrong on our side. Please try again in a moment.';
  }
  if (haystack.includes('row-level security') || haystack.includes('violates row-level')) {
    return 'You do not have permission to do that.';
  }
  if (haystack.includes('could not find the function') || haystack.includes('does not exist')) {
    return 'This part of the app is being updated. Please refresh and try again.';
  }
  if (haystack.includes('failed to fetch') || haystack.includes('networkerror')) {
    return 'Cannot reach the server. Check your internet connection.';
  }
  if (!raw || INTERNAL_ERROR.test(raw)) {
    // Keep the detail where it is useful rather than throwing it away.
    if (raw) console.error('Database error:', raw);
    return fallback;
  }
  return raw;
};
