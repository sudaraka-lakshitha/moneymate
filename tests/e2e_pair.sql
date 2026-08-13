\set ON_ERROR_STOP on
-- The whole story between two people, in the order it actually happens, checked
-- from both sides at every step.
--
-- Three things are verified at each stage rather than at the end, because they
-- can disagree and only one of them is obvious:
--
--   money       — what each of them owes the other
--   statistics  — what counts as whose spending, and who gets asked
--   visibility  — what each of them can see of the other
--
-- Everything here is the real path the app takes: the same functions the
-- screens call, and counting queries copied from the queries the screens run.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('e5000000-0000-0000-0000-00000000000a','pair_ann@t.lk','{"full_name":"Ann"}'),
   ('e5000000-0000-0000-0000-00000000000b','pair_ben@t.lk','{"full_name":"Ben"}'),
   ('e5000000-0000-0000-0000-00000000000c','pair_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;

SET ROLE authenticated;

-- What the Stats screen counts as your spending: every share you are on that
-- is not a loan. Nothing is asked and nothing waits.
CREATE OR REPLACE FUNCTION pg_temp.spend(p_for UUID) RETURNS DECIMAL
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(s.amount), 0)
  FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
  WHERE s.user_id = p_for AND s.is_included AND NOT e.is_deleted AND NOT e.is_loan;
$$;

-- Whether the Friends screen would show them: a connection, a shared group, or
-- money outstanding. Mirrors the filter the list applies.
CREATE OR REPLACE FUNCTION pg_temp.listed(p_me UUID, p_them UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM friend_requests fr
      WHERE fr.status = 'ACCEPTED'
        AND ((fr.requester_id = p_me AND fr.addressee_id = p_them)
          OR (fr.requester_id = p_them AND fr.addressee_id = p_me))
  )
  OR EXISTS (
      SELECT 1 FROM group_members a
      JOIN group_members b ON b.group_id = a.group_id
      JOIN groups g ON g.id = a.group_id
      WHERE a.user_id = p_me AND b.user_id = p_them AND NOT COALESCE(g.is_direct, FALSE)
  )
  OR EXISTS (
      SELECT 1 FROM groups g
      WHERE g.is_direct
        AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.user_id=p_me)
        AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.user_id=p_them)
        AND ABS(public.member_balance(g.id, p_me)) >= 0.01
  );
$$;

DO $t$
DECLARE
  ANN UUID:='e5000000-0000-0000-0000-00000000000a';
  BEN UUID:='e5000000-0000-0000-0000-00000000000b';
  CAR UUID:='e5000000-0000-0000-0000-00000000000c';
  pair UUID; grp UUID; e UUID; other UUID; req UUID; st TEXT; cat TEXT;
  ba DECIMAL; bb DECIMAL; n INT; blocked BOOLEAN;

BEGIN

-- =====================================================================
RAISE NOTICE '--- 1. Two strangers ---';
-- =====================================================================
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  IF public.can_view_profile(BEN) THEN
    RAISE EXCEPTION 'stage 1 failed: a stranger''s profile is readable';
  END IF;
  IF pg_temp.listed(ANN, BEN) THEN
    RAISE EXCEPTION 'stage 1 failed: a stranger appears in the friends list';
  END IF;

  blocked := FALSE;
  BEGIN PERFORM lend_to_friend(BEN, 1000, 'nope', TRUE);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'stage 1 failed: posted a debt against a stranger';
  END IF;
  RAISE NOTICE '  ✓ invisible to each other, and no money can pass between them';

-- =====================================================================
RAISE NOTICE '--- 2. Ann adds Ben, Ben accepts ---';
-- =====================================================================
  SELECT out_status, out_request_id INTO st, req FROM send_friend_request('pair_ben@t.lk');
  IF st <> 'SENT' THEN RAISE EXCEPTION 'stage 2 failed: request status %', st; END IF;

  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM respond_to_friend_request(req, TRUE);

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  IF NOT public.can_view_profile(BEN) THEN
    RAISE EXCEPTION 'stage 2 failed: a friend''s profile is still hidden';
  END IF;
  IF NOT pg_temp.listed(ANN, BEN) OR NOT pg_temp.listed(BEN, ANN) THEN
    RAISE EXCEPTION 'stage 2 failed: the friendship is not on both lists';
  END IF;
  RAISE NOTICE '  ✓ visible to each other, on both lists, nothing owed yet';

