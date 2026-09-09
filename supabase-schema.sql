-- 2026 가을학기 우주의 진화 / 나의 우주 이야기
-- 운영형 스키마
--   * 비공개 제출
--   * 예선 공개: 제목/내용 공개, 이름/학과 비공개
--   * 본선 공개: 본선 진출작 + 이름/학과 공개
--   * 본선 진출작 상단 분리 표시
--   * Google Auth + 수강생 roster
--   * 라운드별 1인 최대 3표, 같은 작품 중복 금지, 본인 작품 투표 금지
--   * 조교 게시물 삭제
--
-- 기존 보안형 스키마 위에 다시 실행해도 되도록 작성했습니다.
-- 기존 1인 1표 votes가 있으면 예선(preliminary) 표로 보존하면서 새 구조로 마이그레이션합니다.

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

-- 예시: 실제 Google 로그인 이메일을 SQL Editor에서 별도로 등록하세요.
-- insert into public.admin_users (email)
-- values ('YOUR_ADMIN_EMAIL@snu.ac.kr')
-- on conflict (email) do nothing;
--
-- insert into public.course_roster (email) values
--   ('student1@snu.ac.kr'),
--   ('student2@snu.ac.kr')
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
-- 3) 게시물 + 개인정보
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
  publication_stage text not null default 'hidden',
  is_finalist boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.entries add column if not exists is_published boolean not null default false;
alter table public.entries add column if not exists published_at timestamptz;
alter table public.entries add column if not exists show_author boolean not null default false;
alter table public.entries add column if not exists public_author text;
alter table public.entries add column if not exists public_department text;
alter table public.entries add column if not exists publication_stage text not null default 'hidden';
alter table public.entries add column if not exists is_finalist boolean not null default false;

alter table public.entries drop constraint if exists entries_publication_stage_check;
alter table public.entries
  add constraint entries_publication_stage_check
  check (publication_stage in ('hidden', 'preliminary', 'final'));

-- 이전 버전의 공개 상태를 새 단계로 마이그레이션합니다.
update public.entries
set publication_stage = case
  when is_published = true and show_author = true then 'final'
  when is_published = true then 'preliminary'
  else 'hidden'
end
where publication_stage = 'hidden' and is_published = true;

update public.entries
set is_finalist = true
where publication_stage = 'final';

-- 공개 단계와 개인정보 공개 상태를 일관되게 정규화합니다.
update public.entries
set is_published = (publication_stage <> 'hidden');

update public.entries
set show_author = false,
    public_author = null,
    public_department = null
where publication_stage <> 'final';

alter table public.entries drop constraint if exists entries_publication_consistency_check;
alter table public.entries
  add constraint entries_publication_consistency_check
  check (
    (publication_stage = 'hidden' and is_published = false)
    or (publication_stage <> 'hidden' and is_published = true)
  );

alter table public.entries drop constraint if exists entries_preliminary_privacy_check;
alter table public.entries
  add constraint entries_preliminary_privacy_check
  check (
    publication_stage = 'final'
    or (
      show_author = false
      and public_author is null
      and public_department is null
    )
  );

create table if not exists public.entry_private (
  entry_id uuid primary key references public.entries(id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 80),
  department text not null default '' check (char_length(department) <= 100),
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_email text,
  created_at timestamptz not null default now()
);

-- 구버전 author / department 컬럼이 있으면 개인정보 테이블로 이동합니다.
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

-- 이전 정책 제거
drop policy if exists "Public can read entries" on public.entries;
drop policy if exists "Public can create entries" on public.entries;
drop policy if exists "Published entries are public" on public.entries;
drop policy if exists "Eligible users can submit hidden entries" on public.entries;
drop policy if exists "Admin can update entries" on public.entries;
drop policy if exists "Admin can delete entries" on public.entries;

-- hidden이 아닌 작품만 공개. 조교는 모든 작품 열람 가능.
create policy "Published entries are public"
on public.entries for select
to anon, authenticated
using (publication_stage <> 'hidden' or public.is_admin());

create policy "Admin can update entries"
on public.entries for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admin can delete entries"
on public.entries for delete
to authenticated
using (public.is_admin());

-- 개인정보는 조교만 직접 열람/수정 가능.
drop policy if exists "Admin can read private entry data" on public.entry_private;
drop policy if exists "Eligible users can submit private entry data" on public.entry_private;
drop policy if exists "Admin can update private entry data" on public.entry_private;

create policy "Admin can read private entry data"
on public.entry_private for select
to authenticated
using (public.is_admin());

