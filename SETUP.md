# MoneyMate Web App — Setup Guide

## 1. Local Development

```bash
# Install dependencies
npm install

# Run Vite dev server
npm run dev
```

Visit `http://localhost:5173`.

## 2. Environment Configuration

The app ships pre-configured to point at the MoneyMate Supabase project, so it runs
with no extra setup. `src/lib/supabase.ts` initializes the client with persistent
authentication state.

To point it at a different project, copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` `public` key |

Both are safe to expose in the browser — the anon key only grants what your Row Level
Security policies allow. Never put the `service_role` key in a `VITE_` variable; Vite
inlines those into the client bundle.

On Vercel, set the same two variables under Project Settings → Environment Variables.

## 3. Free Hosting Deployment (Vercel)

1. Connect your repository to [Vercel](https://vercel.com).
2. Set root directory as `./`.
3. Build command: `npm run build`.
4. Output directory: `dist`.
5. Deploy and get a public URL for all iOS & Android users!