-- =====================================================================
RAISE NOTICE '--- 3. Ann lends Ben 5,000 ---';
-- =====================================================================
  PERFORM lend_to_friend(BEN, 5000, 'Emergency', TRUE);
  pair := direct_group_with(BEN);

  ba := member_balance(pair, ANN); bb := member_balance(pair, BEN);
  IF ba <> 5000 OR bb <> -5000 THEN
    RAISE EXCEPTION 'stage 3 failed: Ann % Ben % (want +5000 / -5000)', ba, bb;
  END IF;
  IF pg_temp.spend(ANN) <> 0 OR pg_temp.spend(BEN) <> 0 THEN
    RAISE EXCEPTION 'stage 3 failed: lending counted as spending (Ann % Ben %)',
      pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;
  RAISE NOTICE '  ✓ Ben owes 5,000; neither has spent anything';

-- =====================================================================
RAISE NOTICE '--- 4. Ann borrows 2,000 back from Ben ---';
-- =====================================================================
  PERFORM lend_to_friend(BEN, 2000, 'Rent top-up', FALSE);

  ba := member_balance(pair, ANN);
  IF ba <> 3000 THEN RAISE EXCEPTION 'stage 4 failed: net is % (want 3000)', ba; END IF;
  IF pg_temp.spend(ANN) <> 0 OR pg_temp.spend(BEN) <> 0 THEN
    RAISE EXCEPTION 'stage 4 failed: borrowing counted as spending';
  END IF;
  RAISE NOTICE '  ✓ lending nets off to 3,000; still nobody''s spending';

-- =====================================================================
RAISE NOTICE '--- 5. They share a 3,000 dinner, Ann pays ---';
-- =====================================================================
  e := add_direct_expense(BEN, 3000, 'Dinner', TRUE, 1500, FALSE, 'FOOD');

  ba := member_balance(pair, ANN);
  IF ba <> 4500 THEN RAISE EXCEPTION 'stage 5 failed: balance % (want 4500)', ba; END IF;

  -- A share is a share: both of them ate, so both of them spent, and neither
  -- had to agree to be counted.
  IF pg_temp.spend(ANN) <> 1500 THEN
    RAISE EXCEPTION 'stage 5 failed: Ann''s share reads % (want 1500)', pg_temp.spend(ANN);
  END IF;
  IF pg_temp.spend(BEN) <> 1500 THEN
    RAISE EXCEPTION 'stage 5 failed: Ben''s share reads % (want 1500)', pg_temp.spend(BEN);
  END IF;

  -- And the category the payer chose is the category it is filed under, so the
  -- breakdown means something for people who mostly split with one friend.
  SELECT category INTO cat FROM expenses WHERE id = e;
  IF cat <> 'FOOD' THEN
    RAISE EXCEPTION 'stage 5 failed: dinner filed under % (want FOOD)', cat;
  END IF;
  RAISE NOTICE '  ✓ 1,500 each, both counted at once, filed under FOOD';

