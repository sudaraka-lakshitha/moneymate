\set ON_ERROR_STOP on
DO $t$
DECLARE
  BEN UUID:='90000000-0000-0000-0000-00000000000b';
  v BOOLEAN; n INT; spent DECIMAL;
BEGIN
  -- M1: the bill Ann paid for Ben is still a bill, not a loan
  SELECT is_loan INTO v FROM expenses WHERE title='Phone bill';
  RAISE NOTICE 'M1 a recorded intent survives a schema re-run | pass=% (now %)', v IS FALSE, v;
  IF v IS NOT FALSE THEN
    RAISE EXCEPTION 'M1 FAILED: re-running the schema relabelled the phone bill as a loan';
  END IF;

  -- M2: so it is still Ben's spending
  SELECT COALESCE(SUM(s.amount),0) INTO spent
  FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
  WHERE s.user_id=BEN AND s.is_included AND NOT e.is_deleted AND NOT e.is_loan;
  RAISE NOTICE 'M2 and still counts for him | pass=% (%)', spent=1200, spent;
  IF spent<>1200 THEN
    RAISE EXCEPTION 'M2 FAILED: Ben''s spending reads % after a re-run, expected 1200', spent;
  END IF;

  -- M3: the real loan is still a loan
  SELECT is_loan INTO v FROM expenses WHERE title='Emergency';
  RAISE NOTICE 'M3 a real loan stays a loan | pass=%', v IS TRUE;
  IF v IS NOT TRUE THEN RAISE EXCEPTION 'M3 FAILED: the loan became %', v; END IF;

  -- M4: nothing was lost along the way
  SELECT COUNT(*) INTO n FROM expenses WHERE NOT is_deleted;
  RAISE NOTICE 'M4 data still there | pass=% (%)', n=3, n;
  IF n<>3 THEN RAISE EXCEPTION 'M4 FAILED: % records survived, expected 3', n; END IF;
END $t$;
