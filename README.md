# 2026년 가을학기 우주의 진화 — 나의 우주 이야기

GitHub Pages + Supabase Auth/DB + Cloudflare R2용 정적 사이트입니다.

> **2026-11-25 신규 저장소 변경:** 앞으로 제출하는 **모든 형식의 첨부파일은 Cloudflare R2**로 업로드합니다. 기존 Supabase Storage 첨부는 그대로 유지합니다. **이번 업데이트는 `supabase-schema.sql` 전체 재실행이 아니라 `supabase/migrations/202611250001_r2_storage.sql`만 실행해야 합니다.** 실제 설정과 배포 순서는 [R2_SETUP.md](R2_SETUP.md)를 먼저 읽어 주세요.

---

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

## 1. 기존 운영형 스키마 소개 (현재 운영 DB에서는 재실행 금지)

아래 설명은 기존 운영형 스키마의 구성에 대한 기록입니다. **이미 게시물이 있는 현재 DB에서는 `supabase-schema.sql` 전체를 다시 실행하지 마세요.** R2 추가는 별도 SQL migration 파일만 실행하며, 설정 및 백업 지침은 [R2_SETUP.md](R2_SETUP.md)를 참고하세요.

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

## 8. 게시물 삭제 (Supabase + R2 공존)

조교 관리 패널의 **삭제** 버튼은 서버 측 `r2-storage` Edge Function을 호출합니다. 기존 Supabase 파일과 신규 R2 파일을 각각 해당 저장소에서 먼저 삭제한 후 게시글, 제출자 개인정보, 투표 기록을 삭제합니다. 일시적인 Storage 오류가 발생하면 게시글을 유지해 다시 시도할 수 있습니다.

## 9. 첨부파일 보안

- 기존 작품은 private Supabase Storage에 그대로 남습니다 (`storage` 메타데이터가 없는 경우).
- 신규 작품은 형식에 관계없이 private Cloudflare R2에 저장합니다 (`storage: "r2"`).
- 모든 첨부파일은 작품의 공개 단계와 조교 권한에 따라 서명된 URL을 발급받습니다.
- 신규 파일은 파일당 기본 2GiB, 한 게시글당 최대 20개로 제한합니다. Edge Function secrets에서 조정할 수 있습니다.
- 기존 Supabase 50MB 제한은 **기존 Storage 쪽에만** 계속 적용됩니다.

## 10. 배포

**자세한 단계는 [R2_SETUP.md](R2_SETUP.md) 참고.** 간단히 요약하면 Cloudflare R2 private bucket 및 CORS 구성 → R2 credentials를 Supabase secrets에 추가 → Edge Function 배포 → `202611250001_r2_storage.sql` 실행 → 새 `app.js`/`index.html`을 GitHub Pages에 배포하는 순서입니다.

이 ZIP에는 기존 `config.js`, `styles.css`, `assets/`도 원형대로 포함했습니다. R2 비밀 키는 포함하지 않았으며 브라우저 코드에 추가해서도 안 됩니다.

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
