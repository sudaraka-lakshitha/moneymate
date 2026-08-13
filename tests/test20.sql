\set ON_ERROR_STOP on
-- What an edit does to the figures, and who may open a record against whom.
--
-- Nothing is asked any more: a share you are on is spending, a loan is not.
-- That makes an edit the only thing that can move a figure after the fact, so
-- this file follows a figure through one.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('70000000-0000-0000-0000-00000000000a','s_ann@t.lk','{"full_name":"Ann"}'),
   ('70000000-0000-0000-0000-00000000000b','s_ben@t.lk','{"full_name":"Ben"}'),
   ('70000000-0000-0000-0000-00000000000c','s_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('70000000-0000-0000-0000-00000000000a','70000000-0000-0000-0000-00000000000b','s_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

-- The figure the Stats screen puts on the page, asked for the way it asks.
CREATE OR REPLACE FUNCTION pg_temp.spend(p_for UUID) RETURNS DECIMAL
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(s.amount), 0)
  FROM expense_splits s
  JOIN expenses e ON e.id = s.expense_id
  WHERE s.user_id = p_for AND s.is_included AND NOT e.is_deleted AND NOT e.is_loan;
$$;

DO $t$
DECLARE
  ANN UUID:='70000000-0000-0000-0000-00000000000a';
  BEN UUID:='70000000-0000-0000-0000-00000000000b';
  CAR UUID:='70000000-0000-0000-0000-00000000000c';
  G UUID; E1 UUID; E2 UUID; D UUID; n INT; blocked BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Stats','','📊')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  E1 := save_expense(G,'Dinner',1000,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',500,'is_included',true)),'[]'::jsonb);

  -- P1: a bill counts for the person who typed it the moment it is saved
  RAISE NOTICE 'P1 the author is counted at once | pass=% (%)', pg_temp.spend(ANN)=500, pg_temp.spend(ANN);
  IF pg_temp.spend(ANN)<>500 THEN RAISE EXCEPTION 'P1 FAILED: %', pg_temp.spend(ANN); END IF;

  -- P2: and for everyone else on it, with nothing to approve. Being asked to
  -- confirm every bill your own group adds is noise, not consent.
  RAISE NOTICE 'P2 the other members too, unasked | pass=% (%)', pg_temp.spend(BEN)=500, pg_temp.spend(BEN);
  IF pg_temp.spend(BEN)<>500 THEN
    RAISE EXCEPTION 'P2 FAILED: Ben''s share reads % — something is still holding it back', pg_temp.spend(BEN);
  END IF;

  -- P3: an edit moves both figures, in step with the new shares
  PERFORM update_expense(E1,'Dinner',1200,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',600,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',600,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'P3 an edit follows through to both figures | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=600 AND pg_temp.spend(BEN)=600, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>600 OR pg_temp.spend(BEN)<>600 THEN
    RAISE EXCEPTION 'P3 FAILED: Ann % Ben %', pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;

  -- P4: an edit that drops somebody from the bill drops their figure with it
  E2 := save_expense(G,'Taxi',400,ANN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',200,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',200,'is_included',true)),'[]'::jsonb);
  IF pg_temp.spend(BEN)<>800 THEN RAISE EXCEPTION 'P4 setup: Ben reads %', pg_temp.spend(BEN); END IF;
  PERFORM update_expense(E2,'Taxi',400,ANN,'TRANSPORT','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',400,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',0,'is_included',false)),'[]'::jsonb);
  RAISE NOTICE 'P4 dropping somebody from a bill un-charges them | pass=% (%)',
    pg_temp.spend(BEN)=600, pg_temp.spend(BEN);
  IF pg_temp.spend(BEN)<>600 THEN
    RAISE EXCEPTION 'P4 FAILED: Ben still carries % from a bill he is off', pg_temp.spend(BEN);
  END IF;

  -- P5: the money and the figures move together — an edit does not leave one
  -- of them behind
  RAISE NOTICE 'P5 the ledger agrees with the charts | pass=% (%)',
    member_balance(G,BEN)=-600, member_balance(G,BEN);
  IF member_balance(G,BEN)<>-600 THEN
    RAISE EXCEPTION 'P5 FAILED: Ben owes % but is charged %', member_balance(G,BEN), pg_temp.spend(BEN);
  END IF;

  -- P6: a record between two people behaves the same, for both of them
  D := add_direct_expense(BEN, 600, 'Lunch', TRUE, 300, FALSE, 'FOOD');
  RAISE NOTICE 'P6 a pair record counts for both at once | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=1300 AND pg_temp.spend(BEN)=900, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>1300 OR pg_temp.spend(BEN)<>900 THEN
    RAISE EXCEPTION 'P6 FAILED: Ann % Ben %', pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;

  -- P7: editing it moves both, again
  PERFORM update_direct_expense(D, 800, 'Lunch', TRUE, 400, FALSE, 'FOOD');
  RAISE NOTICE 'P7 editing a pair record moves both figures | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=1400 AND pg_temp.spend(BEN)=1000, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>1400 OR pg_temp.spend(BEN)<>1000 THEN
    RAISE EXCEPTION 'P7 FAILED: Ann % Ben %', pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;

  -- P8: a loan is not spending, so it charges nobody. Whoever borrowed it will
  -- record what they actually bought.
  PERFORM lend_to_friend(BEN, 2000, 'Emergency', TRUE);
  RAISE NOTICE 'P8 lending charges nobody | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=1400 AND pg_temp.spend(BEN)=1000, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>1400 OR pg_temp.spend(BEN)<>1000 THEN
    RAISE EXCEPTION 'P8 FAILED: a loan reached the charts';
  END IF;

  -- P9: turning a shared record into a loan by editing it takes it back out
  PERFORM update_direct_expense(D, 800, 'Lunch', TRUE, 800, TRUE, 'FOOD');
  RAISE NOTICE 'P9 an edit into a loan takes it out of the charts | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=1000 AND pg_temp.spend(BEN)=600, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>1000 OR pg_temp.spend(BEN)<>600 THEN
    RAISE EXCEPTION 'P9 FAILED: Ann % Ben %', pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;

  -- P10: nothing anywhere is waiting on a decision, because there is no
  -- decision left to make
  SELECT COUNT(*) INTO n
  FROM information_schema.routines
  WHERE routine_schema='public'
    AND routine_name IN ('set_split_stats_choice','set_all_pending_stats_choices');
  RAISE NOTICE 'P10 the confirmation queue is gone | pass=% (% left)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'P10 FAILED: % stats-question functions still defined', n; END IF;

  -- P11: you cannot open a pair record with somebody you have no connection to.
  -- Otherwise anyone holding an account id could post "you owe me" against a
  -- stranger and have it appear on that stranger's Friends screen.
  blocked := FALSE;
  BEGIN
    PERFORM add_direct_expense(CAR, 5000, 'Made up', TRUE, 5000, FALSE, 'OTHER');
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;
  RAISE NOTICE 'P11 a stranger cannot be given a debt | pass=%', blocked;
  IF NOT blocked THEN
    RAISE EXCEPTION 'P11 FAILED: posted a debt against someone with no connection';
  END IF;

  -- P12: the same door one level down. direct_group_with is granted to
  -- authenticated in its own right, so gating only the expense wrapper would
  -- still let a stranger be pulled into a pair group.
  blocked := FALSE;
  BEGIN
    PERFORM direct_group_with(CAR);
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;
  RAISE NOTICE 'P12 no pair group can be opened with a stranger | pass=%', blocked;
  IF NOT blocked THEN
    RAISE EXCEPTION 'P12 FAILED: opened a pair group with someone unconnected';
  END IF;

  RAISE NOTICE 'ALL EDIT-AND-FIGURES TESTS PASSED';
END $t$;
