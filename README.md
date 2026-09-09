# 2026년 가을학기 우주의 진화 — 나의 우주 이야기

GitHub Pages + Supabase용 정적 사이트입니다.

이번 버전의 Entries는 다음 운영 방식을 사용합니다.

- 수강생은 **이메일 OTP 인증 후** 작품 제출
- 제출 작품은 기본적으로 **비공개**이며 조교만 열람 가능
- 조교 화면에서 개별 공개/비공개 및 **대기작 전체 일괄 공개**
- 이름·학과·제출 이메일은 `entry_private`에 별도 저장
- 공개 작품의 이름/학과는 조교가 작품별로 공개/숨김 선택
- 첨부파일은 **private Storage bucket**에 저장
- 공개된 작품의 첨부파일만 제한시간 signed URL로 감상 가능
- 투표는 인증된 수강생만 가능
- `voter_id = auth.uid()`를 기본키로 사용해 **1인 1표**를 DB에서 강제
- 투표 기간 중 다른 작품으로 표 변경 또는 취소 가능
- 조교가 Entries의 관리 패널에서 투표 시작/종료 가능

## 1. Supabase SQL 업데이트

Supabase Dashboard → **SQL Editor**에서 `supabase-schema.sql` 전체를 실행합니다.

이 파일은 초기 공개 게시판 버전에서 업그레이드할 수 있게 작성되어 있습니다.
기존 브라우저 UUID 기반 `likes` 테이블은 삭제되고 공식 `votes` 테이블로 교체됩니다.

### 운영자 이메일 등록

SQL 파일 실행 후 본인이 로그인할 이메일을 등록합니다.

```sql
insert into public.admin_users (email)
values ('YOUR_ADMIN_EMAIL@snu.ac.kr')
on conflict (email) do nothing;
```

이 이메일로 로그인하면 Entries에 **조교 관리 패널**이 표시됩니다.

### 수강생 이메일 등록

공식 투표를 1인 1표로 제한하려면 실제 수강생 이메일 명단을 등록하는 것이 가장 안전합니다.

```sql
insert into public.course_roster (email) values
  ('student1@snu.ac.kr'),
  ('student2@snu.ac.kr'),
  ('student3@snu.ac.kr')
on conflict (email) do nothing;
```

기본값으로 각 수강생은 제출과 투표 권한을 모두 갖습니다.
특정 학생의 권한을 따로 끌 수도 있습니다.

```sql
update public.course_roster
set can_vote = false
where email = 'student1@snu.ac.kr';
```

수강생 명단 자체는 브라우저에서 읽을 수 없게 RLS로 막혀 있습니다.

## 2. Supabase 이메일 OTP 설정

이 사이트는 링크 클릭 방식 대신 **6자리 이메일 OTP**를 사용합니다.
GitHub Pages의 hash routing과 충돌이 없고 학생 입장에서도 단순합니다.

Supabase Dashboard → **Authentication → Email Templates → Magic Link**에서
메일 본문에 `{{ .Token }}`을 넣습니다. 예:

```html
<h2>우주의 진화 수강생 인증</h2>
<p>인증 코드: <strong>{{ .Token }}</strong></p>
```

기존 `{{ .ConfirmationURL }}` 링크 대신 `{{ .Token }}`을 사용해야 6자리 코드가 전송됩니다.

## 3. config.js

기존과 동일하게 Project URL과 browser용 anon/publishable key만 입력합니다.

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_...";
```

`service_role` 키는 절대 GitHub 저장소나 브라우저 코드에 넣지 마세요.

## 4. 제출 흐름

1. 수강생이 Entries → **작품 제출** 클릭
2. 수강생 이메일로 6자리 OTP 인증
3. 제목 / 이름 / 학과 / 본문 / 첨부파일 입력
4. 제출 완료
5. 작품과 첨부파일은 공개 사이트에서는 보이지 않음
6. 조교 계정으로 로그인하면 관리 패널에서 대기작 확인
7. `공개` 또는 `대기작 전체 공개`로 공개

제목 자체에 이름을 쓰면 개인정보 숨김 기능으로 가릴 수 없으므로 제목 입력 예시는 이름 없는 형태로 바꾸었습니다. 또한 원본 첨부파일 이름도 공개 메타데이터에 저장하지 않고 `첨부파일_1.pdf` 같은 일반 이름으로 바꿉니다.

단, 작품 본문·이미지·PDF 내용 자체에 이름이나 학번이 들어 있으면 자동으로 제거되지는 않으므로 익명 공개가 필요할 때는 작품 내용도 확인해야 합니다.

## 5. 이름 / 학과 공개

제출 당시 이름과 학과는 `entry_private`에 저장되어 **조교만 확인**할 수 있습니다.

조교 관리 패널의 `이름 공개` 버튼을 누르면 해당 작품의 공개용 필드에 이름/학과가 복사됩니다.
`이름 숨기기`를 누르면 공개용 필드는 다시 `NULL`이 됩니다.

즉 단순 CSS 숨김이 아니라 공개 API에서도 개인정보가 빠집니다.

## 6. 첨부파일 보안

`entry-media` bucket은 이제 **private**입니다.

- 비공개 제출물: 조교만 읽기 가능
- 공개 작품: 방문자에게 signed URL 발급 가능
- 제출자도 제출 후 비공개 파일을 다시 열람할 권한은 기본적으로 없음

파일 경로는 다음처럼 작품 UUID 아래에 저장됩니다.

```text
entry-media/<ENTRY_UUID>/<RANDOM_UUID>.pdf
```

개별 파일 최대 크기는 기존과 동일하게 50MB입니다.

## 7. 투표 방식

기존의 브라우저 UUID 좋아요는 제거했습니다.

현재 방식은:

```text
인증 이메일 → Supabase Auth user → auth.uid() → votes.voter_id
```

이며 `votes.voter_id` 자체가 Primary Key입니다.
따라서 같은 로그인 계정으로 두 작품에 동시에 투표할 수 없습니다.

- 다른 작품을 누르면 기존 표가 새 작품으로 이동
- 현재 선택 작품을 다시 누르면 표 취소
- 투표가 닫혀 있으면 DB 정책에서도 INSERT / UPDATE / DELETE 거부

단, **한 사람이 서로 다른 이메일 계정을 여러 개 갖고 있고 그 이메일들을 모두 roster에 등록했다면** 여러 표가 가능하므로, course roster에는 실제 1인당 하나의 공식 이메일만 등록해야 합니다.

## 8. 조교 관리 패널

`admin_users`에 등록된 이메일로 로그인하면 Entries 상단에 관리 패널이 생깁니다.

가능한 작업:

- 비공개 대기작 및 제출자 정보 확인
- 작품별 공개 / 비공개
- 대기작 전체 일괄 공개
- 작품별 이름·학과 공개 / 숨김
- 투표 시작 / 종료

## 9. GitHub Pages 배포

파일을 repository 최상위에 올리고 기존처럼 GitHub Pages에서 `main / root`를 배포하면 됩니다.
빌드 과정은 없습니다.

```text
index.html
styles.css
app.js
config.js
supabase-schema.sql
README.md
assets/
```

수정 후 GitHub Actions의 Pages deployment가 완료되면 반영됩니다.