create policy "Admin can update private entry data"
on public.entry_private for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- 제출 내용 + 개인정보를 한 트랜잭션으로 저장.
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

  insert into public.entries (
    id, title, body, attachments,
    is_published, published_at,
    show_author, public_author, public_department,
    publication_stage, is_finalist
  ) values (
    p_id, trim(p_title), coalesce(p_body, ''), coalesce(p_attachments, '[]'::jsonb),
    false, null,
    false, null, null,
    'hidden', false
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

-- 파일 업로드 실패 시 제출자가 자신의 아직 비공개인 제출을 정리할 수 있게 함.
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
      and e.publication_stage = 'hidden'
  ) then
    return false;
  end if;

  delete from public.entries where id = p_entry_id;
  return true;
end;
$$;

revoke all on function public.delete_own_pending_entry(uuid) from public;
grant execute on function public.delete_own_pending_entry(uuid) to authenticated;

-- 본인 작품 ID만 반환. 개인정보 자체는 노출하지 않음.
create or replace function public.my_entry_ids()
returns table(entry_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.entry_id
  from public.entry_private p
  where auth.uid() is not null
    and p.submitted_by = auth.uid();
$$;

revoke all on function public.my_entry_ids() from public;
grant execute on function public.my_entry_ids() to authenticated;

-- -----------------------------------------------------------------------------
-- 4) 조교: 공개 단계 / 본선 진출 관리
-- -----------------------------------------------------------------------------

create or replace function public.admin_set_entry_stage(p_entry_id uuid, p_stage text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_finalist boolean;
  v_author text;
  v_department text;
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  if p_stage not in ('hidden', 'preliminary', 'final') then
    raise exception 'invalid_stage';
  end if;

  select e.is_finalist
  into v_is_finalist
  from public.entries e
  where e.id = p_entry_id;

  if not found then
    raise exception 'entry_not_found';
  end if;

  if p_stage = 'final' and not v_is_finalist then
    raise exception 'finalist_required';
  end if;

  if p_stage = 'hidden' then
    update public.entries
    set publication_stage = 'hidden',
        is_published = false,
        published_at = null,
        show_author = false,
        public_author = null,
        public_department = null
    where id = p_entry_id;

    -- 완전 비공개/철회된 작품의 기존 표도 함께 제거합니다.
    delete from public.votes where entry_id = p_entry_id;

  elsif p_stage = 'preliminary' then
    update public.entries
    set publication_stage = 'preliminary',
        is_published = true,
        published_at = coalesce(published_at, now()),
        show_author = false,
        public_author = null,
        public_department = null
    where id = p_entry_id;

    -- 본선 공개에서 내려온 경우 해당 작품의 본선 표는 무효화합니다.
    delete from public.votes
    where entry_id = p_entry_id
      and voting_round = 'final';

  else
    select nullif(p.author_name, ''), nullif(p.department, '')
    into v_author, v_department
    from public.entry_private p
    where p.entry_id = p_entry_id;

    update public.entries
    set publication_stage = 'final',
        is_published = true,
        published_at = coalesce(published_at, now()),
        show_author = true,
        public_author = v_author,
        public_department = v_department
    where id = p_entry_id;
  end if;

  return true;
end;
$$;

revoke all on function public.admin_set_entry_stage(uuid, text) from public;
grant execute on function public.admin_set_entry_stage(uuid, text) to authenticated;

create or replace function public.admin_set_finalist(p_entry_id uuid, p_is_finalist boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  if not exists (select 1 from public.entries e where e.id = p_entry_id) then
    raise exception 'entry_not_found';
  end if;

  if p_is_finalist then
    update public.entries
    set is_finalist = true
    where id = p_entry_id;
  else
    -- 본선 진출을 해제하면 본선 공개 작품은 예선 공개 상태로 되돌리고 개인정보를 숨김.
    update public.entries
    set is_finalist = false,
        publication_stage = case when publication_stage = 'final' then 'preliminary' else publication_stage end,
        show_author = case when publication_stage = 'final' then false else show_author end,
        public_author = case when publication_stage = 'final' then null else public_author end,
        public_department = case when publication_stage = 'final' then null else public_department end,
        is_published = case when publication_stage = 'hidden' then false else true end
    where id = p_entry_id;

    delete from public.votes
    where entry_id = p_entry_id
      and voting_round = 'final';
  end if;

  return true;
end;
$$;

revoke all on function public.admin_set_finalist(uuid, boolean) from public;
grant execute on function public.admin_set_finalist(uuid, boolean) to authenticated;

create or replace function public.admin_publish_all_preliminary()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  update public.entries
  set publication_stage = 'preliminary',
      is_published = true,
      published_at = coalesce(published_at, now()),
      show_author = false,
      public_author = null,
      public_department = null
  where publication_stage = 'hidden';

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
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  update public.entries e
  set publication_stage = 'final',
      is_published = true,
      published_at = coalesce(e.published_at, now()),
      show_author = true,
      public_author = (
        select nullif(p.author_name, '')
        from public.entry_private p
        where p.entry_id = e.id
      ),
      public_department = (
        select nullif(p.department, '')
        from public.entry_private p
        where p.entry_id = e.id
      )
  where e.is_finalist = true;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.admin_publish_all_finalists() from public;
grant execute on function public.admin_publish_all_finalists() to authenticated;

-- -----------------------------------------------------------------------------
-- 5) 투표 설정: 예선 / 본선
-- -----------------------------------------------------------------------------

create table if not exists public.site_settings (
  id integer primary key default 1 check (id = 1),
  voting_open boolean not null default false,
  voting_round text not null default 'preliminary',
  updated_at timestamptz not null default now()
);

alter table public.site_settings add column if not exists voting_open boolean not null default false;
alter table public.site_settings add column if not exists voting_round text not null default 'preliminary';

alter table public.site_settings drop constraint if exists site_settings_voting_round_check;
alter table public.site_settings
  add constraint site_settings_voting_round_check
  check (voting_round in ('preliminary', 'final'));

insert into public.site_settings (id, voting_open, voting_round)
values (1, false, 'preliminary')
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

create or replace function public.current_voting_round()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.voting_round from public.site_settings s where s.id = 1), 'preliminary');
$$;

