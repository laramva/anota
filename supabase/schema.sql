-- Anota: estrutura do banco na nuvem (rodar uma vez no SQL Editor do Supabase)

create table if not exists public.records (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,
  note_id uuid,
  data jsonb not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_ts timestamptz not null default clock_timestamp()
);

create index if not exists records_user_ts on public.records (user_id, server_ts);
create index if not exists records_user_note on public.records (user_id, note_id);

alter table public.records enable row level security;
revoke all on public.records from anon;
grant select, insert, update, delete on public.records to authenticated;

drop policy if exists "records_select_own" on public.records;
drop policy if exists "records_insert_own" on public.records;
drop policy if exists "records_update_own" on public.records;
drop policy if exists "records_delete_own" on public.records;
create policy "records_select_own" on public.records for select to authenticated using (auth.uid() = user_id);
create policy "records_insert_own" on public.records for insert to authenticated with check (auth.uid() = user_id);
create policy "records_update_own" on public.records for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "records_delete_own" on public.records for delete to authenticated using (auth.uid() = user_id);

-- Carimbo do servidor (usado para baixar só o que mudou)
create or replace function public.records_touch() returns trigger
language plpgsql as $$
begin
  new.server_ts := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
for each row execute function public.records_touch();

-- Envio em lote: só substitui se a versão enviada for mais nova (nunca perde edição mais recente)
create or replace function public.push_records(rows jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  insert into public.records (id, user_id, kind, note_id, data, updated_at, deleted)
  select (r->>'id')::uuid, auth.uid(), r->>'kind', nullif(r->>'note_id', '')::uuid,
         r->'data', (r->>'updated_at')::bigint, coalesce((r->>'deleted')::boolean, false)
  from jsonb_array_elements(rows) as r
  on conflict (id) do update
    set kind = excluded.kind, note_id = excluded.note_id, data = excluded.data,
        updated_at = excluded.updated_at, deleted = excluded.deleted
    where public.records.updated_at < excluded.updated_at
      and public.records.user_id = auth.uid();
  get diagnostics n = row_count;
  return n;
end $$;

-- Remove os itens de uma nota excluída definitivamente (a própria nota fica como "excluída")
create or replace function public.purge_note(nid uuid) returns void
language sql security invoker set search_path = public as $$
  delete from public.records where note_id = nid and kind <> 'note' and user_id = auth.uid();
$$;

revoke execute on function public.push_records(jsonb) from public, anon;
revoke execute on function public.purge_note(uuid) from public, anon;
grant execute on function public.push_records(jsonb) to authenticated;
grant execute on function public.purge_note(uuid) to authenticated;

-- Arquivos (PDF, áudio, imagens): pasta privada por usuário
insert into storage.buckets (id, name, public) values ('files', 'files', false)
on conflict (id) do nothing;

drop policy if exists "files_select_own" on storage.objects;
drop policy if exists "files_insert_own" on storage.objects;
drop policy if exists "files_update_own" on storage.objects;
drop policy if exists "files_delete_own" on storage.objects;
create policy "files_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "files_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
