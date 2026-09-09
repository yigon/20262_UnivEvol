-- 2026 가을학기 우주의 진화 / 나의 우주 이야기
-- 보안형 스키마: 비공개 제출 + 조교 일괄 공개 + 개인정보 분리 + Google Auth 기반 1인 1표
--
-- Supabase Dashboard > SQL Editor에서 실행하세요.
-- 기존 초기 버전 스키마 위에 실행해도 되도록 작성했습니다.
-- 실행 후 아래의 ADMIN / ROSTER 부분에 실제 Google 로그인 이메일을 등록하세요.

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1) 운영자 / 수강생 명단
-- -----------------------------------------------------------------------------

create table if not exists public.admin_users (
  email text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.course_roster (
  email text primary key,
  can_submit boolean not null default true,
  can_vote boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
alter table public.course_roster enable row level security;

-- 두 테이블은 브라우저에서 직접 읽지 못하게 둡니다.
-- SQL Editor / Dashboard에서는 프로젝트 운영자로 관리할 수 있습니다.

-- ▼ 반드시 본인 이메일로 교체해서 실행하세요.
-- insert into public.admin_users (email)
-- values ('YOUR_ADMIN_EMAIL@snu.ac.kr')
-- on conflict (email) do nothing;

-- ▼ 수강생 이메일 등록 예시. 여러 줄을 한 번에 넣어도 됩니다.
-- insert into public.course_roster (email) values
--   ('student1@snu.ac.kr'),
--   ('student2@snu.ac.kr'),
--   ('student3@snu.ac.kr')
-- on conflict (email) do nothing;

-- -----------------------------------------------------------------------------
-- 2) 접근 권한 helper
-- -----------------------------------------------------------------------------

create or replace function public.current_user_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(coalesce((select auth.jwt() ->> 'email'), ''));
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users a
    where lower(a.email) = public.current_user_email()
  );
$$;

create or replace function public.can_submit()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.course_roster r
      where lower(r.email) = public.current_user_email()
        and r.can_submit = true
    );
$$;

create or replace function public.can_vote()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.course_roster r
    where lower(r.email) = public.current_user_email()
      and r.can_vote = true
  );
$$;

revoke all on function public.current_user_email() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.can_submit() from public;
revoke all on function public.can_vote() from public;
grant execute on function public.current_user_email() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.can_submit() to authenticated;
grant execute on function public.can_vote() to authenticated;

-- -----------------------------------------------------------------------------
-- 3) 게시물 공개 데이터 / 개인정보 분리
-- -----------------------------------------------------------------------------

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 12000),
  attachments jsonb not null default '[]'::jsonb,
  is_published boolean not null default false,
  published_at timestamptz,
  show_author boolean not null default false,
  public_author text,
  public_department text,
  created_at timestamptz not null default now()
);

-- 기존 초기 스키마에서 업그레이드할 때 필요한 컬럼 추가
alter table public.entries add column if not exists is_published boolean not null default false;
alter table public.entries add column if not exists published_at timestamptz;
alter table public.entries add column if not exists show_author boolean not null default false;
alter table public.entries add column if not exists public_author text;
alter table public.entries add column if not exists public_department text;

create table if not exists public.entry_private (
  entry_id uuid primary key references public.entries(id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 80),
  department text not null default '' check (char_length(department) <= 100),
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_email text,
  created_at timestamptz not null default now()
);

-- 구버전의 author / department가 존재하면 개인정보 테이블로 옮깁니다.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'entries' and column_name = 'author'
  ) then
    execute $migrate$
      insert into public.entry_private (entry_id, author_name, department)
      select id, coalesce(author, ''), coalesce(department, '')
      from public.entries
      on conflict (entry_id) do nothing
    $migrate$;
  end if;
end $$;

alter table public.entries drop column if exists author;
alter table public.entries drop column if exists department;

alter table public.entries enable row level security;
alter table public.entry_private enable row level security;

-- 초기 버전 공개 정책 제거
drop policy if exists "Public can read entries" on public.entries;
drop policy if exists "Public can create entries" on public.entries;

