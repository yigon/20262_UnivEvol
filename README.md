# 2026년 가을학기 우주의 진화 — 나의 우주 이야기

GitHub Pages + Supabase용 정적 사이트입니다.

이번 버전은 다음 운영 흐름을 사용합니다.

- 수강생/조교: **Google OAuth** 로그인
- 수강생 제출: 기본 **비공개**
- **예선 공개**: 제목/본문/첨부파일만 공개, 이름과 학과/학부는 비공개
- 조교가 작품별 **본선 진출** 지정
- 본선 진출작은 Entries 맨 위의 **본선 진출작** 영역에 따로 표시
- **본선 공개**: 본선 진출작의 이름과 학과/학부를 기본적으로 공개
- 이름/학과 공개 여부는 조교가 본선 공개 후에도 개별적으로 다시 숨길 수 있음
- 조교가 작품을 완전히 삭제 가능
- 삭제 시 `entries`와 함께 `entry_private` 및 해당 작품의 투표 기록이 cascade 삭제되고, Storage 파일도 프런트엔드에서 정리
- 예선/본선 투표를 조교가 별도로 시작/종료
- 각 라운드에서 **1인 최대 3개 작품**에 투표
- 같은 작품에 중복투표 불가
- 본인이 제출한 작품에는 투표 불가
- 본선 투표에서는 `본선 진출 + 본선 공개` 작품만 투표 가능

> 이 버전은 “총 3표”를 **예선 3표 + 본선 3표처럼 라운드별 최대 3표**로 구현했습니다. 예선과 본선을 합쳐 전체 기간 동안 3표만 허용하려면 투표 테이블/함수 규칙을 별도로 바꿔야 합니다.

---

## 1. 이번 업데이트에서 반드시 SQL을 다시 실행

Google OAuth 전환 때와 달리 이번 업데이트는 DB 구조가 바뀝니다.

Supabase Dashboard → **SQL Editor**에서 새 `supabase-schema.sql` 전체를 실행하세요.

기존 보안형 스키마 위에 실행할 수 있도록 작성되어 있습니다.

변경되는 주요 항목:

- `entries.publication_stage`
  - `hidden`
  - `preliminary`
  - `final`
- `entries.is_finalist`
- `site_settings.voting_round`
- `votes`가 기존 1인 1표 구조에서 라운드별 최대 3표 구조로 변경
- `toggle_vote()` RPC가 투표 규칙을 DB에서 강제
- 조교용 공개 단계/본선/투표 상태 RPC 추가

기존 `admin_users`, `course_roster`, 제출작은 유지됩니다.

기존 `votes`가 있다면 새 SQL은 그 표를 `preliminary` 라운드의 표로 보존하면서 복합 PK 구조로 바꿉니다.

---

## 2. 관리자 / 수강생 이메일

이미 등록했다면 다시 넣을 필요 없습니다.

### 관리자

```sql
insert into public.admin_users (email)
values ('YOUR_GOOGLE_LOGIN_EMAIL@snu.ac.kr')
on conflict (email) do nothing;
```

### 수강생

```sql
insert into public.course_roster (email) values
  ('student1@snu.ac.kr'),
  ('student2@snu.ac.kr'),
  ('student3@gmail.com')
on conflict (email) do nothing;
```

한 학생에게 공식 투표용 Google 계정은 하나만 등록하는 것을 권장합니다.

---

## 3. Google OAuth 설정

기존 Google OAuth가 정상 작동 중이면 변경할 필요 없습니다.

Google Cloud OAuth Web Client 기준:

### Authorized JavaScript origins

```text
https://yigon.github.io
```

### Authorized redirect URI

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
```

Supabase → Authentication → Providers → Google에 Client ID / Client Secret을 설정합니다.

Supabase → Authentication → URL Configuration:

```text
Site URL:
https://yigon.github.io/20262_UnivEvol/