-- =====================================================================
RAISE NOTICE '--- 6. Ann pays Ben''s 1,200 phone bill outright ---';
-- =====================================================================
  e := add_direct_expense(BEN, 1200, 'Ben''s phone bill', TRUE, 1200, FALSE, 'UTILITIES');

  ba := member_balance(pair, ANN);
  IF ba <> 5700 THEN RAISE EXCEPTION 'stage 6 failed: balance % (want 5700)', ba; END IF;

  -- Ann fronted it but consumed none of it.
  IF pg_temp.spend(ANN) <> 1500 THEN
    RAISE EXCEPTION 'stage 6 failed: the payer was charged for somebody else''s bill (%)',
      pg_temp.spend(ANN);
  END IF;
  -- It was Ben's bill and it exists nowhere else, so it is Ben's spending —
  -- immediately, and whether or not he is looking.
  IF pg_temp.spend(BEN) <> 2700 THEN
    RAISE EXCEPTION 'stage 6 failed: Ben''s spending reads % (want 2700)', pg_temp.spend(BEN);
  END IF;
  RAISE NOTICE '  ✓ Ben owes 1,200 more and it counts as his, not Ann''s';

-- =====================================================================
RAISE NOTICE '--- 7. Ben pays an 800 bill of Ann''s ---';
-- =====================================================================
  e := add_direct_expense(BEN, 800, 'Ann''s data top-up', FALSE, 0, FALSE, 'UTILITIES');

  ba := member_balance(pair, ANN);
  IF ba <> 4900 THEN RAISE EXCEPTION 'stage 7 failed: balance % (want 4900)', ba; END IF;

  -- Ann's own consumption, which a friend happened to pay for.
  IF pg_temp.spend(ANN) <> 2300 THEN
    RAISE EXCEPTION 'stage 7 failed: Ann''s spending reads % (want 2300)', pg_temp.spend(ANN);
  END IF;
  IF pg_temp.spend(BEN) <> 2700 THEN
    RAISE EXCEPTION 'stage 7 failed: Ben was charged for a bill that was not his (%)',
      pg_temp.spend(BEN);
  END IF;
  RAISE NOTICE '  ✓ Ann owes 800 less and counts it; Ben fronted it and does not';

-- =====================================================================
RAISE NOTICE '--- 8. Ben pays back 2,000 of it ---';
-- =====================================================================
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(pair, ANN, 2000, 'part payment', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  ba := member_balance(pair, ANN);
  IF ba <> 2900 THEN RAISE EXCEPTION 'stage 8 failed: balance % (want 2900)', ba; END IF;
  IF pg_temp.spend(ANN) <> 2300 OR pg_temp.spend(BEN) <> 2700 THEN
    RAISE EXCEPTION 'stage 8 failed: settling changed somebody''s spending (Ann % Ben %)',
      pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;
  SELECT COUNT(*) INTO n FROM group_settlements WHERE group_id = pair;
  IF n <> 1 THEN RAISE EXCEPTION 'stage 8 failed: % payment records', n; END IF;
  RAISE NOTICE '  ✓ 2,900 left; paying somebody back is not spending; the payment is on record';

-- =====================================================================
RAISE NOTICE '--- 9. A real group with Cara, on top of all that ---';
-- =====================================================================
  grp := (create_group('Trip','','✈️')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (grp,BEN,'MEMBER'),(grp,CAR,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  PERFORM save_expense(grp,'Hotel',900,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true)),'[]'::jsonb);

  -- One Ann is not on at all, for the visibility checks after she leaves.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  other := save_expense(grp,'Taxi',200,BEN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',BEN,'amount',100,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',100,'is_included',true),
      jsonb_build_object('user_id',ANN,'amount',0,'is_included',false)),'[]'::jsonb);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  IF pg_temp.spend(ANN) <> 2600 OR pg_temp.spend(BEN) <> 3100 OR pg_temp.spend(CAR) <> 400 THEN
    RAISE EXCEPTION 'stage 9 failed: group shares not counted (Ann % Ben % Cara %)',
      pg_temp.spend(ANN), pg_temp.spend(BEN), pg_temp.spend(CAR);
  END IF;
  RAISE NOTICE '  ✓ group shares count for all three at once, nobody asked';

-- =====================================================================
RAISE NOTICE '--- 10. Ann tries to remove Ben mid-debt ---';
-- =====================================================================
  blocked := FALSE;
  BEGIN PERFORM remove_friend(BEN); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'stage 10 failed: removed a friend who still owes 2,900';
  END IF;
  IF NOT pg_temp.listed(ANN, BEN) THEN
    RAISE EXCEPTION 'stage 10 failed: the refusal still dropped him off the list';
  END IF;
  RAISE NOTICE '  ✓ refused, and he is still on the list where the debt can be seen';

