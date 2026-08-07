# MoneyMate — Expense Splitter & Daily Tracker (Web App & PWA)

MoneyMate is a cross-platform Web Application and Progressive Web App (PWA) built for splitting group expenses, tracking daily personal spending in **LKR (Rs.)**, simplifying debts, and managing balances across friends.

---

## ⚡ Quick Start (Run Locally)

### Option 1: Double-Click Batch File (Windows)
Simply double-click **`run.bat`** in the project folder. It will install dependencies (if needed), launch the server, and automatically open `http://localhost:5173` in your web browser!

### Option 2: Terminal / Command Prompt
```bash
# 1. Install dependencies
npm install

# 2. Run dev server
npm run dev
```

Open your browser at `http://localhost:5173`.

---

## 🌐 Deploying to Vercel / Netlify (Free)

Anyone on **iPhone (iOS)**, **Android**, **Mac**, or **Windows** can use your app once deployed!

1. Push this repository to GitHub.
2. Go to **[vercel.com](https://vercel.com)** → Import your repository.
3. Click **Deploy**.
4. Share your live URL (e.g. `moneymate.vercel.app`) with your friends!

---

## 📲 Install as PWA on Mobile (iPhone & Android)

- **iPhone (Safari)**: Tap the Share button → **"Add to Home Screen"**.
- **Android (Chrome)**: Tap the 3 dots menu → **"Install App"** or **"Add to Home Screen"**.

---

## ⚙️ Backend & Supabase Configuration

The app connects directly to your Supabase project:
- **Supabase URL**: `https://illvzuwxcvttbsoddptr.supabase.co`
- **Anon Public Key**: Configured in `src/lib/supabase.ts`

The database schema, RLS security policies, and user triggers are fully installed via `supabase_schema.sql`.

---

## 🚀 Key Features Implemented

- 💸 **LKR Currency Only (Rs.)** — Tailored for Sri Lanka.
- 👥 **Group Expense Splitting** — Equal, Custom LKR, Percentage %, and Shares split methods.
- 🔘 **Per-Bill Member Toggle** — Include or exclude specific group members per bill.
- 🔄 **Proxy Expense Entry** — Add expenses on behalf of other group members.
- 📜 **Ledger-Based Balance Integrity** — Append-only ledger entries; deletions and edits generate reversal entries.
- 🤝 **Friends Balance Panel** — Cross-group credit/debit calculation per friend.
- 📆 **Daily Personal Expense Tracker** — Log personal expenses, view monthly category totals.
- 📊 **Analytics & Insights** — Category percentage breakdowns.
- 🔐 **Supabase Auth** — Email/Password sign up & Google OAuth.
