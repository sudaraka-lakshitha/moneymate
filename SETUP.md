# MoneyMate — Setup Guide

## 1. Local development

```bash
npm install
npm run dev
```

Visit `http://localhost:5173`.

## 2. Database — run this first

**Open the Supabase SQL editor and run `supabase_schema.sql` in full.** It is
idempotent, so re-running it is safe and is the fix for most "nothing loads"
problems.

The script creates the tables, the row-level-security policies, and the
server-side functions the app calls (`save_expense`, `update_expense`,
`delete_expense`, `record_settlement`, `request_to_join_group`,
`find_group_by_invite_code`, `regenerate_invite_code`).

If you are upgrading an older install, this run is **required** — earlier
policy definitions had three faults that broke core features:

| Symptom | Cause |
| --- | --- |
| Groups never load; console shows `infinite recursion detected in policy for relation "group_members"` | The `group_members` policies queried `group_members`, so Postgres re-entered the same policy while evaluating it. Membership checks now go through `SECURITY DEFINER` helpers. |
| Member names, avatars and "paid by" labels render blank | `users` was readable only for your own row, so every join to a co-member returned `NULL`. You can now read the profile of anyone you share a group with. |
| Every valid invite code reports "Invalid or expired" | `groups` is only selectable by existing members, so the lookup could never match. Joining now goes through the `request_to_join_group` function. |

## 3. Environment configuration

The app ships pre-configured to point at the MoneyMate Supabase project, so it
runs with no extra setup. `src/lib/supabase.ts` initializes the client.

To point it at a different project, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` key |

Both are safe to expose in the browser — the anon key only grants what your Row
Level Security policies allow. Never put the `service_role` key in a `VITE_`
variable; Vite inlines those into the client bundle.

## 4. Google Sign-In

Google is **not** enabled by default on a Supabase project. Until you complete
both halves below, the button will return an error (the app now shows you
exactly which one).

### a. Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create or pick a project.
2. **APIs & Services → OAuth consent screen** — configure it, add your email as a test user while in "Testing".
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Under **Authorised redirect URIs**, add your Supabase callback:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   For this project that is `https://illvzuwxcvttbsoddptr.supabase.co/auth/v1/callback`.
6. Copy the **Client ID** and **Client Secret**.

### b. Supabase

1. **Authentication → Providers → Google** — toggle it on, paste the Client ID and Secret, save.
2. **Authentication → URL Configuration** — set **Site URL** to your deployed
   address, and add every address you sign in from to **Redirect URLs**:
   ```
   http://localhost:5173
   https://your-app.vercel.app
   ```
   A missing entry here is the usual cause of landing back on the login screen.

### Troubleshooting

| Message | Fix |
| --- | --- |
| "Google sign-in is not enabled for this project yet" | Step 4b.1 — the provider is off. |
| "This site's address is not in the allowed redirect list" | Step 4b.2 — add the address to Redirect URLs. |
| "Google could not complete the sign-in" | Client ID/Secret in Supabase do not match Google Cloud. |
| Redirects back but stays signed out | The callback URI in step 4a.5 does not match your project ref. |

## 5. Deploying to Vercel

1. Connect the repository at [vercel.com](https://vercel.com).
2. Root directory `./`, build command `npm run build`, output directory `dist`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under
   **Project Settings → Environment Variables** (optional — the defaults are compiled in).
4. Deploy, then add the resulting URL to Supabase's **Redirect URLs** (step 4b.2)
   so Google sign-in works in production too.
