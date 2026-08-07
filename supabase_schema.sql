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

-- ---- EXPENSE ITEMS (line items behind an ITEMIZED split) ----
CREATE TABLE IF NOT EXISTS expense_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount DECIMAL(14, 2) NOT NULL CHECK (amount >= 0),
    -- Members sharing this line. Empty means "everyone included in the bill".
    shared_by UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
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
CREATE INDEX IF NOT EXISTS idx_items_expense ON expense_items(expense_id);
CREATE INDEX IF NOT EXISTS idx_settlements_group ON group_settlements(group_id);
CREATE INDEX IF NOT EXISTS idx_ledger_group ON ledger_entries(group_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(reference_id);
CREATE INDEX IF NOT EXISTS idx_daily_user_date ON daily_expenses(user_id, date);
CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id, month);
-- ========================================
-- SECURITY DEFINER HELPERS
-- ========================================
-- A policy ON group_members that itself queries group_members makes Postgres
-- re-evaluate the same policy while evaluating it — "infinite recursion detected
-- in policy for relation group_members". These helpers run as SECURITY DEFINER,
-- so their internal reads bypass RLS and the recursion never starts. Every
-- membership check below goes through them.

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_group_admin(p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND user_id = auth.uid() AND role = 'ADMIN'
    );
$$;

