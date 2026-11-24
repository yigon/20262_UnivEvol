# Cloudflare R2 신규 제출 전환 가이드

이 저장소의 `app.js`와 `supabase/functions/r2-storage/index.ts`는 기존 Supabase 파일을 보존하면서 **앞으로 제출하는 모든 파일(이미지, PDF, 영상, 오디오, 문서, 기타 모든 형식)** 을 R2에 저장하도록 변경한 코드다. 게시글·제출자 개인정보·Google 로그인·예선/본선 관리·투표 데이터는 계속 Supabase DB/Auth에 남는다.

> **주의:** ZIP 파일 안에 R2 계정의 실제 키는 들어 있지 않다. 기존 GitHub Pages 사이트에 파일만 푸시한다고 R2 업로드가 작동하지 않는다. 아래의 R2 bucket, Supabase Edge Function, DB migration 설정을 완료해야 한다. 현재 운영 중인 DB 및 버킷에 직접 접속하거나 변경한 것은 없다.

## 1. 기존 파일에 영향 없는 저장 규칙

| 시기 | 메타데이터 `attachments[].storage` | 실제 저장소 |
|---|---|---|
| 기존 제출물 | 없음 | Supabase Storage `entry-media` (그대로 유지) |
| 신규 제출물 | `"r2"` | 새 private Cloudflare R2 bucket |

`storage`가 누락되거나 `"supabase"`라면 기존 Supabase Storage의 signed URL을 발급한다. 신규 R2 파일은 서버의 권한 확인 후 signed GET URL을 발급한다. 기존 업로드 파일, 게시글, 개인정보, 투표 기록은 이동하거나 삭제하지 않는다.

## 2. Cloudflare R2 생성

