-- R2 신규 제출 전환 (기존 Supabase Storage 파일은 그대로 보존).
-- 이 파일만 현재 운영 DB의 SQL Editor에서 1회 실행합니다.
-- 기존 supabase-schema.sql은 재실행하지 마세요.

begin;

alter table public.entries
  add column if not exists upload_state text not null default 'ready';

alter table public.entries drop constraint if exists entries_upload_state_check;
alter table public.entries
  add constraint entries_upload_state_check
  check (upload_state in ('uploading', 'ready'));

-- 제출이 완료되지 않은 작품은 관리자라도 게시할 수 없습니다.
alter table public.entries drop constraint if exists entries_upload_publish_check;
alter table public.entries
  add constraint entries_upload_publish_check
  check (upload_state = 'ready' or publication_stage = 'hidden');

-- R2 object key와 다중 파트 상태를 서버 전용 테이블에서 관리합니다.
-- foreign key ON DELETE CASCADE를 사용하지 않아, 삭제 직후 생길 수 있는
-- 비동기 업로드 orphan의 정리 대상도 추적할 수 있습니다.
create table if not exists public.r2_uploads (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  object_key text not null unique,
  submitted_by uuid not null,
  size_bytes bigint not null check (size_bytes > 0),
  content_type text not null,
  extension text not null,
  upload_mode text not null check (upload_mode in ('single', 'multipart')),
  multipart_upload_id text,
  upload_status text not null default 'pending'
    check (upload_status in ('pending', 'attached')),
  created_at timestamptz not null default now(),
  attached_at timestamptz,
  deleted_at timestamptz
);
create index if not exists r2_uploads_entry_idx on public.r2_uploads(entry_id);
create index if not exists r2_uploads_created_idx on public.r2_uploads(created_at);
alter table public.r2_uploads enable row level security;
revoke all on public.r2_uploads from anon, authenticated;
-- RLS 정책을 만들지 않음: service_role 또는 postgres만 접근합니다.