-- Whose profile may I read? Mine, anyone I share a group with, and anyone with a
-- pending request into a group I administer (otherwise the approval list shows
-- blank names).
CREATE OR REPLACE FUNCTION public.can_view_profile(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT
        p_user_id = auth.uid()
        OR EXISTS (
            SELECT 1
            FROM group_members mine
            JOIN group_members theirs ON theirs.group_id = mine.group_id
            WHERE mine.user_id = auth.uid() AND theirs.user_id = p_user_id
        )
        OR EXISTS (
            SELECT 1
            FROM group_join_requests r
            JOIN group_members admin ON admin.group_id = r.group_id
            WHERE r.user_id = p_user_id
              AND r.status = 'PENDING'
              AND admin.user_id = auth.uid()
              AND admin.role = 'ADMIN'
        );
$$;

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
ALTER TABLE expense_items        ENABLE ROW LEVEL SECURITY;
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
DROP POLICY IF EXISTS "Users can read visible profiles" ON users;
DROP POLICY IF EXISTS "Users can update own profile" ON users;
DROP POLICY IF EXISTS "Users can update their own data" ON users;
DROP POLICY IF EXISTS "Users can insert own profile" ON users;
DROP POLICY IF EXISTS "Users can insert their own data" ON users;

-- Own-row-only reads made every co-member join return NULL, so member lists,
-- friend balances and "paid by" labels all rendered blank.
CREATE POLICY "Users can read visible profiles" ON users FOR SELECT
    USING (public.can_view_profile(id));
CREATE POLICY "Users can update own profile"  ON users FOR UPDATE
    USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can insert own profile"  ON users FOR INSERT
    WITH CHECK (auth.uid() = id);

-- ---- groups ----
DROP POLICY IF EXISTS "Members can read their groups" ON groups;
DROP POLICY IF EXISTS "Creator can update group" ON groups;
DROP POLICY IF EXISTS "Admins can update group" ON groups;
DROP POLICY IF EXISTS "Authenticated users can create groups" ON groups;

CREATE POLICY "Members can read their groups" ON groups FOR SELECT
    USING (public.is_group_member(id));
CREATE POLICY "Admins can update group"      ON groups FOR UPDATE
    USING (created_by = auth.uid() OR public.is_group_admin(id));
CREATE POLICY "Authenticated users can create groups" ON groups FOR INSERT
    WITH CHECK (created_by = auth.uid());

-- ---- group_members ----
DROP POLICY IF EXISTS "Members can read group membership" ON group_members;
DROP POLICY IF EXISTS "Admins can manage members" ON group_members;
DROP POLICY IF EXISTS "Admins can add members" ON group_members;
DROP POLICY IF EXISTS "Admins can remove members" ON group_members;
DROP POLICY IF EXISTS "User can insert own membership" ON group_members;
DROP POLICY IF EXISTS "Users can join groups" ON group_members;
DROP POLICY IF EXISTS "Members can leave groups" ON group_members;

CREATE POLICY "Members can read group membership" ON group_members FOR SELECT
    USING (public.is_group_member(group_id));
CREATE POLICY "User can insert own membership"    ON group_members FOR INSERT
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins can add members"            ON group_members FOR INSERT
    WITH CHECK (public.is_group_admin(group_id));
CREATE POLICY "Admins can remove members"         ON group_members FOR DELETE
    USING (public.is_group_admin(group_id));
CREATE POLICY "Members can leave groups"          ON group_members FOR DELETE
    USING (user_id = auth.uid());

-- ---- group_join_requests ----
DROP POLICY IF EXISTS "Requester or admin sees requests" ON group_join_requests;
DROP POLICY IF EXISTS "Requester or admin can see requests" ON group_join_requests;
DROP POLICY IF EXISTS "Users can create own requests" ON group_join_requests;
DROP POLICY IF EXISTS "Users can create their own requests" ON group_join_requests;
DROP POLICY IF EXISTS "Admins can update requests" ON group_join_requests;

CREATE POLICY "Requester or admin sees requests"  ON group_join_requests FOR SELECT
    USING (user_id = auth.uid() OR public.is_group_admin(group_id));
CREATE POLICY "Users can create own requests"     ON group_join_requests FOR INSERT
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins can update requests"        ON group_join_requests FOR UPDATE
    USING (public.is_group_admin(group_id));

-- ---- expenses ----
DROP POLICY IF EXISTS "Group members can read expenses" ON expenses;
DROP POLICY IF EXISTS "Group members can insert expenses" ON expenses;
DROP POLICY IF EXISTS "Creator or admin can update expense" ON expenses;
DROP POLICY IF EXISTS "Creator can soft-delete expense" ON expenses;

CREATE POLICY "Group members can read expenses"   ON expenses FOR SELECT
    USING (public.is_group_member(group_id));
CREATE POLICY "Group members can insert expenses" ON expenses FOR INSERT
    WITH CHECK (public.is_group_member(group_id));
CREATE POLICY "Creator or admin can update expense" ON expenses FOR UPDATE
    USING (created_by = auth.uid() OR public.is_group_admin(group_id));

-- ---- expense_splits ----
DROP POLICY IF EXISTS "Members can read splits" ON expense_splits;
DROP POLICY IF EXISTS "Members can insert splits" ON expense_splits;
DROP POLICY IF EXISTS "Members can delete splits" ON expense_splits;

CREATE POLICY "Members can read splits" ON expense_splits FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND public.is_group_member(e.group_id)
    ));
CREATE POLICY "Members can insert splits" ON expense_splits FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND public.is_group_member(e.group_id)
    ));
-- Needed so a failed expense save can clean up after itself.
CREATE POLICY "Members can delete splits" ON expense_splits FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND e.created_by = auth.uid()
    ));

-- ---- expense_items ----
DROP POLICY IF EXISTS "Members can read items" ON expense_items;
DROP POLICY IF EXISTS "Members can insert items" ON expense_items;
DROP POLICY IF EXISTS "Members can delete items" ON expense_items;

CREATE POLICY "Members can read items" ON expense_items FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND public.is_group_member(e.group_id)
    ));
CREATE POLICY "Members can insert items" ON expense_items FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND public.is_group_member(e.group_id)
    ));
CREATE POLICY "Members can delete items" ON expense_items FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND e.created_by = auth.uid()
    ));

-- ---- ledger_entries ----
DROP POLICY IF EXISTS "Members can read ledger" ON ledger_entries;
DROP POLICY IF EXISTS "Members can insert ledger entries" ON ledger_entries;

CREATE POLICY "Members can read ledger"          ON ledger_entries FOR SELECT
    USING (public.is_group_member(group_id));
