\set ON_ERROR_STOP on

-- ============================================================
-- END-TO-END: FRIENDS (no group anywhere in this file)
-- Connect, lend, borrow, split a bill directly, correct a record,
-- part-pay, and have the lender record the final repayment.
-- ============================================================

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('20000000-0000-0000-0000-00000000000a','f_ann@t.lk',  '{"full_name":"Ann"}'),
   ('20000000-0000-0000-0000-00000000000b','f_kav@t.lk',  '{"full_name":"Kavya"}'),
   ('20000000-0000-0000-0000-00000000000e','f_eve@t.lk',  '{"full_name":"Eve"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;

SET ROLE authenticated;

DO $t$
DECLARE
  ANN UUID:='20000000-0000-0000-0000-00000000000a';
  KAV UUID:='20000000-0000-0000-0000-00000000000b';
  EVE UUID:='20000000-0000-0000-0000-00000000000e';
  fr UUID; st TEXT; g UUID; e1 UUID; e2 UUID;
  n INT; net DECIMAL; bA DECIMAL; bK DECIMAL; f BOOLEAN; theirs DECIMAL;
  pass INT := 0;
BEGIN
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. Ann sends Kavya a friend request ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT out_status,out_request_id INTO st,fr FROM send_friend_request('F_KAV@t.lk');
  IF st<>'SENT' THEN RAISE EXCEPTION 'request failed: %', st; END IF;

  -- A pending request already makes the profile readable, or the row shows blank
  SELECT COUNT(*) INTO n FROM users WHERE id=KAV;
  IF n<>1 THEN RAISE EXCEPTION 'pending friend profile hidden'; END IF;
  RAISE NOTICE '  ✓ sent, and the profile is readable straight away';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 2. Duplicate and self requests refused ---';
  SELECT out_status INTO st FROM send_friend_request('f_kav@t.lk');
  IF st<>'ALREADY_PENDING' THEN RAISE EXCEPTION 'duplicate not caught: %', st; END IF;
  SELECT out_status INTO st FROM send_friend_request('f_ann@t.lk');
  IF st<>'SELF' THEN RAISE EXCEPTION 'self request not caught: %', st; END IF;
  RAISE NOTICE '  ✓ duplicate and self both refused';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 3. Kavya accepts ---';
  PERFORM set_config('request.jwt.claim.sub', KAV::TEXT, true);
  PERFORM respond_to_friend_request(fr, TRUE);
  SELECT COUNT(*) INTO n FROM friend_requests WHERE id=fr AND status='ACCEPTED';
  IF n<>1 THEN RAISE EXCEPTION 'acceptance did not stick'; END IF;

  -- visible in both directions, sharing no group at all
  SELECT COUNT(*) INTO n FROM users WHERE id=ANN;
  IF n<>1 THEN RAISE EXCEPTION 'friend cannot see requester'; END IF;
  RAISE NOTICE '  ✓ connected, mutually visible, no group involved';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 4. Ann lends Kavya 5000 ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  e1 := lend_to_friend(KAV, 5000, 'Emergency', TRUE);
  g  := direct_group_with(KAV);
  bA := member_balance(g,ANN); bK := member_balance(g,KAV);
  IF bA<>5000 OR bK<>-5000 THEN RAISE EXCEPTION 'loan wrong: Ann=% Kav=%', bA,bK; END IF;
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=g;
  IF net<>0 THEN RAISE EXCEPTION 'loan ledger drifted: %', net; END IF;
  RAISE NOTICE '  ✓ Kavya owes 5000, ledger nets zero, no group created by hand';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 5. Ann borrows 1200 back ---';
  PERFORM lend_to_friend(KAV, 1200, 'She covered lunch', FALSE);
  bA := member_balance(g,ANN);
  IF bA<>3800 THEN RAISE EXCEPTION 'borrow did not net off: %', bA; END IF;
  RAISE NOTICE '  ✓ nets against the loan, Ann now owed 3800';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 6. A shared bill, split unevenly ---';
  e2 := add_direct_expense(KAV, 2000, 'Drinks', TRUE, 1500);
  bA := member_balance(g,ANN);
  IF bA<>5300 THEN RAISE EXCEPTION 'uneven direct split wrong: %', bA; END IF;

  -- the stored split is what the edit form will read back
  SELECT amount INTO theirs FROM expense_splits WHERE expense_id=e2 AND user_id=KAV;
  IF theirs<>1500 THEN RAISE EXCEPTION 'stored share wrong: %', theirs; END IF;
  RAISE NOTICE '  ✓ 1500/500 split stored exactly as entered';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 7. Correct that bill twice ---';
  PERFORM update_direct_expense(e2, 2400, 'Drinks + tip', TRUE, 1800);
  PERFORM update_direct_expense(e2, 2400, 'Drinks + tip', FALSE, 1800);
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=g;
  IF net<>0 THEN RAISE EXCEPTION 'REGRESSION: repeated direct edit moved money: %', net; END IF;
  -- Kavya paid 2400, her share 1800 => Ann owes 600 on this bill.
  -- Running total: 3800 - 600 = 3200
  bA := member_balance(g,ANN);
  IF bA<>3200 THEN RAISE EXCEPTION 'balance after 2 edits wrong: %', bA; END IF;
  RAISE NOTICE '  ✓ edited twice incl. flipping payer, Ann owed 3200, ledger zero';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 8. Delete a record ---';
  PERFORM delete_expense(e2, 'double entered');
  bA := member_balance(g,ANN);
  IF bA<>3800 THEN RAISE EXCEPTION 'delete did not unwind cleanly: %', bA; END IF;
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=g;
  IF net<>0 THEN RAISE EXCEPTION 'delete broke the ledger: %', net; END IF;
  RAISE NOTICE '  ✓ deleting an edited record returns to 3800 exactly';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 9. Kavya part-pays 1800 ---';
  PERFORM set_config('request.jwt.claim.sub', KAV::TEXT, true);
  PERFORM record_settlement(g, ANN, 1800, 'part', 'CASH');
  bA := member_balance(g,ANN);
  IF bA<>2000 THEN RAISE EXCEPTION 'part payment wrong: %', bA; END IF;
  IF group_is_settled(g) THEN RAISE EXCEPTION 'settled while 2000 outstanding'; END IF;
  RAISE NOTICE '  ✓ 2000 still outstanding, not marked settled';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 10. Ann records the final 2000 received ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM record_payment_received(g, KAV, 2000, 'final', 'BANK');
  bA := member_balance(g,ANN); bK := member_balance(g,KAV);
  IF bA<>0 OR bK<>0 THEN RAISE EXCEPTION 'not clear: Ann=% Kav=%', bA,bK; END IF;
  IF NOT group_is_settled(g) THEN RAISE EXCEPTION 'not settled after full repayment'; END IF;
  SELECT COUNT(*) INTO n FROM group_settlements WHERE group_id=g;
  IF n<>2 THEN RAISE EXCEPTION 'payment history wrong: %', n; END IF;
  RAISE NOTICE '  ✓ lender recorded the repayment, both clear, 2 payments on record';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 11. Settled records are frozen ---';
  f:=FALSE;
  BEGIN PERFORM update_direct_expense(e1, 9999, 'sneaky', TRUE, 9999);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'settled loan was editable'; END IF;
  IF member_balance(g,ANN)<>0 THEN RAISE EXCEPTION 'blocked edit moved money'; END IF;
  RAISE NOTICE '  ✓ refused, balance still zero';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 12. Lending again reuses the same ledger ---';
  PERFORM lend_to_friend(KAV, 700, 'New one', TRUE);
  SELECT COUNT(*) INTO n FROM groups WHERE is_direct
    AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=groups.id AND m.user_id=ANN)
    AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=groups.id AND m.user_id=KAV);
  IF n<>1 THEN RAISE EXCEPTION 'a second pair group appeared: %', n; END IF;
  IF member_balance(g,ANN)<>700 THEN RAISE EXCEPTION 'new loan wrong: %', member_balance(g,ANN); END IF;
  RAISE NOTICE '  ✓ one pair ledger reused, not a new group per cycle';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 13. Eve (a stranger) sees none of it ---';
  PERFORM set_config('request.jwt.claim.sub', EVE::TEXT, true);
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id=g;
  IF n<>0 THEN RAISE EXCEPTION 'stranger read the loans'; END IF;
  SELECT COUNT(*) INTO n FROM ledger_entries WHERE group_id=g;
  IF n<>0 THEN RAISE EXCEPTION 'stranger read the ledger'; END IF;
  SELECT COUNT(*) INTO n FROM group_settlements WHERE group_id=g;
  IF n<>0 THEN RAISE EXCEPTION 'stranger read the payments'; END IF;
  f:=FALSE;
  BEGIN PERFORM lend_to_friend(ANN, 1, 'hijack', FALSE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  RAISE NOTICE '  ✓ stranger sees nothing of the pair''s records';
  pass:=pass+1;

  RAISE NOTICE '';
  RAISE NOTICE '=== FRIENDS E2E: %/13 STAGES PASSED ===', pass;
  IF pass<>13 THEN RAISE EXCEPTION 'incomplete'; END IF;
END $t$;
