\set ON_ERROR_STOP on

-- ============================================================
-- END-TO-END: YOUR OWN EXPENSES
-- Personal tracker, budgets, recurring entries, analytics inputs,
-- and the privacy line around all of it.
-- ============================================================

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('30000000-0000-0000-0000-00000000000a','o_ann@t.lk','{"full_name":"Ann"}'),
   ('30000000-0000-0000-0000-00000000000b','o_bob@t.lk','{"full_name":"Bob"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;

SET ROLE authenticated;

DO $t$
DECLARE
  ANN UUID:='30000000-0000-0000-0000-00000000000a';
  BOB UUID:='30000000-0000-0000-0000-00000000000b';
  d1 UUID; d2 UUID; b1 UUID; r1 UUID;
  n INT; f BOOLEAN; amt DECIMAL; posted INT; nxt DATE; spent DECIMAL;
  v_month TEXT := to_char(CURRENT_DATE,'YYYY-MM');
  pass INT := 0;
BEGIN
  ------------------------------------------------------------------
  RAISE NOTICE '--- 1. Log a few personal expenses ---';
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  INSERT INTO daily_expenses (user_id,title,amount,category,date,note)
    VALUES (ANN,'Coffee',450,'FOOD',CURRENT_DATE,'flat white') RETURNING id INTO d1;
  INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'Tuk ride',300,'TRANSPORT',CURRENT_DATE) RETURNING id INTO d2;
  INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'Groceries',5200,'FOOD',CURRENT_DATE - 2);
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=ANN AND is_deleted=FALSE;
  IF n<>3 THEN RAISE EXCEPTION 'expected 3 entries, got %', n; END IF;
  RAISE NOTICE '  ✓ 3 entries logged';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 2. Edit one (the Tracker edit flow) ---';
  UPDATE daily_expenses
     SET title='Coffee + cake', amount=750, category='FOOD', note='shared'
   WHERE id=d1;
  SELECT amount INTO amt FROM daily_expenses WHERE id=d1;
  IF amt<>750 THEN RAISE EXCEPTION 'edit did not save: %', amt; END IF;
  RAISE NOTICE '  ✓ amount corrected 450 -> 750';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 3. Delete one (soft) ---';
  UPDATE daily_expenses SET is_deleted=TRUE, deleted_at=NOW() WHERE id=d2;
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=ANN AND is_deleted=FALSE;
  IF n<>2 THEN RAISE EXCEPTION 'delete count wrong: %', n; END IF;
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE id=d2;
  IF n<>1 THEN RAISE EXCEPTION 'row was hard-deleted'; END IF;
  RAISE NOTICE '  ✓ hidden from the list but still on record';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 4. Rubbish input is refused ---';
  f:=FALSE; BEGIN INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'Neg',-100,'FOOD',CURRENT_DATE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'negative amount accepted'; END IF;

  f:=FALSE; BEGIN INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'Zero',0,'FOOD',CURRENT_DATE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'zero amount accepted'; END IF;

  f:=FALSE; BEGIN INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'Bad cat',10,'NONSENSE',CURRENT_DATE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'unknown category accepted'; END IF;

  f:=FALSE; BEGIN INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'   ',10,'FOOD',CURRENT_DATE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'blank title accepted'; END IF;
  RAISE NOTICE '  ✓ negative, zero, unknown category and blank title all refused';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 5. Budgets ---';
  INSERT INTO budgets (user_id,category,monthly_limit,month)
    VALUES (ANN,'FOOD',10000,v_month) RETURNING id INTO b1;
  -- upsert path the Budgets sheet uses
  INSERT INTO budgets (user_id,category,monthly_limit,month) VALUES (ANN,'FOOD',12000,v_month)
    ON CONFLICT (user_id,category,month) DO UPDATE SET monthly_limit=EXCLUDED.monthly_limit;
  SELECT monthly_limit INTO amt FROM budgets WHERE id=b1;
  IF amt<>12000 THEN RAISE EXCEPTION 'budget upsert failed: %', amt; END IF;

  f:=FALSE; BEGIN INSERT INTO budgets (user_id,category,monthly_limit,month)
    VALUES (ANN,'TRANSPORT',-5,v_month); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'negative budget accepted'; END IF;
  RAISE NOTICE '  ✓ set, updated in place, negative refused';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 6. Spend vs budget adds up ---';
  SELECT COALESCE(SUM(amount),0) INTO spent
    FROM daily_expenses
   WHERE user_id=ANN AND is_deleted=FALSE AND category='FOOD'
     AND date >= date_trunc('month',CURRENT_DATE);
  -- Coffee+cake 750 (today) + Groceries 5200 (2 days ago, same month unless we
  -- are in the first two days) — assert only what is unambiguous.
  IF spent < 750 THEN RAISE EXCEPTION 'food total too low: %', spent; END IF;
  RAISE NOTICE '  ✓ FOOD spend this month = % against a 12000 budget', spent;
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 7. Recurring expense posts once, then holds ---';
  INSERT INTO recurring_expenses (user_id,group_id,title,amount,category,frequency,next_run)
    VALUES (ANN,NULL,'Rent',35000,'ACCOMMODATION','MONTHLY',CURRENT_DATE - 1)
    RETURNING id INTO r1;
  SELECT run_due_recurring() INTO posted;
  IF posted<>1 THEN RAISE EXCEPTION 'due recurring did not post: %', posted; END IF;
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=ANN AND title='Rent';
  IF n<>1 THEN RAISE EXCEPTION 'rent row missing'; END IF;

  SELECT run_due_recurring() INTO posted;
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=ANN AND title='Rent';
  IF n<>1 THEN RAISE EXCEPTION 'rent double-posted: %', n; END IF;
  SELECT next_run INTO nxt FROM recurring_expenses WHERE id=r1;
  IF nxt <= CURRENT_DATE THEN RAISE EXCEPTION 'next_run did not advance: %', nxt; END IF;
  RAISE NOTICE '  ✓ posted once, no double-post on relaunch, next run %', nxt;
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 8. Analytics reads what the app reads ---';
  -- personal side
  SELECT COALESCE(SUM(amount),0) INTO spent FROM daily_expenses
   WHERE user_id=ANN AND is_deleted=FALSE
     AND date >= CURRENT_DATE - 190;
  IF spent<=0 THEN RAISE EXCEPTION 'no personal spend for analytics'; END IF;
  -- group-share side must not error even with nothing to show
  SELECT COUNT(*) INTO n
    FROM expense_splits s JOIN expenses x ON x.id=s.expense_id
   WHERE s.user_id=ANN AND s.is_included AND x.is_deleted=FALSE;
  RAISE NOTICE '  ✓ personal total %, group-share rows % (both queryable)', spent, n;
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 9. Bob cannot see or touch any of it ---';
  PERFORM set_config('request.jwt.claim.sub', BOB::TEXT, true);
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=ANN;
  IF n<>0 THEN RAISE EXCEPTION 'PRIVACY: other user read the tracker'; END IF;
  SELECT COUNT(*) INTO n FROM budgets WHERE user_id=ANN;
  IF n<>0 THEN RAISE EXCEPTION 'PRIVACY: other user read the budgets'; END IF;
  SELECT COUNT(*) INTO n FROM recurring_expenses WHERE user_id=ANN;
  IF n<>0 THEN RAISE EXCEPTION 'PRIVACY: other user read the schedules'; END IF;

  UPDATE daily_expenses SET amount=1 WHERE id=d1;
  DELETE FROM daily_expenses WHERE id=d1;
  f:=FALSE; BEGIN INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (ANN,'Forged',999,'FOOD',CURRENT_DATE); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'PRIVACY: wrote a row owned by someone else'; END IF;

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT amount INTO amt FROM daily_expenses WHERE id=d1;
  IF amt IS NULL THEN RAISE EXCEPTION 'PRIVACY: other user deleted my entry'; END IF;
  IF amt<>750 THEN RAISE EXCEPTION 'PRIVACY: other user changed my amount: %', amt; END IF;
  RAISE NOTICE '  ✓ invisible, untouchable, unforgeable';
  pass:=pass+1;

  ------------------------------------------------------------------
  RAISE NOTICE '--- 10. Bob running the recurring job posts nothing of mine ---';
  PERFORM set_config('request.jwt.claim.sub', BOB::TEXT, true);
  SELECT run_due_recurring() INTO posted;
  IF posted<>0 THEN RAISE EXCEPTION 'other user posted my recurring: %', posted; END IF;
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=ANN AND title='Rent';
  IF n<>1 THEN RAISE EXCEPTION 'rent posted again by someone else: %', n; END IF;
  RAISE NOTICE '  ✓ recurring stays per-user';
  pass:=pass+1;

  RAISE NOTICE '';
  RAISE NOTICE '=== OWN EXPENSES E2E: %/10 STAGES PASSED ===', pass;
  IF pass<>10 THEN RAISE EXCEPTION 'incomplete'; END IF;
END $t$;
