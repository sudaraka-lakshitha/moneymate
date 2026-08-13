/**
 * UI visibility test.
 *
 * Runs the real production bundle in a real browser with Supabase stubbed out,
 * so every screen renders from data the app actually asked for. Checks what a
 * person would check: is the screen there, are the figures on it, did anything
 * throw, and does the layout stay inside the phone.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:4173';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });

const ME = '11111111-1111-1111-1111-111111111111';
const BEN = '22222222-2222-2222-2222-222222222222';
const CARA = '33333333-3333-3333-3333-333333333333';
const G1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const DIRECT = 'aaaaaaaa-0000-0000-0000-000000000002';

const user = (id, name, email) => ({ id, display_name: name, email, avatar_url: null });
const meU = user(ME, 'Sudaraka Lakshitha', 'me@t.lk');
const benU = user(BEN, 'Ben Perera', 'ben@t.lk');
const caraU = user(CARA, 'Cara Silva', 'cara@t.lk');

const today = new Date().toISOString();
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const groups = [
  { id: G1, name: 'Boarding Expenses', description: 'Flat share', icon_emoji: '🏠',
    created_by: ME, invite_code: 'BOARD1', invite_code_expires_at: today,
    is_direct: false, archived_at: null, status: 'ACTIVE', created_at: today, updated_at: today },
  { id: DIRECT, name: 'Between you and Ben Perera', description: '', icon_emoji: '🤝',
    created_by: ME, invite_code: 'DIR001', invite_code_expires_at: today,
    is_direct: true, archived_at: null, status: 'ACTIVE', created_at: today, updated_at: today },
];

const members = [
  { group_id: G1, user_id: ME, role: 'ADMIN', users: meU, user: meU, groups: groups[0] },
  { group_id: G1, user_id: BEN, role: 'MEMBER', users: benU, user: benU, groups: groups[0] },
  { group_id: G1, user_id: CARA, role: 'MEMBER', users: caraU, user: caraU, groups: groups[0] },
  { group_id: DIRECT, user_id: ME, role: 'ADMIN', users: meU, user: meU, groups: groups[1] },
  { group_id: DIRECT, user_id: BEN, role: 'ADMIN', users: benU, user: benU, groups: groups[1] },
];

const expense = (id, group_id, title, amount, paid_by, payer, category, opts = {}) => ({
  id, group_id, title, amount, paid_by, created_by: paid_by, category,
  split_method: 'EQUAL', notes: '', is_deleted: false, settled_at: null, is_loan: false,
  created_at: today, updated_at: today, receipt_url: null, on_behalf_of: null,
  paid_by_user: payer,
  expense_splits: opts.splits ?? [],
  ...opts,
});

const expenses = [
  expense('e1', G1, 'Groceries', 4500, ME, meU, 'FOOD', {
    splits: [
      { user_id: ME, amount: 1500, is_included: true },
      { user_id: BEN, amount: 1500, is_included: true },
      { user_id: CARA, amount: 1500, is_included: true },
    ],
  }),
  expense('e2', G1, 'Electricity bill', 3300, BEN, benU, 'UTILITIES', {
    splits: [
      { user_id: ME, amount: 1100, is_included: true },
      { user_id: BEN, amount: 1100, is_included: true },
      { user_id: CARA, amount: 1100, is_included: true },
    ],
  }),
  expense('e3', G1, 'Wifi (settled)', 2400, CARA, caraU, 'UTILITIES', {
    settled_at: today,
    splits: [
      { user_id: ME, amount: 800, is_included: true },
      { user_id: BEN, amount: 800, is_included: true },
      { user_id: CARA, amount: 800, is_included: true },
    ],
  }),
  expense('e4', G1, 'Typo bill', 999, ME, meU, 'FOOD', { is_deleted: true, splits: [] }),
  expense('e5', DIRECT, 'Lunch', 1200, ME, meU, 'OTHER', {
    splits: [
      { user_id: ME, amount: 600, is_included: true },
      { user_id: BEN, amount: 600, is_included: true },
    ],
  }),
  expense('e6', DIRECT, 'Loan', 5000, ME, meU, 'OTHER', {
    is_loan: true,
    splits: [
      { user_id: ME, amount: 0, is_included: false },
      { user_id: BEN, amount: 5000, is_included: true },
    ],
  }),
  // A loan the other way, so the "a loan is not spending" rule is tested from
  // the borrower's side — the side that would otherwise inflate my figures.
  expense('e7', DIRECT, 'Borrowed', 3000, BEN, benU, 'OTHER', {
    is_loan: true,
    splits: [
      { user_id: ME, amount: 3000, is_included: true },
      { user_id: BEN, amount: 0, is_included: false },
    ],
  }),
];

// What Stats should make of the fixtures above: my share of e1/e2/e3/e5 is
// 1500 + 1100 + 800 + 600 = 4000, and the loan is not spending.
const MY_SHARE = 4000;

// Ledger consistent with the expenses above: I paid 4500 and owe 3400 of it,
// Ben paid 3300 and owes 3400, Cara paid 2400 and owes 3400 — plus the pair
// group where Ben owes me 5600.
// reference_id points back at the expense, which is how Stats works out what
// you actually fronted as opposed to what was your share.
const ledger = [
  { group_id: G1, user_id: ME, amount: 4500, entry_type: 'EXPENSE', reference_id: 'e1' },
  { group_id: G1, user_id: ME, amount: -1500, entry_type: 'SPLIT', reference_id: 'e1' },
  { group_id: G1, user_id: BEN, amount: -1500, entry_type: 'SPLIT', reference_id: 'e1' },
  { group_id: G1, user_id: CARA, amount: -1500, entry_type: 'SPLIT', reference_id: 'e1' },
  { group_id: G1, user_id: BEN, amount: 3300, entry_type: 'EXPENSE', reference_id: 'e2' },
  { group_id: G1, user_id: ME, amount: -1100, entry_type: 'SPLIT', reference_id: 'e2' },
  { group_id: G1, user_id: BEN, amount: -1100, entry_type: 'SPLIT', reference_id: 'e2' },
  { group_id: G1, user_id: CARA, amount: -1100, entry_type: 'SPLIT', reference_id: 'e2' },
  { group_id: G1, user_id: CARA, amount: 2400, entry_type: 'EXPENSE', reference_id: 'e3' },
  { group_id: G1, user_id: ME, amount: -800, entry_type: 'SPLIT', reference_id: 'e3' },
  { group_id: G1, user_id: BEN, amount: -800, entry_type: 'SPLIT', reference_id: 'e3' },
  { group_id: G1, user_id: CARA, amount: -800, entry_type: 'SPLIT', reference_id: 'e3' },
  { group_id: DIRECT, user_id: ME, amount: 1200, entry_type: 'EXPENSE', reference_id: 'e5' },
  { group_id: DIRECT, user_id: ME, amount: -600, entry_type: 'SPLIT', reference_id: 'e5' },
  { group_id: DIRECT, user_id: BEN, amount: -600, entry_type: 'SPLIT', reference_id: 'e5' },
  { group_id: DIRECT, user_id: ME, amount: 5000, entry_type: 'EXPENSE', reference_id: 'e6' },
  { group_id: DIRECT, user_id: BEN, amount: -5000, entry_type: 'SPLIT', reference_id: 'e6' },
  { group_id: DIRECT, user_id: BEN, amount: 3000, entry_type: 'EXPENSE', reference_id: 'e7' },
  { group_id: DIRECT, user_id: ME, amount: -3000, entry_type: 'SPLIT', reference_id: 'e7' },
];

const settlements = [
  { id: 's1', group_id: G1, from_user: BEN, to_user: ME, amount: 500, payment_method: 'CASH',
    note: '', created_at: today, payer: benU, payee: meU },
];

const friendRequests = [
  { id: 'fr1', requester_id: ME, addressee_id: BEN, addressee_email: 'ben@t.lk',
    status: 'ACCEPTED', created_at: today, responded_at: today, requester: meU, addressee: benU },
  { id: 'fr2', requester_id: CARA, addressee_id: ME, addressee_email: 'me@t.lk',
    status: 'PENDING', created_at: today, responded_at: null, requester: caraU, addressee: meU },
];


const byId = { [ME]: meU, [BEN]: benU, [CARA]: caraU };
const splitsFlat = expenses.flatMap((e) =>
  (e.expense_splits ?? []).map((s) => ({
    ...s, expense_id: e.id, percentage: 0, shares: 1, users: byId[s.user_id],
    expenses: { id: e.id, title: e.title, category: e.category, created_at: e.created_at,
                created_by: e.created_by, is_deleted: e.is_deleted, is_loan: e.is_loan,
                group_id: e.group_id,
                groups: { name: groups.find((g) => g.id === e.group_id)?.name, is_direct: e.group_id === DIRECT } },
  }))
);

const TABLES = {
  users: [meU, benU, caraU],
  groups,
  group_members: members,
  expenses,
  expense_splits: splitsFlat,
  ledger_entries: ledger,
  group_settlements: settlements,
  friend_requests: friendRequests,
  friend_pins: [{ user_id: ME, friend_id: BEN }],
  group_join_requests: [],
  group_invitations: [],
  recurring_expenses: [],
  expense_items: [],
  expense_edits: [],
  // Who put money in, mirroring the EXPENSE side of the ledger above. e1 is the
  // one two people paid for: 3,000 from me and 1,500 from Ben.
  expense_payers: [
    { expense_id: 'e1', user_id: ME, amount: 3000 },
    { expense_id: 'e1', user_id: BEN, amount: 1500 },
    { expense_id: 'e2', user_id: BEN, amount: 3300 },
    { expense_id: 'e3', user_id: CARA, amount: 2400 },
    { expense_id: 'e5', user_id: ME, amount: 1200 },
    { expense_id: 'e6', user_id: ME, amount: 5000 },
    { expense_id: 'e7', user_id: BEN, amount: 3000 },
  ],
};

const RPC = {
  run_due_recurring: 0,
  claim_pending_invitations: null,
  member_balance: 1600,
  group_is_settled: false,
  deleted_expense_count: 1,
  friend_record_count: 2,
  add_direct_expense: 'new-id',
  update_direct_expense: null,
  group_contribution_stats: [
    { out_user_id: ME, out_display_name: 'Sudaraka Lakshitha', out_avatar_url: null,
      out_paid: 4500, out_share: 3400, out_net: 1100, out_expenses: 1 },
    { out_user_id: BEN, out_display_name: 'Ben Perera', out_avatar_url: null,
      out_paid: 3300, out_share: 3400, out_net: -100, out_expenses: 1 },
    { out_user_id: CARA, out_display_name: 'Cara Silva', out_avatar_url: null,
      out_paid: 2400, out_share: 3400, out_net: -1000, out_expenses: 1 },
  ],
};

const session = {
  access_token: 'stub', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'stub-refresh',
  user: { id: ME, aud: 'authenticated', role: 'authenticated', email: 'me@t.lk',
          app_metadata: {}, user_metadata: { full_name: 'Sudaraka Lakshitha' },
          created_at: today },
};

const errors = [];
const results = [];

const check = (screen, name, ok, detail = '') => {
  results.push({ screen, name, ok, detail });
};

const run = async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },   // iPhone-ish, the real target
    deviceScaleFactor: 2,
    // The PWA's service worker takes over after the first load and its fetches
    // leave the page context, so they miss the stub and hit the network. This
    // test is about what the screens render, not about the worker.
    serviceWorkers: 'block',
  });

  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
      window.sessionStorage.setItem('moneymate.route', 'home');
    },
    ['sb-illvzuwxcvttbsoddptr-auth-token', JSON.stringify(session)]
  );

  const page = await context.newPage();

  page.on('console', (m) => {
    if (process.env.UITEST_DEBUG === '1') console.log(`  [${m.type()}] ${m.text()}`);
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    if (process.env.UITEST_DEBUG === '1') console.log('  xx failed', r.url().slice(0, 90), r.failure()?.errorText);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const LOG = process.env.UITEST_DEBUG === '1';
  await page.route('**/*.supabase.co/**', async (route) => {
    const url = new URL(route.request().url());
    if (LOG) console.log('  →', url.pathname + url.search.slice(0, 160));
    const path = url.pathname;

    if (path.startsWith('/auth/v1/')) {
      if (path.endsWith('/user')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    }

    if (path.startsWith('/rest/v1/rpc/')) {
      const fn = path.split('/').pop();
      const body = fn in RPC ? RPC[fn] : null;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }

    if (path.startsWith('/rest/v1/')) {
      const table = path.replace('/rest/v1/', '').split('?')[0];
      let rows = TABLES[table] ?? [];

      // Enough of PostgREST's filter grammar that each screen gets the rows it
      // actually asked for. Returning everything regardless would let a screen
      // "pass" on data it never requested.
      const parse = (v) => (v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : v);
      const matches = (row, key, expr) => {
        const [op, ...rest] = expr.split('.');
        const arg = rest.join('.');
        // `expenses.is_loan` filters on the embedded resource, which is a real
        // part of the query: skipping it would let a screen pass on rows it
        // explicitly asked the server to leave out.
        const val = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), row);
        switch (op) {
          case 'eq':  return String(val) === arg;
          case 'neq': return String(val) !== arg;
          case 'is':  return parse(arg) === null ? val === null || val === undefined : val === parse(arg);
          case 'in':  return arg.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(val));
          case 'gte': return String(val) >= arg;
          case 'lte': return String(val) <= arg;
          case 'gt':  return String(val) > arg;
          case 'lt':  return String(val) < arg;
          default:    return true;
        }
      };

      for (const [key, value] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        if (key === 'or') {
          const clauses = value.replace(/^\(|\)$/g, '').split(',');
          rows = rows.filter((r) => clauses.some((c) => {
            const [col, ...expr] = c.split('.');
            return matches(r, col, expr.join('.'));
          }));
          continue;
        }
        rows = rows.filter((r) => matches(r, key, value));
      }

      const limit = url.searchParams.get('limit');
      if (limit) rows = rows.slice(0, Number(limit));

      const accept = route.request().headers()['accept'] || '';
      const single = accept.includes('vnd.pgrst.object');
      if (single && rows.length !== 1) {
        return route.fulfill({
          status: rows.length === 0 ? 406 : 406,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'JSON object requested, multiple (or no) rows returned' }),
        });
      }
      if (LOG) console.log('     ←', rows.length, 'rows');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': `0-${rows.length}/${rows.length}` },
        body: JSON.stringify(single ? rows[0] : rows),
      });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // Realtime: let the socket fail quietly rather than retry-storm the log.
  await page.route('**/realtime/**', (route) => route.abort());

  const shot = async (name) => {
    await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
  };

  const visible = async (screen, label, selector) => {
    try {
      await page.waitForSelector(selector, { timeout: 4000, state: 'visible' });
      check(screen, label, true);
    } catch {
      check(screen, label, false, selector);
    }
  };

  const noOverflow = async (screen) => {
    const over = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return document.body.scrollWidth > w + 1 ? { w, scroll: document.body.scrollWidth } : null;
    });
    check(screen, 'no sideways scroll', !over, over ? `body ${over.scroll}px in a ${over.w}px viewport` : '');
  };

  const goTab = async (label) => {
    await page.click(`nav.bottom-nav button:has-text("${label}")`);
    await page.waitForTimeout(900);
  };

  // ---------- Home ----------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await visible('Home', 'greeting', 'text=Welcome back,');
  await visible('Home', 'overall balance card', 'text=Overall balance');
  await visible('Home', 'you are owed / you owe', 'text=You are owed');
  await visible('Home', 'group rail shows the group', 'text=Boarding Expenses');
  await visible('Home', 'recent activity', 'text=Recent activity');
  await visible('Home', 'bottom navigation', 'nav.bottom-nav');
  await noOverflow('Home');
  await shot('01-home');

  // ---------- Groups ----------
  await goTab('Groups');
  await visible('Groups', 'group card', 'text=Boarding Expenses');
  await visible('Groups', 'direct pair group is hidden', 'body');
  const directShown = await page.locator('text=Between you and').count();
  check('Groups', 'pair record not listed as a group', directShown === 0,
        directShown ? `${directShown} pair rows leaked into the list` : '');
  await noOverflow('Groups');
  await shot('02-groups');

  // ---------- Group detail ----------
  await page.click('text=Boarding Expenses');
  await page.waitForTimeout(1200);
  await visible('Group detail', 'title', 'text=Boarding Expenses');
  await visible('Group detail', 'balance hero', 'text=Your balance here');
  await visible('Group detail', 'live expense listed', 'text=Groceries');
  await visible('Group detail', 'settled bill marked', 'text=Settled');
  await visible('Group detail', 'deleted section heading', 'text=/Deleted \\(\\d+\\)/');
  await visible('Group detail', 'erase all button', 'button:has-text("Erase all")');
  const deletedInMain = await page.locator('text=Typo bill').count();
  check('Group detail', 'deleted bill appears exactly once', deletedInMain === 1,
        `found ${deletedInMain}`);

  // The group in the fixture is NOT settled, which is the state the erase
  // controls have to explain rather than vanish in.
  const eraseAll = page.locator('button:has-text("Erase all")');
  check('Group detail', 'erase-all is present even when it cannot be used',
        (await eraseAll.count()) === 1);
  check('Group detail', 'and is disabled rather than hidden',
        await eraseAll.first().isDisabled());
  const rowErase = page.locator('button[aria-label^="Erase "][aria-label$="permanently"]');
  check('Group detail', 'each deleted row keeps its own erase button',
        (await rowErase.count()) === 1, `${await rowErase.count()} found`);
  check('Group detail', 'which says why it is off',
        (await rowErase.first().getAttribute('title')) === 'Settle every balance in this group first',
        (await rowErase.first().getAttribute('title')) || '');
  const reason = await page.locator('text=/can be erased once everyone in this group is settled up/').count();
  check('Group detail', 'and the section explains the condition', reason === 1);

  // Both ways of starting fresh, side by side, and both present-but-disabled
  // while the group is not settled — with the reason on the button itself.
  await page.click('button[aria-label="Manage group"]');
  await page.waitForTimeout(700);
  await visible('Fresh start', 'keep-the-records option', 'text=Start a fresh balance');
  await visible('Fresh start', 'erase option', 'text=Start fresh and erase everything');
  const freshBtn = page.locator('button:has-text("Settle up first")');
  check('Fresh start', 'offered but not usable while money is owed', (await freshBtn.count()) === 1);
  check('Fresh start', 'and disabled rather than hidden', await freshBtn.first().isDisabled());
  await noOverflow('Fresh start');
  await shot('03c-fresh-start');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await noOverflow('Group detail');
  await shot('03-group-detail');

  // ---------- Several people paying for one group bill ----------
  await page.click('button.btn-primary:has-text("Add")');
  await page.waitForTimeout(800);
  await visible('Add expense', 'sheet open', 'text=Split method');
  await visible('Add expense', 'who paid section', 'div[aria-label="Who paid"]');
  await visible('Add expense', 'the way in', 'button:has-text("More than one person paid")');

  await page.fill('input[placeholder="0.00"]', '1500');
  await page.click('button:has-text("More than one person paid")');
  await page.waitForTimeout(400);

  // One amount per member, so "we put in 1,000 and 500" is expressible at all.
  const payerFields = await page.locator('div[aria-label="Who paid"] input[inputmode="decimal"]').count();
  check('Add expense', 'an amount per member appears', payerFields === 3, `${payerFields} fields`);

  // The remainder is the number people watch while typing, so it has to be
  // right before it is reassuring.
  await page.fill('input[aria-label="What I paid"]', '1000');
  await page.waitForTimeout(300);
  const short = await page.locator('div[aria-label="Who paid"] >> text=Left to account for').count();
  check('Add expense', 'says how much is unaccounted for', short === 1);

  await page.fill('input[aria-label="What Ben Perera paid"]', '500');
  await page.waitForTimeout(300);
  const adds = await page
    .locator('div[aria-label="Who paid"] >> text=Adds up to the bill')
    .count();
  check('Add expense', 'and confirms when it adds up', adds === 1);
  await noOverflow('Add expense');
  await shot('03b-many-payers');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ---------- Balances tab + the chart ----------
  await page.click('button:has-text("Balances")');
  await page.waitForTimeout(700);
  await visible('Group balances', 'who paid what entry point', 'text=Who paid what');
  await visible('Group balances', 'who owes whom', 'text=Who owes whom');
  await visible('Group balances', 'members list', 'text=Members');
  await noOverflow('Group balances');
  await shot('04-group-balances');

  await page.click('text=Who paid what');
  await page.waitForTimeout(900);
  await visible('Contribution chart', 'sheet open', 'text=Contributions');
  const donut = await page.locator('svg circle').count();
  check('Contribution chart', 'donut rendered', donut >= 3, `${donut} circles`);
  await visible('Contribution chart', 'each member listed', 'text=Ben Perera');
  await noOverflow('Contribution chart');
  await shot('05-contribution-chart');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ---------- Friends ----------
  await goTab('Friends');
  await visible('Friends', 'friend listed', 'text=Ben Perera');
  await visible('Friends', 'incoming request', 'text=Cara Silva');
  await noOverflow('Friends');
  await shot('06-friends');

  await page.click('text=Ben Perera');
  await page.waitForTimeout(1200);
  await visible('Friend sheet', 'records between you', 'text=/Records between you/');
  await visible('Friend sheet', 'a direct record listed', 'text=Lunch');
  await visible('Friend sheet', 'a group bill listed too', 'text=Groceries');
  await visible('Friend sheet', 'each side’s share shown', 'text=/your share/');
  await visible('Friend sheet', 'add expense or loan', 'text=Add expense or loan');
  await visible('Friend sheet', 'clear deleted records', 'text=Clear deleted records');
  await visible('Friend sheet', 'remove friend', 'text=Remove friend');
  // One settle control, not one per group: the same action used to appear twice.
  const settleButtons = await page
    .locator('button:has-text("Settle"), button:has-text("Record payment"), button:has-text("received")')
    .count();
  check('Friend sheet', 'exactly one settle control', settleButtons === 1, `${settleButtons} found`);
  await noOverflow('Friend sheet');
  await shot('07-friend-sheet');
  await page.click('text=Add expense or loan');
  await page.waitForTimeout(700);
  await visible('Add record', 'sheet open', 'text=/You and Ben/');
  await page.click('div[aria-label="What happened"] button:has-text("Shared")');
  await page.waitForTimeout(400);
  await visible('Add record', 'a shared bill can be categorised', 'text=Category');
  const foodChip = await page.locator('button:has-text("Food")').count();
  check('Add record', 'the category chips are there', foodChip >= 1, `${foodChip} found`);

  // The 1,500 item: 1,000 from me, 500 from them, still split evenly. The
  // record has to end up saying they owe me 250 — naming either of us as the
  // payer would say 750, in opposite directions.
  await page.fill('input[placeholder="0.00"]', '1500');
  await page.click('div[aria-label="Who paid"] button:has-text("Both did")');
  await page.waitForTimeout(400);
  await visible('Add record', 'what you put in', 'text=What you put in');
  await page.fill('#my-payment', '1000');
  await page.fill('#their-share', '750');
  await page.waitForTimeout(400);
  await visible('Add record', 'their contribution is derived', 'text=/put in the rest: Rs. 500/');
  await visible('Add record', 'the resulting balance is spelled out', 'text=/owes you Rs. 250/');
  await noOverflow('Add record');
  await shot('07d-both-paid');

  await page.click('div[aria-label="What happened"] button:has-text("I lent")');
  await page.waitForTimeout(400);
  const catOnLoan = await page.locator('text=Category').count();
  check('Add record', 'lending has no category', catOnLoan === 0, `${catOnLoan} found`);
  const bothOnLoan = await page.locator('button:has-text("Both did")').count();
  check('Add record', 'lending has no second payer', bothOnLoan === 0, `${bothOnLoan} found`);
  await noOverflow('Add record');
  await shot('07c-add-record');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---------- Stats ----------
  await goTab('Stats');
  await visible('Stats', 'range switch', 'text=/30 days|Last 30/');
  await visible('Stats', 'headline is your share of shared spending', 'text=/Your share/');

  // The headline figure is the arithmetic, on the page: my share of every bill
  // I am on, with the loan left out. If a loan ever leaked in it would read
  // 9,000 instead, so the number is worth asserting rather than the label.
  const headlineText = await page.locator('.amount-xl').first().innerText();
  const headline = (headlineText.match(/([\d,]+)\.\d{2}/)?.[1] ?? '').replace(/,/g, '');
  check(
    'Stats',
    'the headline counts shares and not loans',
    headline === String(MY_SHARE),
    `reads ${headline}, want ${MY_SHARE}`
  );

  // What you put in is a different number from what was yours to pay, and the
  // gap between them is the money you are waiting on.
  await visible('Stats', 'what you fronted', 'text=You fronted');
  await visible('Stats', 'average spending day', 'text=/Avg. spending day/');
  await visible('Stats', 'category breakdown', 'text=Where it goes');
  await visible('Stats', 'who you split with', 'text=Who you spend with');
  await visible('Stats', 'which group', 'text=Which group');
  await visible('Stats', 'the people are named', 'text=Ben Perera');

  // Nothing is ever asked any more, so no approval queue may appear here.
  const asked = await page
    .locator('text=/count this|Include in stats|waiting for you|Approve all/i')
    .count();
  check('Stats', 'nothing is queued for approval', asked === 0, `${asked} prompts found`);
  await noOverflow('Stats');
  await shot('10-stats');

  // The wider range keeps every section rather than emptying the screen.
  await page.click('button:has-text("Last 90 days")');
  await page.waitForTimeout(500);
  await visible('Stats 90d', 'still charted over 90 days', 'text=/Your share · last 90 days/');
  await noOverflow('Stats 90d');
  await shot('10b-stats-90');

  // ---------- Settings ----------
  await goTab('You');
  await visible('Settings', 'profile name', 'text=Sudaraka Lakshitha');
  await visible('Settings', 'app / install section', 'text=/Install MoneyMate|Installed/');
  await visible('Settings', 'appearance', 'text=Appearance');
  await visible('Settings', 'security', 'text=Change password');
  await visible('Settings', 'about', 'text=About this app');
  await visible('Settings', 'version row', 'text=Version');
  await visible('Settings', 'delete account', 'text=Delete account');
  const dev = await page.locator('text=/Supabase|Row Level Security/').count();
  check('Settings', 'no developer rows left', dev === 0, dev ? `${dev} found` : '');
  await noOverflow('Settings');
  await shot('11-settings');

  // ---------- Light theme, same screens ----------
  await page.click('button:has-text("Light")');
  await page.waitForTimeout(600);
  await shot('12-settings-light');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('Settings', 'light theme repaints the page', bg !== 'rgba(0, 0, 0, 0)', bg);

  await browser.close();

  // ---------- report ----------
  const byScreen = new Map();
  for (const r of results) {
    if (!byScreen.has(r.screen)) byScreen.set(r.screen, []);
    byScreen.get(r.screen).push(r);
  }
  let failed = 0;
  for (const [screen, rows] of byScreen) {
    const bad = rows.filter((r) => !r.ok);
    failed += bad.length;
    console.log(`\n${screen}  ${rows.length - bad.length}/${rows.length}`);
    for (const r of rows) {
      console.log(`   ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  const real = errors.filter((e) => !/realtime|websocket|Failed to load resource|ERR_/i.test(e));
  console.log(`\nconsole errors: ${real.length}`);
  for (const e of real.slice(0, 12)) console.log('   ' + e);

  process.exit(failed > 0 || real.length > 0 ? 1 : 0);
};

run().catch((e) => {
  console.error('harness failed:', e);
  process.exit(2);
});
