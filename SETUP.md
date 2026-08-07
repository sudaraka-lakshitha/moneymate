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

The app is already pre-configured to point to your Supabase instance:
- `src/lib/supabase.ts` handles the client initialization with persistent authentication state.

## 3. Free Hosting Deployment (Vercel)

1. Connect your repository to [Vercel](https://vercel.com).
2. Set root directory as `./`.
3. Build command: `npm run build`.
4. Output directory: `dist`.
5. Deploy and get a public URL for all iOS & Android users!
