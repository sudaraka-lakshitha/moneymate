\set ON_ERROR_STOP on
DO $t$
DECLARE
  BEN UUID:='90000000-0000-0000-0000-00000000000b';
  v BOOLEAN; n INT;
BEGIN
  SELECT include_in_stats INTO v
  FROM expense_splits s JOIN expenses e ON e.id=s.expense_id
  WHERE s.user_id=BEN AND e.title='Dinner';

  RAISE NOTICE 'M1 a deliberate opt-out survives a schema re-run | pass=% (now %)', v IS FALSE, v;
  IF v IS NOT FALSE THEN
    RAISE EXCEPTION 'M1 FAILED: re-running the schema flipped Ben''s choice to %', v;
  END IF;

  SELECT COUNT(*) INTO n FROM expenses WHERE title='Dinner' AND NOT is_deleted;
  RAISE NOTICE 'M2 data still there | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'M2 FAILED'; END IF;
END $t$;