CREATE POLICY "Members can insert ledger entries" ON ledger_entries FOR INSERT
    WITH CHECK (public.is_group_member(group_id));

-- ---- balance_snapshots ----
DROP POLICY IF EXISTS "Members can read snapshots" ON balance_snapshots;
DROP POLICY IF EXISTS "Members can upsert snapshots" ON balance_snapshots;

CREATE POLICY "Members can read snapshots" ON balance_snapshots FOR SELECT
    USING (public.is_group_member(group_id));
CREATE POLICY "Members can upsert snapshots" ON balance_snapshots FOR ALL
    USING (public.is_group_member(group_id))
    WITH CHECK (public.is_group_member(group_id));

-- ---- settlement_cycles ----
DROP POLICY IF EXISTS "Members can read cycles" ON settlement_cycles;
DROP POLICY IF EXISTS "Admins can manage cycles" ON settlement_cycles;

CREATE POLICY "Members can read cycles" ON settlement_cycles FOR SELECT
    USING (public.is_group_member(group_id));
CREATE POLICY "Admins can manage cycles" ON settlement_cycles FOR ALL
    USING (public.is_group_admin(group_id))
    WITH CHECK (public.is_group_admin(group_id));

-- ---- group_settlements ----
DROP POLICY IF EXISTS "Members can read settlements" ON group_settlements;
DROP POLICY IF EXISTS "Members can insert settlements" ON group_settlements;
DROP POLICY IF EXISTS "Participants can update settlements" ON group_settlements;

CREATE POLICY "Members can read settlements" ON group_settlements FOR SELECT
    USING (public.is_group_member(group_id));
CREATE POLICY "Members can insert settlements" ON group_settlements FOR INSERT
    WITH CHECK (public.is_group_member(group_id));
CREATE POLICY "Participants can update settlements" ON group_settlements FOR UPDATE
    USING (from_user = auth.uid() OR to_user = auth.uid());

-- ---- expense_edits ----
DROP POLICY IF EXISTS "Members can read edits" ON expense_edits;
DROP POLICY IF EXISTS "Members can insert edits" ON expense_edits;

CREATE POLICY "Members can read edits" ON expense_edits FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND public.is_group_member(e.group_id)
    ));
CREATE POLICY "Members can insert edits" ON expense_edits FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM expenses e
        WHERE e.id = expense_id AND public.is_group_member(e.group_id)
    ));

-- ---- daily_expenses ----
DROP POLICY IF EXISTS "Users manage own daily expenses" ON daily_expenses;
DROP POLICY IF EXISTS "Users can manage their own daily expenses" ON daily_expenses;

CREATE POLICY "Users manage own daily expenses" ON daily_expenses FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ---- budgets ----
DROP POLICY IF EXISTS "Users manage own budgets" ON budgets;
DROP POLICY IF EXISTS "Users can manage their own budgets" ON budgets;

CREATE POLICY "Users manage own budgets" ON budgets FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ========================================
-- RPCs
-- ========================================
-- Joining by invite code cannot work through a plain SELECT: the groups policy
-- only exposes groups you are already in, so the lookup always came back empty
-- and the UI reported "Invalid or expired invite code" for valid codes. These
-- SECURITY DEFINER functions do the lookup server-side and return only
-- non-sensitive fields.

CREATE OR REPLACE FUNCTION public.find_group_by_invite_code(p_code TEXT)
RETURNS TABLE (
    group_id UUID,
    name TEXT,
    description TEXT,
    icon_emoji TEXT,
    member_count BIGINT,
    is_expired BOOLEAN,
    already_member BOOLEAN,
    has_pending_request BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT
        g.id,
        g.name,
        g.description,
        g.icon_emoji,
        (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id),
        g.invite_code_expires_at < NOW(),
        EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.user_id = auth.uid()),
        EXISTS (
            SELECT 1 FROM group_join_requests r
            WHERE r.group_id = g.id AND r.user_id = auth.uid() AND r.status = 'PENDING'
        )
    FROM groups g
    WHERE UPPER(g.invite_code) = UPPER(TRIM(p_code));
