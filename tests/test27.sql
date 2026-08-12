\set ON_ERROR_STOP on
-- The Friends screen: a category on a record between two people, and who earns
-- a place in the list.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('d4000000-0000-0000-0000-00000000000a','fr_ann@t.lk','{"full_name":"Ann"}'),
   ('d4000000-0000-0000-0000-00000000000b','fr_ben@t.lk','{"full_name":"Ben"}'),
   ('d4000000-0000-0000-0000-00000000000c','fr_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
DO $f$ BEGIN
  INSERT INTO friend_requests (requester_id, addressee_id, addressee_email, status, responded_at)
  VALUES ('d4000000-0000-0000-0000-00000000000a','d4000000-0000-0000-0000-00000000000b','fr_ben@t.lk','ACCEPTED',NOW())
  ON CONFLICT (requester_id, addressee_email) DO NOTHING;
END $f$;
SET ROLE authenticated;

-- The predicate the Friends list applies, mirrored so a change to one is
-- noticed by the other: a connection, or money outstanding.
CREATE OR REPLACE FUNCTION pg_temp.listed(p_me UUID, p_them UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM friend_requests fr
      WHERE fr.status = 'ACCEPTED'
        AND ((fr.requester_id = p_me AND fr.addressee_id = p_them)
          OR (fr.requester_id = p_them AND fr.addressee_id = p_me))
  )
  OR EXISTS (
      SELECT 1 FROM groups g
      JOIN group_members a ON a.group_id = g.id AND a.user_id = p_me
      JOIN group_members b ON b.group_id = g.id AND b.user_id = p_them
      WHERE ABS(public.member_balance(g.id, p_me)) >= 0.01
  );
$$;

DO $t$
DECLARE
  ANN UUID:='d4000000-0000-0000-0000-00000000000a';
  BEN UUID:='d4000000-0000-0000-0000-00000000000b';
  CAR UUID:='d4000000-0000-0000-0000-00000000000c';
  e UUID; g UUID; v TEXT; blocked BOOLEAN;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- C1: a shared record keeps the category it was given
  e := add_direct_expense(BEN, 900, 'Dinner', TRUE, 450, FALSE, 'FOOD');
  SELECT category INTO v FROM expenses WHERE id = e;
  RAISE NOTICE 'C1 a shared record keeps its category | pass=% (%)', v='FOOD', v;
  IF v <> 'FOOD' THEN RAISE EXCEPTION 'C1 FAILED: category came out as %', v; END IF;

  -- C2: editing keeps it, and can change it
  PERFORM update_direct_expense(e, 900, 'Dinner', TRUE, 450, FALSE, 'ENTERTAINMENT');
  SELECT category INTO v FROM expenses WHERE id = e;
  RAISE NOTICE 'C2 editing can change the category | pass=% (%)', v='ENTERTAINMENT', v;
  IF v <> 'ENTERTAINMENT' THEN RAISE EXCEPTION 'C2 FAILED: %', v; END IF;

  -- C3: an unknown category is refused, same as anywhere else
  blocked := FALSE;
  BEGIN PERFORM add_direct_expense(BEN, 100, 'Nope', TRUE, 50, FALSE, 'NOT_A_CATEGORY');
  EXCEPTION WHEN OTHERS THEN blocked := TRUE; END;
  RAISE NOTICE 'C3 an unknown category is refused | pass=%', blocked;
  IF NOT blocked THEN RAISE EXCEPTION 'C3 FAILED: an invented category was stored'; END IF;

  -- C4: lending has no category — it is not a kind of spending
  e := lend_to_friend(BEN, 2000, 'Emergency', TRUE);
  SELECT category INTO v FROM expenses WHERE id = e;
  RAISE NOTICE 'C4 a loan stays uncategorised | pass=% (%)', v='OTHER', v;
  IF v <> 'OTHER' THEN RAISE EXCEPTION 'C4 FAILED: a loan was filed under %', v; END IF;

  -- C5: even if one is passed anyway
  e := add_direct_expense(BEN, 500, 'Loan', TRUE, 500, TRUE, 'FOOD');
  SELECT category INTO v FROM expenses WHERE id = e;
  RAISE NOTICE 'C5 a category cannot be forced onto a loan | pass=% (%)', v='OTHER', v;
  IF v <> 'OTHER' THEN RAISE EXCEPTION 'C5 FAILED: %', v; END IF;

  -- ---- who belongs in the list ----

  -- C6: an accepted friend is listed even with nothing outstanding
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(direct_group_with(ANN), ANN, 2950, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  IF ABS(member_balance(direct_group_with(BEN), ANN)) >= 0.01 THEN
    RAISE EXCEPTION 'C6 setup: not square (%)', member_balance(direct_group_with(BEN), ANN);
  END IF;
  RAISE NOTICE 'C6 a friend stays listed when square | pass=%', pg_temp.listed(ANN, BEN);
  IF NOT pg_temp.listed(ANN, BEN) THEN RAISE EXCEPTION 'C6 FAILED: a friend vanished'; END IF;

  -- C7: a group-mate you never befriended, with nothing owed, is not a friend
  g := (create_group('Trip','','✈️')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (g,CAR,'MEMBER');
  EXECUTE 'SET ROLE authenticated';
  RAISE NOTICE 'C7 a settled group-mate is not in the friends list | pass=%',
    NOT pg_temp.listed(ANN, CAR);
  IF pg_temp.listed(ANN, CAR) THEN
    RAISE EXCEPTION 'C7 FAILED: somebody you only share a group with is listed as a friend';
  END IF;

  -- C8: but money owed puts them there, because that is when you need them
  PERFORM save_expense(g,'Hotel',600,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',300,'is_included',true),
      jsonb_build_object('user_id',CAR,'amount',300,'is_included',true)),'[]'::jsonb);
  RAISE NOTICE 'C8 an outstanding balance puts them in the list | pass=%', pg_temp.listed(ANN, CAR);
  IF NOT pg_temp.listed(ANN, CAR) THEN
    RAISE EXCEPTION 'C8 FAILED: somebody who owes you is not reachable from Friends';
  END IF;

  -- C9: and once they pay, they leave again
  PERFORM set_config('request.jwt.claim.sub', CAR::TEXT, true);
  PERFORM record_settlement(g, ANN, 300, '', 'CASH');
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  RAISE NOTICE 'C9 settling up removes them again | pass=%', NOT pg_temp.listed(ANN, CAR);
  IF pg_temp.listed(ANN, CAR) THEN RAISE EXCEPTION 'C9 FAILED: still listed after settling'; END IF;

  -- C10: an ex-friend you still share a settled group with is gone for good
  PERFORM remove_friend(BEN);
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (g,BEN,'MEMBER');
  EXECUTE 'SET ROLE authenticated';
  RAISE NOTICE 'C10 an ex-friend sharing a settled group is not listed | pass=%',
    NOT pg_temp.listed(ANN, BEN);
  IF pg_temp.listed(ANN, BEN) THEN
    RAISE EXCEPTION 'C10 FAILED: a removed friend came back through a shared group';
  END IF;

  RAISE NOTICE 'ALL FRIENDS-SCREEN TESTS PASSED';
END $t$;
