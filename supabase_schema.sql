-- ========================================
-- MoneyMate Supabase Schema (IDEMPOTENT / RE-RUNNABLE)
-- Run this in Supabase SQL Editor
-- Strategy: CREATE all tables first, DROP existing policies, THEN add RLS policies
-- ========================================

-- ---- USERS ----
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- GROUPS ----
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    icon_emoji TEXT DEFAULT '💰',
    invite_code TEXT NOT NULL UNIQUE,
    invite_code_expires_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SETTLING', 'SETTLED')),
    current_cycle_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- GROUP MEMBERS ----
CREATE TABLE IF NOT EXISTS group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'MEMBER' CHECK (role IN ('ADMIN', 'MEMBER')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    default_split_share INT DEFAULT 1,
    UNIQUE (group_id, user_id)
);

-- ---- GROUP JOIN REQUESTS ----
CREATE TABLE IF NOT EXISTS group_join_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES users(id)
);

-- ---- SETTLEMENT CYCLES ----
CREATE TABLE IF NOT EXISTS settlement_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    status TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SETTLING', 'SETTLED')),
    initiated_by UUID REFERENCES users(id),
    archive_snapshot JSONB
);

-- ---- EXPENSES ----
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    cycle_id UUID REFERENCES settlement_cycles(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    amount DECIMAL(14, 2) NOT NULL CHECK (amount > 0),
    paid_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    on_behalf_of UUID REFERENCES users(id) ON DELETE SET NULL,
    category TEXT DEFAULT 'OTHER',
    receipt_url TEXT,
    split_method TEXT DEFAULT 'EQUAL',
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_rule TEXT,
    notes TEXT DEFAULT '',
    settlement_id UUID,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    delete_reason TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- EXPENSE SPLITS ----
CREATE TABLE IF NOT EXISTS expense_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_included BOOLEAN DEFAULT TRUE,
    amount DECIMAL(14, 2) DEFAULT 0.00,
    percentage DECIMAL(7, 4) DEFAULT 0.00,
    shares INT DEFAULT 1,
    is_settled BOOLEAN DEFAULT FALSE,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ
);

-- ---- LEDGER ENTRIES (append-only, NEVER update/delete) ----
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    cycle_id UUID REFERENCES settlement_cycles(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL,
    amount DECIMAL(14, 2) NOT NULL,
    reference_id UUID,
    description TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- BALANCE SNAPSHOTS ----
CREATE TABLE IF NOT EXISTS balance_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    balance DECIMAL(14, 2) DEFAULT 0.00,
    total_paid DECIMAL(14, 2) DEFAULT 0.00,
    total_owed DECIMAL(14, 2) DEFAULT 0.00,
    cycle_id UUID REFERENCES settlement_cycles(id) ON DELETE SET NULL,
    snapshot_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (group_id, user_id, cycle_id)
);

-- ---- GROUP SETTLEMENTS ----
CREATE TABLE IF NOT EXISTS group_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    cycle_id UUID NOT NULL REFERENCES settlement_cycles(id) ON DELETE CASCADE,
    from_user UUID NOT NULL REFERENCES users(id),
    to_user UUID NOT NULL REFERENCES users(id),
    amount DECIMAL(14, 2) NOT NULL CHECK (amount > 0),
    confirmed_at TIMESTAMPTZ,
    payment_method TEXT DEFAULT 'CASH',
    note TEXT DEFAULT '',
    is_confirmed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- EXPENSE EDITS (audit trail) ----
CREATE TABLE IF NOT EXISTS expense_edits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    edited_by UUID REFERENCES users(id) ON DELETE SET NULL,
    edited_at TIMESTAMPTZ DEFAULT NOW(),
    old_snapshot JSONB NOT NULL,
    new_snapshot JSONB NOT NULL,
    change_summary TEXT NOT NULL
);

-- ---- DAILY EXPENSES (personal tracker) ----
CREATE TABLE IF NOT EXISTS daily_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    amount DECIMAL(14, 2) NOT NULL CHECK (amount > 0),
    category TEXT DEFAULT 'OTHER',
    date DATE NOT NULL,
    note TEXT DEFAULT '',
    receipt_url TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---- BUDGETS ----
CREATE TABLE IF NOT EXISTS budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_limit DECIMAL(14, 2) NOT NULL CHECK (monthly_limit > 0),
    month TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, category, month)
);