$$;

-- Returns one of: NOT_FOUND, EXPIRED, ALREADY_MEMBER, ALREADY_PENDING, REQUESTED
-- OUT params are prefixed because a plpgsql OUT param named "status" would
-- shadow group_join_requests.status and make the WHERE clauses ambiguous.
CREATE OR REPLACE FUNCTION public.request_to_join_group(p_code TEXT)
RETURNS TABLE (out_status TEXT, out_group_name TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_group groups%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN QUERY SELECT 'NOT_AUTHENTICATED'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    SELECT * INTO v_group FROM groups g
    WHERE UPPER(g.invite_code) = UPPER(TRIM(p_code));

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_group.invite_code_expires_at < NOW() THEN
        RETURN QUERY SELECT 'EXPIRED'::TEXT, v_group.name;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM group_members m
        WHERE m.group_id = v_group.id AND m.user_id = auth.uid()
    ) THEN
        RETURN QUERY SELECT 'ALREADY_MEMBER'::TEXT, v_group.name;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM group_join_requests r
        WHERE r.group_id = v_group.id AND r.user_id = auth.uid() AND r.status = 'PENDING'
    ) THEN
        RETURN QUERY SELECT 'ALREADY_PENDING'::TEXT, v_group.name;
        RETURN;
    END IF;

    -- Re-requesting after a rejection is allowed; clear the old row first so the
    -- admin sees a single live request.
    DELETE FROM group_join_requests r
    WHERE r.group_id = v_group.id AND r.user_id = auth.uid();

    INSERT INTO group_join_requests (group_id, user_id, status)
    VALUES (v_group.id, auth.uid(), 'PENDING');

    RETURN QUERY SELECT 'REQUESTED'::TEXT, v_group.name;
END;
$$;

-- Admin-only: mint a fresh code and push the expiry out. Used when a code lapses.
CREATE OR REPLACE FUNCTION public.regenerate_invite_code(p_group_id UUID, p_days INT DEFAULT 7)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_code TEXT;
    v_attempts INT := 0;
BEGIN
    IF NOT public.is_group_admin(p_group_id) THEN
        RAISE EXCEPTION 'Only a group admin can regenerate the invite code';
    END IF;

    LOOP
        v_attempts := v_attempts + 1;
        v_code := UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 6));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM groups WHERE invite_code = v_code);
        IF v_attempts > 20 THEN
            RAISE EXCEPTION 'Could not allocate a unique invite code';
        END IF;
    END LOOP;

    UPDATE groups
    SET invite_code = v_code,
        invite_code_expires_at = NOW() + (p_days || ' days')::INTERVAL,
        updated_at = NOW()
    WHERE id = p_group_id;

    RETURN v_code;
END;
$$;

-- Records a payment between two members and writes the matching pair of ledger
-- entries in one transaction, so a settlement can never half-apply.
CREATE OR REPLACE FUNCTION public.record_settlement(
    p_group_id UUID,
    p_to_user  UUID,
    p_amount   DECIMAL,
    p_note     TEXT DEFAULT '',
    p_method   TEXT DEFAULT 'CASH'
)
RETURNS UUID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_cycle_id UUID;
    v_settlement_id UUID;
    v_from UUID := auth.uid();