-- =====================================================================
RAISE NOTICE '--- 11. Ben clears the rest ---';
-- =====================================================================
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(pair, ANN, 2900, 'the rest', 'BANK');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  IF member_balance(pair, ANN) <> 0 OR member_balance(pair, BEN) <> 0 THEN
    RAISE EXCEPTION 'stage 11 failed: not square (Ann % Ben %)',
      member_balance(pair, ANN), member_balance(pair, BEN);
  END IF;
  IF NOT group_is_settled(pair) THEN RAISE EXCEPTION 'stage 11 failed: pair not settled'; END IF;
  RAISE NOTICE '  ✓ square, and the pair record reports itself settled';

-- =====================================================================
RAISE NOTICE '--- 12. Old records are locked now ---';
-- =====================================================================
  SELECT id INTO e FROM expenses WHERE group_id = pair AND title = 'Dinner';
  blocked := FALSE;
  BEGIN PERFORM update_direct_expense(e, 9999, 'Dinner', TRUE, 5000, FALSE);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'stage 12 failed: a settled record was edited, reopening a paid-up debt';
  END IF;
  IF member_balance(pair, ANN) <> 0 THEN
    RAISE EXCEPTION 'stage 12 failed: the refused edit moved money (%)', member_balance(pair, ANN);
  END IF;
  RAISE NOTICE '  ✓ settled records refuse edits, and the refusal costs nothing';

-- =====================================================================
RAISE NOTICE '--- 13. Ann removes Ben, keeping the history ---';
-- =====================================================================
  -- Two loans, a shared dinner, his phone bill and her top-up.
  IF friend_record_count(BEN) <> 5 THEN
    RAISE EXCEPTION 'stage 13 failed: % records between them (want 5)', friend_record_count(BEN);
  END IF;

  PERFORM remove_friend(BEN);          -- history kept by default

  SELECT COUNT(*) INTO n FROM friend_requests
   WHERE (requester_id=ANN AND addressee_id=BEN) OR (requester_id=BEN AND addressee_id=ANN);
  IF n <> 0 THEN RAISE EXCEPTION 'stage 13 failed: still connected'; END IF;

  SELECT COUNT(*) INTO n FROM expenses WHERE group_id = pair AND NOT is_deleted;
  IF n <> 5 THEN RAISE EXCEPTION 'stage 13 failed: shared history destroyed (% left)', n; END IF;

  IF pg_temp.spend(ANN) <> 2600 OR pg_temp.spend(BEN) <> 3100 THEN
    RAISE EXCEPTION 'stage 13 failed: unfriending rewrote spending (Ann % Ben %)',
      pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;
  RAISE NOTICE '  ✓ connection gone, records and both spending histories untouched';

