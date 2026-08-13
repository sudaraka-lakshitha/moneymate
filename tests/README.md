# MoneyMate test suite

Plain SQL, run against a real PostgreSQL 16 instance rather than a mock, because
almost everything worth testing here lives in the database: row-level security,
the SECURITY DEFINER functions, and the ledger invariant that every group must
net to zero.

## Running

Each file is self-contained apart from `prelude.sql`, which stands in for
Supabase's `auth` schema and `authenticated` role.

```bash
createdb mm
psql -d mm -f prelude.sql
psql -d mm -f ../supabase_schema.sql
psql -d mm -v ON_ERROR_STOP=1 -f e2e_groups.sql
```

Use a **fresh database per file**. Several files seed overlapping user ids, and
a leftover row from a previous run shows up as a confusing duplicate-key failure
rather than a real one.

## End-to-end journeys

These follow a whole user story rather than one function, so a change that
breaks the seam between two features fails here even when every unit test still
passes.

| File | Covers |
| --- | --- |
| `e2e_groups.sql` | Create a trip, join by code with approval, invite by email, keep outsiders out, split evenly and unevenly, exclude a member, edit twice, part-settle, archive, purge, delete |
| `e2e_friends.sql` | Friend request and acceptance, lend, borrow, split directly, edit twice including flipping the payer, delete, part-pay, lender records the repayment — no group involved anywhere |
| `e2e_pair.sql` | The whole story between two people in the order it happens — strangers, friend request, lend, borrow, share a bill, pay a bill that was entirely theirs, have one of yours paid, part-settle, a real group on top, unfriend, leave, re-add. Every stage checks all three of money, statistics and visibility, because they can disagree and only the first is obvious |

## What the assertions are really guarding

Two invariants matter more than any individual figure:

- **The ledger nets to zero.** Checked after every mutation. A group whose
  entries do not sum to zero has invented or destroyed money, and because
  "settled" means a zero balance, such a group can never be settled, archived,
  purged or deleted again.
- **Repeated edits do not move money.** `test14.sql` edits one expense fifteen
  times and deletes it. This exists because reversing an expense by re-negating
  its rows was correct exactly once and silently wrong from the second edit on.
- **Nothing moves money, under any sequence.** `test24.sql` throws random
  operations at a four-person group and re-checks both invariants after every
  one, so a fault that needs an unlikely order to show up still names the step
  that caused it. Change the seed to get a different run.

These are the kind of fault that produces a plausible-looking wrong number rather
than an error, so they are asserted explicitly rather than assumed.

## The screens

`uitest.mjs` runs the production bundle in a real browser at phone size with
Supabase stubbed by a PostgREST-shaped fixture, so every screen renders from
data the app actually asked for. It checks that each screen is there, that the
figures are on it, that nothing threw, and that the layout stays inside the
phone — including the states where a control is disabled rather than absent.

```bash
npm run build
npx vite preview --port 4173 --host 127.0.0.1 &
node tests/uitest.mjs        # needs playwright-core; Chromium at /opt/pw-browsers
```

Service workers are blocked in the harness: the PWA's worker takes over after
the first load and its fetches leave the page context, so they would miss the
stub and hit the network.

## Do the screens and the schema agree?

The browser harness answers a stub, and a stub answers whatever it is asked, so
it cannot notice a screen requesting a column the database no longer has.
TypeScript cannot either — table names, column names, function names and
argument names are strings resolved by PostgREST at request time. A dropped
column therefore compiles, passes the harness, and fails only when a real user
opens the screen.

```bash
node tests/aligncheck.mjs
```

It loads `../supabase_schema.sql` into a scratch database, asks Postgres what
exists, and holds every `.from`, `.select`, `.eq`, `.order`, `.rpc` and
`useLiveRefresh` call in `src/` up against the answer — including embed hints
that need a named constraint, RPCs granted to `authenticated`, and realtime
subscriptions whose table must be in the publication. Run it after any schema
change; it is the only check that catches this class.

## Regression files

| File | Guards against |
| --- | --- |
| `test17.sql` | A group bill counting for everyone on it with nothing asked, the contribution figures behind the "who paid" chart, and removing a friend |
| `test18.sql` | Inviting a friend straight into a group, deleting an account |
| `test19.sql` | A member leaving or deleting their account while the group keeps going: the ledger still nets to zero, and the contribution chart still accounts for every rupee they spent |
| `test20.sql` | What an edit does to the figures — both people move together, dropping somebody un-charges them, turning a record into a loan takes it back out — plus the door that stops a debt being posted against a stranger |
| `test21.sql` | Removing a friend for good (the pair record must not outlive the friendship and drag them back onto the list), and clearing already-deleted records without moving a rupee |
| `test22_setup.sql` + `test22_check.sql` | Run the setup, re-run `../supabase_schema.sql` over it, then run the check: the deploy step must not rewrite anybody's records. The migration at risk guesses from shape whether an old pair record was a loan, and "I paid your phone bill" has a loan's exact shape without being one |
| `test23.sql` | Who can see and do what on the newer functions — an outsider gets no contribution figures, no record counts and no splits; a plain member can read the other side's share, which is what the Friends screen lists |
| `test24.sql` | Fuzz: 250 random add / edit / delete / settle operations by four people, with both invariants re-checked after every single one |
| `test25.sql` | What realtime needs from the database: the tables published, and `REPLICA IDENTITY FULL` so an update or delete carries enough of the row for RLS to authorise sending it. Needs a `supabase_realtime` publication to exist — create an empty one locally, as Supabase provisions it |
| `test26.sql` | What counts as your spending now that nothing is ever asked: every share you are on counts the moment it is saved, in a group or between two people; lending counts for nobody in either direction; a bill paid entirely for somebody else counts for them and not the payer; and the opt-in column is gone from the schema |
| `test27.sql` | The Friends screen — a record between two people keeps the category it was given and refuses an invented one, a loan stays uncategorised, and the list predicate keeps anyone owed money while dropping an ex-friend you only share a settled group with |