-- ========================================
-- INDEXES (performance)
-- ========================================
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_group ON group_join_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_status ON group_join_requests(status);
CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_deleted ON expenses(is_deleted);
CREATE INDEX IF NOT EXISTS idx_splits_expense ON expense_splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_ledger_group ON ledger_entries(group_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(reference_id);
CREATE INDEX IF NOT EXISTS idx_daily_user_date ON daily_expenses(user_id, date);
CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id, month);

-- ========================================
-- VIEWS
-- ========================================

CREATE OR REPLACE VIEW group_balances AS
SELECT
    group_id,
    user_id,
    COALESCE(SUM(amount), 0)                                            AS net_balance,
    COALESCE(SUM(CASE WHEN amount > 0 THEN amount  ELSE 0 END), 0)     AS total_paid,
    COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS total_owed
FROM ledger_entries
GROUP BY group_id, user_id;

-- ========================================
-- ROW LEVEL SECURITY — enable AFTER all tables exist
-- ========================================

ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups               ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_join_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_splits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_cycles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_settlements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_edits        ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_expenses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets              ENABLE ROW LEVEL SECURITY;

-- ---- users ----
DROP POLICY IF EXISTS "Users can read own profile" ON users;
DROP POLICY IF EXISTS "Users can read their own data" ON users;
DROP POLICY IF EXISTS "Users can update own profile" ON users;
DROP POLICY IF EXISTS "Users can update their own data" ON users;
DROP POLICY IF EXISTS "Users can insert own profile" ON users;
DROP POLICY IF EXISTS "Users can insert their own data" ON users;

CREATE POLICY "Users can read own profile"    ON users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile"  ON users FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile"  ON users FOR INSERT WITH CHECK (auth.uid() = id);

-- ---- groups ----
DROP POLICY IF EXISTS "Members can read their groups" ON groups;
DROP POLICY IF EXISTS "Creator can update group" ON groups;
DROP POLICY IF EXISTS "Authenticated users can create groups" ON groups;

CREATE POLICY "Members can read their groups" ON groups FOR SELECT
    USING (id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Creator can update group"      ON groups FOR UPDATE
    USING (created_by = auth.uid());
CREATE POLICY "Authenticated users can create groups" ON groups FOR INSERT
    WITH CHECK (created_by = auth.uid());

-- ---- group_members ----
DROP POLICY IF EXISTS "Members can read group membership" ON group_members;
DROP POLICY IF EXISTS "Admins can manage members" ON group_members;
DROP POLICY IF EXISTS "User can insert own membership" ON group_members;
DROP POLICY IF EXISTS "Users can join groups" ON group_members;

CREATE POLICY "Members can read group membership" ON group_members FOR SELECT
    USING (group_id IN (SELECT group_id FROM group_members gm2 WHERE gm2.user_id = auth.uid()));
CREATE POLICY "Admins can manage members"         ON group_members FOR ALL
    USING (group_id IN (SELECT group_id FROM group_members gm2 WHERE gm2.user_id = auth.uid() AND gm2.role = 'ADMIN'));
CREATE POLICY "User can insert own membership"    ON group_members FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- ---- group_join_requests ----
DROP POLICY IF EXISTS "Requester or admin sees requests" ON group_join_requests;
DROP POLICY IF EXISTS "Requester or admin can see requests" ON group_join_requests;
DROP POLICY IF EXISTS "Users can create own requests" ON group_join_requests;
DROP POLICY IF EXISTS "Users can create their own requests" ON group_join_requests;
DROP POLICY IF EXISTS "Admins can update requests" ON group_join_requests;

CREATE POLICY "Requester or admin sees requests"  ON group_join_requests FOR SELECT
    USING (
        user_id = auth.uid()
        OR group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'ADMIN')
    );
CREATE POLICY "Users can create own requests"     ON group_join_requests FOR INSERT
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins can update requests"        ON group_join_requests FOR UPDATE
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'ADMIN'));

-- ---- expenses ----
DROP POLICY IF EXISTS "Group members can read expenses" ON expenses;
DROP POLICY IF EXISTS "Group members can insert expenses" ON expenses;
DROP POLICY IF EXISTS "Creator or admin can update expense" ON expenses;
DROP POLICY IF EXISTS "Creator can soft-delete expense" ON expenses;

