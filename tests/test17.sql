\set ON_ERROR_STOP on
-- Remove friend, what counts as spending, and group contribution stats.
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

  -- ===== what a group bill counts for =====

  -- L1: a bill lands on everyone it names, at once
  e1 := save_expense(G,'Hotel',900,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true)),'[]'::jsonb);

  SELECT COUNT(*) INTO n FROM expense_splits WHERE expense_id=e1 AND is_included;
  RAISE NOTICE 'L1 everyone named is on the bill | pass=% (%)', n=3, n;
  IF n<>3 THEN RAISE EXCEPTION 'L1 failed: % included shares', n; END IF;

  -- L2: and it is their spending straight away — being asked to approve each
  -- bill your own group adds is noise, not consent
  SELECT COALESCE(SUM(s.amount),0) INTO shr
  FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
  WHERE s.user_id=BEN AND s.is_included AND NOT e.is_deleted AND NOT e.is_loan;
  RAISE NOTICE 'L2 a group share counts without asking | pass=% (%)', shr=300, shr;
  IF shr<>300 THEN RAISE EXCEPTION 'L2 failed: Ben''s spending reads %', shr; END IF;

  -- L3: the record itself is readable by everyone on it
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT COUNT(*) INTO n FROM expenses WHERE id=e1;
  IF n<>1 THEN RAISE EXCEPTION 'L3 failed: the record was blocked'; END IF;
  SELECT amount INTO shr FROM expense_splits WHERE expense_id=e1 AND user_id=BEN;
  RAISE NOTICE 'L3 record readable by everyone on it | pass=% (share %)', n=1 AND shr=300, shr;
  IF shr<>300 THEN RAISE EXCEPTION 'L3 failed: share missing'; END IF;

  -- L4: and the money side says the same thing
  IF member_balance(G,BEN) <> -300 THEN
    RAISE EXCEPTION 'L4 failed: balance reads % against a 300 share', member_balance(G,BEN);
  END IF;
  RAISE NOTICE 'L4 balance agrees with the share | pass=t';

  -- L5: somebody left off a bill is charged nothing for it
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  e2 := save_expense(G,'Solo',100,CAR,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',CAR,'amount',100,'is_included',true)),'[]'::jsonb);
  SELECT COUNT(*) INTO n FROM expense_splits WHERE expense_id=e2 AND user_id=BEN AND is_included;
  RAISE NOTICE 'L5 nobody is charged for a bill they are off | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'L5 failed'; END IF;

  -- L6: a record between two people counts for both, same as a group bill
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM send_friend_request('s_cara@t.lk');
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  PERFORM respond_to_friend_request(
    (SELECT id FROM friend_requests WHERE requester_id=ANN AND addressee_id=CAR), TRUE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM add_direct_expense(CAR, 500, 'Split taxi', TRUE, 250, FALSE, 'TRANSPORT');
  SELECT COUNT(*) INTO n FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
   WHERE s.is_included AND NOT e.is_loan AND s.amount=250;
  RAISE NOTICE 'L6 a pair record counts for both | pass=% (%)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'L6 failed: % counted shares', n; END IF;

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