-- 공개된 작품만 누구나 읽을 수 있고, 운영자는 대기작까지 모두 읽을 수 있습니다.
drop policy if exists "Published entries are public" on public.entries;
create policy "Published entries are public"
on public.entries for select
to anon, authenticated
using (is_published = true or public.is_admin());

-- 직접 INSERT는 열어두지 않습니다. 제출은 아래 submit_entry() RPC를 통해서만
-- 이루어지므로 공개 플래그나 개인정보 필드를 제출자가 임의로 조작할 수 없습니다.
drop policy if exists "Eligible users can submit hidden entries" on public.entries;

-- 공개/비공개, 이름 공개 여부 등 변경은 운영자만 가능합니다.
drop policy if exists "Admin can update entries" on public.entries;
create policy "Admin can update entries"
on public.entries for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admin can delete entries" on public.entries;
create policy "Admin can delete entries"
on public.entries for delete
to authenticated
using (public.is_admin());

-- 개인정보는 운영자만 읽을 수 있습니다.
drop policy if exists "Admin can read private entry data" on public.entry_private;
create policy "Admin can read private entry data"
on public.entry_private for select
to authenticated
using (public.is_admin());

-- 개인정보 행 역시 브라우저에서 직접 INSERT하지 않고 submit_entry()가 생성합니다.
drop policy if exists "Eligible users can submit private entry data" on public.entry_private;

drop policy if exists "Admin can update private entry data" on public.entry_private;
create policy "Admin can update private entry data"
on public.entry_private for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- 제출 내용 + 개인정보를 한 트랜잭션으로 저장합니다.
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

  if char_length(coalesce(p_author_name, '')) > 80 or char_length(coalesce(p_department, '')) > 100 then
    raise exception 'private_field_too_long';
  end if;

  insert into public.entries (
    id, title, body, attachments, is_published, published_at,
    show_author, public_author, public_department
  ) values (
    p_id, trim(p_title), coalesce(p_body, ''), coalesce(p_attachments, '[]'::jsonb),
    false, null, false, null, null
  );

  insert into public.entry_private (
    entry_id, author_name, department, submitted_by, submitted_email
  ) values (
    p_id, coalesce(p_author_name, ''), coalesce(p_department, ''),
    auth.uid(), public.current_user_email()
  );

  return p_id;
end;
$$;

revoke all on function public.submit_entry(uuid, text, text, jsonb, text, text) from public;
grant execute on function public.submit_entry(uuid, text, text, jsonb, text, text) to authenticated;

-- 파일 업로드 실패 시 제출자가 자신의 아직 비공개인 제출을 정리할 수 있게 합니다.
create or replace function public.delete_own_pending_entry(p_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.entry_private p
    join public.entries e on e.id = p.entry_id
    where p.entry_id = p_entry_id
      and p.submitted_by = auth.uid()
      and e.is_published = false
  ) then
    return false;
  end if;

  delete from public.entries where id = p_entry_id;
  return true;
end;
$$;

revoke all on function public.delete_own_pending_entry(uuid) from public;
grant execute on function public.delete_own_pending_entry(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4) 투표 설정 + 1인 1표
-- -----------------------------------------------------------------------------

create table if not exists public.site_settings (
  id integer primary key default 1 check (id = 1),
  voting_open boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.site_settings (id, voting_open)
values (1, false)
on conflict (id) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists "Anyone can read site settings" on public.site_settings;
create policy "Anyone can read site settings"
on public.site_settings for select
to anon, authenticated
using (true);

drop policy if exists "Admin can update site settings" on public.site_settings;
create policy "Admin can update site settings"
on public.site_settings for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create or replace function public.is_voting_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.voting_open from public.site_settings s where s.id = 1), false);
$$;

revoke all on function public.is_voting_open() from public;
grant execute on function public.is_voting_open() to anon, authenticated;

-- 구버전 브라우저 UUID 좋아요는 공식 투표로 사용하지 않습니다.
drop table if exists public.likes cascade;

