\set ON_ERROR_STOP on

-- ============================================================
-- END-TO-END: GROUPS
-- A full trip, start to finish, the way people actually use it:
-- create, invite, join, spend unevenly, exclude someone, correct a
-- mistake, settle in parts, then clean up.
-- ============================================================

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('10000000-0000-0000-0000-00000000000a','g_ann@t.lk',  '{"full_name":"Ann"}'),
   ('10000000-0000-0000-0000-00000000000b','g_ben@t.lk',  '{"full_name":"Ben"}'),
   ('10000000-0000-0000-0000-00000000000c','g_cara@t.lk', '{"full_name":"Cara"}'),
   ('10000000-0000-0000-0000-00000000000d','g_dan@t.lk',  '{"full_name":"Dan"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;

SET ROLE authenticated;

DO $t$
DECLARE
  ANN  UUID:='10000000-0000-0000-0000-00000000000a';
  BEN  UUID:='10000000-0000-0000-0000-00000000000b';
  CARA UUID:='10000000-0000-0000-0000-00000000000c';
  DAN  UUID:='10000000-0000-0000-0000-00000000000d';
  G UUID; code TEXT; rid UUID; iid UUID; st TEXT;
  e_hotel UUID; e_food UUID; e_taxi UUID;
  n INT; net DECIMAL; bA DECIMAL; bB DECIMAL; bC DECIMAL; bD DECIMAL; f BOOLEAN;
  pass INT := 0;
BEGIN
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. Ann creates the trip ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Galle Trip','Beach weekend','🏖️')).id;
  SELECT invite_code INTO code FROM groups WHERE id=G;

  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND user_id=ANN AND role='ADMIN';
  IF n<>1 THEN RAISE EXCEPTION 'creator not seated as admin'; END IF;
  RAISE NOTICE '  ✓ created, creator is admin, code=%', code;
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 2. Ben joins by code, Ann approves ---';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT out_status INTO st FROM request_to_join_group(code);
  IF st<>'REQUESTED' THEN RAISE EXCEPTION 'join request failed: %', st; END IF;

  -- Ben must NOT see the group yet
  SELECT COUNT(*) INTO n FROM groups WHERE id=G;
  IF n<>0 THEN RAISE EXCEPTION 'pending requester could read the group'; END IF;

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT id INTO rid FROM group_join_requests WHERE group_id=G AND user_id=BEN AND status='PENDING';
  IF rid IS NULL THEN RAISE EXCEPTION 'admin cannot see the join request'; END IF;
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER');
  UPDATE group_join_requests SET status='APPROVED', reviewed_by=ANN, reviewed_at=NOW() WHERE id=rid;

  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT COUNT(*) INTO n FROM groups WHERE id=G;
  IF n<>1 THEN RAISE EXCEPTION 'approved member cannot read the group'; END IF;
  RAISE NOTICE '  ✓ request hidden before approval, visible after';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 3. Cara invited by email, accepts ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT out_status,out_invitation_id INTO st,iid FROM invite_to_group_by_email(G,'G_CARA@t.lk');
  IF st<>'INVITED' THEN RAISE EXCEPTION 'invite failed: %', st; END IF;
  PERFORM set_config('request.jwt.claim.sub', CARA::TEXT, true);
  PERFORM respond_to_group_invitation(iid, TRUE);
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND user_id=CARA;
  IF n<>1 THEN RAISE EXCEPTION 'invite acceptance did not seat Cara'; END IF;
  RAISE NOTICE '  ✓ case-insensitive email invite accepted';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 4. Dan (outsider) cannot get in or see anything ---';
  PERFORM set_config('request.jwt.claim.sub', DAN::TEXT, true);
  SELECT COUNT(*) INTO n FROM groups WHERE id=G;
  IF n<>0 THEN RAISE EXCEPTION 'outsider read the group'; END IF;
  -- With the policy removed this is refused outright rather than silently
  -- writing nothing, so the attempt has to be caught.
  f:=FALSE;
  BEGIN INSERT INTO group_members (group_id,user_id,role) VALUES (G,DAN,'ADMIN');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND user_id=DAN;
  IF n<>0 THEN RAISE EXCEPTION 'SECURITY: outsider self-joined as admin'; END IF;
  IF NOT f THEN RAISE EXCEPTION 'SECURITY: self-join was not refused'; END IF;
  RAISE NOTICE '  ✓ outsider blind and cannot self-join';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 5. Ann pays the hotel, split 3 ways ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  e_hotel := save_expense(G,'Hotel',9000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN, 'amount',3000,'is_included',true),
      jsonb_build_object('user_id',BEN, 'amount',3000,'is_included',true),
      jsonb_build_object('user_id',CARA,'amount',3000,'is_included',true)),'[]'::jsonb);
  IF member_balance(G,ANN)<>6000 THEN RAISE EXCEPTION 'hotel split wrong: %', member_balance(G,ANN); END IF;
  RAISE NOTICE '  ✓ Ann +6000, others -3000 each';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 6. Ben pays dinner, Cara excluded (did not eat) ---';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  e_food := save_expense(G,'Dinner',2000,BEN,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN, 'amount',1200,'is_included',true),
      jsonb_build_object('user_id',BEN, 'amount',800, 'is_included',true),
      jsonb_build_object('user_id',CARA,'amount',0,   'is_included',false)),'[]'::jsonb);
  SELECT COUNT(*) INTO n FROM ledger_entries WHERE reference_id=e_food AND user_id=CARA;
  IF n<>0 THEN RAISE EXCEPTION 'excluded member was charged'; END IF;
  RAISE NOTICE '  ✓ uneven split honoured, excluded member untouched';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 7. Cara pays taxi on behalf of the group ---';
  PERFORM set_config('request.jwt.claim.sub', CARA::TEXT, true);
  e_taxi := save_expense(G,'Taxi',900,CARA,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN, 'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN, 'amount',300,'is_included',true),
      jsonb_build_object('user_id',CARA,'amount',300,'is_included',true)),'[]'::jsonb);
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=G;
  IF net<>0 THEN RAISE EXCEPTION 'ledger drifted: %', net; END IF;
  RAISE NOTICE '  ✓ three expenses, ledger still nets to zero';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 8. Ben corrects the dinner amount (twice) ---';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM update_expense(e_food,'Dinner',2400,BEN,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN, 'amount',1400,'is_included',true),
      jsonb_build_object('user_id',BEN, 'amount',1000,'is_included',true),
      jsonb_build_object('user_id',CARA,'amount',0,   'is_included',false)),'[]'::jsonb);
  PERFORM update_expense(e_food,'Dinner + drinks',3000,BEN,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN, 'amount',1500,'is_included',true),
      jsonb_build_object('user_id',BEN, 'amount',1500,'is_included',true),
      jsonb_build_object('user_id',CARA,'amount',0,   'is_included',false)),'[]'::jsonb);

  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=G;
  IF net<>0 THEN RAISE EXCEPTION 'REGRESSION: repeated edit moved money, net=%', net; END IF;

  -- expected: Ann 6000 -1500 -300 = 4200 ; Ben -3000 +3000 -1500 -300 = -1800 ;
  -- Cara -3000 +900 -300 = -2400
  bA:=member_balance(G,ANN); bB:=member_balance(G,BEN); bC:=member_balance(G,CARA);
  IF bA<>4200 OR bB<>-1800 OR bC<>-2400 THEN
    RAISE EXCEPTION 'balances wrong after 2 edits: Ann=% Ben=% Cara=%', bA,bB,bC;
  END IF;
  RAISE NOTICE '  ✓ edited twice, Ann=% Ben=% Cara=%, ledger zero', bA,bB,bC;
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 9. Cara pays Ann in two parts ---';
  PERFORM set_config('request.jwt.claim.sub', CARA::TEXT, true);
  PERFORM record_settlement(G,ANN,1000,'part 1','CASH');
  IF member_balance(G,CARA)<>-1400 THEN RAISE EXCEPTION 'part payment wrong: %', member_balance(G,CARA); END IF;
  IF group_is_settled(G) THEN RAISE EXCEPTION 'group settled while money outstanding'; END IF;
  PERFORM record_settlement(G,ANN,1400,'part 2','BANK');
  IF member_balance(G,CARA)<>0 THEN RAISE EXCEPTION 'final part wrong: %', member_balance(G,CARA); END IF;
  RAISE NOTICE '  ✓ two part payments clear Cara exactly';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 10. Settled bills are frozen ---';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  f:=FALSE;
  BEGIN PERFORM update_expense(e_food,'Sneaky',9999,BEN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',9999,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'settled expense was editable'; END IF;

  -- Cara has paid her 2400, so Ann is down to 1800 and Ben still owes 1800.
  bA:=member_balance(G,ANN); bB:=member_balance(G,BEN);
  IF bA<>1800 OR bB<>-1800 THEN
    RAISE EXCEPTION 'blocked edit still moved money: Ann=% Ben=%', bA, bB;
  END IF;
  RAISE NOTICE '  ✓ edit refused and balances untouched';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 11. Ben settles; nobody can leave while owing ---';
  f:=FALSE; BEGIN PERFORM leave_group(G); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'member left while owing'; END IF;

  PERFORM record_settlement(G,ANN,1800,'settling','CASH');
  IF member_balance(G,BEN)<>0 THEN RAISE EXCEPTION 'Ben not clear'; END IF;
  RAISE NOTICE '  ✓ leave blocked while owing, allowed after paying';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 12. Everyone square, admin cleans up ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  IF NOT group_is_settled(G) THEN
    RAISE EXCEPTION 'group not settled: Ann=% Ben=% Cara=%',
      member_balance(G,ANN), member_balance(G,BEN), member_balance(G,CARA);
  END IF;

  PERFORM archive_group(G, TRUE);
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id=G;
  IF n<>3 THEN RAISE EXCEPTION 'archive destroyed data'; END IF;
  PERFORM archive_group(G, FALSE);
  RAISE NOTICE '  ✓ archive/restore round-trip keeps all 3 expenses';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 13. Purge history, group stays usable ---';
  PERFORM purge_group_history(G);
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id=G;
  IF n<>0 THEN RAISE EXCEPTION 'purge left expenses'; END IF;
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G;
  IF n<>3 THEN RAISE EXCEPTION 'purge removed members'; END IF;
  PERFORM save_expense(G,'Fresh start',300,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',150,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',150,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE '  ✓ purged, members kept, new expense accepted';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 14. Delete the group ---';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(G,ANN,150,'','CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM delete_group(G);
  SELECT COUNT(*) INTO n FROM groups WHERE id=G;
  IF n<>0 THEN RAISE EXCEPTION 'group survived delete'; END IF;
  SELECT COUNT(*) INTO n FROM ledger_entries WHERE group_id=G;
  IF n<>0 THEN RAISE EXCEPTION 'ledger survived delete'; END IF;
  RAISE NOTICE '  ✓ group and all its data removed';
  pass:=pass+1;

  RAISE NOTICE '';
  RAISE NOTICE '=== GROUPS E2E: %/14 STAGES PASSED ===', pass;
  IF pass<>14 THEN RAISE EXCEPTION 'incomplete'; END IF;
END $t$;