BEGIN
    IF v_from IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT public.is_group_member(p_group_id) THEN
        RAISE EXCEPTION 'You are not a member of this group';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = p_to_user) THEN
        RAISE EXCEPTION 'Recipient is not a member of this group';
    END IF;
    IF p_to_user = v_from THEN
        RAISE EXCEPTION 'You cannot settle up with yourself';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Settlement amount must be greater than zero';
    END IF;

    SELECT id INTO v_cycle_id FROM settlement_cycles
    WHERE group_id = p_group_id AND status = 'ACTIVE'
    ORDER BY started_at DESC LIMIT 1;

    IF v_cycle_id IS NULL THEN
        INSERT INTO settlement_cycles (group_id, status, initiated_by)
        VALUES (p_group_id, 'ACTIVE', v_from)
        RETURNING id INTO v_cycle_id;
    END IF;

    INSERT INTO group_settlements (group_id, cycle_id, from_user, to_user, amount, note, payment_method, is_confirmed)
    VALUES (p_group_id, v_cycle_id, v_from, p_to_user, p_amount, COALESCE(p_note, ''), COALESCE(p_method, 'CASH'), FALSE)
    RETURNING id INTO v_settlement_id;

    -- Paying down what you owe moves your balance up; being paid moves theirs down.
    INSERT INTO ledger_entries (group_id, cycle_id, user_id, entry_type, amount, reference_id, description)
    VALUES
        (p_group_id, v_cycle_id, v_from,     'SETTLEMENT',  p_amount, v_settlement_id, 'Settlement paid'),
        (p_group_id, v_cycle_id, p_to_user,  'SETTLEMENT', -p_amount, v_settlement_id, 'Settlement received');

    RETURN v_settlement_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_group_member(UUID)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_admin(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_profile(UUID)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_group_by_invite_code(TEXT)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_to_join_group(TEXT)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_invite_code(UUID, INT)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_settlement(UUID, UUID, DECIMAL, TEXT, TEXT) TO authenticated;

-- ========================================
-- EXPENSE RPCs
-- ========================================
-- An expense is four writes: the expense row, its splits, its line items and
-- the ledger pair. Done from the client they are four round trips with no
-- transaction, so a failure midway leaves splits without ledger entries and
-- every balance in the group goes wrong. These do the whole thing atomically
-- and refuse to write a split set that does not add up.

-- Membership check for an arbitrary user (is_group_member only checks caller).
CREATE OR REPLACE FUNCTION public.is_group_member_of(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND user_id = p_user_id
    );
$$;

-- Shared by save_expense and update_expense.
CREATE OR REPLACE FUNCTION public.write_expense_rows(
    p_expense_id UUID,
    p_group_id   UUID,
    p_title      TEXT,
    p_amount     DECIMAL,
    p_paid_by    UUID,
    p_splits     JSONB,
    p_items      JSONB
)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_split       JSONB;
    v_item        JSONB;
    v_split_total DECIMAL(14,2) := 0;
BEGIN
    -- Splits must reconstruct the bill exactly, or the ledger will not net to
    -- zero and every balance in the group drifts.
    SELECT COALESCE(SUM((s->>'amount')::DECIMAL), 0) INTO v_split_total
    FROM jsonb_array_elements(p_splits) s
    WHERE (s->>'is_included')::BOOLEAN;

    IF ROUND(v_split_total, 2) <> ROUND(p_amount, 2) THEN
        RAISE EXCEPTION 'Split total (%) does not equal the expense amount (%)', v_split_total, p_amount;
    END IF;

    INSERT INTO expense_splits (expense_id, user_id, is_included, amount, percentage, shares)
    SELECT
        p_expense_id,
        (s->>'user_id')::UUID,
        COALESCE((s->>'is_included')::BOOLEAN, TRUE),
        COALESCE((s->>'amount')::DECIMAL, 0),
        COALESCE((s->>'percentage')::DECIMAL, 0),
        COALESCE((s->>'shares')::INT, 1)
    FROM jsonb_array_elements(p_splits) s;

    IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) > 0 THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
            INSERT INTO expense_items (expense_id, name, amount, shared_by)
            VALUES (
                p_expense_id,
                v_item->>'name',
                (v_item->>'amount')::DECIMAL,
                COALESCE(
                    (SELECT ARRAY_AGG(value::TEXT::UUID)
                     FROM jsonb_array_elements_text(v_item->'shared_by') AS value),
                    '{}'::UUID[]
                )
            );
        END LOOP;
    END IF;

    -- Whoever paid is credited the full amount; each participant is debited
    -- their share. The two sides sum to zero by construction.
    INSERT INTO ledger_entries (group_id, user_id, entry_type, amount, reference_id, description)
    VALUES (p_group_id, p_paid_by, 'EXPENSE', p_amount, p_expense_id, 'Paid for ' || p_title);

    FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits) LOOP
        IF COALESCE((v_split->>'is_included')::BOOLEAN, FALSE)
           AND COALESCE((v_split->>'amount')::DECIMAL, 0) > 0 THEN
            INSERT INTO ledger_entries (group_id, user_id, entry_type, amount, reference_id, description)
            VALUES (
                p_group_id,
                (v_split->>'user_id')::UUID,
                'SPLIT',
                -(v_split->>'amount')::DECIMAL,
                p_expense_id,
                'Share of ' || p_title
            );
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_expense(
    p_group_id     UUID,
    p_title        TEXT,
    p_amount       DECIMAL,
    p_paid_by      UUID,
    p_category     TEXT,
    p_split_method TEXT,
    p_notes        TEXT,
    p_splits       JSONB,
    p_items        JSONB DEFAULT '[]'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_expense_id UUID;
BEGIN
    IF NOT public.is_group_member(p_group_id) THEN
        RAISE EXCEPTION 'You are not a member of this group';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;
    IF NOT public.is_group_member_of(p_group_id, p_paid_by) THEN
        RAISE EXCEPTION 'The payer is not a member of this group';
    END IF;

    INSERT INTO expenses (group_id, title, amount, paid_by, created_by, on_behalf_of,
                          category, split_method, notes)
    VALUES (
        p_group_id, p_title, p_amount, p_paid_by, auth.uid(),
        CASE WHEN p_paid_by <> auth.uid() THEN p_paid_by END,
        COALESCE(p_category, 'OTHER'), COALESCE(p_split_method, 'EQUAL'), COALESCE(p_notes, '')
    )
    RETURNING id INTO v_expense_id;

    PERFORM public.write_expense_rows(v_expense_id, p_group_id, p_title, p_amount, p_paid_by, p_splits, p_items);

    RETURN v_expense_id;
END;
$$;

-- Editing re-derives the ledger by reversing the old entries and posting fresh
-- ones, so history stays append-only and the audit trail records both states.
CREATE OR REPLACE FUNCTION public.update_expense(
    p_expense_id   UUID,
    p_title        TEXT,
    p_amount       DECIMAL,
    p_paid_by      UUID,
    p_category     TEXT,
    p_split_method TEXT,
    p_notes        TEXT,
    p_splits       JSONB,
    p_items        JSONB DEFAULT '[]'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_old      expenses%ROWTYPE;
    v_old_snap JSONB;
    v_new_snap JSONB;
    v_summary  TEXT := '';
BEGIN
    SELECT * INTO v_old FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF v_old.is_deleted THEN
        RAISE EXCEPTION 'This expense has been deleted';
    END IF;
    IF v_old.created_by <> auth.uid() AND NOT public.is_group_admin(v_old.group_id) THEN
        RAISE EXCEPTION 'Only the person who added this expense, or a group admin, can edit it';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;

    v_old_snap := jsonb_build_object(
        'title', v_old.title, 'amount', v_old.amount, 'paid_by', v_old.paid_by,
        'category', v_old.category, 'split_method', v_old.split_method, 'notes', v_old.notes,
        'splits', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'user_id', user_id, 'amount', amount, 'is_included', is_included)), '[]'::jsonb)
                   FROM expense_splits WHERE expense_id = p_expense_id)
    );

    IF v_old.title <> p_title THEN
        v_summary := v_summary || format('title "%s" → "%s"; ', v_old.title, p_title);
    END IF;
    IF ROUND(v_old.amount, 2) <> ROUND(p_amount, 2) THEN
        v_summary := v_summary || format('amount %s → %s; ', v_old.amount, p_amount);
    END IF;
    IF v_old.paid_by IS DISTINCT FROM p_paid_by THEN
        v_summary := v_summary || 'payer changed; ';
    END IF;
    IF v_old.split_method <> p_split_method THEN
        v_summary := v_summary || format('split %s → %s; ', v_old.split_method, p_split_method);
    END IF;
    IF v_summary = '' THEN
        v_summary := 'splits adjusted';
    END IF;

    -- Reverse every ledger entry this expense produced. Nothing is deleted:
    -- the ledger stays append-only and auditable.
    INSERT INTO ledger_entries (group_id, user_id, entry_type, amount, reference_id, description)
    SELECT group_id, user_id, 'EDIT_REVERSAL', -amount, p_expense_id, 'Reversal for edit of ' || v_old.title
    FROM ledger_entries
    WHERE reference_id = p_expense_id
      AND entry_type IN ('EXPENSE', 'SPLIT');

    DELETE FROM expense_splits WHERE expense_id = p_expense_id;
    DELETE FROM expense_items  WHERE expense_id = p_expense_id;

    UPDATE expenses
    SET title = p_title, amount = p_amount, paid_by = p_paid_by,
        on_behalf_of = CASE WHEN p_paid_by <> auth.uid() THEN p_paid_by END,
        category = COALESCE(p_category, 'OTHER'),
        split_method = COALESCE(p_split_method, 'EQUAL'),
        notes = COALESCE(p_notes, ''),
        updated_at = NOW()
    WHERE id = p_expense_id;

    PERFORM public.write_expense_rows(p_expense_id, v_old.group_id, p_title, p_amount, p_paid_by, p_splits, p_items);

    v_new_snap := jsonb_build_object(
        'title', p_title, 'amount', p_amount, 'paid_by', p_paid_by,
        'category', p_category, 'split_method', p_split_method, 'notes', p_notes,
        'splits', p_splits
    );

    INSERT INTO expense_edits (expense_id, edited_by, old_snapshot, new_snapshot, change_summary)
    VALUES (p_expense_id, auth.uid(), v_old_snap, v_new_snap, RTRIM(v_summary, '; '));
