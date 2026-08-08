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

Both are the kind of fault that produces a plausible-looking wrong number rather
than an error, so they are asserted explicitly rather than assumed.
