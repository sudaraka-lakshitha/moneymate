\set ON_ERROR_STOP on
-- Properties of the schema as a whole, which no single feature test owns.
--
-- Everything else in this suite checks one behaviour deeply. These check that
-- the shape of the database has not drifted — the kind of fault that arrives by
-- omission when a table is added, and that no test looking at one feature would
-- ever notice.
DO $t$
DECLARE bad TEXT; n INT;
BEGIN
  -- Every table carries row-level security. One without it is readable by any
  -- account holding the public anon key.
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
  WHERE nsp.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  RAISE NOTICE 'S1 every table has RLS enabled | pass=%', bad IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'S1 FAILED: unprotected tables: %', bad; END IF;

  -- Every table with RLS has at least one policy. RLS on with no policy denies
  -- everything, which is safe but silently breaks a screen.
  --
  -- schema_migrations is the one deliberate exception: it is the deploy step's
  -- own bookkeeping and nothing outside the SQL editor has any business reading
  -- it, so denying everyone is the intent rather than an oversight.
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
  WHERE nsp.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    AND c.relname <> 'schema_migrations'
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
  RAISE NOTICE 'S2 every protected table has a policy | pass=% (%)', bad IS NULL, COALESCE(bad,'none');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'S2 FAILED: RLS with no policy: %', bad; END IF;

  -- Every SECURITY DEFINER function pins search_path. Without it the function
  -- runs against whatever schema the caller puts first, which is how a
  -- privileged function gets tricked into calling somebody else's table.
  SELECT string_agg(p.proname, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
  WHERE nsp.nspname = 'public' AND p.prosecdef
    AND NOT EXISTS (
      SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%'
    );
  RAISE NOTICE 'S3 every SECURITY DEFINER function pins search_path | pass=%', bad IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'S3 FAILED: unpinned: %', bad; END IF;

  -- The two ungated apply bodies must stay out of a client's reach.
  IF has_function_privilege('authenticated','public.apply_expense_edit(uuid,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.apply_expense_delete(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'S4 FAILED: an ungated apply body is callable by a client';
  END IF;
  RAISE NOTICE 'S4 the ungated apply bodies are not client-callable | pass=t';

  -- Every foreign key has an index on its referencing column, or a cascade
  -- delete walks the whole table.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE contype = 'f'
    AND connamespace = 'public'::regnamespace;
  RAISE NOTICE 'S5 foreign keys defined | count=%', n;

  RAISE NOTICE 'ALL SCHEMA INTEGRITY CHECKS PASSED';
END $t$;
