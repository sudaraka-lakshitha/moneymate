\set ON_ERROR_STOP on
-- Whose statistics decision is whose, and what survives an edit.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('70000000-0000-0000-0000-00000000000a','s_ann@t.lk','{"full_name":"Ann"}'),
   ('70000000-0000-0000-0000-00000000000b','s_ben@t.lk','{"full_name":"Ben"}'),
   ('70000000-0000-0000-0000-00000000000c','s_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
SET ROLE authenticated;
DO $t$
DECLARE
  ANN UUID:='70000000-0000-0000-0000-00000000000a';
  BEN UUID:='70000000-0000-0000-0000-00000000000b';
  CAR UUID:='70000000-0000-0000-0000-00000000000c';
  G UUID; E1 UUID; E2 UUID; D UUID; v BOOLEAN; n INT; blocked BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Stats','','📊')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  E1 := save_expense(G,'Dinner',1000,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',500,'is_included',true)),'[]'::jsonb);

  -- P1: the person who typed the bill has already answered for themselves
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=E1 AND user_id=ANN;
  RAISE NOTICE 'P1 author''s own split is decided | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'P1 FAILED: author left undecided on their own bill'; END IF;

  -- P2: everyone else is asked
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=E1 AND user_id=BEN;
  RAISE NOTICE 'P2 other member is left to decide | pass=%', v IS NULL;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'P2 FAILED: someone else answered for Ben'; END IF;

  -- Ben says yes
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM set_split_stats_choice(E1, TRUE);

  -- Ann edits the bill afterwards
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM update_expense(E1,'Dinner',1200,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',600,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',600,'is_included',true)),'[]'::jsonb);

  -- P3: Ben's answer is not wiped by somebody else's edit
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=E1 AND user_id=BEN;
  RAISE NOTICE 'P3 a yes survives another member''s edit | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN
    RAISE EXCEPTION 'P3 FAILED: Ben''s stats choice was reset to % by Ann''s edit', v;
  END IF;

  -- P4: and so is the editor's own
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=E1 AND user_id=ANN;
  RAISE NOTICE 'P4 editor''s own choice still set | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'P4 FAILED'; END IF;

  -- A deliberate NO must survive an edit just as firmly as a yes
  E2 := save_expense(G,'Taxi',400,ANN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',200,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',200,'is_included',true)),'[]'::jsonb);
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM set_split_stats_choice(E2, FALSE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM update_expense(E2,'Taxi',500,ANN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',250,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',250,'is_included',true)),'[]'::jsonb);
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=E2 AND user_id=BEN;
  RAISE NOTICE 'P5 a no survives another member''s edit | pass=%', v IS FALSE;
  IF v IS NOT FALSE THEN RAISE EXCEPTION 'P5 FAILED: Ben''s no became %', v; END IF;

  -- Direct records between two people follow the same rule
  D := add_direct_expense(BEN, 600, 'Lunch', TRUE, 300);
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=D AND user_id=ANN;
  RAISE NOTICE 'P6 direct record decided for its author | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'P6 FAILED: own direct record left pending'; END IF;
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=D AND user_id=BEN;
  RAISE NOTICE 'P7 direct record left open for the other person | pass=%', v IS NULL;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'P7 FAILED'; END IF;

  PERFORM update_direct_expense(D, 800, 'Lunch', TRUE, 400);
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=D AND user_id=ANN;
  RAISE NOTICE 'P8 editing a direct record keeps the author decided | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'P8 FAILED: editing your own record re-queued it'; END IF;

  -- The backfill: rows that predate the column must not drag the author's own
  -- history out of their charts.
  EXECUTE 'RESET ROLE';
  UPDATE expense_splits s SET include_in_stats = NULL
  FROM expenses e WHERE e.id = s.expense_id AND e.group_id IN (G, (SELECT group_id FROM expenses WHERE id=D));

  UPDATE expense_splits s SET include_in_stats = TRUE
  FROM expenses e
  WHERE e.id = s.expense_id AND s.user_id = e.created_by AND s.include_in_stats IS NULL;
  EXECUTE 'SET ROLE authenticated';

  SELECT COUNT(*) INTO n FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
   WHERE s.user_id=ANN AND e.created_by=ANN AND s.include_in_stats IS NOT TRUE;
  RAISE NOTICE 'P9 backfill answers the author''s own history | pass=% (% left pending)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'P9 FAILED: % of Ann''s own bills went back to pending', n; END IF;

  SELECT COUNT(*) INTO n FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
   WHERE s.user_id=BEN AND e.created_by=ANN AND s.include_in_stats IS NOT NULL;
  RAISE NOTICE 'P10 backfill answers nothing on Ben''s behalf | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'P10 FAILED: backfill decided % splits for Ben', n; END IF;

  -- P11: you cannot open a pair record with somebody you have no connection to.
  -- Otherwise anyone holding an account id could post "you owe me" against a
  -- stranger and have it appear on that stranger's Friends screen.
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  blocked := FALSE;
  BEGIN
    PERFORM add_direct_expense(CAR, 5000, 'Made up', TRUE, 5000);
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;
  RAISE NOTICE 'P11 a stranger cannot be given a debt | pass=%', blocked;
  IF NOT blocked THEN
    RAISE EXCEPTION 'P11 FAILED: posted a debt against someone with no connection';
  END IF;

  -- P12: the same door one level down. direct_group_with is granted to
  -- authenticated in its own right, so gating only the expense wrapper would
  -- still let a stranger be pulled into a pair group.
  blocked := FALSE;
  BEGIN
    PERFORM direct_group_with(CAR);
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;
  RAISE NOTICE 'P12 no pair group can be opened with a stranger | pass=%', blocked;
  IF NOT blocked THEN
    RAISE EXCEPTION 'P12 FAILED: opened a pair group with someone unconnected';
  END IF;

  RAISE NOTICE 'ALL STATS-DECISION TESTS PASSED';
END $t$;