CREATE POLICY "Group members can read expenses"   ON expenses FOR SELECT
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Group members can insert expenses" ON expenses FOR INSERT
    WITH CHECK (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Creator or admin can update expense" ON expenses FOR UPDATE
    USING (
        created_by = auth.uid()
        OR group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'ADMIN')
    );

-- ---- expense_splits ----
DROP POLICY IF EXISTS "Members can read splits" ON expense_splits;
DROP POLICY IF EXISTS "Members can insert splits" ON expense_splits;

CREATE POLICY "Members can read splits" ON expense_splits FOR SELECT
    USING (expense_id IN (
        SELECT e.id FROM expenses e
        INNER JOIN group_members gm ON e.group_id = gm.group_id
        WHERE gm.user_id = auth.uid()
    ));
CREATE POLICY "Members can insert splits" ON expense_splits FOR INSERT
    WITH CHECK (expense_id IN (
        SELECT e.id FROM expenses e
        INNER JOIN group_members gm ON e.group_id = gm.group_id
        WHERE gm.user_id = auth.uid()
    ));

-- ---- ledger_entries ----
DROP POLICY IF EXISTS "Members can read ledger" ON ledger_entries;
DROP POLICY IF EXISTS "Members can insert ledger entries" ON ledger_entries;

CREATE POLICY "Members can read ledger"          ON ledger_entries FOR SELECT
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Members can insert ledger entries" ON ledger_entries FOR INSERT
    WITH CHECK (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));

-- ---- balance_snapshots ----
DROP POLICY IF EXISTS "Members can read snapshots" ON balance_snapshots;
DROP POLICY IF EXISTS "Members can upsert snapshots" ON balance_snapshots;

CREATE POLICY "Members can read snapshots" ON balance_snapshots FOR SELECT
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Members can upsert snapshots" ON balance_snapshots FOR ALL
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));

-- ---- settlement_cycles ----
DROP POLICY IF EXISTS "Members can read cycles" ON settlement_cycles;
DROP POLICY IF EXISTS "Admins can manage cycles" ON settlement_cycles;

CREATE POLICY "Members can read cycles" ON settlement_cycles FOR SELECT
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Admins can manage cycles" ON settlement_cycles FOR ALL
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'ADMIN'));

-- ---- group_settlements ----
DROP POLICY IF EXISTS "Members can read settlements" ON group_settlements;
DROP POLICY IF EXISTS "Members can insert settlements" ON group_settlements;
DROP POLICY IF EXISTS "Participants can update settlements" ON group_settlements;

CREATE POLICY "Members can read settlements" ON group_settlements FOR SELECT
    USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Members can insert settlements" ON group_settlements FOR INSERT
    WITH CHECK (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid()));
CREATE POLICY "Participants can update settlements" ON group_settlements FOR UPDATE
    USING (from_user = auth.uid() OR to_user = auth.uid());

-- ---- expense_edits ----
DROP POLICY IF EXISTS "Members can read edits" ON expense_edits;
DROP POLICY IF EXISTS "Members can insert edits" ON expense_edits;

CREATE POLICY "Members can read edits" ON expense_edits FOR SELECT
    USING (expense_id IN (
        SELECT e.id FROM expenses e
        INNER JOIN group_members gm ON e.group_id = gm.group_id
        WHERE gm.user_id = auth.uid()
    ));
CREATE POLICY "Members can insert edits" ON expense_edits FOR INSERT
    WITH CHECK (expense_id IN (
        SELECT e.id FROM expenses e
        INNER JOIN group_members gm ON e.group_id = gm.group_id
        WHERE gm.user_id = auth.uid()
    ));

-- ---- daily_expenses ----
DROP POLICY IF EXISTS "Users manage own daily expenses" ON daily_expenses;
DROP POLICY IF EXISTS "Users can manage their own daily expenses" ON daily_expenses;

CREATE POLICY "Users manage own daily expenses" ON daily_expenses FOR ALL
    USING (user_id = auth.uid());

-- ---- budgets ----
DROP POLICY IF EXISTS "Users manage own budgets" ON budgets;
DROP POLICY IF EXISTS "Users can manage their own budgets" ON budgets;

CREATE POLICY "Users manage own budgets" ON budgets FOR ALL
    USING (user_id = auth.uid());

-- ========================================
-- AUTO-CREATE USER ON GOOGLE SIGN-IN
-- ========================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, display_name, email, avatar_url)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NEW.email,
        NEW.raw_user_meta_data->>'avatar_url'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE handle_new_user();
