# 2026년 가을학기 우주의 진화 — 나의 우주 이야기

GitHub Pages + Supabase용 정적 사이트입니다.

이번 버전의 Entries는 다음 운영 방식을 사용합니다.

- 수강생/조교는 **Google OAuth**로 로그인
- 로그인 이메일이 `course_roster`에 등록된 수강생만 작품 제출/투표 가능
- `admin_users`에 등록된 이메일은 조교 권한으로 인식
- 제출 작품은 기본적으로 **비공개**이며 조교만 열람 가능
- 조교 화면에서 개별 공개/비공개 및 **대기작 전체 일괄 공개**
- 이름·학과·제출 이메일은 `entry_private`에 별도 저장
- 공개 작품의 이름/학과는 조교가 작품별로 공개/숨김 선택
- 첨부파일은 **private Storage bucket**에 저장
- 공개된 작품의 첨부파일만 제한시간 signed URL로 감상 가능
- `votes.voter_id = auth.uid()`를 Primary Key로 사용해 **인증 계정당 1표**를 DB에서 강제
- 투표 기간 중 다른 작품으로 표 변경 또는 취소 가능
- 조교가 Entries 관리 패널에서 투표 시작/종료 가능

---

## 1. Supabase SQL

아직 보안형 `supabase-schema.sql`을 실행하지 않았다면 Supabase Dashboard → **SQL Editor**에서 전체를 실행합니다.

이미 이전 보안형 스키마(비공개 제출 + `course_roster` + `admin_users` + `votes`)를 실행했다면 **Google OAuth 전환만을 위해 SQL을 다시 실행할 필요는 없습니다.** 이번 파일의 DB 구조는 동일하고 설명만 Google 로그인 기준으로 정리했습니다.

### 운영자 이메일 등록

조교가 Google 로그인에 사용할 이메일을 등록합니다.

```sql
insert into public.admin_users (email)
values ('YOUR_GOOGLE_LOGIN_EMAIL@snu.ac.kr')
on conflict (email) do nothing;
```

이 이메일로 Google 로그인하면 Entries에 **조교 관리 패널**이 표시됩니다.

### 수강생 이메일 등록

학생이 실제 Google 로그인에 사용할 이메일을 등록합니다. Google 계정의 로그인 이메일과 roster의 이메일이 정확히 같아야 합니다.

```sql
insert into public.course_roster (email) values
  ('student1@snu.ac.kr'),
  ('student2@snu.ac.kr'),
  ('student3@gmail.com')
on conflict (email) do nothing;
```

기본값으로 각 수강생은 제출과 투표 권한을 모두 갖습니다.

```sql
update public.course_roster
set can_vote = false
where email = 'student1@snu.ac.kr';
```

수강생 명단 자체는 브라우저에서 직접 읽을 수 없게 RLS로 막혀 있습니다.

> **1인 1표 운영 시 주의:** 한 학생에게 여러 Google 계정을 roster에 등록하지 마세요. 공식 투표용 이메일은 학생당 하나만 등록하는 것이 안전합니다.

---

## 2. Google Cloud에서 OAuth Client 만들기

Google Cloud의 **Google Auth Platform**에서 OAuth 클라이언트를 만듭니다.

1. Google Cloud Console에서 프로젝트 생성 또는 선택
2. **Google Auth Platform → Audience**에서 사용자 범위 설정
3. **Clients → Create client**
4. Application type: **Web application**

현재 GitHub Pages 주소가 예를 들어

```text
https://yigon.github.io/20262_UnivEvol/
```

이라면 **Authorized JavaScript origins**에는 경로 없이 origin만 넣습니다.

```text
https://yigon.github.io
```

**Authorized redirect URIs**에는 GitHub Pages 주소가 아니라 Supabase의 callback URL을 넣습니다.

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
```

정확한 callback URL은 Supabase Dashboard → **Authentication → Providers → Google**에 표시된 값을 그대로 복사하는 것을 권장합니다.

Google에서 발급된 다음 두 값을 복사해 둡니다.

- Client ID
- Client Secret

### Google OAuth 앱의 Audience

수업 전체가 로그인해야 하므로 Google Auth Platform의 Audience 설정도 확인하세요.

- 앱을 **Testing** 상태로 두면 로그인할 계정을 Test users에 별도로 등록해야 할 수 있습니다.
- 수강생 전체가 자유롭게 로그인해야 한다면 실제 운영 전에 Audience/Publishing 설정을 적절히 완료하세요.
- 이 사이트는 기본적인 Google 로그인 정보만 사용하며 Google Drive 등의 추가 API 권한을 요청하지 않습니다.

---

## 3. Supabase에서 Google Provider 활성화

Supabase Dashboard → **Authentication → Providers → Google**에서:

1. Google provider 활성화
2. 위에서 만든 **Client ID** 입력
3. **Client Secret** 입력
4. 저장

이 사이트의 브라우저 코드에는 Google Client Secret을 넣지 않습니다.

---

## 4. Supabase Redirect URL 설정

Supabase Dashboard → **Authentication → URL Configuration**에서 설정합니다.

### Site URL

```text
https://yigon.github.io/20262_UnivEvol/
```

### Redirect URLs

최소한 실제 배포 주소를 추가합니다.

```text
https://yigon.github.io/20262_UnivEvol/
```

코드에서는 `location.origin + location.pathname`으로 redirect URL을 동적으로 만들기 때문에 repository 이름을 바꿀 경우에도 코드 수정은 필요 없습니다. 다만 **Supabase Redirect URLs에는 새 주소를 다시 등록해야 합니다.**

---

## 5. 로그인 구현 방식

`app.js`는 Google OAuth를 다음 방식으로 사용합니다.

```text
Google 로그인
→ Supabase Auth
→ Google 인증 화면
→ Supabase callback
→ GitHub Pages로 복귀
→ Supabase session 생성
→ my_access()로 roster/admin 권한 확인
```

GitHub Pages 사이트는 `#home`, `#entries` 같은 hash routing을 사용하므로 OAuth는 **PKCE flow**로 설정했습니다.

