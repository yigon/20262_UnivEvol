# 2026년 가을학기 우주의 진화 — 나의 우주 이야기

2024년 봄학기 Wix 사이트의 **Home / Notice / Entries / Archive** 구조와 담백한 폭 980px 레이아웃을 참고해 만든 2026년 가을학기 버전입니다.

Entries는 Supabase를 백엔드로 사용해 다음 기능을 제공합니다.

- 누구나 새 게시물 작성
- 이미지 / PDF / 오디오 / 영상 등 다중 파일 첨부
- 게시물 상세 보기
- 좋아요 토글 및 좋아요 수 저장
- 모바일 반응형 레이아웃
- 별도 빌드 과정 없이 정적 호스팅 가능

## 1. Supabase 만들기

1. https://supabase.com 에서 무료 프로젝트를 만듭니다.
2. Dashboard → **SQL Editor**에서 `supabase-schema.sql` 전체를 실행합니다.
3. Dashboard → **Project Settings / API**에서 아래 두 값을 확인합니다.
   - Project URL
   - `anon` 또는 `publishable` key

> `service_role` 키는 절대 웹페이지 코드에 넣지 마세요.

## 2. config.js 설정

`config.js`의 두 값을 바꿉니다.

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```

조교 연락처도 같은 파일에서 바꿀 수 있습니다.

```js
export const SITE_CONFIG = {
  taLine: "TA : 김이곤 your-email@snu.ac.kr",
  storageBucket: "entry-media",
  maxFileSizeMB: 50,
};
```

## 3. 로컬 미리보기

ES module을 사용하므로 `index.html`을 파일로 직접 더블클릭하기보다 간단한 로컬 서버를 쓰는 편이 안전합니다.

```bash
cd evoluniverse-2026-fall
python -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다.

## 4. 배포

가장 간단한 방법은 GitHub Pages / Netlify / Vercel 중 하나에 이 폴더 그대로 올리는 것입니다. 빌드 명령은 필요 없습니다.

### GitHub Pages 예시

1. 새 GitHub repository를 만듭니다.
2. 이 폴더의 파일을 repository 최상위에 업로드합니다.
3. Settings → Pages → Deploy from a branch → `main` / `/root`를 선택합니다.

## 5. 공지사항 수정

`index.html` 안의 `noticeTemplate`을 찾아 제출 마감, 본선 일정 등을 바꾸면 됩니다. 현재 일정이 확정되지 않은 부분은 노란색 `추후 공지` 표시로 두었습니다.

## 6. 좋아요 방식

각 브라우저에 무작위 UUID를 하나 저장하고, `(게시물 ID, 브라우저 UUID)` 조합을 중복 저장하지 못하게 해 **같은 브라우저에서 게시물당 좋아요 1회**로 동작합니다.

이 방식은 수업 감상용 “좋아요”에는 가볍고 편하지만, **공식 투표**처럼 1인 1표를 강제하는 용도에는 충분하지 않습니다. 브라우저 저장소를 초기화하거나 다른 기기를 사용하면 다시 좋아요를 누를 수 있기 때문입니다. 공식 투표가 필요하면 SNU 계정 로그인이나 별도의 인증 기반 투표 기능을 붙이는 것이 안전합니다.

## 7. 운영상 주의

현재 SQL 정책은 요청대로 “누구나 게시 가능”하게 열어 두었습니다. 외부에 널리 공개할 경우 스팸 게시물이 올라올 수 있습니다. 수업 구성원만 글을 올리게 하려면 다음 단계에서 **업로드 비밀번호**, **Supabase Auth**, 또는 **SNU 계정 인증**을 붙이는 것을 권장합니다.

## 파일 구조

```text
index.html            페이지 구조 / 공지 / Archive
styles.css            기존 Wix 스타일을 참고한 레이아웃
app.js                Entries, 업로드, 상세보기, 좋아요 기능
config.js             Supabase 및 TA 정보
supabase-schema.sql   DB / Storage / RLS 생성
README.md             설치·배포 안내
```
