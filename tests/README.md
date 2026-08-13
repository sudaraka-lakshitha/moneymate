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
- **Contributions and shares each reconstruct the bill.** Since several people
  can pay for one expense, "who put money in" and "who owes what" are separate
  sets of rows. Both must sum to the total — that is what keeps every group
  netting to zero, and it is why the money core needed no changes to support it.
- **A change nobody agreed to moves nothing.** Past ten minutes an edit or a
  delete is a proposal. `test30.sql` checks the balance and the record after
  every step of one, because "waiting for approval" is only worth anything if
  the figures genuinely hold still while it waits.
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
| `test32.sql` | The shape of the database rather than any one behaviour: every table has RLS, every protected table has a policy (bar `schema_migrations`, which denies everyone on purpose), every `SECURITY DEFINER` function pins `search_path`, and the two ungated apply bodies are not callable by a client. Faults of omission, which arrive when a table is added and no feature test would notice |
| `test31.sql` | Starting a group with its people already in it: friends are seated as members straight away with nothing to accept, the creator stays admin, a stranger cannot be seated, one stranger in the list refuses the whole thing rather than half-making a group — and nothing removes anybody, because settling up and unfriending are not the app's decision to act on |
| `test30.sql` | Changing a record after the fact: inside ten minutes it just applies; outside it, the balance and the record hold absolutely still while the request waits; a majority approves, one refusal past the point of no return rejects; the requester cannot vote themselves through and an outsider cannot vote at all; a settlement landing mid-request drops the change rather than reopening a paid-up balance; and the ungated bodies are not reachable from a client, which is what everything else rests on |
| `test29.sql` | Starting a fresh balance, both ways: both refused while anything is outstanding and to a plain member; keeping history empties the current view without destroying a record; the closed cycle nets to zero per person, which is why `member_balance` stays whole-ledger and unfiltered; new bills join the new cycle; erasing leaves the group and its members standing |
| `test28.sql` | Several people paying for one bill: the 1,500 item with 1,000 and 500 in it produces a 250 balance rather than 750; contributions that do not add up, a stranger paying, and a zero contribution are all refused; the chart attributes to both payers instead of handing the bill to one; edits and deletes move every contribution; and a one-payer bill still behaves exactly as it did |
