-- Выполняется пользователем один раз в НОВОМ отдельном проекте Supabase.
-- Не содержит ключей, паролей и данных пользователя. Все изменения атомарны.
begin;

create table public.kd_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id)
);
create table public.kd_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  imports uuid[] not null default '{}'
);
create table public.kd_tasks (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id) between 1 and 200),
  name text not null check (length(btrim(name)) between 1 and 500),
  archived boolean not null default false,
  interval_days integer check (interval_days between 1 and 36500),
  primary key (user_id, id)
);
create unique index kd_tasks_name on public.kd_tasks
  (user_id, lower(replace(regexp_replace(btrim(name), '\s+', ' ', 'g'), 'ё', 'е')));
create table public.kd_entries (
  user_id uuid not null,
  id text not null check (length(id) between 1 and 200),
  task_id text not null,
  date date not null check (date >= date '1000-01-01' and date <= date '9999-12-31'),
  created bigint not null check (created between 0 and 9007199254740991),
  primary key (user_id, id),
  foreign key (user_id, task_id) references public.kd_tasks(user_id, id) on delete cascade
);
create index kd_entries_task on public.kd_entries(user_id, task_id);

alter table public.kd_owner enable row level security;
alter table public.kd_state enable row level security;
alter table public.kd_tasks enable row level security;
alter table public.kd_entries enable row level security;
create policy owner_read on public.kd_owner for select to authenticated using (user_id = (select auth.uid()));
create policy state_read on public.kd_state for select to authenticated using (user_id = (select auth.uid()) and exists (select 1 from public.kd_owner));
create policy tasks_read on public.kd_tasks for select to authenticated using (user_id = (select auth.uid()) and exists (select 1 from public.kd_owner));
create policy entries_read on public.kd_entries for select to authenticated using (user_id = (select auth.uid()) and exists (select 1 from public.kd_owner));
-- Запись только через RPC с проверкой версии. Прямой REST UPDATE запрещён.
revoke all on public.kd_owner, public.kd_state, public.kd_tasks, public.kd_entries from public, anon, authenticated;
grant select on public.kd_owner, public.kd_state, public.kd_tasks, public.kd_entries to authenticated;

create function public.kd_load() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_result jsonb;
begin
  if v_user is null or not exists (select 1 from public.kd_owner where user_id = v_user) then
    raise exception 'KD_FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.kd_state(user_id) values (v_user) on conflict do nothing;
  -- Один SQL-запрос получает согласованный снимок таблиц и версии.
  select jsonb_build_object(
    'revision', s.revision, 'imports', to_jsonb(s.imports),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'archived', t.archived, 'interval_days', t.interval_days) order by t.id) from public.kd_tasks t where t.user_id = v_user), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'task_id', e.task_id, 'date', to_char(e.date, 'YYYY-MM-DD'), 'created', e.created) order by e.id) from public.kd_entries e where e.user_id = v_user), '[]'::jsonb)
  ) into v_result from public.kd_state s where s.user_id = v_user;
  return v_result;
end;
$$;

create function public.kd_save(p_data jsonb, p_revision bigint, p_import_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_state public.kd_state%rowtype;
begin
  if v_user is null or not exists (select 1 from public.kd_owner where user_id = v_user) then
    raise exception 'KD_FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.kd_state(user_id) values (v_user) on conflict do nothing;
  select * into v_state from public.kd_state where user_id = v_user for update;
  -- Повторный перенос с того же устройства не воскрешает удалённые записи.
  if p_import_id is not null and p_import_id = any(v_state.imports) then return public.kd_load(); end if;
  if p_revision is null or p_revision <> v_state.revision then
    raise exception 'KD_CONFLICT' using errcode = '40001';
  end if;
  if p_data is null or jsonb_typeof(p_data->'tasks') is distinct from 'array' or jsonb_typeof(p_data->'entries') is distinct from 'array' then
    raise exception 'KD_INVALID_DATA' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 5000000 or jsonb_array_length(p_data->'entries') > 20000 then
    raise exception 'KD_DATA_LIMIT' using errcode = '22023';
  end if;
  -- Полный снимок небольшого личного журнала заменяется одной транзакцией.
  -- При любой ошибке PostgreSQL отменит и удаления, и вставки.
  delete from public.kd_entries where user_id = v_user;
  delete from public.kd_tasks where user_id = v_user;
  insert into public.kd_tasks(user_id, id, name, archived, interval_days)
    select v_user, t.id, t.name, t.archived, t.interval_days
    from jsonb_to_recordset(p_data->'tasks') as t(id text, name text, archived boolean, interval_days integer);
  insert into public.kd_entries(user_id, id, task_id, date, created)
    select v_user, e.id, e.task_id, e.date, e.created
    from jsonb_to_recordset(p_data->'entries') as e(id text, task_id text, date date, created bigint);
  if exists (select 1 from public.kd_tasks t where t.user_id = v_user and not exists (select 1 from public.kd_entries e where e.user_id = v_user and e.task_id = t.id)) then
    raise exception 'KD_EMPTY_TASK' using errcode = '22023';
  end if;
  update public.kd_state set revision = revision + 1,
    imports = case when p_import_id is null then imports else array_append(imports, p_import_id) end
    where user_id = v_user;
  return public.kd_load();
end;
$$;
revoke all on function public.kd_load(), public.kd_save(jsonb, bigint, uuid) from public, anon;
grant execute on function public.kd_load(), public.kd_save(jsonb, bigint, uuid) to authenticated;
commit;
