\set ON_ERROR_STOP on
-- Who can see and do what, on everything added recently.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('a1000000-0000-0000-0000-00000000000a','x_ann@t.lk','{"full_name":"Ann"}'),
   ('a1000000-0000-0000-0000-00000000000b','x_ben@t.lk','{"full_name":"Ben"}'),
   ('a1000000-0000-0000-0000-00000000000e','x_eve@t.lk','{"full_name":"Eve"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
SET ROLE authenticated;
DO $t$
DECLARE
  ANN UUID:='a1000000-0000-0000-0000-00000000000a';
  BEN UUID:='a1000000-0000-0000-0000-00000000000b';
  EVE UUID:='a1000000-0000-0000-0000-00000000000e';
  G UUID; E UUID; n INT; total DECIMAL; blocked BOOLEAN; taxi UUID;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Private','','🔒')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  E := save_expense(G,'Dinner',1200,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',600,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',600,'is_included',true)),'[]'::jsonb);
  PERFORM delete_expense(E,'changed my mind');

  -- ---- Eve is in none of it ----
  PERFORM set_config('request.jwt.claim.sub', EVE::TEXT, true);

  SELECT COUNT(*) INTO n FROM group_contribution_stats(G);
  RAISE NOTICE 'X1 outsider gets no contribution figures | pass=% (% rows)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'X1 FAILED: leaked % rows of who paid what', n; END IF;

  RAISE NOTICE 'X2 outsider cannot count deleted records | pass=%', deleted_expense_count(G)=0;
  IF deleted_expense_count(G)<>0 THEN RAISE EXCEPTION 'X2 FAILED: leaked a record count'; END IF;

  blocked := FALSE;
  BEGIN PERFORM purge_deleted_expenses(G); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'X3 outsider cannot clear a group''s records | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'X3 FAILED: an outsider erased group records'; END IF;

  blocked := FALSE;
  BEGIN PERFORM purge_deleted_expense(E); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'X4 outsider cannot erase one record | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'X4 FAILED'; END IF;

  RAISE NOTICE 'X5 outsider sees no shared records with a stranger | pass=%', friend_record_count(ANN)=0;
  IF friend_record_count(ANN)<>0 THEN RAISE EXCEPTION 'X5 FAILED'; END IF;

  -- ---- A member who is not an admin ----
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT COUNT(*) INTO n FROM group_contribution_stats(G);
  RAISE NOTICE 'X6 a member does see the figures | pass=% (% rows)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'X6 FAILED: member got % rows', n; END IF;

  RAISE NOTICE 'X7 a member can see what is waiting to be cleared | pass=%', deleted_expense_count(G)=1;
  IF deleted_expense_count(G)<>1 THEN RAISE EXCEPTION 'X7 FAILED'; END IF;

  -- ---- Removing somebody you were never connected to ----
  PERFORM set_config('request.jwt.claim.sub', EVE::TEXT, true);
  PERFORM remove_friend(ANN);          -- a no-op, not an error
  RAISE NOTICE 'X8 removing a non-friend is harmless | pass=t';

  -- Read back as a member: RLS hides the group from Eve entirely, so counting
  -- as her would return zero whether or not anything had been destroyed.
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G;
  RAISE NOTICE 'X9 and touches nothing | pass=% (% members)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'X9 FAILED: membership changed to %', n; END IF;

  -- ---- Erasing keeps the settlement history it is not part of ----
  taxi := save_expense(G,'Taxi',400,ANN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',200,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',200,'is_included',true)),'[]'::jsonb);
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(G,ANN,200,'','CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  SELECT purge_deleted_expenses(G) INTO n;
  RAISE NOTICE 'X10 cleared % deleted record(s)', n;

  SELECT COUNT(*) INTO n FROM group_settlements WHERE group_id=G;
  RAISE NOTICE 'X11 the payment record survives | pass=% (%)', n=1, n;
  IF n<>1 THEN RAISE EXCEPTION 'X11 FAILED: erasing records destroyed payment history'; END IF;

  SELECT COALESCE(SUM(out_paid),0) INTO total FROM group_contribution_stats(G);
  RAISE NOTICE 'X12 the chart counts only what is left | pass=% (%)', total=400, total;
  IF total<>400 THEN RAISE EXCEPTION 'X12 FAILED: chart says % of 400', total; END IF;

  -- ---- The new stats rule, seen from the analytics query's angle ----
  SELECT COUNT(*) INTO n
  FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
  WHERE s.user_id=BEN AND e.id=taxi AND s.is_included AND s.include_in_stats;
  RAISE NOTICE 'X13 a group share lands in the other member''s charts | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'X13 FAILED: group share not counted for Ben'; END IF;

  -- ---- What the Friends screen reads to list a shared bill ----
  -- It shows "your share X, theirs Y", which needs a member to be able to read
  -- the other person's split. If RLS only exposed your own row the other figure
  -- would silently read zero rather than fail.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT amount INTO total FROM expense_splits WHERE expense_id=taxi AND user_id=ANN;
  RAISE NOTICE 'X14 a member can read the other side''s share | pass=% (%)', total=200, total;
  IF total IS NULL OR total<>200 THEN
    RAISE EXCEPTION 'X14 FAILED: other side''s share read as % — the pair list would show zero', total;
  END IF;

  -- And an outsider still cannot.
  PERFORM set_config('request.jwt.claim.sub', EVE::TEXT, true);
  SELECT COUNT(*) INTO n FROM expense_splits WHERE expense_id=taxi;
  RAISE NOTICE 'X15 an outsider reads no splits at all | pass=% (% rows)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'X15 FAILED: leaked % split rows', n; END IF;

  RAISE NOTICE 'ALL ACCESS / CLEANUP BOUNDARY TESTS PASSED';
END $t$;