revoke all on function public.is_voting_open() from public;
revoke all on function public.current_voting_round() from public;
grant execute on function public.is_voting_open() to anon, authenticated;
grant execute on function public.current_voting_round() to anon, authenticated;

create or replace function public.admin_set_voting_state(p_round text, p_open boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  if p_round not in ('preliminary', 'final') then
    raise exception 'invalid_round';
  end if;

  if p_open and p_round = 'final' and not exists (
    select 1
    from public.entries e
    where e.is_finalist = true
      and e.publication_stage = 'final'
  ) then
    raise exception 'no_final_entries';
  end if;

  update public.site_settings
  set voting_round = p_round,
      voting_open = p_open,
      updated_at = now()
  where id = 1;

  return true;
end;
$$;

revoke all on function public.admin_set_voting_state(text, boolean) from public;
grant execute on function public.admin_set_voting_state(text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 6) 투표: 라운드별 최대 3표 / 중복 금지 / 본인 작품 금지
-- -----------------------------------------------------------------------------

-- 구버전 브라우저 UUID 좋아요는 공식 투표로 사용하지 않음.
drop table if exists public.likes cascade;

create table if not exists public.votes (
  voter_id uuid not null references auth.users(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  voting_round text not null default 'preliminary',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 기존 1인 1표 테이블 업그레이드.
alter table public.votes add column if not exists voting_round text;
alter table public.votes add column if not exists created_at timestamptz not null default now();
alter table public.votes add column if not exists updated_at timestamptz not null default now();
update public.votes set voting_round = 'preliminary' where voting_round is null;
alter table public.votes alter column voting_round set default 'preliminary';
alter table public.votes alter column voting_round set not null;

alter table public.votes drop constraint if exists votes_voting_round_check;
alter table public.votes
  add constraint votes_voting_round_check
  check (voting_round in ('preliminary', 'final'));

-- 예전 PK(voter_id)를 제거하고, 같은 라운드/같은 작품 중복만 막는 복합 PK로 변경.
do $$
declare
  v_pk text;
begin
  select c.conname
  into v_pk
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'votes'
    and c.contype = 'p';

  if v_pk is not null then
    execute format('alter table public.votes drop constraint %I', v_pk);
  end if;
end $$;

alter table public.votes
  add primary key (voter_id, entry_id, voting_round);

alter table public.votes enable row level security;

-- 기존 직접 변경 정책 제거. 표의 추가/취소는 toggle_vote() RPC로만 수행.
drop policy if exists "Voter can read own vote" on public.votes;
drop policy if exists "Eligible voter can vote once" on public.votes;
drop policy if exists "Voter can change own vote" on public.votes;
drop policy if exists "Voter can cancel own vote" on public.votes;
drop policy if exists "Voter can read own votes" on public.votes;

create policy "Voter can read own votes"
on public.votes for select
to authenticated
using (voter_id = auth.uid() or public.is_admin());

create or replace function public.toggle_vote(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round text;
  v_open boolean;
  v_stage text;
  v_finalist boolean;
  v_count integer;
  v_selected boolean;
begin
  if auth.uid() is null or not public.can_vote() then
    raise exception 'vote_not_allowed';
  end if;

  select s.voting_round, s.voting_open
  into v_round, v_open
  from public.site_settings s
  where s.id = 1;

  if not coalesce(v_open, false) then
    raise exception 'voting_closed';
  end if;

  select e.publication_stage, e.is_finalist
  into v_stage, v_finalist
  from public.entries e
  where e.id = p_entry_id;

  if not found then
    raise exception 'entry_not_found';
  end if;

  if v_round = 'preliminary' then
    if v_stage not in ('preliminary', 'final') then
      raise exception 'entry_not_eligible';
    end if;
  elsif v_round = 'final' then
    if v_stage <> 'final' or not v_finalist then
      raise exception 'entry_not_eligible';
    end if;
  else
    raise exception 'invalid_round';
  end if;

  -- 제출자가 자신의 어떤 작품에도 투표하지 못하도록 DB에서 강제.
  if exists (
    select 1
    from public.entry_private p
    where p.entry_id = p_entry_id
      and p.submitted_by = auth.uid()
  ) then
    raise exception 'own_entry_not_allowed';
  end if;

  -- 동일 사용자가 동시 요청으로 3표 제한을 우회하지 못하도록 사용자/라운드 단위 잠금.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text || ':' || v_round, 0)
  );

  -- 이미 찍은 작품을 다시 누르면 취소.
  if exists (
    select 1
    from public.votes v
    where v.voter_id = auth.uid()
      and v.entry_id = p_entry_id
      and v.voting_round = v_round
  ) then
    delete from public.votes
    where voter_id = auth.uid()
      and entry_id = p_entry_id
      and voting_round = v_round;
    v_selected := false;
  else
    select count(*)::integer
    into v_count
    from public.votes v
    join public.entries e on e.id = v.entry_id
    where v.voter_id = auth.uid()
      and v.voting_round = v_round
      and (
        (v_round = 'preliminary' and e.publication_stage in ('preliminary', 'final'))
        or
        (v_round = 'final' and e.publication_stage = 'final' and e.is_finalist = true)
      );

    if v_count >= 3 then
      raise exception 'vote_limit_reached';
    end if;

    insert into public.votes (voter_id, entry_id, voting_round)
    values (auth.uid(), p_entry_id, v_round);
    v_selected := true;
  end if;

  select count(*)::integer
  into v_count
  from public.votes v
  join public.entries e on e.id = v.entry_id
  where v.voter_id = auth.uid()
    and v.voting_round = v_round
    and (
      (v_round = 'preliminary' and e.publication_stage in ('preliminary', 'final'))
      or
      (v_round = 'final' and e.publication_stage = 'final' and e.is_finalist = true)
    );

  return jsonb_build_object(
    'selected', v_selected,
    'voting_round', v_round,
    'used_votes', v_count,
    'remaining_votes', greatest(0, 3 - v_count)
  );
end;
$$;

revoke all on function public.toggle_vote(uuid) from public;
grant execute on function public.toggle_vote(uuid) to authenticated;

-- 현재 선택된 라운드(투표 종료 후에도 마지막 라운드)의 작품별 득표수.
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
  where v.voting_round = public.current_voting_round()
    and (
      (public.current_voting_round() = 'preliminary' and e.publication_stage in ('preliminary', 'final'))
      or
      (public.current_voting_round() = 'final' and e.publication_stage = 'final' and e.is_finalist = true)
    )
  group by v.entry_id;
$$;

revoke all on function public.get_vote_counts() from public;
grant execute on function public.get_vote_counts() to anon, authenticated;

-- 로그인한 사용자가 자신의 권한/현재 투표 상태만 확인.
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
    'voting_open', public.is_voting_open(),
    'voting_round', public.current_voting_round()
  );
$$;

revoke all on function public.my_access() from public;
grant execute on function public.my_access() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7) 첨부 파일: private bucket + 공개 작품만 읽기 허용
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('entry-media', 'entry-media', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

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
        and e.publication_stage <> 'hidden'
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
        and e.publication_stage = 'hidden'
    );
