\set ON_ERROR_STOP on
-- Starting a group with the people already in it.
--
-- Creating a group used to leave you alone in it holding a code, which is a
-- round trip through invitations for people you have already vouched for by
-- adding them as friends. Friendship is the consent boundary the rest of the
-- app runs on — add_direct_expense posts a shared bill against a friend on the
-- same grounds — so it is the boundary here too, and it is checked on the
-- server rather than trusted from the client.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('c9000000-0000-0000-0000-00000000000a','cg_ann@t.lk','{"full_name":"Ann"}'),
   ('c9000000-0000-0000-0000-00000000000b','cg_ben@t.lk','{"full_name":"Ben"}'),
   ('c9000000-0000-0000-0000-00000000000c','cg_cara@t.lk','{"full_name":"Cara"}'),
   ('c9000000-0000-0000-0000-00000000000d','cg_dan@t.lk','{"full_name":"Dan"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES
   ('c9000000-0000-0000-0000-00000000000a','c9000000-0000-0000-0000-00000000000b','cg_ben@t.lk','ACCEPTED',NOW()),
   ('c9000000-0000-0000-0000-00000000000a','c9000000-0000-0000-0000-00000000000c','cg_cara@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

DO $t$
DECLARE
  ANN UUID:='c9000000-0000-0000-0000-00000000000a';
  BEN UUID:='c9000000-0000-0000-0000-00000000000b';
  CAR UUID:='c9000000-0000-0000-0000-00000000000c';
  DAN UUID:='c9000000-0000-0000-0000-00000000000d';
  g UUID; n INT; blocked BOOLEAN; role TEXT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- G1: the group exists with everyone in it, no invitations to chase
  g := (create_group_with_friends('Trip','Ella','✈️', ARRAY[BEN, CAR])).id;
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id = g;
  RAISE NOTICE 'G1 the group starts with its people in it | pass=% (%)', n=3, n;
  IF n<>3 THEN RAISE EXCEPTION 'G1 FAILED: % members', n; END IF;

  SELECT COUNT(*) INTO n FROM group_invitations WHERE group_id = g;
  RAISE NOTICE 'G1b and nobody has to accept anything | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'G1b FAILED: % invitations left pending', n; END IF;

  -- G2: the creator is still the admin, and the others are not
  SELECT r.role INTO role FROM group_members r WHERE r.group_id = g AND r.user_id = ANN;
  IF role <> 'ADMIN' THEN RAISE EXCEPTION 'G2 FAILED: creator is %', role; END IF;
  SELECT r.role INTO role FROM group_members r WHERE r.group_id = g AND r.user_id = BEN;
  RAISE NOTICE 'G2 the creator administers it, the rest are members | pass=% (%)', role='MEMBER', role;
  IF role <> 'MEMBER' THEN RAISE EXCEPTION 'G2 FAILED: friend seated as %', role; END IF;

  -- G3: it works straight away — a bill can be split across all three
  PERFORM save_expense(g,'Hotel',900,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',BEN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'G3 usable immediately | pass=% (Ben %)',
    member_balance(g,BEN)=-300, member_balance(g,BEN);
  IF member_balance(g,BEN)<>-300 THEN
    RAISE EXCEPTION 'G3 FAILED: %', member_balance(g,BEN);
  END IF;

  -- G4: somebody you are not connected to cannot be seated. Otherwise the
  -- friends check is decoration and any account id would do.
  blocked := FALSE;
  BEGIN PERFORM create_group_with_friends('Sneaky','','💰', ARRAY[DAN]);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'G4 a stranger cannot be put in a group | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'G4 FAILED: seated somebody with no connection'; END IF;

  -- G5: and one stranger in the list refuses the whole thing rather than
  -- quietly seating the friends and dropping them. A half-made group is
  -- harder to notice than a refusal.
  blocked := FALSE;
  BEGIN PERFORM create_group_with_friends('Mixed','','💰', ARRAY[BEN, DAN]);
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'G5 one stranger refuses the whole list | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'G5 FAILED: partially seated'; END IF;
  SELECT COUNT(*) INTO n FROM groups WHERE name = 'Mixed';
  RAISE NOTICE 'G5b and leaves no half-made group behind | pass=% (%)', n=0, n;
  IF n<>0 THEN RAISE EXCEPTION 'G5b FAILED: % left over', n; END IF;

  -- G6: naming nobody is still fine — you make the group and share its code
  g := (create_group_with_friends('Alone','','💰', ARRAY[]::UUID[])).id;
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id = g;
  RAISE NOTICE 'G6 a group with nobody named is still yours alone | pass=% (%)', n=1, n;
  IF n<>1 THEN RAISE EXCEPTION 'G6 FAILED: % members', n; END IF;

  -- G7: naming yourself changes nothing — no duplicate seat
  g := (create_group_with_friends('Solo','','💰', ARRAY[ANN, BEN])).id;
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id = g;
  RAISE NOTICE 'G7 naming yourself does not seat you twice | pass=% (%)', n=2, n;
  IF n<>2 THEN RAISE EXCEPTION 'G7 FAILED: % members', n; END IF;

  -- G8: nothing about this removes anybody. Settling up and unfriending are
  -- not reasons to take somebody out of a group they are in — that stays a
  -- decision a person makes, never one the app makes for them.
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement((SELECT id FROM groups WHERE name='Trip'), ANN, 300, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM remove_friend(BEN);
  SELECT COUNT(*) INTO n FROM group_members
  WHERE group_id = (SELECT id FROM groups WHERE name='Trip') AND user_id = BEN;
  RAISE NOTICE 'G8 settling and unfriending remove nobody | pass=% (%)', n=1, n;
  IF n<>1 THEN
    RAISE EXCEPTION 'G8 FAILED: somebody was dropped from a group without being asked';
  END IF;

  RAISE NOTICE 'ALL START-A-GROUP TESTS PASSED';
END $t$;
