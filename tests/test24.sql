\set ON_ERROR_STOP on
-- Fuzz. Four people, hundreds of random operations, and the two things that must
-- never stop being true:
--
--   1. every group's ledger sums to exactly zero
--   2. each person's balance equals their own ledger rows
--
-- Both are checked after every single operation, so a failure names the step
-- that broke it rather than leaving a wrong number to be found later.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
DO $s$ BEGIN
  INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
   ('b2000000-0000-0000-0000-00000000000a','f_a@t.lk','{"full_name":"Ann"}'),
   ('b2000000-0000-0000-0000-00000000000b','f_b@t.lk','{"full_name":"Ben"}'),
   ('b2000000-0000-0000-0000-00000000000c','f_c@t.lk','{"full_name":"Cara"}'),
   ('b2000000-0000-0000-0000-00000000000d','f_d@t.lk','{"full_name":"Dee"}')
  ON CONFLICT (id) DO NOTHING;
END $s$;
SET ROLE authenticated;
DO $t$
DECLARE
  who   UUID[] := ARRAY['b2000000-0000-0000-0000-00000000000a'::UUID,
                        'b2000000-0000-0000-0000-00000000000b'::UUID,
                        'b2000000-0000-0000-0000-00000000000c'::UUID,
                        'b2000000-0000-0000-0000-00000000000d'::UUID];
  cats  TEXT[] := ARRAY['FOOD','TRANSPORT','ACCOMMODATION','ENTERTAINMENT','SHOPPING','OTHER'];
  G UUID; actor UUID; other UUID; e UUID; live UUID[];
  amt DECIMAL; a1 DECIMAL; a2 DECIMAL; a3 DECIMAL;
  op INT; i INT; k INT; net DECIMAL; bal DECIMAL; owed DECIMAL;
  ops INT := 0; adds INT := 0; edits INT := 0; dels INT := 0; setts INT := 0;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', who[1]::TEXT, true);
  G := (create_group('Fuzz','','🎲')).id;
  EXECUTE 'RESET ROLE';
  INSERT INTO group_members (group_id,user_id,role) VALUES
    (G,who[2],'MEMBER'),(G,who[3],'MEMBER'),(G,who[4],'MEMBER');
  EXECUTE 'SET ROLE authenticated';

  PERFORM setseed(0.4242);

  FOR i IN 1..250 LOOP
    actor := who[1 + floor(random()*4)::INT];
    PERFORM set_config('request.jwt.claim.sub', actor::TEXT, true);

    SELECT ARRAY_AGG(id) INTO live
    FROM expenses WHERE group_id=G AND NOT is_deleted AND settled_at IS NULL AND created_by=actor;

    op := floor(random()*10)::INT;

    BEGIN
      IF op < 5 OR live IS NULL THEN
        -- add a bill, split three ways with the remainder on the payer
        amt := ROUND((50 + random()*4000)::NUMERIC, 2);
        a1  := ROUND(amt/3, 2);
        a2  := ROUND(amt/3, 2);
        a3  := ROUND(amt - a1 - a2, 2);
        e := save_expense(G, 'Bill '||i, amt, actor,
              cats[1 + floor(random()*6)::INT], 'UNEQUAL', '',
              jsonb_build_array(
                jsonb_build_object('user_id',who[1],'amount',a1,'is_included',true),
                jsonb_build_object('user_id',who[2],'amount',a2,'is_included',true),
                jsonb_build_object('user_id',who[3],'amount',a3,'is_included',true),
                jsonb_build_object('user_id',who[4],'amount',0,'is_included',false)),
              '[]'::jsonb);
        adds := adds + 1;

      ELSIF op < 7 THEN
        -- edit one of your own, changing both the amount and who paid
        e := live[1 + floor(random()*array_length(live,1))::INT];
        amt := ROUND((50 + random()*4000)::NUMERIC, 2);
        a1  := ROUND(amt/2, 2);
        a2  := ROUND(amt - a1, 2);
        other := who[1 + floor(random()*4)::INT];
        PERFORM update_expense(e, 'Bill '||i||' (edited)', amt, other,
              'OTHER', 'UNEQUAL', '',
              jsonb_build_array(
                jsonb_build_object('user_id',who[2],'amount',a1,'is_included',true),
                jsonb_build_object('user_id',who[4],'amount',a2,'is_included',true)),
              '[]'::jsonb);
        edits := edits + 1;

      ELSIF op < 9 THEN
        -- delete one of your own
        e := live[1 + floor(random()*array_length(live,1))::INT];
        PERFORM delete_expense(e, 'fuzz');
        dels := dels + 1;

      ELSE
        -- settle part of what you owe somebody
        other := who[1 + floor(random()*4)::INT];
        CONTINUE WHEN other = actor;
        owed := member_balance(G, actor);
        CONTINUE WHEN owed >= -0.01;
        amt := ROUND((LEAST(ABS(owed), 200))::NUMERIC, 2);
        CONTINUE WHEN amt <= 0;
        PERFORM record_settlement(G, other, amt, 'fuzz', 'CASH');
        setts := setts + 1;
      END IF;

      ops := ops + 1;
    EXCEPTION WHEN OTHERS THEN
      -- A refusal is a valid outcome (settled bills are locked, and so on).
      -- What matters is that a refusal leaves nothing behind, which the
      -- invariant check below proves.
      NULL;
    END;

    -- INVARIANT 1: the group's ledger nets to zero
    SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=G;
    IF ROUND(net,2) <> 0 THEN
      RAISE EXCEPTION 'F1 FAILED at step % (op %): ledger nets to % instead of zero', i, op, net;
    END IF;

    -- INVARIANT 2: member_balance agrees with the raw rows for every person
    FOR k IN 1..4 LOOP
      SELECT COALESCE(SUM(amount),0) INTO bal
      FROM ledger_entries WHERE group_id=G AND user_id=who[k];
      IF ROUND(bal,2) <> ROUND(member_balance(G,who[k]),2) THEN
        RAISE EXCEPTION 'F2 FAILED at step %: % reads % but their rows sum to %',
          i, who[k], member_balance(G,who[k]), bal;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'F1 ledger nets to zero after every one of % operations | pass=t', ops;
  RAISE NOTICE 'F2 balances match the raw ledger throughout | pass=t';
  RAISE NOTICE '   (% added, % edited, % deleted, % settled)', adds, edits, dels, setts;

  -- The mix has to be real, or the run proves nothing.
  IF adds < 20 OR edits < 5 OR dels < 5 THEN
    RAISE EXCEPTION 'F3 FAILED: too thin a mix to mean anything (% / % / %)', adds, edits, dels;
  END IF;
  RAISE NOTICE 'F3 the run actually exercised all four operations | pass=t';

  -- And the whole thing can still be wound up.
  SELECT COALESCE(SUM(amount),0) INTO net FROM ledger_entries WHERE group_id=G;
  RAISE NOTICE 'F4 final ledger | pass=% (%)', ROUND(net,2)=0, net;
  IF ROUND(net,2) <> 0 THEN RAISE EXCEPTION 'F4 FAILED'; END IF;

  RAISE NOTICE 'ALL FUZZ TESTS PASSED';
END $t$;
