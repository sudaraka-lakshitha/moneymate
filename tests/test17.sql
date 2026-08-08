\set ON_ERROR_STOP on
-- Remove friend, per-person stats opt-in, and group contribution stats.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('40000000-0000-0000-0000-00000000000a','s_ann@t.lk','{"full_name":"Ann"}'),
   ('40000000-0000-0000-0000-00000000000b','s_ben@t.lk','{"full_name":"Ben"}'),
   ('40000000-0000-0000-0000-00000000000c','s_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;

SET ROLE authenticated;

DO $t$
DECLARE
  ANN UUID:='40000000-0000-0000-0000-00000000000a';
  BEN UUID:='40000000-0000-0000-0000-00000000000b';
  CAR UUID:='40000000-0000-0000-0000-00000000000c';
  G UUID; e1 UUID; e2 UUID; fr UUID; st TEXT; g2 UUID;
  n INT; f BOOLEAN; v BOOLEAN; paid DECIMAL; shr DECIMAL; net DECIMAL; cnt INT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Stats','','📊')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER'),(G,CAR,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  -- ===== stats opt-in =====

  -- L1: Ann adds a bill and opts her own share IN
  e1 := save_expense(G,'Hotel',900,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true)),'[]'::jsonb);

  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=e1 AND user_id=ANN;
  RAISE NOTICE 'L1 creator''s own choice recorded | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'L1 failed'; END IF;

  -- L2: the others are left undecided, NOT silently counted
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=e1 AND user_id=BEN;
  RAISE NOTICE 'L2 other participants left undecided | pass=%', v IS NULL;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'L2 failed: someone else decided for Ben'; END IF;

  -- L3: but the expense itself exists for them regardless
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT COUNT(*) INTO n FROM expenses WHERE id=e1;
  IF n<>1 THEN RAISE EXCEPTION 'L3 failed: the record was blocked'; END IF;
  SELECT amount INTO shr FROM expense_splits WHERE expense_id=e1 AND user_id=BEN;
  RAISE NOTICE 'L3 record still added for everyone | pass=% (share %)', n=1 AND shr=300, shr;
  IF shr<>300 THEN RAISE EXCEPTION 'L3 failed: share missing'; END IF;

  -- L4: Ben's balance is unaffected by the stats question
  IF member_balance(G,BEN) <> -300 THEN
    RAISE EXCEPTION 'L4 failed: stats choice moved money (%)', member_balance(G,BEN);
  END IF;
  RAISE NOTICE 'L4 money side untouched by the stats question | pass=t';

  -- L5: Ben decides for himself
  PERFORM set_split_stats_choice(e1, TRUE);
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=e1 AND user_id=BEN;
  RAISE NOTICE 'L5 participant can opt in | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'L5 failed'; END IF;

  -- L6: and can opt back out
  PERFORM set_split_stats_choice(e1, FALSE);
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=e1 AND user_id=BEN;
  RAISE NOTICE 'L6 participant can opt out | pass=%', v IS FALSE;
  IF v IS NOT FALSE THEN RAISE EXCEPTION 'L6 failed'; END IF;

  -- L7: Ben cannot decide on Ann's behalf
  SELECT include_in_stats INTO v FROM expense_splits WHERE expense_id=e1 AND user_id=ANN;
  RAISE NOTICE 'L7 one person''s choice does not change another''s | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'L7 failed'; END IF;

  -- L8: no share in an expense means no choice to make
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  e2 := save_expense(G,'Solo',100,CAR,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',CAR,'amount',100,'is_included',true,'stats',false)),'[]'::jsonb);
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  f:=FALSE;
  BEGIN PERFORM set_split_stats_choice(e2, TRUE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  RAISE NOTICE 'L8 cannot opt into an expense you are not in | pass=%', f;
  IF NOT f THEN RAISE EXCEPTION 'L8 failed'; END IF;

  -- L9: bulk-answer everything outstanding
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  SELECT COUNT(*) INTO n FROM expense_splits WHERE user_id=CAR AND include_in_stats IS NULL;
  IF n<1 THEN RAISE EXCEPTION 'L9 setup: expected pending rows'; END IF;
  SELECT set_all_pending_stats_choices(TRUE) INTO cnt;
  SELECT COUNT(*) INTO n FROM expense_splits WHERE user_id=CAR AND include_in_stats IS NULL;
  RAISE NOTICE 'L9 bulk decision clears the queue | pass=% (answered %)', n=0, cnt;
  IF n<>0 THEN RAISE EXCEPTION 'L9 failed'; END IF;

  -- ===== group contribution stats =====

  -- L10: paid / share / net per member
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT out_paid,out_share,out_net,out_expenses INTO paid,shr,net,cnt
  FROM group_contribution_stats(G) WHERE out_user_id=ANN;
  RAISE NOTICE 'L10 Ann paid=% share=% net=% bills=%', paid,shr,net,cnt;
  IF paid<>900 OR shr<>300 OR net<>600 OR cnt<>1 THEN RAISE EXCEPTION 'L10 failed'; END IF;

  SELECT out_paid,out_share,out_net INTO paid,shr,net
  FROM group_contribution_stats(G) WHERE out_user_id=CAR;
  IF paid<>100 OR shr<>400 OR net<>-300 THEN
    RAISE EXCEPTION 'L10b failed: Cara paid=% share=% net=%', paid,shr,net;
  END IF;
  RAISE NOTICE 'L10b Cara paid=% share=% net=% | pass=t', paid,shr,net;

  -- L11: the paid column sums to the group total, so the pie is whole
  SELECT SUM(out_paid) INTO paid FROM group_contribution_stats(G);
  RAISE NOTICE 'L11 contributions sum to the group total | pass=% (%)', paid=1000, paid;
  IF paid<>1000 THEN RAISE EXCEPTION 'L11 failed: %', paid; END IF;

  -- L12: settlements must NOT count as contributions
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(G,ANN,300,'','CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT SUM(out_paid) INTO paid FROM group_contribution_stats(G);
  RAISE NOTICE 'L12 settling does not inflate contributions | pass=% (%)', paid=1000, paid;
  IF paid<>1000 THEN RAISE EXCEPTION 'L12 failed: %', paid; END IF;

  -- L13: an outsider gets nothing
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000009ff',true);
  SELECT COUNT(*) INTO n FROM group_contribution_stats(G);
  RAISE NOTICE 'L13 outsider sees no group stats | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'L13 failed'; END IF;

  -- ===== remove friend =====

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT out_status,out_request_id INTO st,fr FROM send_friend_request('s_ben@t.lk');
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM respond_to_friend_request(fr, TRUE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- L14: cannot unfriend while a direct balance is outstanding
  PERFORM lend_to_friend(BEN, 500, 'Loan', TRUE);
  g2 := direct_group_with(BEN);
  f:=FALSE; BEGIN PERFORM remove_friend(BEN); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  RAISE NOTICE 'L14 unfriend blocked while money outstanding | pass=%', f;
  IF NOT f THEN RAISE EXCEPTION 'L14 failed'; END IF;

  -- L15: settle, then it works
  PERFORM record_payment_received(g2, BEN, 500, '', 'CASH');
  PERFORM remove_friend(BEN);
  SELECT COUNT(*) INTO n FROM friend_requests
   WHERE (requester_id=ANN AND addressee_id=BEN) OR (requester_id=BEN AND addressee_id=ANN);
  RAISE NOTICE 'L15 unfriend once settled | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'L15 failed'; END IF;

  -- L16: the pin goes with it
  SELECT COUNT(*) INTO n FROM friend_pins WHERE user_id=ANN AND friend_id=BEN;
  RAISE NOTICE 'L16 pin removed with the friend | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'L16 failed'; END IF;

  -- L17: the shared history is not destroyed, just the connection
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id=g2;
  RAISE NOTICE 'L17 past records survive unfriending | pass=% (%)', n>0, n;
  IF n=0 THEN RAISE EXCEPTION 'L17 failed: history was destroyed'; END IF;

  -- L18: they can be added again afterwards
  SELECT out_status INTO st FROM send_friend_request('s_ben@t.lk');
  RAISE NOTICE 'L18 can re-add after removing | pass=% (%)', st IN ('SENT','ACCEPTED_EXISTING'), st;
  IF st NOT IN ('SENT','ACCEPTED_EXISTING') THEN RAISE EXCEPTION 'L18 failed: %', st; END IF;

  RAISE NOTICE 'ALL STATS / REMOVE-FRIEND TESTS PASSED';
END $t$;
