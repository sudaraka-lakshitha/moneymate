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
| `e2e_own.sql` | Personal entries, edit and soft delete, input validation, budgets and their upsert, recurring posting exactly once, analytics inputs, and one user being unable to see or touch another's data |

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

## Regression files

| File | Guards against |
| --- | --- |
| `test17.sql` | Personal-only statistics, per-split opt-in, removing a friend |
| `test18.sql` | Inviting a friend straight into a group, deleting an account |
| `test19.sql` | A member leaving or deleting their account while the group keeps going: the ledger still nets to zero, and the contribution chart still accounts for every rupee they spent |
| `test20.sql` | Whose statistics decision is whose — your own entries are answered as you make them, and somebody else editing a bill never resets your answer |
| `test21.sql` | Removing a friend for good (the pair record must not outlive the friendship and drag them back onto the list), and clearing already-deleted records without moving a rupee |
| `test22_setup.sql` + `test22_check.sql` | Run the setup, re-run `../supabase_schema.sql` over it, then run the check: a deliberate stats opt-out must survive the deploy step |
| `test23.sql` | Who can see and do what on the newer functions — an outsider gets no contribution figures, no record counts and no splits; a plain member can read the other side's share, which is what the Friends screen lists |
| `test24.sql` | Fuzz: 250 random add / edit / delete / settle operations by four people, with both invariants re-checked after every single one |
| `test26.sql` | Lending is never a question: neither side is asked, nothing is left undecided and no loan counts as spending — in both directions and whichever way the empty side was written — while a genuinely shared bill still asks |
| `test25.sql` | What realtime needs from the database: the tables published, and `REPLICA IDENTITY FULL` so an update or delete carries enough of the row for RLS to authorise sending it. Needs a `supabase_realtime` publication to exist — create an empty one locally, as Supabase provisions it |
