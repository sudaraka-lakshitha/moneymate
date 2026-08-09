\set ON_ERROR_STOP on
-- Lending is never a question. Money moving between two people is not spending
-- by either of them, so neither side is ever asked whether it counts.
--
-- The counting here mirrors the query the Stats screen runs to build its
-- confirmation queue, so a row that would show up there fails the test.
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

-- The Stats queue, exactly as the screen asks for it.
CREATE OR REPLACE FUNCTION pg_temp.queued(p_for UUID) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INT
  FROM expense_splits s
  JOIN expenses e ON e.id = s.expense_id
  WHERE s.user_id = p_for
    AND s.is_included
    AND s.include_in_stats IS NULL
    AND NOT e.is_deleted
    AND e.created_by <> p_for;
$$;

DO $t$
DECLARE
  ANN UUID:='c3000000-0000-0000-0000-00000000000a';
  BEN UUID:='c3000000-0000-0000-0000-00000000000b';
  pair UUID; e UUID; n INT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- Q1: Ann lends Ben 5,000. Neither of them is asked about it.
  PERFORM lend_to_friend(BEN, 5000, 'Emergency', TRUE);
  pair := direct_group_with(BEN);

  RAISE NOTICE 'Q1 lending asks the borrower nothing | pass=% (% queued)',
    pg_temp.queued(BEN)=0, pg_temp.queued(BEN);
  IF pg_temp.queued(BEN)<>0 THEN
    RAISE EXCEPTION 'Q1 FAILED: the borrower is being asked to count % lent record(s)', pg_temp.queued(BEN);
  END IF;

  RAISE NOTICE 'Q2 and asks the lender nothing | pass=%', pg_temp.queued(ANN)=0;
  IF pg_temp.queued(ANN)<>0 THEN RAISE EXCEPTION 'Q2 FAILED'; END IF;

  -- Q3: the other direction — Ann borrows from Ben.
  PERFORM lend_to_friend(BEN, 3000, 'Rent top-up', FALSE);
  RAISE NOTICE 'Q3 borrowing asks nobody either | pass=% (Ann % / Ben %)',
    pg_temp.queued(ANN)=0 AND pg_temp.queued(BEN)=0, pg_temp.queued(ANN), pg_temp.queued(BEN);
  IF pg_temp.queued(ANN)<>0 OR pg_temp.queued(BEN)<>0 THEN
    RAISE EXCEPTION 'Q3 FAILED: borrowing queued a question';
  END IF;

  -- Q4: nothing is left undecided at all on a loan — an unanswered row is a
  -- question waiting to be asked, even if no screen shows it today.
  SELECT COUNT(*) INTO n
  FROM expense_splits s JOIN expenses ex ON ex.id = s.expense_id
  WHERE ex.group_id = pair AND s.include_in_stats IS NULL;
  RAISE NOTICE 'Q4 no undecided rows left behind by lending | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'Q4 FAILED: % undecided split(s) on loans', n; END IF;

  -- Q5: and no loan counts as anybody's spending.
  SELECT COUNT(*) INTO n
  FROM expense_splits s JOIN expenses ex ON ex.id = s.expense_id
  WHERE ex.group_id = pair AND s.include_in_stats;
  RAISE NOTICE 'Q5 a loan is nobody''s spending | pass=% (% counted)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'Q5 FAILED: % loan share(s) counted as spending', n; END IF;

  -- Q6: paying a bill that was entirely somebody else's is not lending, even
  -- though the numbers are identical. The money was consumed, it was theirs,
  -- and it will never be recorded anywhere else — so they are asked.
  e := add_direct_expense(BEN, 700, 'Your phone bill', TRUE, 700, FALSE);
  RAISE NOTICE 'Q6 paying their bill outright asks them | pass=% (% queued)',
    pg_temp.queued(BEN)=1, pg_temp.queued(BEN);
  IF pg_temp.queued(BEN)<>1 THEN
    RAISE EXCEPTION 'Q6 FAILED: their own bill was treated as a loan and never counted';
  END IF;

  -- Q6b: and it is not the payer's spending — they carry none of it.
  SELECT include_in_stats INTO n FROM (
    SELECT CASE WHEN include_in_stats THEN 1 ELSE 0 END AS include_in_stats
    FROM expense_splits WHERE expense_id=e AND user_id=ANN) z;
  RAISE NOTICE 'Q6b and is not the payer''s own spending | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'Q6b FAILED: the payer was charged for a bill that was not theirs'; END IF;

  -- Answer it so the later counts stay readable.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM set_split_stats_choice(e, TRUE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- Q6c: the mirror image. Ben pays a bill that is entirely Ann's, and Ann
  -- records it. It is her consumption, so it counts for her without a prompt —
  -- she is the one filling in the form.
  e := add_direct_expense(BEN, 400, 'My phone bill', FALSE, 0, FALSE);
  SELECT CASE WHEN include_in_stats THEN 1 WHEN include_in_stats IS NULL THEN -1 ELSE 0 END
    INTO n FROM expense_splits WHERE expense_id=e AND user_id=ANN;
  RAISE NOTICE 'Q6c a bill of mine that a friend paid counts as mine | pass=%', n=1;
  IF n<>1 THEN
    RAISE EXCEPTION 'Q6c FAILED: my own bill read as % (1 counted, 0 excluded, -1 unanswered)', n;
  END IF;

  SELECT CASE WHEN include_in_stats THEN 1 WHEN include_in_stats IS NULL THEN -1 ELSE 0 END
    INTO n FROM expense_splits WHERE expense_id=e AND user_id=BEN;
  RAISE NOTICE 'Q6d and the friend who fronted it is not charged for it | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'Q6d FAILED: the payer got asked about a bill that was not theirs'; END IF;

  -- Q7: the change must not have swallowed genuinely shared bills, which are
  -- the one thing that should still ask.
  PERFORM add_direct_expense(BEN, 900, 'Split dinner', TRUE, 450);
  RAISE NOTICE 'Q7 a shared bill still asks the other person | pass=% (%)',
    pg_temp.queued(BEN)=1, pg_temp.queued(BEN);
  IF pg_temp.queued(BEN)<>1 THEN
    RAISE EXCEPTION 'Q7 FAILED: expected exactly one question, got %', pg_temp.queued(BEN);
  END IF;

  -- Q8: and answering everything outstanding touches only that one.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  SELECT set_all_pending_stats_choices(TRUE) INTO n;
  RAISE NOTICE 'Q8 bulk answer covers only the shared bill | pass=% (% answered)', n=1, n;
  IF n<>1 THEN RAISE EXCEPTION 'Q8 FAILED: answered % rows', n; END IF;

  RAISE NOTICE 'ALL LENDING-IS-NOT-A-QUESTION TESTS PASSED';
END $t$;
