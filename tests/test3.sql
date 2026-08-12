\set ON_ERROR_STOP on
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $test$
DECLARE
    G     UUID := 'aaaaaaaa-0000-0000-0000-000000000001';
    ALICE UUID := '11111111-1111-1111-1111-111111111111';
    BOB   UUID := '22222222-2222-2222-2222-222222222222';
    v_method TEXT;
    v_share  INT;
    v_inc    BOOLEAN;
    v_created INT;
    v_count  INT;
    v_next   DATE;
    v_net    DECIMAL;
    v_rec    UUID;
BEGIN
    -- ---------- 33: split defaults persist ----------
    PERFORM save_split_defaults(G, 'SHARES', jsonb_build_array(
        jsonb_build_object('user_id', ALICE, 'share', 2, 'included', true),
        jsonb_build_object('user_id', BOB,   'share', 1, 'included', false)
    ));

    SELECT default_split_method INTO v_method FROM groups WHERE id = G;
    SELECT default_split_share, include_by_default INTO v_share, v_inc
    FROM group_members WHERE group_id = G AND user_id = BOB;

    RAISE NOTICE '33 split defaults saved | pass=%', (v_method = 'SHARES' AND v_share = 1 AND v_inc = FALSE);
    IF NOT (v_method = 'SHARES' AND v_share = 1 AND v_inc = FALSE) THEN
        RAISE EXCEPTION 'test 33 failed: method=% share=% inc=%', v_method, v_share, v_inc;
    END IF;

    -- ---------- 34: a group template backfills missed occurrences ----------
    -- Dated 3 days ago on a DAILY schedule => today inclusive means 4 postings.
    INSERT INTO recurring_expenses (user_id, group_id, title, amount, category, frequency,
                                    next_run, paid_by, split_method, splits)
    VALUES (ALICE, G, 'Bus fare', 120.00, 'TRANSPORT', 'DAILY', CURRENT_DATE - 3,
            ALICE, 'EQUAL',
            jsonb_build_array(jsonb_build_object('user_id', ALICE, 'amount', 120, 'is_included', true)));

    v_created := run_due_recurring();
    SELECT COUNT(*) INTO v_count FROM expenses
    WHERE group_id = G AND title = 'Bus fare' AND NOT is_deleted;

    RAISE NOTICE '34 group recurring backfilled | pass=% (created=%)', v_count = 4, v_count;
    IF v_count <> 4 THEN RAISE EXCEPTION 'test 34 failed: % rows', v_count; END IF;

    -- ---------- 35: next_run advanced past today ----------
    SELECT next_run INTO v_next FROM recurring_expenses WHERE title = 'Bus fare';
    RAISE NOTICE '35 next_run moved to future | pass=%', v_next > CURRENT_DATE;
    IF NOT (v_next > CURRENT_DATE) THEN RAISE EXCEPTION 'test 35 failed: next_run=%', v_next; END IF;

    -- ---------- 36: re-running the same day is a no-op ----------
    v_created := run_due_recurring();
    SELECT COUNT(*) INTO v_count FROM expenses
    WHERE group_id = G AND title = 'Bus fare' AND NOT is_deleted;
    RAISE NOTICE '36 repeat run creates nothing | pass=%', (v_created = 0 AND v_count = 4);
    IF v_created <> 0 OR v_count <> 4 THEN
        RAISE EXCEPTION 'test 36 failed: created=% rows=%', v_created, v_count;
    END IF;

    -- ---------- 37: group recurring posts a balanced expense ----------
    INSERT INTO recurring_expenses (user_id, group_id, title, amount, paid_by, category,
                                    split_method, splits, frequency, next_run)
    VALUES (ALICE, G, 'Netflix', 1500.00, ALICE, 'ENTERTAINMENT', 'EQUAL',
            jsonb_build_array(
                jsonb_build_object('user_id', ALICE, 'is_included', true, 'amount', 750.00),
                jsonb_build_object('user_id', BOB,   'is_included', true, 'amount', 750.00)
            ),
            'MONTHLY', CURRENT_DATE)
    RETURNING id INTO v_rec;

    v_created := run_due_recurring();
    SELECT COUNT(*) INTO v_count FROM expenses WHERE group_id = G AND title = 'Netflix';
    RAISE NOTICE '37 group recurring posted | pass=%', v_count = 1;
    IF v_count <> 1 THEN RAISE EXCEPTION 'test 37 failed: % expenses', v_count; END IF;

    -- ---------- 38: its ledger still nets to zero ----------
    SELECT COALESCE(SUM(l.amount), 0) INTO v_net
    FROM ledger_entries l
    JOIN expenses e ON e.id = l.reference_id
    WHERE e.title = 'Netflix';
    RAISE NOTICE '38 recurring ledger nets to zero | pass=% (net=%)', v_net = 0, v_net;
    IF v_net <> 0 THEN RAISE EXCEPTION 'test 38 failed: net=%', v_net; END IF;

    -- ---------- 39: marked as recurring on the expense row ----------
    SELECT COUNT(*) INTO v_count FROM expenses
    WHERE title = 'Netflix' AND is_recurring AND recurrence_rule = 'MONTHLY';
    RAISE NOTICE '39 expense flagged recurring | pass=%', v_count = 1;
    IF v_count <> 1 THEN RAISE EXCEPTION 'test 39 failed'; END IF;

    -- ---------- 40: another user cannot run my templates ----------
    PERFORM set_config('request.jwt.claim.sub', BOB::TEXT, true);
    v_created := run_due_recurring();
    RAISE NOTICE '40 templates are per-user | pass=%', v_created = 0;
    IF v_created <> 0 THEN RAISE EXCEPTION 'test 40 failed: created=%', v_created; END IF;

    -- ---------- 41: templates outside any group post nothing and are private ----------
    SELECT COUNT(*) INTO v_count FROM recurring_expenses WHERE group_id IS NULL;
    RAISE NOTICE '41 ungrouped templates hidden from others | pass=%', v_count = 0;
    IF v_count <> 0 THEN RAISE EXCEPTION 'test 41 failed: % visible', v_count; END IF;

    -- ---------- 42: but group templates are visible to members ----------
    -- Two by now: the daily bus fare and the monthly subscription.
    SELECT COUNT(*) INTO v_count FROM recurring_expenses WHERE group_id = G;
    RAISE NOTICE '42 group templates visible to members | pass=%', v_count = 2;
    IF v_count <> 2 THEN RAISE EXCEPTION 'test 42 failed: % visible', v_count; END IF;

    PERFORM set_config('request.jwt.claim.sub', ALICE::TEXT, true);

    -- ---------- 43: safe_uuid tolerates junk ----------
    RAISE NOTICE '43 safe_uuid handles non-uuid | pass=%',
        (public.safe_uuid('personal') IS NULL AND public.safe_uuid(G::TEXT) = G);
    IF public.safe_uuid('personal') IS NOT NULL THEN RAISE EXCEPTION 'test 43 failed'; END IF;

    -- ---------- 44: whole-group ledger still balances ----------
    SELECT COALESCE(SUM(amount), 0) INTO v_net FROM ledger_entries WHERE group_id = G;
    RAISE NOTICE '44 group ledger balances overall | pass=% (net=%)', v_net = 0, v_net;
    IF v_net <> 0 THEN RAISE EXCEPTION 'test 44 failed: net=%', v_net; END IF;

    RAISE NOTICE 'ALL FEATURE TESTS PASSED';
END
$test$;

RESET ROLE;
