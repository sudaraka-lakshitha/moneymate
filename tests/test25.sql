\set ON_ERROR_STOP on
-- What realtime needs from the database. Both of these are silent when wrong:
-- the client subscribes happily and then simply never hears anything.
DO $t$
DECLARE
  t TEXT;
  wanted TEXT[] := ARRAY['expenses','expense_splits','expense_payers','ledger_entries',
                         'group_settlements','group_members','groups','group_invitations',
                         'group_join_requests','friend_requests'];
  missing TEXT := '';
  thin    TEXT := '';
  ident   CHAR;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    RAISE NOTICE 'RT0 no supabase_realtime publication here — skipping (Supabase creates it)';
    RETURN;
  END IF;

  FOREACH t IN ARRAY wanted LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=t
    ) THEN
      missing := missing || t || ' ';
    END IF;

    SELECT relreplident INTO ident FROM pg_class
    WHERE oid = ('public.'||t)::regclass;
    IF ident <> 'f' THEN
      thin := thin || t || '(' || ident || ') ';
    END IF;
  END LOOP;

  RAISE NOTICE 'RT1 every screen''s tables are published | pass=%', missing='';
  IF missing <> '' THEN
    RAISE EXCEPTION 'RT1 FAILED: not published, so nothing is ever sent: %', missing;
  END IF;

  RAISE NOTICE 'RT2 all of them replicate the full row | pass=%', thin='';
  IF thin <> '' THEN
    RAISE EXCEPTION 'RT2 FAILED: % replicate only a key, so under RLS every update and delete is dropped', thin;
  END IF;

  RAISE NOTICE 'ALL REALTIME PREREQUISITE TESTS PASSED';
END $t$;