create table if not exists public.votes (
  voter_id uuid primary key references auth.users(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.votes enable row level security;

-- 본인의 현재 투표만 읽을 수 있습니다. 운영자는 필요하면 전체 행을 확인할 수 있습니다.
drop policy if exists "Voter can read own vote" on public.votes;
create policy "Voter can read own vote"
on public.votes for select
to authenticated
using (voter_id = auth.uid() or public.is_admin());

-- voter_id가 PK이므로 한 계정은 동시에 정확히 한 작품에만 투표할 수 있습니다.
drop policy if exists "Eligible voter can vote once" on public.votes;
create policy "Eligible voter can vote once"
on public.votes for insert
to authenticated
with check (
  voter_id = auth.uid()
  and public.can_vote()
  and public.is_voting_open()
  and exists (
    select 1 from public.entries e
    where e.id = entry_id and e.is_published = true
  )
);

-- 투표 기간 중 다른 작품으로 표를 변경할 수 있습니다.
drop policy if exists "Voter can change own vote" on public.votes;
create policy "Voter can change own vote"
on public.votes for update
to authenticated
using (voter_id = auth.uid() and public.can_vote() and public.is_voting_open())
with check (
  voter_id = auth.uid()
  and public.can_vote()
  and public.is_voting_open()
  and exists (
    select 1 from public.entries e
    where e.id = entry_id and e.is_published = true
  )
);

drop policy if exists "Voter can cancel own vote" on public.votes;
create policy "Voter can cancel own vote"
on public.votes for delete
to authenticated
using (voter_id = auth.uid() and public.can_vote() and public.is_voting_open());

-- 다른 사람의 신원은 노출하지 않고 작품별 득표수만 반환합니다.
create or replace function public.get_vote_counts()
returns table(entry_id uuid, vote_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select v.entry_id, count(*)::bigint
  from public.votes v
  join public.entries e on e.id = v.entry_id
  where e.is_published = true
  group by v.entry_id;
$$;

revoke all on function public.get_vote_counts() from public;
grant execute on function public.get_vote_counts() to anon, authenticated;

-- 로그인한 사용자가 자신의 권한만 확인하는 용도입니다.
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', public.current_user_email(),
    'is_admin', public.is_admin(),
    'can_submit', public.can_submit(),
    'can_vote', public.can_vote(),
    'voting_open', public.is_voting_open()
  );
$$;

revoke all on function public.my_access() from public;
grant execute on function public.my_access() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5) 첨부 파일: private bucket + 게시된 작품만 읽기 허용
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('entry-media', 'entry-media', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

-- entry-media/<ENTRY_UUID>/<FILE> 형식의 첫 폴더를 게시물 ID로 사용합니다.
create or replace function public.can_view_entry_media(entry_id_text text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    or exists (
      select 1 from public.entries e
      where e.id::text = entry_id_text
        and e.is_published = true
    );
$$;

create or replace function public.can_upload_entry_media(entry_id_text text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.entry_private p
      join public.entries e on e.id = p.entry_id
      where p.entry_id::text = entry_id_text
        and p.submitted_by = auth.uid()
        and e.is_published = false
    );
$$;

revoke all on function public.can_view_entry_media(text) from public;
revoke all on function public.can_upload_entry_media(text) from public;
grant execute on function public.can_view_entry_media(text) to anon, authenticated;
grant execute on function public.can_upload_entry_media(text) to authenticated;

-- 초기 버전 Storage 정책 제거
drop policy if exists "Public can view entry media" on storage.objects;
drop policy if exists "Public can upload entry media" on storage.objects;

drop policy if exists "Published entry media can be viewed" on storage.objects;
create policy "Published entry media can be viewed"
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'entry-media'
  and public.can_view_entry_media((storage.foldername(name))[1])
);

drop policy if exists "Eligible user can upload own pending media" on storage.objects;
create policy "Eligible user can upload own pending media"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'entry-media'
  and public.can_upload_entry_media((storage.foldername(name))[1])
);

drop policy if exists "Owner can delete own pending media" on storage.objects;
create policy "Owner can delete own pending media"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'entry-media'
  and public.can_upload_entry_media((storage.foldername(name))[1])
);

drop policy if exists "Admin can delete entry media" on storage.objects;
create policy "Admin can delete entry media"
on storage.objects for delete
to authenticated
using (bucket_id = 'entry-media' and public.is_admin());

-- 주의: service_role 키는 브라우저 코드에 절대 넣지 마세요.