Redirect URL:
https://yigon.github.io/20262_UnivEvol/
```

`app.js`는 PKCE flow를 사용합니다.

---

## 4. 공개 단계

### 제출 직후 — `hidden`

- 일반 방문자에게 게시글/첨부파일이 보이지 않음
- 조교만 관리자 패널에서 확인 가능
- 이름/학과/제출 이메일은 `entry_private`에 저장

### 예선 공개 — `preliminary`

관리자 패널의 **예선 공개** 또는 **대기작 전체 예선 공개**를 사용합니다.

자동으로:

- 작품 공개
- 이름 숨김
- 학과/학부 숨김
- `public_author`, `public_department` 제거

따라서 예선 단계에서는 이름/학과가 단순 CSS로 가려지는 것이 아니라 공개 데이터에서 제거됩니다.

### 본선 공개 — `final`

먼저 작품을 **본선 진출 지정**해야 합니다.

그다음 **본선 공개** 또는 **본선 진출작 전체 본선 공개**를 누릅니다.

자동으로:

- `is_finalist = true`
- 작품 공개 유지
- `entry_private`의 이름과 학과/학부를 공개 필드에 복사
- Entries 상단의 본선 진출작 영역에 표시

본선 공개 후에도 조교가 `이름 숨기기`를 눌러 개인정보를 다시 숨길 수 있습니다.

---

## 5. 본선 진출작

관리자 패널의 **본선 진출 지정** 버튼은 공개 단계와 별개입니다.

예를 들어 예선 종료 후:

1. 예선 투표 종료
2. 득표수를 보고 본선 진출작 결정
3. 해당 작품에서 `본선 진출 지정`
4. 본선 진출작이 Entries 상단에 별도 표시
5. `본선 진출작 전체 본선 공개`
6. 본선 투표 시작

본선 진출을 해제하면, 이미 `final` 상태였던 작품은 자동으로 `preliminary` 상태로 되돌아가며 이름/학과도 다시 숨겨집니다.

---

## 6. 투표 규칙

투표는 프런트엔드가 아니라 `toggle_vote()` RPC에서 최종 검증합니다.

한 라운드에서 한 사용자의 표 구조는:

```text
(voter_id, entry_id, voting_round)
```

복합 Primary Key이므로 같은 사용자가 같은 작품에 두 번 표를 만들 수 없습니다.

DB에서 다음 규칙을 강제합니다.

- `course_roster.can_vote = true`인 인증 사용자만 가능
- 투표가 열려 있어야 함
- 예선: 공개된 예선/본선 작품에 투표 가능
- 본선: `is_finalist = true`이고 `publication_stage = final`인 작품만 가능
- 자신의 `submitted_by = auth.uid()` 작품에는 투표 불가
- 같은 라운드에서 최대 3개 작품
- 이미 선택한 작품을 다시 누르면 그 표는 취소

동시에 여러 요청을 보내 3표 제한을 넘기지 못하도록 사용자/라운드 단위 PostgreSQL advisory transaction lock도 사용합니다.

---

## 7. 투표 운영 순서

### 예선

1. 대기작 전체 예선 공개
2. 이름/학과가 모두 익명인지 확인
3. **예선 투표 시작**
4. 학생은 서로 다른 최대 3작품 선택
5. 본인 작품의 투표 버튼은 비활성화되며 DB에서도 거부
6. **예선 투표 종료**
7. 종료 후 득표수는 그대로 확인 가능

### 본선

1. 본선 진출작 지정
2. 본선 진출작 전체 본선 공개
3. 이름/학과 공개 여부 확인
4. **본선 투표 시작**
5. 각 학생에게 새로운 본선 3표가 부여됨
6. 본선 진출작에만 투표 가능
7. **본선 투표 종료**

예선 표와 본선 표는 `voting_round`가 달라 별도로 저장됩니다.

---

## 8. 게시물 삭제

조교 관리 패널에 **삭제** 버튼이 있습니다.

삭제 확인 후:

1. `entries` 행 삭제
2. FK cascade로 `entry_private` 삭제
3. FK cascade로 그 작품의 `votes` 삭제
4. 첨부파일 경로를 Supabase Storage에서 삭제

Storage 삭제에 실패해도 DB 게시물은 이미 삭제된 상태이므로, 경고 메시지와 함께 Storage에서 해당 UUID 폴더를 확인하도록 안내합니다.

---

## 9. 첨부파일 보안

`entry-media` bucket은 private입니다.

- `hidden`: 조교만 열람
- `preliminary` / `final`: signed URL을 통해 공개 작품 파일 열람
- 업로드 권한은 제출자의 자기 비공개 작품 또는 조교만 허용

개별 파일 최대 크기는 기존과 동일하게 50MB입니다.

---

## 10. 배포

다음 파일을 GitHub repository 최상위에 교체합니다.

```text
index.html
styles.css
app.js
supabase-schema.sql
README.md
```

기존 `config.js`와 `assets/`는 그대로 유지하면 됩니다.

순서 권장:

1. Supabase SQL Editor에서 새 `supabase-schema.sql` 실행
2. SQL 오류가 없는지 확인
3. GitHub에 새 `app.js`, `styles.css`, `index.html` 업로드
4. Commit / push
5. GitHub Pages deployment 완료 확인
6. 조교 Google 로그인
7. 테스트 작품 1개 제출
8. 예선 공개 → 본선 지정 → 본선 공개 → 삭제까지 테스트
9. 학생 테스트 계정으로 3표 제한 및 본인 작품 금지 확인

---

## 11. `config.js`

기존 파일을 그대로 사용합니다.

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_...";
```

`service_role` 키나 Google Client Secret은 GitHub 저장소에 넣지 마세요.


## 제출자 정보 필수 입력

이름과 학과/학부는 제출 시 필수입니다. 이 정보는 `entry_private`에 저장되어 조교만 확인하며, 예선 공개 시에는 외부에 노출되지 않습니다. 본선 공개 여부는 조교가 관리합니다.
