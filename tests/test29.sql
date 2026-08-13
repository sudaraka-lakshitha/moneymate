\set ON_ERROR_STOP on
-- Drawing a line once everybody is square.
--
-- Two ways, and the difference matters: clearing it out destroys the records,
-- keeping history files them behind a closed cycle. Both are only allowed when
-- nothing is outstanding, and that condition is what keeps balances honest —
-- every closed cycle nets to zero per person for ever, so an unfiltered balance
-- still equals the current cycle's balance and member_balance never had to
-- learn cycles exist.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('f7000000-0000-0000-0000-00000000000a','fs_ann@t.lk','{"full_name":"Ann"}'),
   ('f7000000-0000-0000-0000-00000000000b','fs_ben@t.lk','{"full_name":"Ben"}'),
   ('f7000000-0000-0000-0000-00000000000c','fs_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('f7000000-0000-0000-0000-00000000000a','f7000000-0000-0000-0000-00000000000b','fs_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

-- What the group screen would list: this cycle's records only.
CREATE OR REPLACE FUNCTION pg_temp.current_records(p_group UUID) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INT FROM expenses e
  JOIN groups g ON g.id = e.group_id
  WHERE e.group_id = p_group AND NOT e.is_deleted
    AND e.cycle_id IS NOT DISTINCT FROM g.current_cycle_id;
$$;

DO $t$
DECLARE
  ANN UUID:='f7000000-0000-0000-0000-00000000000a';
  BEN UUID:='f7000000-0000-0000-0000-00000000000b';
  CAR UUID:='f7000000-0000-0000-0000-00000000000c';
  grp UUID; pair UUID; e UUID; cyc UUID; n INT; earlier INT; closed INT;
  blocked BOOLEAN; total DECIMAL;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  grp := (create_group('Flat','','🏠')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (grp,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  PERFORM save_expense(grp,'March rent',2000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',1000,'is_included',true)),'[]'::jsonb);
  PERFORM save_expense(grp,'March power',600,BEN,'UTILITIES','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true)),'[]'::jsonb);

  -- F1: you cannot draw a line while money is still owed across it
  blocked := FALSE;
  BEGIN PERFORM start_new_cycle(grp); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'F1 refused while a balance is outstanding | pass=% (balance %)',
    blocked, member_balance(grp,BEN);
  IF NOT blocked THEN
    RAISE EXCEPTION 'F1 FAILED: closed a cycle with % still owed', member_balance(grp,BEN);
  END IF;

  -- F2: clearing it out is refused on the same terms
  blocked := FALSE;
  BEGIN PERFORM purge_group_history(grp); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'F2 erasing is refused on the same terms | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'F2 FAILED: erased a group that was not settled'; END IF;

  -- Settle up: Ben owes 700
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(grp, ANN, 700, 'square', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  IF NOT group_is_settled(grp) THEN RAISE EXCEPTION 'setup: not settled'; END IF;

  -- F3: now the line can be drawn, keeping everything
  cyc := start_new_cycle(grp);
  RAISE NOTICE 'F3 a fresh cycle opens once square | pass=%', cyc IS NOT NULL;
  IF cyc IS NULL THEN RAISE EXCEPTION 'F3 FAILED'; END IF;

  -- F4: the current view is empty, which is the whole point
  RAISE NOTICE 'F4 the current view starts empty | pass=% (%)',
    pg_temp.current_records(grp)=0, pg_temp.current_records(grp);
  IF pg_temp.current_records(grp)<>0 THEN
    RAISE EXCEPTION 'F4 FAILED: % records still showing', pg_temp.current_records(grp);
  END IF;

  -- F5: and nothing was destroyed
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id = grp;
  RAISE NOTICE 'F5 the records are still there | pass=% (%)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'F5 FAILED: % records survived', n; END IF;

  SELECT out_current, out_earlier, out_closed INTO n, earlier, closed
  FROM group_cycle_info(grp);
  RAISE NOTICE 'F6 the screen is told what is where | pass=% (now % / earlier % / closed %)',
    n=0 AND earlier=2 AND closed=1, n, earlier, closed;
  IF n<>0 OR earlier<>2 OR closed<>1 THEN
    RAISE EXCEPTION 'F6 FAILED: now % earlier % closed %', n, earlier, closed;
  END IF;

  -- F7: the balance still reads zero, computed over the whole ledger. This is
  -- the assertion that says the money core did not have to change.
  RAISE NOTICE 'F7 balances are untouched and still square | pass=% (Ann % / Ben %)',
    member_balance(grp,ANN)=0 AND member_balance(grp,BEN)=0,
    member_balance(grp,ANN), member_balance(grp,BEN);
  IF member_balance(grp,ANN)<>0 OR member_balance(grp,BEN)<>0 THEN
    RAISE EXCEPTION 'F7 FAILED: Ann % Ben %', member_balance(grp,ANN), member_balance(grp,BEN);
  END IF;

  -- F8: the closed cycle nets to zero per person, for ever. That is what makes
  -- an unfiltered balance equal to the current cycle's balance.
  SELECT COALESCE(SUM(amount),0) INTO total FROM ledger_entries
  WHERE group_id = grp AND cycle_id IS DISTINCT FROM (SELECT current_cycle_id FROM groups WHERE id=grp);
  RAISE NOTICE 'F8 the closed cycle nets to zero | pass=% (%)', total=0, total;
  IF total<>0 THEN RAISE EXCEPTION 'F8 FAILED: a closed cycle carries %', total; END IF;

  -- F9: a new bill joins the new cycle and shows up straight away
  PERFORM save_expense(grp,'April rent',2000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',1000,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'F9 new records join the new cycle | pass=% (%)',
    pg_temp.current_records(grp)=1, pg_temp.current_records(grp);
  IF pg_temp.current_records(grp)<>1 THEN
    RAISE EXCEPTION 'F9 FAILED: % showing', pg_temp.current_records(grp);
  END IF;

  -- F10: and the balance is that bill alone, not the old ones over again
  RAISE NOTICE 'F10 the fresh balance is only the new bill | pass=% (%)',
    member_balance(grp,BEN)=-1000, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>-1000 THEN
    RAISE EXCEPTION 'F10 FAILED: %', member_balance(grp,BEN);
  END IF;

  -- F11: a second boundary cannot be drawn while that is outstanding
  blocked := FALSE;
  BEGIN PERFORM start_new_cycle(grp); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'F11 no second line while the new balance is open | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'F11 FAILED'; END IF;

  -- F12: only an admin may draw one
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(grp, ANN, 1000, '', 'CASH');
  blocked := FALSE;
  BEGIN PERFORM start_new_cycle(grp); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'F12 a plain member cannot start fresh | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'F12 FAILED: a member closed the group''s books'; END IF;
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- F13: erasing works too, and leaves the group standing with nothing owed
  PERFORM purge_group_history(grp);
  SELECT COUNT(*) INTO n FROM expenses WHERE group_id = grp;
  RAISE NOTICE 'F13 erasing clears the records | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'F13 FAILED: % left', n; END IF;
  RAISE NOTICE 'F13b and the group is still there, square | pass=% (%)',
    member_balance(grp,ANN)=0, member_balance(grp,ANN);
  IF member_balance(grp,ANN)<>0 THEN RAISE EXCEPTION 'F13b FAILED'; END IF;

  SELECT COUNT(*) INTO n FROM group_members WHERE group_id = grp;
  RAISE NOTICE 'F13c with everyone still in it | pass=% (%)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'F13c FAILED: % members', n; END IF;

  -- F14: a group with nothing in it has nothing to close off
  blocked := FALSE;
  BEGIN PERFORM start_new_cycle(grp); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'F14 nothing to close on an empty group | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'F14 FAILED'; END IF;

  -- ---- Between two people ----

  -- F15: the same line can be drawn on a pair record, which seats both of you
  -- as admin, so either of you can do it once you are square
  PERFORM add_direct_expense(BEN, 900, 'Dinner', TRUE, 450, FALSE, 'FOOD');
  pair := direct_group_with(BEN);
  blocked := FALSE;
  BEGIN PERFORM start_new_cycle(pair); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'F15 a pair refuses while 450 is owed | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'F15 FAILED'; END IF;

  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(pair, ANN, 450, '', 'CASH');
  cyc := start_new_cycle(pair);
  RAISE NOTICE 'F16 either side can start fresh once square | pass=%', cyc IS NOT NULL;
  IF cyc IS NULL THEN RAISE EXCEPTION 'F16 FAILED'; END IF;

  RAISE NOTICE 'F17 the pair view starts empty too | pass=% (%)',
    pg_temp.current_records(pair)=0, pg_temp.current_records(pair);
  IF pg_temp.current_records(pair)<>0 THEN
    RAISE EXCEPTION 'F17 FAILED: % showing', pg_temp.current_records(pair);
  END IF;

  SELECT COUNT(*) INTO n FROM expenses WHERE group_id = pair;
  RAISE NOTICE 'F18 with the record kept | pass=% (%)', n=1, n;
  IF n<>1 THEN RAISE EXCEPTION 'F18 FAILED: %', n; END IF;

  -- F19: an outsider is told nothing about any of it
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  SELECT COUNT(*) INTO n FROM group_cycle_info(grp);
  RAISE NOTICE 'F19 an outsider learns nothing | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'F19 FAILED'; END IF;

  RAISE NOTICE 'ALL FRESH-START TESTS PASSED';
END $t$;