1. Cloudflare Dashboard → **R2 Object Storage** → **Create bucket**에서 예: `univevol-entries` bucket을 생성한다.
2. **Public Development URL / public bucket access는 활성화하지 않는다.** bucket은 private으로 둔다.
3. R2의 **Manage R2 API Tokens**에서 해당 bucket에만 `Object Read & Write` 권한이 있는 API token을 생성한다.
4. 아래 정보를 별도 안전한 곳에 기록한다.
   - `R2_ACCOUNT_ID`: Cloudflare 계정 ID
   - `R2_BUCKET`: 위에서 만든 bucket 이름
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`: R2 API token의 S3 호환 키 쌍
5. R2 bucket → Settings → **CORS policy**에 아래 규칙을 등록한다.

```json
[
  {
    "AllowedOrigins": ["https://yigon.github.io"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

로컬 HTTP 서버에서 테스트할 경우 사용하는 개발 origin(예: `http://localhost:8000`)을 `AllowedOrigins`에 **필요한 동안만** 추가한다. R2 presigned URL은 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`의 S3 API endpoint에서만 동작한다.

## 3. Supabase Edge Function secrets 입력

**CLI 권장:** `.env.r2` 파일을 로컬에만 만든다. `.gitignore`가 `.env.*`를 제외하므로 GitHub에 커밋되지 않는다.

```dotenv
R2_ACCOUNT_ID=여기에_ACCOUNT_ID
R2_BUCKET=univevol-entries
R2_ACCESS_KEY_ID=여기에_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=여기에_SECRET_ACCESS_KEY
ALLOWED_ORIGINS=https://yigon.github.io
R2_MAX_FILE_BYTES=2147483648
R2_MAX_FILES_PER_ENTRY=20
```

실제 `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`는 보통 Supabase Edge Functions에서 기본 제공한다. **service_role/secret key는 오직 서버 secrets에만 있어야 한다.** `config.js`, `.env.r2.example`, 프런트엔드, GitHub에 넣지 않는다.

```bash
# 로컬에 Supabase CLI 설치 후 저장소 루트에서
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set --env-file .env.r2
```

`ALLOWED_ORIGINS`는 추가 origin을 쉼표로 구분할 수 있다. GitHub Pages의 정확한 origin은 `https://yigon.github.io`이며 `/20262_UnivEvol/` 경로는 넣지 않는다.

## 4. DB migration (기존 제출물 유지)

Supabase Dashboard → **SQL Editor**에서 새 파일 **`supabase/migrations/202611250001_r2_storage.sql`만** 실행한다. 기존 `supabase-schema.sql`을 반복 실행할 필요가 없다.

핵심 변경점:
- `entries.upload_state` 컬럼 추가. **기존 모든 작품에는 기본값 `ready` 적용**, 새 제출만 `uploading`으로 시작
- R2 파일/분할 업로드 기록용 `r2_uploads` 테이블 추가 (일반 사용자의 접근 불가)
- 새 첨부파일을 0개로 등록한 후 Edge Function이 R2 실물을 확인해 첨부 메타데이터를 확정
- 업로드 완료 전에는 조교의 일괄 공개 대상에서도 제외
- 기존 Supabase 버킷에 수강생이 새 파일을 업로드하는 구 정책 비활성화
- 기존 로컬 삭제 RPC 및 브라우저만의 관리 삭제 경로 차단, **R2 정리를 포함하는 서버 측 삭제로 통일**

**절대 기존 데이터나 bucket을 삭제하지 않는다.** 운영 DB를 변경하기 전에 백업(특히 `entries`, `entry_private`, `votes`)을 권장한다.

## 5. Edge Function 배포

새 코드 위치: `supabase/functions/r2-storage/index.ts`.

```bash
supabase functions deploy r2-storage --no-verify-jwt
```

이미 `supabase/config.toml`에도 `verify_jwt = false`가 명시되어 있다. **이것은 익명에게 비공개 파일을 공개한다는 뜻이 아니다.** 공개된 작품에만 익명 서명 URL을 허용하고, 신규 업로드/완료/삭제/비공개 열람은 Edge Function 내부에서 유효한 Supabase Auth 세션과 조교 권한을 확인한다. Google OAuth 로그인 설정은 기존 상태 그대로 사용한다.

**중요: 배포 순서**는 R2 생성/CORS → secrets 입력 → Edge Function 배포 → SQL migration → GitHub Pages 프런트엔드 교체로 한다. SQL migration 직후 구 버전 프런트엔드로 제출하면 에러가 나므로 가능하면 제출을 잠시 중단한 시간대에 전환한다.

## 6. GitHub Pages 코드 배포

이 ZIP에서 `app.js`, `index.html`, `README.md`, `R2_SETUP.md`, `supabase/` 폴더를 저장소에 추가/교체한다. `styles.css`, `assets/`, `config.js`도 ZIP 안에 원본을 그대로 담았다.

```bash
git add app.js index.html README.md R2_SETUP.md supabase/ .gitignore .env.r2.example
git commit -m "Route all new submission attachments to private R2"
git push
```

`config.js`에는 기존의 **Supabase URL + publishable/anon key**만 유지한다. R2 Secret은 절대 입력하지 않는다. GitHub Pages는 여전히 HTML/CSS/JS만 제공하고, 파일 본문은 브라우저가 R2로 직접 업로드한다.

## 7. 작동 방식 및 상한

```text
학생 Google 로그인 (기존 roster 확인)
  → Supabase RPC: 제목·본문·비공개 이름·학과 저장 (upload_state=uploading)
  → Edge Function: 파일별 업로드 세션 생성 및 권한 검증
  → 학생 브라우저: R2 private bucket으로 직접 전송
      - 32MiB 미만: signed PUT
      - 32MiB 이상: 16MiB 파트로 멀티파트 전송
  → Edge Function: R2 HEAD/파트 크기 확인, 첨부 경로 DB에 기록
  → Edge Function: 제출 완료(ready)
  → 조교가 예선 익명 공개/본선 공개 결정 (기존 로직)
```

기본 상한은 **개별 파일 2GiB**, 한 작품 **최대 20개 첨부**다. Supabase의 50MB 제한과는 무관하다. 이 값은 Edge Function secret의 `R2_MAX_FILE_BYTES`, `R2_MAX_FILES_PER_ENTRY`로 조정할 수 있다. 대용량 파일은 16MiB씩 순서대로 업로드하며, 파트당 최대 3번 재시도한다. **이 버전은 페이지 새로고침 뒤 업로드를 이어받는 영속적인 resumable 업로드는 구현하지 않았다.** 브라우저를 닫으면 다시 제출해야 한다.

R2 signed upload URL은 15분, signed read URL은 1시간 동안 유효하다. 따라서 공개된 작품을 다시 비공개로 전환해도 이미 발급된 읽기 URL은 최대 1시간 사용될 수 있다. 이미지/영상/파일명 자체에 포함된 개인정보는 자동으로 제거되지 않는다.

## 8. 조교의 열람·삭제 및 정리

- **비공개 작품:** 제출 완료 후에는 조교만 상세 페이지에서 작품 내용과 첨부파일을 볼 수 있다.
- **예선 공개:** 기존처럼 이름·학과 공개 없이 작품 내용/첨부파일만 표시한다.
- **본선 공개:** 기존처럼 조교가 결정한 이름·학과 공개 설정을 따른다.
- **삭제:** 조교 삭제 요청은 Edge Function을 통해 R2 파일/기존 Supabase 파일을 먼저 삭제하고, 성공한 경우 게시글과 개인정보/투표 기록을 삭제한다.
- **정리:** 관리자 패널의 `미완료 업로드 정리` 버튼은 **24시간 이상 중단된 업로드**와 삭제 후 남은 파일을 정리한다. R2 자체에서도 미완료 multipart에 대해 자동 abort lifecycle을 설정해 두면 좋다.

일시적인 네트워크 문제로 삭제가 실패하면 게시물이 남아 다시 삭제할 수 있다. 삭제 직전 발급된 signed URL이 유효하더라도 실제 R2 객체가 제거되면 읽을 수 없다.

## 9. 실제 계정으로 반드시 테스트할 항목

- [ ] 기존 Supabase 첨부 작품(공개 및 조교 전용)이 정상 열리는지
- [ ] 익명 방문자가 비공개 R2 작품/첨부파일을 읽지 못하는지
- [ ] 학생이 50MB 이상의 MP4와 PDF를 업로드할 수 있는지
- [ ] 이름·학과 필수 입력 및 학생 roster 확인이 그대로 작동하는지
- [ ] 신규 작품이 조교 화면에서만 보이는지, 예선 공개 시 개인정보가 숨겨지는지
- [ ] 본선 진출/본선 공개/투표 3표 제한/본인 작품 제외가 기존과 같은지
- [ ] 신규 R2 작품 삭제 시 R2 객체도 제거되는지
- [ ] 기존 Supabase 작품 삭제 시 이전 Storage 객체도 제거되는지
- [ ] R2 직접 URL 접근은 서명이 만료되면 거절되는지
- [ ] CORS 또는 large multipart 업로드 오류가 나는 경우 콘솔에 세부 원인이 표시되는지

## 10. 운영비·보안 주의

- Cloudflare R2 무료 구간에는 용량/요청수 한도가 있으니 학기 중 사용량과 과금 경고를 설정한다. 2GiB 파일 여러 개만 올라와도 무료 저장 한도에 도달할 수 있다.
- presigned URL은 **만료 전까지 URL 보유자에게 유효**하므로 로그·SNS·공개 페이지에 원문을 저장하지 않는다.
- GitHub에 올라가는 `supabase-schema.sql`은 초기 구조 참고용이며, **운영 중 이관에는 새 migration만 실행**해야 한다.
- 외부 서비스를 실제 연결하는 통합 테스트는 R2 자격 증명과 Supabase 프로젝트 권한이 있어야만 가능하다. 이 ZIP은 로컬 정적/문법 검사를 거친 코드 패치다.

## 공식 자료

- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare R2 multipart upload](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Edge Functions secrets](https://supabase.com/docs/guides/functions/secrets)
