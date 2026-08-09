\set ON_ERROR_STOP on
-- Getting rid of things: removing a friend for good, and clearing out records
-- that were already deleted.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('80000000-0000-0000-0000-00000000000a','r_ann@t.lk','{"full_name":"Ann"}'),
   ('80000000-0000-0000-0000-00000000000b','r_ben@t.lk','{"full_name":"Ben"}'),
   ('80000000-0000-0000-0000-00000000000c','r_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at) VALUES
   ('80000000-0000-0000-0000-00000000000a','80000000-0000-0000-0000-00000000000b','r_ben@t.lk','ACCEPTED',NOW()),
   ('80000000-0000-0000-0000-00000000000a','80000000-0000-0000-0000-00000000000c','r_cara@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;
DO $t$
DECLARE
  ANN UUID:='80000000-0000-0000-0000-00000000000a';
  BEN UUID:='80000000-0000-0000-0000-00000000000b';
  CAR UUID:='80000000-0000-0000-0000-00000000000c';
  pair UUID; g UUID; e1 UUID; e2 UUID; n INT; net DECIMAL; blocked BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- ---- Removing a friend you still owe ----
  PERFORM lend_to_friend(BEN, 1500, 'Loan', TRUE);
  pair := direct_group_with(BEN);

  blocked := FALSE;
  BEGIN
    PERFORM remove_friend(BEN);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE;
  END;
  RAISE NOTICE 'R1 cannot remove a friend mid-debt | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'R1 FAILED: removed a friend with money outstanding'; END IF;

  -- ---- Settle, then remove: the pair record must not outlive the friendship ----
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(pair, ANN, 1500, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  RAISE NOTICE 'R2 records that would be lost | %', friend_record_count(BEN);
  IF friend_record_count(BEN) <> 1 THEN
    RAISE EXCEPTION 'R2 FAILED: expected 1 record, counted %', friend_record_count(BEN);
  END IF;

  -- History exists, so a plain removal must leave it alone: it is the other
  -- person's record too, and unfriending is one-sided.
  PERFORM remove_friend(BEN);
  SELECT COUNT(*) INTO n FROM groups WHERE id = pair;
  RAISE NOTICE 'R3 shared history survives a plain removal | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'R3 FAILED: erased shared history without being asked'; END IF;

  SELECT COUNT(*) INTO n FROM friend_requests
   WHERE (requester_id=ANN AND addressee_id=BEN) OR (requester_id=BEN AND addressee_id=ANN);
  RAISE NOTICE 'R4 the connection itself is gone | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'R4 FAILED'; END IF;

  -- ---- A friend with nothing between you leaves no trace at all ----
  -- Ann records a loan to Cara and then deletes it again, so the pair is square
  -- and nothing live is left between them.
  PERFORM lend_to_friend(CAR, 800, 'Loan', TRUE);
  pair := direct_group_with(CAR);
  SELECT id INTO e1 FROM expenses WHERE group_id=pair AND NOT is_deleted LIMIT 1;
  PERFORM delete_expense(e1, 'not needed');

  RAISE NOTICE 'R5 nothing live left | pass=%', friend_record_count(CAR)=0;
  IF friend_record_count(CAR)<>0 THEN RAISE EXCEPTION 'R5 FAILED'; END IF;

  PERFORM remove_friend(CAR);
  SELECT COUNT(*) INTO n FROM groups WHERE id = pair;
  RAISE NOTICE 'R6 empty pair record is torn down | pass=%', n=0;
  IF n<>0 THEN
    RAISE EXCEPTION 'R6 FAILED: removed friend still anchored to a pair group — they stay on the list';
  END IF;

  SELECT COUNT(*) INTO n FROM group_members WHERE user_id = CAR;
  RAISE NOTICE 'R7 and no membership is left behind | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'R7 FAILED: % stray memberships', n; END IF;

  -- ---- Clearing deleted records out of a real group ----
  g := (create_group('Trip','','✈️')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (g,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  e1 := save_expense(g,'Hotel',2000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1000,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',1000,'is_included',true)),'[]'::jsonb);
  e2 := save_expense(g,'Mistake',600,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true)),'[]'::jsonb);
  PERFORM delete_expense(e2, 'typo');

  RAISE NOTICE 'R8 one record waiting to be cleared | pass=%', deleted_expense_count(g)=1;
  IF deleted_expense_count(g)<>1 THEN RAISE EXCEPTION 'R8 FAILED: counted %', deleted_expense_count(g); END IF;

  -- Still owed, so clearing must be refused
  blocked := FALSE;
  BEGIN
    PERFORM purge_deleted_expenses(g);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE;
  END;
  RAISE NOTICE 'R9 refused while the group is unsettled | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'R9 FAILED: cleared records with money outstanding'; END IF;

  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(g, ANN, 1000, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  SELECT purge_deleted_expenses(g) INTO n;
  RAISE NOTICE 'R10 cleared % deleted record(s) | pass=%', n, n=1;
  IF n<>1 THEN RAISE EXCEPTION 'R10 FAILED: cleared % records', n; END IF;

  SELECT COUNT(*) INTO n FROM expenses WHERE id = e2;
  RAISE NOTICE 'R11 the deleted record is really gone | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'R11 FAILED'; END IF;

  SELECT COUNT(*) INTO n FROM expenses WHERE id = e1;
  RAISE NOTICE 'R12 the live record is untouched | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'R12 FAILED: cleared a record that was not deleted'; END IF;

  -- THE INVARIANT: clearing must not move a single rupee
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=g;
  RAISE NOTICE 'R13 ledger still nets to zero | pass=% (%)', net=0, net;
  IF net<>0 THEN RAISE EXCEPTION 'R13 FAILED: clearing moved money (net=%)', net; END IF;

  RAISE NOTICE 'R14 balances Ann=% Ben=%', member_balance(g,ANN), member_balance(g,BEN);
  IF member_balance(g,ANN)<>0 OR member_balance(g,BEN)<>0 THEN
    RAISE EXCEPTION 'R14 FAILED: balances shifted when deleted records were cleared';
  END IF;

  SELECT COUNT(*) INTO n FROM ledger_entries WHERE reference_id = e2;
  RAISE NOTICE 'R15 no orphaned ledger rows left | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'R15 FAILED: % orphaned entries', n; END IF;

  -- A member who is not an admin cannot do it
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  blocked := FALSE;
  BEGIN
    PERFORM purge_deleted_expenses(g);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE;
  END;
  RAISE NOTICE 'R16 only an admin can clear records | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'R16 FAILED: a plain member cleared group records'; END IF;

  RAISE NOTICE 'ALL REMOVAL / CLEANUP TESTS PASSED';
END $t$;
