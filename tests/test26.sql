\set ON_ERROR_STOP on
-- What counts as your spending, now that nothing is ever asked.
--
-- Everything shared that you are on counts. The one distinction that survives
-- is lending: money moving between two people is a transfer, and counting it
-- would double the spending once the borrower records what they actually
-- bought. That is a rule now, not a question.
--
-- The counting mirrors the query the Stats screen runs, so a figure that would
-- reach the charts is the figure this test checks.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('c3000000-0000-0000-0000-00000000000a','q_ann@t.lk','{"full_name":"Ann"}'),
   ('c3000000-0000-0000-0000-00000000000b','q_ben@t.lk','{"full_name":"Ben"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('c3000000-0000-0000-0000-00000000000a','c3000000-0000-0000-0000-00000000000b','q_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

-- What the Stats screen counts, exactly as it asks for it.
CREATE OR REPLACE FUNCTION pg_temp.spend(p_for UUID) RETURNS DECIMAL
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(s.amount), 0)
  FROM expense_splits s
  JOIN expenses e ON e.id = s.expense_id
  WHERE s.user_id = p_for AND s.is_included AND NOT e.is_deleted AND NOT e.is_loan;
$$;

DO $t$
DECLARE
  ANN UUID:='c3000000-0000-0000-0000-00000000000a';
  BEN UUID:='c3000000-0000-0000-0000-00000000000b';
  pair UUID; grp UUID; e UUID; n INT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- Q1: Ann lends Ben 5,000. Nobody has spent anything.
  PERFORM lend_to_friend(BEN, 5000, 'Emergency', TRUE);
  pair := direct_group_with(BEN);
  RAISE NOTICE 'Q1 lending is not the borrower''s spending | pass=% (%)',
    pg_temp.spend(BEN)=0, pg_temp.spend(BEN);
  IF pg_temp.spend(BEN)<>0 THEN
    RAISE EXCEPTION 'Q1 FAILED: the borrower was charged % for money they merely owe', pg_temp.spend(BEN);
  END IF;
  RAISE NOTICE 'Q2 nor the lender''s | pass=% (%)', pg_temp.spend(ANN)=0, pg_temp.spend(ANN);
  IF pg_temp.spend(ANN)<>0 THEN RAISE EXCEPTION 'Q2 FAILED: %', pg_temp.spend(ANN); END IF;

  -- Q3: the other direction is the same.
  PERFORM lend_to_friend(BEN, 3000, 'Rent top-up', FALSE);
  RAISE NOTICE 'Q3 borrowing counts for nobody either | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=0 AND pg_temp.spend(BEN)=0, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>0 OR pg_temp.spend(BEN)<>0 THEN
    RAISE EXCEPTION 'Q3 FAILED: borrowing reached the charts';
  END IF;

  -- Q4: but the money is real — it is a balance, not spending.
  RAISE NOTICE 'Q4 lending still moves the balance | pass=% (%)',
    member_balance(pair, ANN)=2000, member_balance(pair, ANN);
  IF member_balance(pair, ANN)<>2000 THEN
    RAISE EXCEPTION 'Q4 FAILED: balance reads %', member_balance(pair, ANN);
  END IF;

  -- Q5: a shared bill counts for both, with nothing asked of either.
  e := add_direct_expense(BEN, 900, 'Split dinner', TRUE, 450, FALSE, 'FOOD');
  RAISE NOTICE 'Q5 a shared bill counts for the person who typed it | pass=% (%)',
    pg_temp.spend(ANN)=450, pg_temp.spend(ANN);
  IF pg_temp.spend(ANN)<>450 THEN RAISE EXCEPTION 'Q5 FAILED: %', pg_temp.spend(ANN); END IF;
  RAISE NOTICE 'Q6 and for the other person, unasked | pass=% (%)',
    pg_temp.spend(BEN)=450, pg_temp.spend(BEN);
  IF pg_temp.spend(BEN)<>450 THEN
    RAISE EXCEPTION 'Q6 FAILED: the other person''s share reads % — they are still waiting to be asked',
      pg_temp.spend(BEN);
  END IF;

  -- Q7: paying a bill that was entirely somebody else's counts for them, not
  -- for whoever fronted the money.
  e := add_direct_expense(BEN, 700, 'Your phone bill', TRUE, 700, FALSE, 'UTILITIES');
  RAISE NOTICE 'Q7 their bill counts for them | pass=% (%)',
    pg_temp.spend(BEN)=1150, pg_temp.spend(BEN);
  IF pg_temp.spend(BEN)<>1150 THEN RAISE EXCEPTION 'Q7 FAILED: %', pg_temp.spend(BEN); END IF;
  RAISE NOTICE 'Q8 and not for the payer | pass=% (%)', pg_temp.spend(ANN)=450, pg_temp.spend(ANN);
  IF pg_temp.spend(ANN)<>450 THEN
    RAISE EXCEPTION 'Q8 FAILED: the payer was charged % for a bill that was not theirs',
      pg_temp.spend(ANN);
  END IF;

  -- Q9: the mirror image — Ben pays a bill that is entirely Ann's.
  e := add_direct_expense(BEN, 400, 'My phone bill', FALSE, 0, FALSE, 'UTILITIES');
  RAISE NOTICE 'Q9 a bill of mine a friend paid counts as mine | pass=% (%)',
    pg_temp.spend(ANN)=850, pg_temp.spend(ANN);
  IF pg_temp.spend(ANN)<>850 THEN RAISE EXCEPTION 'Q9 FAILED: %', pg_temp.spend(ANN); END IF;

  -- Q10: a group bill counts for everyone on it, straight away.
  grp := (create_group('Trip','','✈️')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (grp,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';
  PERFORM save_expense(grp,'Hotel',1000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',500,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'Q10 a group share counts for both at once | pass=% (Ann % / Ben %)',
    pg_temp.spend(ANN)=1350 AND pg_temp.spend(BEN)=1650, pg_temp.spend(ANN), pg_temp.spend(BEN);
  IF pg_temp.spend(ANN)<>1350 OR pg_temp.spend(BEN)<>1650 THEN
    RAISE EXCEPTION 'Q10 FAILED: Ann % Ben %', pg_temp.spend(ANN), pg_temp.spend(BEN);
  END IF;

  -- Q11: somebody excluded from a bill is not charged for it.
  PERFORM save_expense(grp,'Ann only',300,ANN,'FOOD','UNEQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',0,'is_included',false)),'[]'::jsonb);
  RAISE NOTICE 'Q11 an excluded member is not charged | pass=% (%)',
    pg_temp.spend(BEN)=1650, pg_temp.spend(BEN);
  IF pg_temp.spend(BEN)<>1650 THEN RAISE EXCEPTION 'Q11 FAILED: %', pg_temp.spend(BEN); END IF;

  -- Q12: deleting a bill takes it out of the charts too.
  SELECT id INTO e FROM expenses WHERE group_id=grp AND title='Ann only';
  PERFORM delete_expense(e, 'mistake');
  RAISE NOTICE 'Q12 a deleted bill leaves the charts | pass=% (%)',
    pg_temp.spend(ANN)=1350, pg_temp.spend(ANN);
  IF pg_temp.spend(ANN)<>1350 THEN RAISE EXCEPTION 'Q12 FAILED: %', pg_temp.spend(ANN); END IF;

  -- Q13: nothing anywhere is left in a "waiting to be asked" state, because
  -- there is no longer anything to ask.
  SELECT COUNT(*) INTO n
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='expense_splits' AND column_name='include_in_stats';
  RAISE NOTICE 'Q13 the opt-in column is gone | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'Q13 FAILED: the stats question still exists in the schema'; END IF;

  RAISE NOTICE 'ALL WHAT-COUNTS TESTS PASSED';
END $t$;