```js
supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: "pkce",
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});
```

로그인 전에 보고 있던 `#entries` 등의 위치는 `sessionStorage`에 잠시 저장하고, Google 인증 후 자동으로 원래 탭으로 돌아옵니다.

Google 로그인 화면에서는 `prompt: "select_account"`를 사용하므로 여러 Google 계정에 로그인되어 있으면 사용할 계정을 선택할 수 있습니다.

---

## 6. 권한 판정

Google 로그인 자체가 성공했다고 해서 자동으로 제출/투표 권한이 생기지는 않습니다.

```text
Google 계정 이메일
        ↓
Supabase Auth user / auth.uid()
        ↓
my_access()
        ↓
course_roster / admin_users 확인
```

- `admin_users`에 있으면 조교
- `course_roster.can_submit = true`이면 제출 가능
- `course_roster.can_vote = true`이면 투표 가능
- 어느 명단에도 없으면 로그인은 가능하지만 제출/투표는 불가능

이메일 비교는 SQL에서 소문자로 정규화해서 수행합니다.

---

## 7. 제출 흐름

1. 수강생이 Entries → **작품 제출** 클릭
2. 로그인되지 않았다면 Google 로그인으로 이동
3. roster에 등록된 계정인지 확인
4. 제목 / 이름 / 학과 / 본문 / 첨부파일 입력
5. 제출 완료
6. 작품과 첨부파일은 공개 사이트에서는 보이지 않음
7. 조교 계정에서 관리 패널로 확인
8. `공개` 또는 `대기작 전체 공개`로 공개

제목 자체에 이름을 쓰면 개인정보 숨김 기능으로 가릴 수 없습니다. 또한 원본 첨부파일 이름은 공개 메타데이터에 저장하지 않고 `첨부파일_1.pdf` 같은 일반 이름으로 바꿉니다.

작품 본문·이미지·PDF 내용 자체에 이름이나 학번이 들어 있으면 자동으로 제거되지는 않으므로 익명 공개가 필요할 때는 작품 내용도 확인해야 합니다.

---

## 8. 이름 / 학과 공개

제출 당시 이름과 학과는 `entry_private`에 저장되어 **조교만 확인**할 수 있습니다.

조교 관리 패널의 `이름 공개` 버튼을 누르면 해당 작품의 공개용 필드에 이름/학과가 복사됩니다. `이름 숨기기`를 누르면 공개용 필드는 다시 `NULL`이 됩니다.

즉 단순 CSS 숨김이 아니라 공개 API에서도 개인정보가 빠집니다.

---

## 9. 첨부파일 보안

`entry-media` bucket은 **private**입니다.

- 비공개 제출물: 조교만 읽기 가능
- 공개 작품: 방문자에게 제한시간 signed URL 발급 가능
- 제출자도 제출 후 비공개 파일을 다시 열람할 권한은 기본적으로 없음

파일 경로 예시:

```text
entry-media/<ENTRY_UUID>/<RANDOM_UUID>.pdf
```

개별 파일 최대 크기는 50MB입니다.

---

## 10. 투표 방식

투표는 다음 식으로 연결됩니다.

```text
Google 로그인 이메일 → Supabase Auth user → auth.uid() → votes.voter_id
```

`votes.voter_id` 자체가 Primary Key이므로 같은 Supabase 인증 계정으로 두 작품에 동시에 투표할 수 없습니다.

- 다른 작품을 누르면 기존 표가 새 작품으로 이동
- 현재 선택 작품을 다시 누르면 표 취소
- 투표가 닫혀 있으면 DB 정책에서도 INSERT / UPDATE / DELETE 거부

---

## 11. 조교 관리 패널

`admin_users`에 등록된 Google 로그인 이메일로 로그인하면 Entries 상단에 관리 패널이 생깁니다.

가능한 작업:

- 비공개 대기작 및 제출자 정보 확인
- 작품별 공개 / 비공개
- 대기작 전체 일괄 공개
- 작품별 이름·학과 공개 / 숨김
- 투표 시작 / 종료

---

## 12. config.js

기존과 동일하게 Supabase Project URL과 browser용 publishable/anon key만 입력합니다.

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_...";
```

`service_role` / secret key와 Google Client Secret은 절대 GitHub 저장소나 브라우저 코드에 넣지 마세요.

---

## 13. GitHub Pages 배포

repository 최상위에 다음 파일을 둡니다.

```text
index.html
styles.css
app.js
config.js
supabase-schema.sql
README.md
assets/
```

기존처럼 GitHub Pages에서 `main / root`를 배포하면 됩니다. 빌드 과정은 없습니다.

수정 후 GitHub Actions의 Pages deployment가 완료되면 반영됩니다.
