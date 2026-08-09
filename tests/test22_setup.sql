\set ON_ERROR_STOP on
-- Re-running supabase_schema.sql is the deploy step, and it happens after every
-- change. A second run must not touch anybody's data.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('90000000-0000-0000-0000-00000000000a','m_ann@t.lk','{"full_name":"Ann"}'),
   ('90000000-0000-0000-0000-00000000000b','m_ben@t.lk','{"full_name":"Ben"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
SET ROLE authenticated;
DO $t$
DECLARE
  ANN UUID:='90000000-0000-0000-0000-00000000000a';
  BEN UUID:='90000000-0000-0000-0000-00000000000b';
  G UUID; E UUID;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Rerun','','🔁')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  E := save_expense(G,'Dinner',1000,ANN,'FOOD','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',500,'is_included',true)),'[]'::jsonb);

  -- Ben deliberately keeps this bill out of his own charts.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM set_split_stats_choice(E, FALSE);
END $t$;
RESET ROLE;
\echo '--- re-running the schema over live data ---'
