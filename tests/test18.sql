\set ON_ERROR_STOP on
-- Inviting a friend straight into a group, and deleting your own account.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('50000000-0000-0000-0000-00000000000a','x_ann@t.lk','{"full_name":"Ann"}'),
   ('50000000-0000-0000-0000-00000000000b','x_ben@t.lk','{"full_name":"Ben"}'),
   ('50000000-0000-0000-0000-00000000000c','x_cara@t.lk','{"full_name":"Cara"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;

SET ROLE authenticated;

DO $t$
DECLARE
  ANN UUID:='50000000-0000-0000-0000-00000000000a';
  BEN UUID:='50000000-0000-0000-0000-00000000000b';
  CAR UUID:='50000000-0000-0000-0000-00000000000c';
  G UUID; G2 UUID; fr UUID; st TEXT; iid UUID; n INT; f BOOLEAN; v_role TEXT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  G := (create_group('Trip','','✈️')).id;

  -- M1: cannot invite a non-friend this way
  f:=FALSE;
  BEGIN PERFORM invite_friend_to_group(G, BEN); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  RAISE NOTICE 'M1 cannot invite a stranger by id | pass=%', f;
  IF NOT f THEN RAISE EXCEPTION 'M1 failed'; END IF;

  -- become friends
  SELECT out_status,out_request_id INTO st,fr FROM send_friend_request('x_ben@t.lk');
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM respond_to_friend_request(fr, TRUE);
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);

  -- M2: invite the friend with no email typing
  SELECT out_status,out_invitation_id INTO st,iid FROM invite_friend_to_group(G, BEN);
  RAISE NOTICE 'M2 friend invited directly | pass=% (%)', st='INVITED', st;
  IF st<>'INVITED' THEN RAISE EXCEPTION 'M2 failed: %', st; END IF;

  -- M3: still an invitation, not a silent seating
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND user_id=BEN;
  RAISE NOTICE 'M3 not added without consent | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'M3 failed: seated without accepting'; END IF;

  -- M4: inviting twice is idempotent
  SELECT out_status INTO st FROM invite_friend_to_group(G, BEN);
  RAISE NOTICE 'M4 duplicate invite reported | pass=% (%)', st='ALREADY_INVITED', st;
  IF st<>'ALREADY_INVITED' THEN RAISE EXCEPTION 'M4 failed: %', st; END IF;

  -- M5: accepting works through the normal path
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM respond_to_group_invitation(iid, TRUE);
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND user_id=BEN;
  RAISE NOTICE 'M5 accepted and seated | pass=%', n=1;
  IF n<>1 THEN RAISE EXCEPTION 'M5 failed'; END IF;

  -- M6: already a member is reported, not duplicated
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT out_status INTO st FROM invite_friend_to_group(G, BEN);
  RAISE NOTICE 'M6 existing member reported | pass=% (%)', st='ALREADY_MEMBER', st;
  IF st<>'ALREADY_MEMBER' THEN RAISE EXCEPTION 'M6 failed: %', st; END IF;

  -- M7: a non-admin cannot invite
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  f:=FALSE;
  BEGIN PERFORM invite_friend_to_group(G, CAR); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  RAISE NOTICE 'M7 non-admin cannot invite | pass=%', f;
  IF NOT f THEN RAISE EXCEPTION 'M7 failed'; END IF;

  -- ===== account deletion =====

  -- N1: refused while a balance is outstanding
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  PERFORM save_expense(G,'Hotel',1000,ANN,'ACCOMMODATION','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',ANN,'amount',500,'is_included',true,'stats',true),
      jsonb_build_object('user_id',BEN,'amount',500,'is_included',true)),'[]'::jsonb);
  f:=FALSE;
  BEGIN PERFORM delete_my_account(); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  RAISE NOTICE 'N1 deletion blocked while owed money | pass=%', f;
  IF NOT f THEN RAISE EXCEPTION 'N1 failed'; END IF;

  -- N2: still there
  SELECT COUNT(*) INTO n FROM users WHERE id=ANN;
  IF n<>1 THEN RAISE EXCEPTION 'N2 failed: account partly deleted'; END IF;
  RAISE NOTICE 'N2 blocked deletion left the account intact | pass=t';

  -- settle up
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  PERFORM record_settlement(G, ANN, 500, '', 'CASH');

  -- N3: Ben (a plain member, now square) can delete
  PERFORM set_config('request.jwt.claim.sub', BEN::TEXT, true);
  INSERT INTO daily_expenses (user_id,title,amount,category,date)
    VALUES (BEN,'Coffee',300,'FOOD',CURRENT_DATE);
  PERFORM delete_my_account();
  SELECT COUNT(*) INTO n FROM users WHERE id=BEN;
  RAISE NOTICE 'N3 settled account deletes | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'N3 failed'; END IF;

  -- N4: their personal data goes with it
  EXECUTE 'RESET ROLE';
  SELECT COUNT(*) INTO n FROM daily_expenses WHERE user_id=BEN;
  IF n<>0 THEN RAISE EXCEPTION 'N4 failed: % personal rows left', n; END IF;
  SELECT COUNT(*) INTO n FROM group_members WHERE user_id=BEN;
  IF n<>0 THEN RAISE EXCEPTION 'N4 failed: still in a group'; END IF;
  SELECT COUNT(*) INTO n FROM friend_requests WHERE requester_id=BEN OR addressee_id=BEN;
  IF n<>0 THEN RAISE EXCEPTION 'N4 failed: friend links left'; END IF;
  RAISE NOTICE 'N4 personal data, memberships and friendships removed | pass=t';
  EXECUTE 'SET ROLE authenticated';

  -- N5: the group survives with an admin
  PERFORM set_config('request.jwt.claim.sub', ANN::TEXT, true);
  SELECT COUNT(*) INTO n FROM groups WHERE id=G;
  IF n<>1 THEN RAISE EXCEPTION 'N5 failed: group vanished'; END IF;
  SELECT COUNT(*) INTO n FROM group_members WHERE group_id=G AND role='ADMIN';
  RAISE NOTICE 'N5 group still has an admin | pass=% (%)', n>=1, n;
  IF n<1 THEN RAISE EXCEPTION 'N5 failed'; END IF;

  -- N6: a sole member deleting takes the empty group with them
  G2 := (create_group('Solo','','👤')).id;
  PERFORM delete_my_account();
  EXECUTE 'RESET ROLE';
  SELECT COUNT(*) INTO n FROM groups WHERE id=G2;
  RAISE NOTICE 'N6 empty group removed with the account | pass=%', n=0;
  IF n<>0 THEN RAISE EXCEPTION 'N6 failed'; END IF;
  SELECT COUNT(*) INTO n FROM users WHERE id=ANN;
  IF n<>0 THEN RAISE EXCEPTION 'N6b failed: account survived'; END IF;

  RAISE NOTICE 'ALL INVITE-FRIEND / DELETE-ACCOUNT TESTS PASSED';
END $t$;
