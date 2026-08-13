\set ON_ERROR_STOP on
-- Several people paying for one bill.
--
-- The case the app could not record: a 1,500 item, one person putting in 1,000
-- and the other 500, split evenly. Naming either of them "the payer" is wrong
-- by 500 in opposite directions, and wrong invisibly — the ledger nets to zero
-- either way, so the balance simply reads 750 instead of 250.
--
-- What this file is really guarding is that separating contributions from
-- shares did not disturb the money core. Every assertion below either checks a
-- balance or checks that the ledger still nets to zero per person.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('e6000000-0000-0000-0000-00000000000a','mp_ann@t.lk','{"full_name":"Ann"}'),
   ('e6000000-0000-0000-0000-00000000000b','mp_ben@t.lk','{"full_name":"Ben"}'),
   ('e6000000-0000-0000-0000-00000000000c','mp_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('e6000000-0000-0000-0000-00000000000a','e6000000-0000-0000-0000-00000000000b','mp_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

CREATE OR REPLACE FUNCTION pg_temp.spend(p_for UUID) RETURNS DECIMAL
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(s.amount), 0)
  FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
  WHERE s.user_id = p_for AND s.is_included AND NOT e.is_deleted AND NOT e.is_loan;
$$;

DO $t$
DECLARE
  ANN UUID:='e6000000-0000-0000-0000-00000000000a';
  BEN UUID:='e6000000-0000-0000-0000-00000000000b';
  CAR UUID:='e6000000-0000-0000-0000-00000000000c';
  pair UUID; grp UUID; e UUID; n INT; blocked BOOLEAN;
  total DECIMAL; paid DECIMAL; shr DECIMAL;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- ---- Between two people: the case that started this ----

  -- Y1: Ann puts in 1,000 of a 1,500 item, Ben puts in 500, split evenly.
  e := add_direct_expense(BEN, 1500, 'Rice cooker', TRUE, 750, FALSE, 'SHOPPING', 1000);
  pair := direct_group_with(BEN);
  RAISE NOTICE 'Y1 the balance is the 250 it should be | pass=% (%)',
    member_balance(pair, ANN)=250, member_balance(pair, ANN);
  IF member_balance(pair, ANN)<>250 THEN
    RAISE EXCEPTION 'Y1 FAILED: reads %, and 750 means one payer swallowed the lot',
      member_balance(pair, ANN);
  END IF;

  -- Y2: and it nets off exactly against Ben
  RAISE NOTICE 'Y2 the other side is its mirror | pass=% (%)',
    member_balance(pair, BEN)=-250, member_balance(pair, BEN);
  IF member_balance(pair, BEN)<>-250 THEN
    RAISE EXCEPTION 'Y2 FAILED: Ben reads %', member_balance(pair, BEN);
  END IF;

  -- Y3: both contributions are on record, not just the larger one
  SELECT COUNT(*), SUM(amount) INTO n, total FROM expense_payers WHERE expense_id = e;
  RAISE NOTICE 'Y3 both contributions recorded | pass=% (% rows, %)', n=2 AND total=1500, n, total;
  IF n<>2 OR total<>1500 THEN RAISE EXCEPTION 'Y3 FAILED: % rows totalling %', n, total; END IF;

  -- Y4: the ledger still nets to zero, which is what makes all of this safe
  SELECT COALESCE(SUM(amount),0) INTO total FROM ledger_entries WHERE group_id = pair;
  RAISE NOTICE 'Y4 the ledger still nets to zero | pass=% (%)', total=0, total;
  IF total<>0 THEN RAISE EXCEPTION 'Y4 FAILED: ledger sums to %', total; END IF;

  -- Y5: it is spending for both of them, in the amounts they owe, not the
  -- amounts they handed over
  RAISE NOTICE 'Y5 each is charged their share, not their payment | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=750 AND pg_temp.spend(BEN)=750, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>750 OR pg_temp.spend(BEN)<>750 THEN
    RAISE EXCEPTION 'Y5 FAILED: Ann % Ben %', pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;

  -- Y6: editing it to a different division moves the balance with it
  PERFORM update_direct_expense(e, 1500, 'Rice cooker', TRUE, 750, FALSE, 'SHOPPING', 1500);
  RAISE NOTICE 'Y6 editing the contributions moves the balance | pass=% (%)',
    member_balance(pair, ANN)=750, member_balance(pair, ANN);
  IF member_balance(pair, ANN)<>750 THEN
    RAISE EXCEPTION 'Y6 FAILED: after paying it all, Ann is owed %', member_balance(pair, ANN);
  END IF;

  -- Y7: and back again, through the repeated-edit path that has broken before
  PERFORM update_direct_expense(e, 1500, 'Rice cooker', TRUE, 750, FALSE, 'SHOPPING', 1000);
  SELECT COALESCE(SUM(amount),0) INTO total FROM ledger_entries WHERE group_id = pair;
  RAISE NOTICE 'Y7 repeated edits leave it whole | pass=% (balance %, ledger %)',
    member_balance(pair, ANN)=250 AND total=0, member_balance(pair, ANN), total;
  IF member_balance(pair, ANN)<>250 OR total<>0 THEN
    RAISE EXCEPTION 'Y7 FAILED: balance % ledger %', member_balance(pair, ANN), total;
  END IF;

  -- Y8: paying more than the bill is refused
  blocked := FALSE;
  BEGIN PERFORM add_direct_expense(BEN, 900, 'Too much', TRUE, 450, FALSE, 'FOOD', 1200);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'Y8 paying more than the bill is refused | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'Y8 FAILED: recorded a payment larger than the bill'; END IF;

  -- Y9: a loan ignores it — lending is one person handing over money
  e := lend_to_friend(BEN, 2000, 'Emergency', TRUE);
  SELECT COUNT(*) INTO n FROM expense_payers WHERE expense_id = e;
  RAISE NOTICE 'Y9 a loan has exactly one payer | pass=% (%)', n=1, n;
  IF n<>1 THEN RAISE EXCEPTION 'Y9 FAILED: % contributions on a loan', n; END IF;

  -- ---- In a group, where it is just as common ----

  grp := (create_group('Trip','','✈️')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (grp,BEN,'MEMBER'),(grp,CAR,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  -- Y10: a 3,000 hotel: Ann puts in 2,000 and Cara 1,000, split three ways
  e := save_expense(grp,'Hotel',3000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',1000,'is_included',true)),
    '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',2000),
      jsonb_build_object('user_id',CAR,'amount',1000)));

  RAISE NOTICE 'Y10 three-way split, two payers | pass=% (Ann % Ben % Cara %)',
    member_balance(grp,ANN)=1000 AND member_balance(grp,BEN)=-1000 AND member_balance(grp,CAR)=0,
    member_balance(grp,ANN), member_balance(grp,BEN), member_balance(grp,CAR);
  IF member_balance(grp,ANN)<>1000 OR member_balance(grp,BEN)<>-1000 OR member_balance(grp,CAR)<>0 THEN
    RAISE EXCEPTION 'Y10 FAILED: Ann % Ben % Cara %',
      member_balance(grp,ANN), member_balance(grp,BEN), member_balance(grp,CAR);
  END IF;

  -- Y11: Cara put money in and owes exactly her share, so she is square —
  -- which is a different thing from not being involved
  SELECT COALESCE(SUM(amount),0) INTO total FROM ledger_entries WHERE group_id = grp;
  RAISE NOTICE 'Y11 the group ledger nets to zero | pass=% (%)', total=0, total;
  IF total<>0 THEN RAISE EXCEPTION 'Y11 FAILED: %', total; END IF;

  -- Y12: the chart attributes to both payers rather than handing it all to one
  SELECT out_paid INTO paid FROM group_contribution_stats(grp) WHERE out_user_id=ANN;
  SELECT out_paid INTO shr  FROM group_contribution_stats(grp) WHERE out_user_id=CAR;
  RAISE NOTICE 'Y12 the chart splits the contributions | pass=% (Ann % / Cara %)',
    paid=2000 AND shr=1000, paid, shr;
  IF paid<>2000 OR shr<>1000 THEN
    RAISE EXCEPTION 'Y12 FAILED: Ann paid %, Cara paid % — one of them swallowed the bill', paid, shr;
  END IF;

  -- Y13: and the slices still add up to what the group spent
  SELECT SUM(out_paid) INTO total FROM group_contribution_stats(grp);
  RAISE NOTICE 'Y13 the slices add up to the group total | pass=% (%)', total=3000, total;
  IF total<>3000 THEN RAISE EXCEPTION 'Y13 FAILED: %', total; END IF;

  -- Y14: contributions that do not add up to the bill are refused, for the same
  -- reason shares that do not add up are refused
  blocked := FALSE;
  BEGIN
    PERFORM save_expense(grp,'Wrong',600,ANN,'FOOD','EQUAL','',
      jsonb_build_array(
        jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
        jsonb_build_object('user_id',BEN,'amount',300,'is_included',true)),
      '[]'::jsonb,
      jsonb_build_array(
        jsonb_build_object('user_id',ANN,'amount',200),
        jsonb_build_object('user_id',BEN,'amount',300)));
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'Y14 contributions must add up to the bill | pass=%', blocked;
  IF NOT blocked THEN
    RAISE EXCEPTION 'Y14 FAILED: 500 of contributions was accepted against a 600 bill';
  END IF;

  -- Y15: and neither may somebody outside the group be listed as paying
  blocked := FALSE;
  BEGIN
    PERFORM save_expense(grp,'Outsider',400,ANN,'FOOD','EQUAL','',
      jsonb_build_array(
        jsonb_build_object('user_id',ANN,'amount',200,'is_included',true),
        jsonb_build_object('user_id',BEN,'amount',200,'is_included',true)),
      '[]'::jsonb,
      jsonb_build_array(
        jsonb_build_object('user_id','00000000-0000-0000-0000-0000000009ff','amount',400)));
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'Y15 a stranger cannot be listed as paying | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'Y15 FAILED: a non-member was recorded as a payer'; END IF;

  -- Y16: a bill nobody put money into is refused too
  blocked := FALSE;
  BEGIN
    PERFORM save_expense(grp,'Zero',400,ANN,'FOOD','EQUAL','',
      jsonb_build_array(
        jsonb_build_object('user_id',ANN,'amount',200,'is_included',true),
        jsonb_build_object('user_id',BEN,'amount',200,'is_included',true)),
      '[]'::jsonb,
      jsonb_build_array(
        jsonb_build_object('user_id',ANN,'amount',400),
        jsonb_build_object('user_id',BEN,'amount',0)));
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'Y16 nobody is listed as paying nothing | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'Y16 FAILED: a zero contribution was recorded'; END IF;

  -- Y17: editing a group bill's contributions moves the balances and leaves
  -- the ledger whole
  PERFORM update_expense(e,'Hotel',3000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',1000,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',1000,'is_included',true)),
    '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object('user_id',BEN,'amount',3000)));
  SELECT COALESCE(SUM(amount),0) INTO total FROM ledger_entries WHERE group_id = grp;
  RAISE NOTICE 'Y17 handing the bill to one payer by edit | pass=% (Ann % Ben % ledger %)',
    member_balance(grp,ANN)=-1000 AND member_balance(grp,BEN)=2000 AND total=0,
    member_balance(grp,ANN), member_balance(grp,BEN), total;
  IF member_balance(grp,ANN)<>-1000 OR member_balance(grp,BEN)<>2000 OR total<>0 THEN
    RAISE EXCEPTION 'Y17 FAILED: Ann % Ben % ledger %',
      member_balance(grp,ANN), member_balance(grp,BEN), total;
  END IF;

  -- Y18: deleting it takes the whole thing back out, every contribution
  PERFORM delete_expense(e, 'not going');
  SELECT COALESCE(SUM(amount),0) INTO total FROM ledger_entries WHERE group_id = grp;
  RAISE NOTICE 'Y18 deleting reverses every contribution | pass=% (Ann % Ben % ledger %)',
    member_balance(grp,ANN)=0 AND member_balance(grp,BEN)=0 AND total=0,
    member_balance(grp,ANN), member_balance(grp,BEN), total;
  IF member_balance(grp,ANN)<>0 OR member_balance(grp,BEN)<>0 OR total<>0 THEN
    RAISE EXCEPTION 'Y18 FAILED: Ann % Ben % ledger %',
      member_balance(grp,ANN), member_balance(grp,BEN), total;
  END IF;

  -- Y19: an ordinary one-payer bill still works exactly as before, without
  -- anybody having to say anything about contributions
  e := save_expense(grp,'Taxi',300,BEN,'TRANSPORT','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',150,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',150,'is_included',true)),'[]'::jsonb);
  SELECT COUNT(*), SUM(amount) INTO n, total FROM expense_payers WHERE expense_id = e;
  RAISE NOTICE 'Y19 one payer is still one row for the whole bill | pass=% (% rows, %)',
    n=1 AND total=300, n, total;
  IF n<>1 OR total<>300 THEN RAISE EXCEPTION 'Y19 FAILED: % rows totalling %', n, total; END IF;
  RAISE NOTICE 'Y19b and the balance follows | pass=% (%)',
    member_balance(grp,BEN)=150, member_balance(grp,BEN);
  IF member_balance(grp,BEN)<>150 THEN
    RAISE EXCEPTION 'Y19b FAILED: %', member_balance(grp,BEN);
  END IF;

  -- Y20: paying for a bill you take no share of stays readable after you leave.
  -- Fronting a booking you are not on is a real thing people do, and losing
  -- sight of it the moment you leave the group would lose the money with it.
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  e := save_expense(grp,'Their dinner',400,CAR,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',200,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',200,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',0,'is_included',false)),'[]'::jsonb);
  PERFORM record_payment_received(grp, ANN, 200, '', 'CASH');
  PERFORM record_payment_received(grp, BEN, 200, '', 'CASH');
  PERFORM leave_group(grp);
  SELECT COUNT(*) INTO n FROM expenses WHERE id = e;
  RAISE NOTICE 'Y20 a bill you paid for outlives your membership | pass=% (%)', n=1, n;
  IF n<>1 THEN
    RAISE EXCEPTION 'Y20 FAILED: the bill Cara paid for vanished when she left';
  END IF;

  RAISE NOTICE 'ALL MULTI-PAYER TESTS PASSED';
END $t$;