END;
$$;

-- Soft-delete plus a reversal pair, in one transaction.
CREATE OR REPLACE FUNCTION public.delete_expense(p_expense_id UUID, p_reason TEXT DEFAULT '')
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_old expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_old FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF v_old.is_deleted THEN
        RETURN;  -- already gone; nothing to reverse twice
    END IF;
    IF v_old.created_by <> auth.uid() AND NOT public.is_group_admin(v_old.group_id) THEN
        RAISE EXCEPTION 'Only the person who added this expense, or a group admin, can delete it';
    END IF;

    INSERT INTO ledger_entries (group_id, user_id, entry_type, amount, reference_id, description)
    SELECT group_id, user_id, 'DELETE_REVERSAL', -amount, p_expense_id, 'Reversal of deleted expense'
    FROM ledger_entries
    WHERE reference_id = p_expense_id
      AND entry_type IN ('EXPENSE', 'SPLIT');

    UPDATE expenses
    SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = auth.uid(),
        delete_reason = COALESCE(p_reason, '')
    WHERE id = p_expense_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_group_member_of(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.write_expense_rows(UUID, UUID, TEXT, DECIMAL, UUID, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_expense(UUID, TEXT, DECIMAL, UUID, TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_expense(UUID, TEXT, DECIMAL, UUID, TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_expense(UUID, TEXT) TO authenticated;

-- ========================================
-- AUTO-CREATE USER ON SIGN-UP / GOOGLE SIGN-IN
-- ========================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO public.users (id, display_name, email, avatar_url)
    VALUES (
        NEW.id,
        COALESCE(
            NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
            NULLIF(NEW.raw_user_meta_data->>'name', ''),
            split_part(NEW.email, '@', 1)
        ),
        NEW.email,
        COALESCE(
            NEW.raw_user_meta_data->>'avatar_url',
            NEW.raw_user_meta_data->>'picture'
        )
    )
    -- Refresh what the provider owns, but never clobber a display name the user
    -- has edited in Settings.
    ON CONFLICT (id) DO UPDATE SET
        email      = EXCLUDED.email,
        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE handle_new_user();

-- Google can hand back a newer avatar or a verified email on a later sign-in.
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
    AFTER UPDATE ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE handle_new_user();