-- =====================================================================
RAISE NOTICE '--- 14. He is still listed, but only because of the group ---';
-- =====================================================================
  IF NOT pg_temp.listed(ANN, BEN) THEN
    RAISE EXCEPTION 'stage 14 failed: a group-mate vanished from the list';
  END IF;
  IF NOT public.can_view_profile(BEN) THEN
    RAISE EXCEPTION 'stage 14 failed: a group-mate''s profile went dark';
  END IF;

  -- Leaving is gated on being square, which is the right refusal — so the
  -- group has to be settled before Ann can walk away from it.
  blocked := FALSE;
  BEGIN PERFORM leave_group(grp); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'stage 14 failed: left a group while still owed 600';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(grp, ANN, 200, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  PERFORM record_settlement(grp, ANN, 400, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  PERFORM leave_group(grp);

  IF pg_temp.listed(ANN, BEN) THEN
    RAISE EXCEPTION 'stage 14 failed: removed, square and sharing nothing — still listed';
  END IF;
  RAISE NOTICE '  ✓ leaving needs settling first; once nothing connects them, he is off the list';

-- =====================================================================
RAISE NOTICE '--- 14b. What Ann keeps of the group she left, and what she does not ---';
-- =====================================================================
  -- She really did pay for that hotel. Her own share is hers whatever happened
  -- to her membership afterwards.
  IF pg_temp.spend(ANN) <> 2600 THEN
    RAISE EXCEPTION 'stage 14b failed: leaving erased her own spending (% of 2600)',
      pg_temp.spend(ANN);
  END IF;

  -- But she keeps nothing else about the group.
  SELECT COUNT(*) INTO n FROM expenses WHERE id = other;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stage 14b failed: she can still read a bill she was never on';
  END IF;

  SELECT COUNT(*) INTO n FROM expense_splits s
   JOIN expenses ex ON ex.id = s.expense_id
   WHERE ex.group_id = grp AND s.user_id <> ANN;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stage 14b failed: she can still read % of other people''s shares', n;
  END IF;

  SELECT COUNT(*) INTO n FROM group_members WHERE group_id = grp;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stage 14b failed: she can still see the membership (% rows)', n;
  END IF;

  SELECT COUNT(*) INTO n FROM ledger_entries WHERE group_id = grp;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stage 14b failed: she can still read the group ledger (% rows)', n;
  END IF;

  SELECT COUNT(*) INTO n FROM groups WHERE id = grp;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stage 14b failed: the group itself is still visible to her';
  END IF;

  -- And the group carries on for the two who stayed.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id = grp AND NOT is_deleted;
  IF n <> 2 THEN
    RAISE EXCEPTION 'stage 14b failed: the group lost bills when she left (% of 2)', n;
  END IF;
  IF pg_temp.spend(BEN) <> 3100 THEN
    RAISE EXCEPTION 'stage 14b failed: her leaving changed Ben''s spending (%)', pg_temp.spend(BEN);
  END IF;
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  RAISE NOTICE '  ✓ she keeps her own share and nothing else; the group is unchanged for the rest';

-- =====================================================================
RAISE NOTICE '--- 15. Ann adds him again ---';
-- =====================================================================
  SELECT out_status, out_request_id INTO st, req FROM send_friend_request('pair_ben@t.lk');
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM respond_to_friend_request(req, TRUE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  IF NOT pg_temp.listed(ANN, BEN) THEN
    RAISE EXCEPTION 'stage 15 failed: re-added and still not listed';
  END IF;
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id = pair AND NOT is_deleted;
  IF n <> 5 THEN RAISE EXCEPTION 'stage 15 failed: history did not come back (%)', n; END IF;
  IF member_balance(pair, ANN) <> 0 THEN
    RAISE EXCEPTION 'stage 15 failed: re-adding invented a balance (%)', member_balance(pair, ANN);
  END IF;
  RAISE NOTICE '  ✓ back on the list, old records intact, still square';

-- =====================================================================
RAISE NOTICE '--- 16. The ledgers still add up ---';
-- =====================================================================
  SELECT COALESCE(SUM(amount),0) INTO ba FROM ledger_entries WHERE group_id = pair;
  IF ROUND(ba,2) <> 0 THEN
    RAISE EXCEPTION 'stage 16 failed: the pair ledger nets to % instead of zero', ba;
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO bb FROM ledger_entries WHERE group_id = grp;
  IF ROUND(bb,2) <> 0 THEN
    RAISE EXCEPTION 'stage 16 failed: the group ledger nets to % instead of zero', bb;
  END IF;
  RAISE NOTICE '  ✓ both ledgers net to zero after all of it';

  RAISE NOTICE '';
  RAISE NOTICE '=== PAIR E2E: 17/17 STAGES PASSED ===';
  RAISE NOTICE '    final: Ann spent %, Ben spent %, Cara spent %',
    pg_temp.spend(ANN), pg_temp.spend(BEN), pg_temp.spend(CAR);
END $t$;
