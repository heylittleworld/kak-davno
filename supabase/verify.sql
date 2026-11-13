-- Проверка в SQL Editor НОВОГО проекта после schema.sql и назначения владельца.
-- Все тестовые изменения откатываются. При ошибке ничего не коммить: выполни rollback.
begin;
do $$
declare owner_id uuid; before_data jsonb; result jsonb; payload jsonb;
begin
  select user_id into owner_id from public.kd_owner;
  if owner_id is null then raise exception 'Сначала назначь владельца по SUPABASE.md'; end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('kd_owner','kd_state','kd_tasks','kd_entries') and not c.relrowsecurity) then raise exception 'RLS выключен'; end if;
  if has_function_privilege('anon', 'public.kd_load()', 'EXECUTE') or has_function_privilege('anon', 'public.kd_save(jsonb,bigint,uuid)', 'EXECUTE') then raise exception 'anon получил доступ к RPC'; end if;
  if has_table_privilege('authenticated', 'public.kd_tasks', 'UPDATE') or has_table_privilege('authenticated', 'public.kd_entries', 'INSERT') or has_table_privilege('authenticated', 'public.kd_owner', 'INSERT') then raise exception 'Есть лишние права записи'; end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  before_data := public.kd_load();
  payload := jsonb_build_object('tasks', jsonb_build_array(jsonb_build_object('id','verify-task','name','Проверка','archived',false,'interval_days',7)),
    'entries', jsonb_build_array(jsonb_build_object('id','verify-entry','task_id','verify-task','date','2024-01-01','created',1)));
  result := public.kd_save(payload, (before_data->>'revision')::bigint, '11111111-1111-4111-8111-111111111111');
  if (result->>'revision')::bigint <> (before_data->>'revision')::bigint + 1 then raise exception 'Версия не увеличилась'; end if;
  if public.kd_save(payload, -1, '11111111-1111-4111-8111-111111111111') <> result then raise exception 'Повторный перенос изменил данные'; end if;
  begin
    perform public.kd_save(payload, -1);
    raise exception 'Конфликт не обнаружен';
  exception when serialization_failure then null;
  end;
  begin
    perform public.kd_save('{"tasks":[],"entries":[{"id":"broken","task_id":"missing","date":"2024-01-01","created":1}]}', (result->>'revision')::bigint);
    raise exception 'Неверная связь принята';
  exception when foreign_key_violation then null;
  end;
  if public.kd_load() <> result then raise exception 'Не сработал откат ошибочной записи'; end if;
end;
$$;
-- Проверка фактического RLS и RPC от имени другого authenticated пользователя.
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.kd_tasks) or exists (select 1 from public.kd_entries) or exists (select 1 from public.kd_state) or exists (select 1 from public.kd_owner) then raise exception 'RLS открыл чужие данные'; end if;
  begin
    perform public.kd_load();
    raise exception 'RPC открыл чужие данные';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.kd_save('{"tasks":[],"entries":[]}', 0);
    raise exception 'RPC разрешил чужую запись';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
rollback;
