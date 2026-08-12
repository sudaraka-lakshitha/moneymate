\set ON_ERROR_STOP on
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('e0000000-0000-0000-0000-00000000000a','v_a@t.lk','{"full_name":"Ann"}'),
   ('e0000000-0000-0000-0000-00000000000b','v_b@t.lk','{"full_name":"Ben"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
SET ROLE authenticated;
DO $t$
DECLARE
  A UUID:='e0000000-0000-0000-0000-00000000000a';
  B UUID:='e0000000-0000-0000-0000-00000000000b';
  G UUID; e UUID; f BOOLEAN; n INT; v TEXT; st TEXT;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', A::TEXT, true);
  G := (create_group('Val','','🧪')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES (G,B,'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  -- E1 negative amount
  f:=FALSE; BEGIN INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G,'Neg',-50,A,A,'FOOD');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E1 was accepted'; END IF;
  RAISE NOTICE 'E1 negative amount refused | pass=%', f;

  -- E2 zero amount
  f:=FALSE; BEGIN INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G,'Zero',0,A,A,'FOOD');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E2 was accepted'; END IF;
  RAISE NOTICE 'E2 zero amount refused | pass=%', f;

  -- E3 an amount below the smallest unit of currency
  f:=FALSE; BEGIN PERFORM save_expense(G,'Dust',0,A,'FOOD','EQUAL','',
    jsonb_build_array(jsonb_build_object('user_id',A,'amount',0,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E3 was accepted'; END IF;
  RAISE NOTICE 'E3 zero-amount bill refused through the RPC | pass=%', f;

  -- E4 numeric overflow (DECIMAL(14,2))
  f:=FALSE; BEGIN INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G,'Huge',99999999999999999,A,A,'FOOD');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E4 was accepted'; END IF;
  RAISE NOTICE 'E4 absurd amount refused (overflow) | pass=%', f;

  -- E5 arbitrary category string accepted?
  f:=FALSE; BEGIN INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G,'Cat',10,A,A,'NOT_A_REAL_CATEGORY');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E5 was accepted'; END IF;
  RAISE NOTICE 'E5 invalid category REJECTED? %  (f=blocked, t=allowed)', CASE WHEN f THEN 'blocked' ELSE 'ALLOWED' END;

  -- E6 empty title on a group expense
  f:=FALSE;
  BEGIN PERFORM save_expense(G,'',100,A,'OTHER','EQUAL','',
    jsonb_build_array(jsonb_build_object('user_id',A,'amount',100,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E6 was accepted'; END IF;
  RAISE NOTICE 'E6 empty expense title REJECTED? %', CASE WHEN f THEN 'blocked' ELSE 'ALLOWED' END;

  -- E7 invalid split_method
  f:=FALSE;
  BEGIN PERFORM save_expense(G,'Bad method',100,A,'OTHER','NONSENSE','',
    jsonb_build_array(jsonb_build_object('user_id',A,'amount',100,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E7 was accepted'; END IF;
  RAISE NOTICE 'E7 invalid split_method REJECTED? %', CASE WHEN f THEN 'blocked' ELSE 'ALLOWED' END;

  -- E8 a split naming someone who is NOT in the group
  f:=FALSE;
  BEGIN PERFORM save_expense(G,'Ghost',100,A,'OTHER','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',A,'amount',50,'is_included',true),
      jsonb_build_object('user_id','00000000-0000-0000-0000-0000000009ff','amount',50,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E8 was accepted'; END IF;
  RAISE NOTICE 'E8 split naming a non-member REJECTED? %', CASE WHEN f THEN 'blocked' ELSE 'ALLOWED' END;

  -- E9 negative split amounts that still sum correctly
  f:=FALSE;
  BEGIN PERFORM save_expense(G,'Neg split',100,A,'OTHER','EQUAL','',
    jsonb_build_array(
      jsonb_build_object('user_id',A,'amount',200,'is_included',true),
      jsonb_build_object('user_id',B,'amount',-100,'is_included',true)),'[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E9 was accepted'; END IF;
  RAISE NOTICE 'E9 negative split amount REJECTED? %', CASE WHEN f THEN 'blocked' ELSE 'ALLOWED' END;

  -- E10 a blank title
  f:=FALSE; BEGIN INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G,'',10,A,A,'FOOD');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E10 was accepted'; END IF;
  RAISE NOTICE 'E10 blank title refused | pass=%', f;

  -- E11 invalid email to invite
  SELECT out_status INTO st FROM invite_to_group_by_email(G,'not-an-email');
  IF st <> 'INVALID_EMAIL' THEN RAISE EXCEPTION 'VALIDATION: bad email accepted (%)', st; END IF;
  RAISE NOTICE 'E11 invalid invite email | status=%', st;

  -- E12 SQL-injection-shaped text is stored literally, not executed
  INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G,'''); DROP TABLE users; --',10,A,A,'FOOD');
  SELECT COUNT(*) INTO n FROM information_schema.tables WHERE table_name='users' AND table_schema='public';
  IF n <> 1 THEN RAISE EXCEPTION 'VALIDATION: injection affected the schema'; END IF;
  RAISE NOTICE 'E12 injection-shaped title harmless | users table intact=%', n=1;
  RAISE NOTICE 'ALL VALIDATION TESTS PASSED';

  -- E13 very long title
  f:=FALSE; BEGIN INSERT INTO expenses (group_id,title,amount,paid_by,created_by,category)
    VALUES (G, repeat('x',100000),10,A,A,'FOOD');
  EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E13 was accepted'; END IF;
  RAISE NOTICE 'E13 100k-char title REJECTED? %', CASE WHEN f THEN 'blocked' ELSE 'ALLOWED' END;

  -- E14 role must be ADMIN/MEMBER
  f:=FALSE; BEGIN PERFORM set_member_role(G,B,'SUPERUSER'); EXCEPTION WHEN OTHERS THEN f:=TRUE; END;
  IF NOT f THEN RAISE EXCEPTION 'VALIDATION: E14 was accepted'; END IF;
  RAISE NOTICE 'E14 bogus role refused | pass=%', f;
END $t$;