$$;

revoke all on function public.can_view_entry_media(text) from public;
revoke all on function public.can_upload_entry_media(text) from public;
grant execute on function public.can_view_entry_media(text) to anon, authenticated;
grant execute on function public.can_upload_entry_media(text) to authenticated;

-- 초기/이전 Storage 정책 제거
drop policy if exists "Public can view entry media" on storage.objects;
drop policy if exists "Public can upload entry media" on storage.objects;
drop policy if exists "Published entry media can be viewed" on storage.objects;
drop policy if exists "Eligible user can upload own pending media" on storage.objects;
drop policy if exists "Owner can delete own pending media" on storage.objects;
drop policy if exists "Admin can delete entry media" on storage.objects;

create policy "Published entry media can be viewed"
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'entry-media'
  and public.can_view_entry_media((storage.foldername(name))[1])
);

create policy "Eligible user can upload own pending media"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'entry-media'
  and public.can_upload_entry_media((storage.foldername(name))[1])
);

create policy "Owner can delete own pending media"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'entry-media'
  and public.can_upload_entry_media((storage.foldername(name))[1])
);

create policy "Admin can delete entry media"
on storage.objects for delete
to authenticated
using (bucket_id = 'entry-media' and public.is_admin());

-- service_role 키는 브라우저 코드에 절대 넣지 마세요.
