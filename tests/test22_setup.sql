\set ON_ERROR_STOP on
-- Re-running supabase_schema.sql is the deploy step, and it happens after every
-- change. A second run must not touch anybody's data.
--
-- The thing at risk is any migration that reads existing rows and rewrites
-- them. The live one guesses whether an old pair record was a loan from its
-- shape — one person carrying the whole share — and "I paid your phone bill"
-- has exactly that shape without being a loan. If the guess ran again on every
-- deploy it would undo the correction and quietly drop the bill out of the
-- charts.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('90000000-0000-0000-0000-00000000000a','m_ann@t.lk','{"full_name":"Ann"}'),
   ('90000000-0000-0000-0000-00000000000b','m_ben@t.lk','{"full_name":"Ben"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('90000000-0000-0000-0000-00000000000a','90000000-0000-0000-0000-00000000000b','m_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
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

  -- Ann settles Ben's phone bill. Ben carries the whole share, so it looks
  -- exactly like a loan and is not one: Ben will never log this anywhere else.
  PERFORM add_direct_expense(BEN, 700, 'Phone bill', TRUE, 700, FALSE, 'UTILITIES');

  -- And a real loan beside it, so the check can tell the two apart.
  PERFORM lend_to_friend(BEN, 2000, 'Emergency', TRUE);
END $t$;
RESET ROLE;
\echo '--- re-running the schema over live data ---'
