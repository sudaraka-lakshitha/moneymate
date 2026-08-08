# MoneyMate — Expense Splitter & Daily Tracker (Web App & PWA)

MoneyMate is a cross-platform web app and Progressive Web App for splitting group
expenses, tracking daily personal spending in **LKR (Rs.)**, simplifying debts, and
settling up with friends.

---

## ⚡ Quick start

> **Run `supabase_schema.sql` in the Supabase SQL editor first.** Without it the
> app cannot read groups or members. See [SETUP.md](SETUP.md).

### Option 1: double-click batch file (Windows)
Double-click **`run.bat`**. It installs dependencies if needed, launches the
server, and opens `http://localhost:5173`.

### Option 2: terminal
```bash
npm install
npm run dev
```

---

## 🚀 Features

### Splitting
- **Five split methods** — Equal, Custom (exact LKR), Percentage, Shares, and
  **Itemized** (add each line, tick who is on it, and per-person totals are derived).
- **Per-bill member toggle** — include or exclude members on any bill.
- **Proxy entry** — record an expense on behalf of whoever actually paid.
- **Exact money maths** — Rs. 100 across three people is 33.34 / 33.33 / 33.33, not
  three lots of 33.33. The remainder is distributed, so a split always sums to the bill.
- **Live preview** — see what each person owes before saving, and a clear warning
  when percentages do not reach 100% or custom amounts miss the total.

### Balances
- **Append-only ledger** — expenses, edits and deletions all post entries rather than
  mutating history. Every operation nets to zero.
- **Edit with audit trail** — editing reverses the old ledger entries, posts fresh
  ones, and records a before/after snapshot in `expense_edits`.
- **Debt simplification** — the fewest payments that clear the group.
- **Friends panel** — true pairwise balances (what each friend owes *you*), broken
  down by group.
- **Settle up** — record a payment and the balancing ledger entries in one transaction.

### Personal
- **Daily tracker** — log spending, grouped by day.
- **Monthly budgets** — per-category limits with progress meters and over-budget warnings.
- **Analytics** — 30/90-day trend chart with hover detail, period-over-period change,
  daily average, and a ranked category breakdown. Covers both your own spending and your
  share of group bills, filterable by source.

### Convenience
- **Receipt scanning** — photograph a receipt and on-device OCR fills in the total,
  date and merchant. The image is attached either way, and everything stays editable.
- **Recurring expenses** — rent, subscriptions and season tickets repeat daily, weekly
  or monthly. Missed occurrences are backfilled the next time you open the app.
- **Saved default splits** — remember a group's usual arrangement so the regular
  dinner crowd is not re-configured on every bill.
- **Search** — across every bill and tracker entry, filtered by category, source,
  amount range and date range.
- **Offline mode** — installs as a real app, launches with no connection, shows your
  last-known data, and queues personal entries until you are back online.

### Access
- **Google Sign-In** and email/password, with real error messages when a provider is
  misconfigured rather than a silent bounce back to the login screen.
- **Invite codes** — six characters, expiring, regenerable by admins.
- **Join approval** — admins approve or decline each request.

---

## 📲 Install as an app

The app prompts to install itself when the browser reports it is installable.

- **Android (Chrome/Edge)**: tap **Install** in the prompt. This installs a **WebAPK**,
  so MoneyMate appears in the **app drawer**, in Settings → Apps and in the share
  sheet — not just as a home-screen shortcut. Using the browser's own
  "Add to Home screen" menu item instead creates a plain bookmark, so prefer the
  in-app Install button.
- **Desktop (Chrome/Edge)**: the install icon in the address bar, or the in-app
  prompt. It then appears in your OS app list and `chrome://apps`.
- **iPhone (Safari)**: Share → **Add to Home Screen**. iOS has no install API and no
  app drawer, so this is the only route there.

Installability is enforced by a check in CI-style testing: manifest `id`, name,
description, `start_url`, standalone display, 192/512 icons, a maskable icon, a
narrow screenshot, and a registered service worker.

**Offline scope, honestly:** the app shell and your last-loaded data are cached, so
MoneyMate opens and remains readable with no connection, and personal tracker entries
you add offline are queued and sent on reconnect. Group expenses and settlements
require a connection — they are validated server-side against balances other people
are changing concurrently, so replaying them blind would corrupt a shared ledger.

---

## ⚙️ Architecture notes

**Security-sensitive and multi-step writes live in the database, not the client.**
Saving an expense touches four tables; done as four browser round trips, a failure
midway leaves splits with no ledger entries and corrupts every balance in the group.
`save_expense`, `update_expense`, `delete_expense` and `record_settlement` are
`SECURITY DEFINER` functions that do the whole job in one transaction and reject a
split set that does not reconstruct the bill total.

**RLS membership checks go through `SECURITY DEFINER` helpers.** A policy on
`group_members` that itself queries `group_members` makes Postgres re-enter the same
policy and raise `infinite recursion detected in policy`. `is_group_member()`,
`is_group_admin()` and `can_view_profile()` break the cycle.

**Chart colours are validated, not eyeballed.** The categorical palette in
`src/lib/categories.ts` clears the colour-vision-deficiency separation floor and the
3:1 contrast floor against the dark chart surface.

---

## 🗄️ Backend

- **Supabase URL**: `https://illvzuwxcvttbsoddptr.supabase.co`
- **Anon public key**: in `src/lib/supabase.ts`, overridable via `VITE_SUPABASE_ANON_KEY`

The anon key is a public, RLS-protected client key — it is designed to ship in the
browser bundle. Schema, policies, functions and triggers all live in
`supabase_schema.sql`.

Full setup — including the Google Cloud + Supabase steps needed for Google
Sign-In — is in **[SETUP.md](SETUP.md)**.