-- 기존 작품들은 upload_state 기본값 ready로 보존됩니다.
-- 신규 제출은 브라우저가 임의의 파일 경로를 DB에 써넣지 못하게 하고,
-- Edge Function이 파일 업로드를 확인한 뒤 서버 측에서 메타데이터를 추가합니다.
create or replace function public.submit_entry(
  p_id uuid,
  p_title text,
  p_body text,
  p_attachments jsonb,
  p_author_name text,
  p_department text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.can_submit() then
    raise exception 'submission_not_allowed';
  end if;
  if char_length(trim(coalesce(p_title, ''))) < 1 or char_length(p_title) > 120 then
    raise exception 'invalid_title';
  end if;
  if char_length(coalesce(p_body, '')) > 12000 then
    raise exception 'body_too_long';
  end if;
  if char_length(trim(coalesce(p_author_name, ''))) < 1 then
    raise exception 'author_required';
  end if;
  if char_length(trim(coalesce(p_department, ''))) < 1 then
    raise exception 'department_required';
  end if;
  if char_length(p_author_name) > 80 or char_length(p_department) > 100 then
    raise exception 'private_field_too_long';
  end if;
  if p_attachments is null or p_attachments <> '[]'::jsonb then
    raise exception 'attachments_must_be_uploaded_using_r2';
  end if;

  insert into public.entries (
    id, title, body, attachments,
    is_published, published_at,
    show_author, public_author, public_department,
    publication_stage, is_finalist, upload_state
  ) values (
    p_id, trim(p_title), coalesce(p_body, ''), '[]'::jsonb,
    false, null,
    false, null, null,
    'hidden', false, 'uploading'
  );

  insert into public.entry_private (
    entry_id, author_name, department, submitted_by, submitted_email
  ) values (
    p_id, trim(p_author_name), trim(p_department),
    auth.uid(), public.current_user_email()
  );
  return p_id;
end;
$$;
revoke all on function public.submit_entry(uuid, text, text, jsonb, text, text) from public;
grant execute on function public.submit_entry(uuid, text, text, jsonb, text, text) to authenticated;

-- 오직 서비스 키를 보유한 Edge Function만 호출합니다.
-- HeadObject/멀티파트 완료를 서버에서 검증한 후 호출하도록 설계했습니다.
create or replace function public.r2_finalize_upload(p_upload_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.r2_uploads%rowtype;
  v_count integer;
begin
  select * into v_upload from public.r2_uploads
    where id = p_upload_id for update;
  if not found then raise exception 'upload_not_found'; end if;
  if v_upload.upload_status = 'attached' then return true; end if;
  perform 1 from public.entries
    where id = v_upload.entry_id
      and publication_stage = 'hidden'
      and upload_state = 'uploading' for update;
  if not found then raise exception 'entry_not_uploading'; end if;

  select jsonb_array_length(coalesce(e.attachments, '[]'::jsonb))
    into v_count from public.entries e where e.id = v_upload.entry_id;

  update public.entries
  set attachments = coalesce(attachments, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'storage', 'r2',
      'path', v_upload.object_key,
      'type', v_upload.content_type,
      'name', '첨부파일_' || (v_count + 1)::text || '.' || v_upload.extension
    )
  )
  where id = v_upload.entry_id;

  update public.r2_uploads
  set upload_status = 'attached', attached_at = now()
  where id = p_upload_id;
  return true;
end;
$$;
revoke all on function public.r2_finalize_upload(uuid) from public, anon, authenticated;
grant execute on function public.r2_finalize_upload(uuid) to service_role;

create or replace function public.r2_complete_submission(p_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.entries%rowtype;
begin
  select * into v_entry from public.entries where id = p_entry_id for update;
  if not found then raise exception 'entry_not_found'; end if;
  if v_entry.upload_state = 'ready' then return true; end if;
  if exists (select 1 from public.r2_uploads
             where entry_id = p_entry_id and upload_status <> 'attached') then
    raise exception 'unfinished_uploads';
  end if;
  if trim(coalesce(v_entry.body, '')) = ''
     and jsonb_array_length(coalesce(v_entry.attachments, '[]'::jsonb)) = 0 then
    raise exception 'submission_requires_body_or_file';
  end if;
  update public.entries set upload_state = 'ready' where id = p_entry_id;
  return true;
end;
$$;
revoke all on function public.r2_complete_submission(uuid) from public, anon, authenticated;
grant execute on function public.r2_complete_submission(uuid) to service_role;

-- 대기작 일괄 공개가 진행 중인 업로드를 함께 공개하지 않도록 수정합니다.
create or replace function public.admin_publish_all_preliminary()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not public.is_admin() then raise exception 'admin_only'; end if;
  update public.entries
  set publication_stage = 'preliminary', is_published = true,
      published_at = coalesce(published_at, now()),
      show_author = false, public_author = null, public_department = null
  where publication_stage = 'hidden' and upload_state = 'ready';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.admin_publish_all_preliminary() from public;
grant execute on function public.admin_publish_all_preliminary() to authenticated;

create or replace function public.admin_publish_all_finalists()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not public.is_admin() then raise exception 'admin_only'; end if;
  update public.entries e
  set publication_stage = 'final', is_published = true,
      published_at = coalesce(e.published_at, now()),
      show_author = true,
      public_author = (select nullif(p.author_name, '') from public.entry_private p where p.entry_id = e.id),
      public_department = (select nullif(p.department, '') from public.entry_private p where p.entry_id = e.id)
  where e.is_finalist = true and e.upload_state = 'ready';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.admin_publish_all_finalists() from public;
grant execute on function public.admin_publish_all_finalists() to authenticated;

-- 기존 파일 읽기 정책은 유지, 신규 Supabase 업로드는 차단합니다.
drop policy if exists "Eligible user can upload own pending media" on storage.objects;
-- R2 정리를 생략하는 구식 클라이언트 삭제 경로도 비활성화합니다.
revoke execute on function public.delete_own_pending_entry(uuid) from authenticated;
drop policy if exists "Admin can delete entries" on public.entries;
-- 조교도 R2를 정리하는 Edge Function 경유로만 게시물을 삭제합니다.

commit;
