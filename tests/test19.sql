\set ON_ERROR_STOP on
-- What a departing member leaves behind in a group that keeps going.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('60000000-0000-0000-0000-00000000000a','z_ann@t.lk','{"full_name":"Ann"}'),
   ('60000000-0000-0000-0000-00000000000b','z_ben@t.lk','{"full_name":"Ben"}'),
   ('60000000-0000-0000-0000-00000000000c','z_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
SET ROLE authenticated;
DO $t$
DECLARE
  ANN UUID:='60000000-0000-0000-0000-00000000000a';
  BEN UUID:='60000000-0000-0000-0000-00000000000b';
  CAR UUID:='60000000-0000-0000-0000-00000000000c';
  G UUID; net DECIMAL; total DECIMAL; spend DECIMAL; n INT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Ongoing','','🏠')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER'),(G,CAR,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  -- Ben pays a 900 bill split three ways, then settles up and leaves for good.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM save_expense(G,'Ben''s bill',900,BEN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true,'stats',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true)),'[]'::jsonb);

  -- Ann pays her 300 back so Ben is square
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM record_settlement(G,BEN,300,'','CASH');
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  PERFORM record_settlement(G,BEN,300,'','CASH');

  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  IF member_balance(G,BEN) <> 0 THEN
    RAISE EXCEPTION 'setup: Ben not square (%)', member_balance(G,BEN);
  END IF;
  PERFORM delete_my_account();

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- O1: the group survives
  SELECT COUNT(*) INTO n FROM groups WHERE id=G;
  RAISE NOTICE 'O1 group survives a member deleting | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'O1 failed'; END IF;

  -- O2: THE INVARIANT — the ledger must still net to zero
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=G;
  RAISE NOTICE 'O2 ledger still nets to zero | pass=% (%)', net=0, net;
  IF net<>0 THEN RAISE EXCEPTION 'O2 FAILED: departing member broke the ledger (net=%)', net; END IF;

  -- O3: remaining members'' balances are untouched
  RAISE NOTICE 'O3 Ann=% Cara=%', member_balance(G,ANN), member_balance(G,CAR);
  IF member_balance(G,ANN)<>0 OR member_balance(G,CAR)<>0 THEN
    RAISE EXCEPTION 'O3 failed: balances shifted';
  END IF;

  -- O4: the group can still be settled/cleaned up
  RAISE NOTICE 'O4 group still settleable | pass=%', group_is_settled(G);
  IF NOT group_is_settled(G) THEN RAISE EXCEPTION 'O4 FAILED: group permanently stuck'; END IF;

  -- O5: the expense itself survives as history
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id=G AND NOT is_deleted;
  RAISE NOTICE 'O5 the bill remains on record | pass=% (%)', n=1, n;
  IF n<>1 THEN RAISE EXCEPTION 'O5 failed'; END IF;

  -- O6: contribution stats must still account for every rupee spent
  SELECT COALESCE(SUM(amount),0) INTO spend FROM expenses WHERE group_id=G AND NOT is_deleted;
  SELECT COALESCE(SUM(out_paid),0) INTO total FROM group_contribution_stats(G);
  RAISE NOTICE 'O6 contributions % vs spend % | pass=%', total, spend, total=spend;
  IF total<>spend THEN
    RAISE EXCEPTION 'O6 FAILED: % of % spending unattributed after a member left', spend-total, spend;
  END IF;

  -- The other way out of a group: removed by an admin, account still alive.
  -- Cara fronts 600 for the two of them, Ann pays her back, Ann removes her.
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  PERFORM save_expense(G,'Cara''s bill',600,CAR,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true,'stats',true)),'[]'::jsonb);

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM record_settlement(G,CAR,300,'','CASH');
  PERFORM remove_group_member(G,CAR);

  -- O7: she really is out
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND user_id=CAR;
  RAISE NOTICE 'O7 removed member is gone from the group | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'O7 failed'; END IF;

  -- O8: her spending is still attributed to her, by name
  SELECT COALESCE(SUM(amount),0) INTO spend FROM expenses WHERE group_id=G AND NOT is_deleted;
  SELECT COALESCE(SUM(out_paid),0) INTO total FROM group_contribution_stats(G);
  RAISE NOTICE 'O8 contributions % vs spend % | pass=%', total, spend, total=spend;
  IF total<>spend THEN
    RAISE EXCEPTION 'O8 FAILED: % of % unattributed after an admin removed a member', spend-total, spend;
  END IF;

  -- O9: and the chart names her rather than lumping her into the unknown bucket
  SELECT COUNT(*) INTO n FROM group_contribution_stats(G)
   WHERE out_user_id=CAR AND out_display_name LIKE 'Cara%' AND out_paid=600;
  RAISE NOTICE 'O9 removed member still named in the chart | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'O9 FAILED: removed member lost their name or their total'; END IF;

  RAISE NOTICE 'ALL DEPARTED-MEMBER TESTS PASSED';
END $t$;
