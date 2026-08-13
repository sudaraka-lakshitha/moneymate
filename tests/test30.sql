\set ON_ERROR_STOP on
-- Changing a record after the fact needs the agreement of the people it
-- affects — because otherwise it is a way to cheat.
--
-- Record a 3,000 dinner, wait, quietly edit it to 6,000 and the other person's
-- balance moves with no warning. What this file mostly asserts is the negative:
-- while a change is waiting, nothing moves.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('a8000000-0000-0000-0000-00000000000a','ap_ann@t.lk','{"full_name":"Ann"}'),
   ('a8000000-0000-0000-0000-00000000000b','ap_ben@t.lk','{"full_name":"Ben"}'),
   ('a8000000-0000-0000-0000-00000000000c','ap_cara@t.lk','{"full_name":"Cara"}'),
   ('a8000000-0000-0000-0000-00000000000d','ap_dan@t.lk','{"full_name":"Dan"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('a8000000-0000-0000-0000-00000000000a','a8000000-0000-0000-0000-00000000000b','ap_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

-- Push a record's clock back so it is outside the ten minutes without the test
-- having to wait ten minutes.
CREATE OR REPLACE FUNCTION pg_temp.age(p_expense UUID, p_minutes INT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  UPDATE expenses SET updated_at = NOW() - (p_minutes || ' minutes')::INTERVAL,
                      created_at = NOW() - (p_minutes || ' minutes')::INTERVAL
  WHERE id = p_expense;
  EXECUTE 'SET ROLE authenticated';
END $$;

DO $t$
DECLARE
  ANN UUID:='a8000000-0000-0000-0000-00000000000a';
  BEN UUID:='a8000000-0000-0000-0000-00000000000b';
  CAR UUID:='a8000000-0000-0000-0000-00000000000c';
  DAN UUID:='a8000000-0000-0000-0000-00000000000d';
  grp UUID; pair UUID; e UUID; req UUID; st TEXT; n INT; blocked BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  grp := (create_group('Trip','','✈️')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (grp,BEN,'MEMBER'),(grp,CAR,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  -- ---- Inside the ten minutes ----

  e := save_expense(grp,'Dinner',3000,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',1000,'is_included',true)),'[]'::jsonb);

  -- A1: a typo caught straight away just gets fixed
  st := update_expense(e,'Dinner',3300,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1100,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',1100,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',1100,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'A1 a fresh record can be corrected outright | pass=% (%)', st='APPLIED', st;
  IF st<>'APPLIED' THEN RAISE EXCEPTION 'A1 FAILED: %', st; END IF;
  RAISE NOTICE 'A1b and the balance follows | pass=% (%)',
    member_balance(grp,BEN)=-1100, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>-1100 THEN RAISE EXCEPTION 'A1b FAILED: %', member_balance(grp,BEN); END IF;

  -- ---- Outside it ----

  PERFORM pg_temp.age(e, 30);

  -- A2: now the same edit only asks
  st := update_expense(e,'Dinner',6000,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',2000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',2000,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',2000,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'A2 an old record can only be proposed | pass=% (%)', st='PENDING', st;
  IF st<>'PENDING' THEN RAISE EXCEPTION 'A2 FAILED: %', st; END IF;

  -- A3: and until it is agreed, nothing has moved. This is the whole point.
  RAISE NOTICE 'A3 the balance does not budge while it waits | pass=% (%)',
    member_balance(grp,BEN)=-1100, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>-1100 THEN
    RAISE EXCEPTION 'A3 FAILED: balance moved to % before anybody agreed', member_balance(grp,BEN);
  END IF;
  SELECT amount INTO n FROM expenses WHERE id = e;
  RAISE NOTICE 'A3b nor has the record itself | pass=% (%)', n=3300, n;
  IF n<>3300 THEN RAISE EXCEPTION 'A3b FAILED: the record already says %', n; END IF;

  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';

  -- A4: the person asking cannot wave it through themselves
  blocked := FALSE;
  BEGIN PERFORM vote_on_expense_change(req, TRUE); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'A4 you cannot approve your own change | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'A4 FAILED: approved their own edit'; END IF;

  -- A5: nor can somebody the record has nothing to do with
  PERFORM set_config('request.jwt.claim.sub', DAN::TEXT, true);
  blocked := FALSE;
  BEGIN PERFORM vote_on_expense_change(req, TRUE); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'A5 an outsider cannot vote | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'A5 FAILED: a stranger voted'; END IF;

  -- A6: two others, so one approval is not yet a majority — floor(2/2)+1 = 2
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  st := vote_on_expense_change(req, TRUE);
  RAISE NOTICE 'A6 one of two is not a majority | pass=% (%)', st='PENDING', st;
  IF st<>'PENDING' THEN RAISE EXCEPTION 'A6 FAILED: %', st; END IF;
  RAISE NOTICE 'A6b and still nothing has moved | pass=% (%)',
    member_balance(grp,BEN)=-1100, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>-1100 THEN RAISE EXCEPTION 'A6b FAILED'; END IF;

  -- A7: the second one carries it
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  st := vote_on_expense_change(req, TRUE);
  RAISE NOTICE 'A7 the majority applies it | pass=% (%)', st='APPROVED', st;
  IF st<>'APPROVED' THEN RAISE EXCEPTION 'A7 FAILED: %', st; END IF;

  -- A8: now it has moved, and by exactly the right amount
  RAISE NOTICE 'A8 the balance moves once, on approval | pass=% (%)',
    member_balance(grp,BEN)=-2000, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>-2000 THEN RAISE EXCEPTION 'A8 FAILED: %', member_balance(grp,BEN); END IF;

  -- A9: and the ledger is still whole
  SELECT COALESCE(SUM(amount),0) INTO n FROM ledger_entries WHERE group_id = grp;
  RAISE NOTICE 'A9 the ledger still nets to zero | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'A9 FAILED: %', n; END IF;

  -- A10: the edit is on the audit trail like any other
  SELECT COUNT(*) INTO n FROM expense_edits WHERE expense_id = e;
  RAISE NOTICE 'A10 an approved edit is audited | pass=% (%)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'A10 FAILED: % audit rows', n; END IF;

  -- ---- Turning one down ----

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM pg_temp.age(e, 30);
  st := update_expense(e,'Dinner',9000,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',3000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',3000,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',3000,'is_included',true)),'[]'::jsonb);
  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';

  -- A11: a majority becomes unreachable as soon as one of two says no
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  st := vote_on_expense_change(req, FALSE);
  RAISE NOTICE 'A11 refused as soon as a majority is impossible | pass=% (%)', st='REJECTED', st;
  IF st<>'REJECTED' THEN RAISE EXCEPTION 'A11 FAILED: %', st; END IF;

  -- A12: and the record is exactly as it was
  SELECT amount INTO n FROM expenses WHERE id = e;
  RAISE NOTICE 'A12 a refused change leaves no trace | pass=% (% / balance %)',
    n=6000 AND member_balance(grp,BEN)=-2000, n, member_balance(grp,BEN);
  IF n<>6000 OR member_balance(grp,BEN)<>-2000 THEN
    RAISE EXCEPTION 'A12 FAILED: amount % balance %', n, member_balance(grp,BEN);
  END IF;

  -- ---- Deleting ----

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM pg_temp.age(e, 30);
  st := delete_expense(e, 'changed my mind');
  RAISE NOTICE 'A13 deleting an old record also asks | pass=% (%)', st='PENDING', st;
  IF st<>'PENDING' THEN RAISE EXCEPTION 'A13 FAILED: %', st; END IF;

  SELECT COUNT(*) INTO n FROM expenses WHERE id = e AND NOT is_deleted;
  RAISE NOTICE 'A13b and the record is still there | pass=% (balance %)',
    n=1 AND member_balance(grp,BEN)=-2000, member_balance(grp,BEN);
  IF n<>1 OR member_balance(grp,BEN)<>-2000 THEN RAISE EXCEPTION 'A13b FAILED'; END IF;

  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';

  -- A14: the person who asked can withdraw it
  st := cancel_expense_change(req);
  RAISE NOTICE 'A14 the requester can withdraw | pass=% (%)', st='CANCELLED', st;
  IF st<>'CANCELLED' THEN RAISE EXCEPTION 'A14 FAILED: %', st; END IF;

  -- A15: and only they can
  PERFORM pg_temp.age(e, 30);
  PERFORM delete_expense(e, 'really this time');
  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  blocked := FALSE;
  BEGIN PERFORM cancel_expense_change(req); EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'A15 nobody else can withdraw it | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'A15 FAILED'; END IF;

  -- A16: approved, the delete goes through and unwinds the balance
  st := vote_on_expense_change(req, TRUE);
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  st := vote_on_expense_change(req, TRUE);
  RAISE NOTICE 'A16 an approved delete goes through | pass=% (%)', st='APPROVED', st;
  IF st<>'APPROVED' THEN RAISE EXCEPTION 'A16 FAILED: %', st; END IF;
  RAISE NOTICE 'A16b and unwinds the balance | pass=% (%)',
    member_balance(grp,BEN)=0, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>0 THEN RAISE EXCEPTION 'A16b FAILED: %', member_balance(grp,BEN); END IF;

  -- ---- Settlement landing mid-request ----

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  e := save_expense(grp,'Taxi',600,ANN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true)),'[]'::jsonb);
  PERFORM pg_temp.age(e, 30);
  PERFORM update_expense(e,'Taxi',900,ANN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',450,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',450,'is_included',true)),'[]'::jsonb);
  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';

  -- Ben settles up while the request is still waiting, which locks the record
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(grp, ANN, 300, '', 'CASH');

  -- A17: the approval then finds a settled record and drops the change rather
  -- than reopening a paid-up balance
  st := vote_on_expense_change(req, TRUE);
  RAISE NOTICE 'A17 a settlement landing mid-request cancels it | pass=% (%)', st='CANCELLED', st;
  IF st<>'CANCELLED' THEN RAISE EXCEPTION 'A17 FAILED: %', st; END IF;
  SELECT amount INTO n FROM expenses WHERE id = e;
  RAISE NOTICE 'A17b and the settled record is unchanged | pass=% (%)', n=600, n;
  IF n<>600 THEN RAISE EXCEPTION 'A17b FAILED: %', n; END IF;

  -- ---- Between two people, where a majority means unanimity ----

  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  e := add_direct_expense(BEN, 3000, 'Dinner', TRUE, 1500, FALSE, 'FOOD');
  pair := direct_group_with(BEN);
  PERFORM pg_temp.age(e, 30);

  -- A18: with one other person, that person's yes is the whole majority
  st := update_direct_expense(e, 6000, 'Dinner', TRUE, 3000, FALSE, 'FOOD');
  RAISE NOTICE 'A18 a pair edit has to be asked too | pass=% (%)', st='PENDING', st;
  IF st<>'PENDING' THEN RAISE EXCEPTION 'A18 FAILED: %', st; END IF;
  RAISE NOTICE 'A18b and 1,500 does not quietly become 3,000 | pass=% (%)',
    member_balance(pair,ANN)=1500, member_balance(pair,ANN);
  IF member_balance(pair,ANN)<>1500 THEN
    RAISE EXCEPTION 'A18b FAILED: balance already reads %', member_balance(pair,ANN);
  END IF;

  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  st := vote_on_expense_change(req, FALSE);
  RAISE NOTICE 'A19 one no is enough between two people | pass=% (%)', st='REJECTED', st;
  IF st<>'REJECTED' THEN RAISE EXCEPTION 'A19 FAILED: %', st; END IF;
  RAISE NOTICE 'A19b and the record stands | pass=% (%)',
    member_balance(pair,ANN)=1500, member_balance(pair,ANN);
  IF member_balance(pair,ANN)<>1500 THEN RAISE EXCEPTION 'A19b FAILED'; END IF;

  -- A20: a record nobody else is on has nobody to ask
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  e := save_expense(grp,'My own',400,ANN,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',400,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',0,'is_included',false)),'[]'::jsonb);
  PERFORM pg_temp.age(e, 30);
  st := update_expense(e,'My own',500,ANN,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',0,'is_included',false)),'[]'::jsonb);
  RAISE NOTICE 'A20 a record only you are on needs no approval | pass=% (%)', st='APPLIED', st;
  IF st<>'APPLIED' THEN RAISE EXCEPTION 'A20 FAILED: %', st; END IF;

  -- A21: one open request at a time
  e := save_expense(grp,'Hotel',1000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',500,'is_included',true)),'[]'::jsonb);
  PERFORM pg_temp.age(e, 30);
  PERFORM update_expense(e,'Hotel',1200,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',600,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',600,'is_included',true)),'[]'::jsonb);
  blocked := FALSE;
  BEGIN
    PERFORM update_expense(e,'Hotel',1500,ANN,'ACCOMMODATION','EQUAL','',
      jsonb_build_array(
        jsonb_build_object('user_id',ANN,'amount',750,'is_included',true),
        jsonb_build_object('user_id',BEN,'amount',750,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'A21 only one change can be waiting at a time | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'A21 FAILED: two open requests on one record'; END IF;

  -- A22: an approved edit does not reopen an unguarded ten minutes. The clock
  -- runs from the last change, so the next edit is asked about too.
  SELECT id INTO req FROM expense_change_requests WHERE expense_id = e AND status='PENDING';
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM vote_on_expense_change(req, TRUE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  RAISE NOTICE 'A22 an approved edit leaves the record fresh again | pass=%',
    expense_in_grace(e);
  IF NOT expense_in_grace(e) THEN
    RAISE EXCEPTION 'A22 FAILED: the clock did not restart on approval';
  END IF;

  -- A23: the screen can see what it has to draw
  SELECT COUNT(*) INTO n FROM pending_changes_for_group(grp);
  RAISE NOTICE 'A23 nothing left waiting | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'A23 FAILED: % still open', n; END IF;

  -- A24: the ungated bodies are not reachable from a client. Everything above
  -- rests on this: apply_expense_edit skips the authorship check, the settled
  -- lock and the ten minutes, so a client able to call it directly could walk
  -- past every rule in this file. Postgres grants EXECUTE to PUBLIC by default,
  -- which is exactly how this would happen by accident.
  IF has_function_privilege('authenticated', 'public.apply_expense_edit(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A24 FAILED: a client can apply an edit with no approval at all';
  END IF;
  IF has_function_privilege('authenticated', 'public.apply_expense_delete(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A24 FAILED: a client can delete with no approval at all';
  END IF;
  RAISE NOTICE 'A24 the ungated bodies are out of a client''s reach | pass=t';

  RAISE NOTICE 'ALL CHANGE-APPROVAL TESTS PASSED';
END $t$;
