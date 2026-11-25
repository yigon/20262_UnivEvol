import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_CONFIG } from "./config.js";

const app = document.querySelector("#app");
const composer = document.querySelector("#composerDialog");
const entryForm = document.querySelector("#entryForm");
const formStatus = document.querySelector("#formStatus");
const submitEntry = document.querySelector("#submitEntry");
const editDialog = document.querySelector("#editDialog");
const editForm = document.querySelector("#editForm");
const editStatus = document.querySelector("#editStatus");
const saveOwnEditButton = document.querySelector("#saveOwnEdit");
let currentEditEntry = null;
let editSaving = false;
const menuToggle = document.querySelector("#menuToggle");
const mainNav = document.querySelector("#mainNav");

const taLine = document.querySelector("#taLine");
taLine.textContent = SITE_CONFIG.taLine;

const configured = !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
const MAX_VOTES = 3;

let supabase = null;
let session = null;
let access = {
  email: "",
  is_admin: false,
  can_submit: false,
  can_vote: false,
  voting_open: false,
  voting_round: "preliminary",
};

let entriesCache = [];
let voteCounts = new Map();
let myVoteEntryIds = new Set();
let myOwnEntryIds = new Set();

const POST_AUTH_ROUTE_KEY = "evoluniverse_post_auth_route";

function restorePostAuthRoute() {
  const savedRoute = sessionStorage.getItem(POST_AUTH_ROUTE_KEY);
  if (!savedRoute) return;
  sessionStorage.removeItem(POST_AUTH_ROUTE_KEY);
  if (location.hash !== savedRoute) location.hash = savedRoute;
}

if (configured) {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  const { data, error } = await supabase.auth.getSession();
  if (error) console.error(error);
  session = data.session;
  await refreshAccess();
  if (session) restorePostAuthRoute();

  supabase.auth.onAuthStateChange((event, nextSession) => {
    session = nextSession;
    setTimeout(async () => {
      await refreshAccess();
      if (event === "SIGNED_IN") {
        restorePostAuthRoute();
        if (!access.is_admin && !access.can_submit && !access.can_vote) {
          alert("Google 로그인은 완료되었지만 현재 수강생 명단에 등록된 계정이 아닙니다.");
        }
      }
      await router();
    }, 0);
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "home";
  const [section, id] = raw.split("/");
  return { section, id };
}

function setActiveNav(section) {
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === (section === "entry" ? "entries" : section));
  });
}

function renderTemplate(id) {
  const tpl = document.querySelector(id);
  app.replaceChildren(tpl.content.cloneNode(true));
}

async function router() {
  const { section, id } = parseRoute();
  setActiveNav(section);
  mainNav.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");

  if (section === "notice") return renderTemplate("#noticeTemplate");
  if (section === "archive") return renderTemplate("#archiveTemplate");
  if (section === "entries") return renderEntries();
  if (section === "entry" && id) return renderEntryDetail(id);
  return renderTemplate("#homeTemplate");
}

function setupBanner() {
  return configured ? "" : `
    <div class="setup-banner">
      현재는 백엔드 연결 전 미리보기 상태입니다. <code>config.js</code>와
      <code>supabase-schema.sql</code> 설정이 필요합니다.
    </div>`;
}

async function refreshAccess() {
  if (!configured) return;
  const { data, error } = await supabase.rpc("my_access");
  if (error) {
    console.error(error);
    access = {
      email: "",
      is_admin: false,
      can_submit: false,
      can_vote: false,
      voting_open: false,
      voting_round: "preliminary",
    };
    return;
  }

  access = {
    email: data?.email || session?.user?.email || "",
    is_admin: Boolean(data?.is_admin),
    can_submit: Boolean(data?.can_submit),
    can_vote: Boolean(data?.can_vote),
    voting_open: Boolean(data?.voting_open),
    voting_round: data?.voting_round === "final" ? "final" : "preliminary",
  };
}

function authControlsHtml() {
  if (!configured) return "";
  if (!session) {
    return `<button id="loginButton" class="btn secondary google-login-btn">Google 로그인</button>`;
  }
  const label = access.is_admin ? "조교 로그인" : escapeHtml(access.email || session.user.email || "로그인됨");
  return `
    <span class="auth-user-label">${label}</span>
    <button id="logoutButton" class="btn secondary">로그아웃</button>`;
}

function wireAuthControls() {
  document.querySelector("#loginButton")?.addEventListener("click", signInWithGoogle);
  document.querySelector("#logoutButton")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });
}

async function loadPublishedEntries() {
  if (!configured) {
    entriesCache = [];
    voteCounts = new Map();
    myVoteEntryIds = new Set();
    myOwnEntryIds = new Set();
    return;
  }

  const { data: entries, error: entriesError } = await supabase
    .from("entries")
    .select("id,title,body,attachments,is_published,published_at,show_author,public_author,public_department,created_at,publication_stage,is_finalist")
    .neq("publication_stage", "hidden")
    .order("is_finalist", { ascending: false })
    .order("published_at", { ascending: false, nullsFirst: false });
  if (entriesError) throw entriesError;

  entriesCache = await attachSignedUrls(entries || []);
  await loadVoteState();
}

// Files submitted before the migration have no `storage` field: treat them as Supabase.
function storageOf(file) {
  return file.storage === "r2" ? "r2" : "supabase";
}

async function r2Request(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("r2-storage", {
    body: { action, ...payload },
  });
  if (error) {
    let explanation = error.message || "R2 파일 처리 요청에 실패했습니다.";
    try {
      const response = error.context;
      if (response?.json) {
        const details = await response.json();
        explanation = details.error || explanation;
      }
    } catch { /* keep the underlying network error */ }
    throw new Error(explanation);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function attachSignedUrls(entries) {
  const supabasePaths = [];
  const r2Files = [];
  for (const entry of entries) {
    for (const file of Array.isArray(entry.attachments) ? entry.attachments : []) {
      if (!file.path) continue;
      if (storageOf(file) === "r2") r2Files.push({ entryId: entry.id, path: file.path });
      else supabasePaths.push(file.path);
    }
  }
  const supabaseUrls = new Map();
  const r2Urls = new Map();

  if (supabasePaths.length) {
    for (let i = 0; i < supabasePaths.length; i += 100) {
      const paths = [...new Set(supabasePaths.slice(i, i + 100))];
      const { data, error } = await supabase.storage.from(SITE_CONFIG.storageBucket)
        .createSignedUrls(paths, 1800);
      if (error) console.error("Legacy Supabase URLs:", error);
      else for (const item of data || []) {
        if (item?.path && item?.signedUrl) supabaseUrls.set(item.path, item.signedUrl);
      }
    }
  }

  if (r2Files.length) {
    for (let i = 0; i < r2Files.length; i += 100) {
      try {
        const { items } = await r2Request("sign-read", { files: r2Files.slice(i, i + 100) });
        for (const item of items || []) r2Urls.set(`${item.entryId}:${item.path}`, item.url);
      } catch (error) {
        console.error("R2 URL signing failed:", error);
      }
    }
  }
  return entries.map((entry) => ({
    ...entry,
    attachments: (Array.isArray(entry.attachments) ? entry.attachments : []).map((file) => ({
      ...file,
      url: storageOf(file) === "r2"
        ? r2Urls.get(`${entry.id}:${file.path}`) || ""
        : supabaseUrls.get(file.path) || "",
    })),
  }));
}

// Submitted entries stay private until the TA publishes them. The SQL RLS policy
// permits a student to read only their own *completed* hidden submissions.
async function loadOwnPendingEntries() {
  if (!session || !myOwnEntryIds.size) return [];
  const ids = [...myOwnEntryIds];
  const { data, error } = await supabase
    .from("entries")
    .select("id,title,body,attachments,created_at,publication_stage,upload_state,is_finalist,show_author,public_author,public_department,owner_edit_locked")
    .in("id", ids)
    .eq("publication_stage", "hidden")
    .eq("upload_state", "ready")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return attachSignedUrls(data || []);
}

async function loadVoteState() {
  voteCounts = new Map();
  myVoteEntryIds = new Set();
  myOwnEntryIds = new Set();

  const { data: counts, error: countError } = await supabase.rpc("get_vote_counts");
  if (countError) throw countError;
  for (const row of counts || []) voteCounts.set(row.entry_id, Number(row.vote_count || 0));

  if (!session) return;

  const [{ data: votes, error: voteError }, { data: ownEntries, error: ownError }] = await Promise.all([
    supabase
      .from("votes")
      .select("entry_id")
      .eq("voter_id", session.user.id)
      .eq("voting_round", access.voting_round),
    supabase.rpc("my_entry_ids"),
  ]);

  if (voteError) throw voteError;
  if (ownError) throw ownError;

  const eligibleIds = new Set(
    entriesCache
      .filter((entry) => isEntryEligibleForRound(entry, access.voting_round))
      .map((entry) => entry.id)
  );
  myVoteEntryIds = new Set((votes || []).map((row) => row.entry_id).filter((id) => eligibleIds.has(id)));
  myOwnEntryIds = new Set((ownEntries || []).map((row) => row.entry_id || row));
}

function getCover(entry) {
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  return attachments.find((file) => file.type?.startsWith("image/") && file.url) || null;
}

function currentRoundLabel() {
  return access.voting_round === "final" ? "본선" : "예선";
}

function voteStatusText() {
  if (!access.voting_open) return "투표 마감/대기";
  return `${currentRoundLabel()} 투표 진행 중 · 최대 ${MAX_VOTES}작품`;
}

function isEntryEligibleForRound(entry, round) {
  if (round === "final") {
    return entry.is_finalist === true && entry.publication_stage === "final";
  }
  return entry.publication_stage === "preliminary" || entry.publication_stage === "final";
}

function isEntryEligibleForCurrentVote(entry) {
  return access.voting_open && isEntryEligibleForRound(entry, access.voting_round);
}

function voteButtonState(entry) {
  const selected = myVoteEntryIds.has(entry.id);
  const ownEntry = myOwnEntryIds.has(entry.id);
  const eligible = isEntryEligibleForCurrentVote(entry);
  const atLimit = myVoteEntryIds.size >= MAX_VOTES && !selected;

  if (ownEntry) {
    return { selected, disabled: true, label: "내 작품", title: "본인이 제출한 작품에는 투표할 수 없습니다." };
  }
  if (session && !access.can_vote) {
    return { selected, disabled: true, label: "투표 권한 없음", title: "수강생 명단에 투표 권한이 등록된 계정만 투표할 수 있습니다." };
  }
  if (!access.voting_open) {
    return { selected, disabled: true, label: selected ? "✓ 내 투표" : "투표", title: "현재 투표 기간이 아닙니다." };
  }
  if (!eligible) {
    return { selected, disabled: true, label: "투표 대상 아님", title: "현재 투표 라운드의 대상 작품이 아닙니다." };
  }
  if (atLimit) {
    return { selected, disabled: true, label: "3표 사용 완료", title: "이미 3개 작품에 투표했습니다. 기존 표를 취소한 뒤 선택해 주세요." };
  }
  return { selected, disabled: false, label: selected ? "✓ 내 투표" : "투표", title: "" };
}

function entriesSectionHtml(title, entries, sectionClass = "") {
  if (!entries.length) return "";
  return `
    <section class="entries-section ${sectionClass}">
      <div class="entries-section-head">
        <h2>${escapeHtml(title)}</h2>
        <span>${entries.length}개 작품</span>
      </div>
      <div class="entries-grid" data-entry-grid="${sectionClass || "regular"}"></div>
    </section>`;
}

function makeOwnPendingCard(entry) {
  const article = document.createElement("article");
  article.className = "entry-card own-entry-card";
  const cover = getCover(entry);
  const media = cover
    ? `<img class="entry-card-cover" src="${escapeHtml(cover.url)}" alt="${escapeHtml(entry.title)} 대표 이미지" loading="lazy" data-open-entry="${entry.id}">`
    : `<div class="entry-card-placeholder" data-open-entry="${entry.id}">MY UNIVERSE STORY</div>`;
  article.innerHTML = `
    <div class="own-entry-banner">비공개 · 본인 확인용</div>
    ${media}
    <div class="entry-card-body">
      <button class="entry-card-title" data-open-entry="${entry.id}">${escapeHtml(entry.title)}</button>
      <div class="entry-card-meta">제출일 ${formatDate(entry.created_at)}</div>
    </div>
    <div class="entry-card-footer own-entry-footer">
      ${entry.owner_edit_locked
        ? "예선 공개 이력이 있어 열람만 가능합니다."
        : `<button class="btn secondary" data-own-edit="${entry.id}">수정</button>`}
    </div>`;
  article.querySelectorAll("[data-open-entry]").forEach((node) => {
    node.addEventListener("click", () => { location.hash = `#entry/${entry.id}`; });
  });
  article.querySelector("[data-own-edit]")?.addEventListener("click", () => openOwnEdit(entry));
  return article;
}

async function renderEntries() {
  app.innerHTML = `
    <section class="entries-page">
      <div class="entries-title-row">
        <h1>Entries</h1>
        <div class="entries-tools">
          <button id="openComposer" class="btn primary">+ 작품 제출</button>
          ${authControlsHtml()}
        </div>
      </div>
      ${setupBanner()}
      <div id="adminPanel"></div>
      <div id="entriesStatus" class="entries-status">게시물을 불러오는 중…</div>
      <div id="voteSummary"></div>
      <div id="entriesHost"></div>
    </section>`;

  wireAuthControls();
  document.querySelector("#openComposer").addEventListener("click", () => {
    if (!session) return signInWithGoogle();
    if (!access.can_submit) {
      alert("수강생 명단에 제출 권한이 등록된 계정만 작품을 제출할 수 있습니다.");
      return;
    }
    openComposer();
  });

  const status = document.querySelector("#entriesStatus");
  const voteSummary = document.querySelector("#voteSummary");
  const host = document.querySelector("#entriesHost");

  try {
    await refreshAccess();
    await loadPublishedEntries();
    const ownPending = await loadOwnPendingEntries();
    if (access.is_admin) await renderAdminPanel();

    status.textContent = configured
      ? `${entriesCache.length}개의 공개 작품 · ${voteStatusText()}`
      : "Supabase를 연결하면 게시물이 여기에 표시됩니다.";

    if (session && access.can_vote) {
      voteSummary.innerHTML = `
        <div class="vote-summary ${access.voting_open ? "open" : "closed"}">
          <strong>${currentRoundLabel()} 투표</strong>
          <span>내 선택 ${myVoteEntryIds.size}/${MAX_VOTES}</span>
          <span class="muted">본인 작품에는 투표할 수 없으며, 같은 작품에는 한 표만 줄 수 있습니다.</span>
        </div>`;
    } else {
      voteSummary.innerHTML = "";
    }

    if (!entriesCache.length && !ownPending.length) {
      host.innerHTML = `<div class="empty-state"><div><strong>현재 공개된 작품이 없습니다.</strong><br>제출 작품은 조교 확인 후 공개됩니다.</div></div>`;
      return;
    }

    const finalists = entriesCache.filter((entry) => entry.is_finalist);
    const others = entriesCache.filter((entry) => !entry.is_finalist);

    host.innerHTML = [
      entriesSectionHtml("내 비공개 제출작 · 본인만 열람", ownPending, "own-pending-section"),
      entriesSectionHtml("본선 진출작", finalists, "finalist-section"),
      entriesSectionHtml(finalists.length ? "예선 출품작" : "출품작", others, "regular-section"),
    ].join("");

    const ownGrid = host.querySelector('[data-entry-grid="own-pending-section"]');
    if (ownGrid) ownGrid.replaceChildren(...ownPending.map(makeOwnPendingCard));

    const finalistGrid = host.querySelector('[data-entry-grid="finalist-section"]');
    if (finalistGrid) finalistGrid.replaceChildren(...finalists.map(makeEntryCard));

    const regularGrid = host.querySelector('[data-entry-grid="regular-section"]');
    if (regularGrid) regularGrid.replaceChildren(...others.map(makeEntryCard));
  } catch (error) {
    console.error(error);
    status.textContent = "게시물을 불러오지 못했습니다.";
    host.innerHTML = `<div class="empty-state"><div>데이터베이스 연결을 확인해 주세요.<br><span class="muted">${escapeHtml(error.message || "Unknown error")}</span></div></div>`;
  }
}

function makeEntryCard(entry) {
  const article = document.createElement("article");
  article.className = `entry-card${entry.is_finalist ? " finalist-card" : ""}`;
  const cover = getCover(entry);
  const media = cover
    ? `<img class="entry-card-cover" src="${escapeHtml(cover.url)}" alt="${escapeHtml(entry.title)} 대표 이미지" loading="lazy" data-open-entry="${entry.id}">`
    : `<div class="entry-card-placeholder" data-open-entry="${entry.id}">MY UNIVERSE STORY</div>`;

  const authorBits = entry.show_author
    ? [entry.public_author, entry.public_department].filter(Boolean).map(escapeHtml).join(" · ")
    : "익명";
  const voteState = voteButtonState(entry);

  article.innerHTML = `
    ${entry.is_finalist ? `<div class="finalist-badge">FINALIST</div>` : ""}
    ${media}
    <div class="entry-card-body">
      <button class="entry-card-title" data-open-entry="${entry.id}">${escapeHtml(entry.title)}</button>
      <div class="entry-card-meta">${authorBits} · ${formatDate(entry.published_at || entry.created_at)}</div>
    </div>
    <div class="entry-card-footer">
      <button
        class="vote-btn ${voteState.selected ? "selected" : ""}"
        data-vote="${entry.id}"
        ${voteState.disabled ? "disabled" : ""}
        ${voteState.title ? `title="${escapeHtml(voteState.title)}"` : ""}
      >
        <span>${escapeHtml(voteState.label)}</span>
        <span class="vote-count">${voteCounts.get(entry.id) || 0}</span>
      </button>
    </div>`;

  article.querySelectorAll("[data-open-entry]").forEach((node) => {
    node.addEventListener("click", () => { location.hash = `#entry/${entry.id}`; });
  });
  article.querySelector("[data-vote]")?.addEventListener("click", async () => {
    await castVote(entry.id);
  });
  return article;
}

async function renderEntryDetail(id) {
  app.innerHTML = `<section class="entry-detail"><p>게시물을 불러오는 중…</p></section>`;
  try {
    await refreshAccess();
    if (!entriesCache.length) await loadPublishedEntries();
    let entry = entriesCache.find((item) => item.id === id);

    if (!entry && configured) {
      // RLS is the sole authority: the public sees published work, while
      // students can also read their own complete pending work and TAs see all.
      const { data, error } = await supabase
        .from("entries")
        .select("id,title,body,attachments,is_published,published_at,show_author,public_author,public_department,created_at,publication_stage,is_finalist,upload_state,owner_edit_locked")
        .eq("id", id)
        .single();
      if (error) throw error;
      [entry] = await attachSignedUrls([data]);
      await loadVoteState();
    }
    if (!entry) throw new Error("게시물을 찾을 수 없습니다.");

    const ownHidden = entry.publication_stage === "hidden" &&
      entry.upload_state === "ready" && myOwnEntryIds.has(entry.id);
    let privateEntry = null;
    if (access.is_admin || ownHidden) {
      const { data, error } = await supabase
        .from("entry_private")
        .select("author_name,department,submitted_email")
        .eq("entry_id", entry.id)
        .maybeSingle();
      if (error) console.error(error);
      privateEntry = data || null;
    }

    const mediaHtml = (Array.isArray(entry.attachments) ? entry.attachments : []).map(renderAttachment).join("");
    const author = entry.show_author
      ? [entry.public_author, entry.public_department].filter(Boolean).map(escapeHtml).join(" · ")
      : "익명";
    const voteState = voteButtonState(entry);
    const privateInfoHtml = privateEntry && (access.is_admin || ownHidden)
      ? `<div class="admin-detail-private"><strong>${access.is_admin ? "조교 확인용 제출자 정보" : "내 제출 정보"}</strong><span>${[privateEntry.author_name, privateEntry.department].filter(Boolean).map(escapeHtml).join(" · ")} · ${escapeHtml(privateEntry.submitted_email || "이메일 정보 없음")}</span></div>`
      : "";
    const privateBadge = entry.publication_stage === "hidden"
      ? `<div class="detail-private-badge">${access.is_admin ? "비공개 · 조교 전용 열람" : "비공개 · 본인 확인용"}</div>` : "";
    const ownerCanManage = ownHidden && !entry.owner_edit_locked;
    const ownerActions = ownerCanManage ? `
      <div class="owner-detail-actions">
        <button class="btn secondary" id="editOwnEntry">내 작품 수정</button>
      </div>` : "";
    const detailVotingHtml = entry.publication_stage === "hidden" ? "" : `
          <div class="detail-actions">
            <button
              class="vote-btn ${voteState.selected ? "selected" : ""}"
              data-vote="${entry.id}"
              ${voteState.disabled ? "disabled" : ""}
              ${voteState.title ? `title="${escapeHtml(voteState.title)}"` : ""}
            >
              <span>${escapeHtml(voteState.label)}</span>
              <span class="vote-count">${voteCounts.get(entry.id) || 0}</span>
            </button>
          </div>`;

    app.innerHTML = `
      <article class="entry-detail">
        <button class="back-link" id="backToEntries">← Entries로 돌아가기</button>
        ${privateBadge}
        ${entry.is_finalist ? `<div class="detail-finalist-badge">본선 진출작</div>` : ""}
        <h1>${escapeHtml(entry.title)}</h1>
        <div class="detail-meta">${author} · ${formatDate(entry.published_at || entry.created_at)}</div>
        ${privateInfoHtml}
        <div class="detail-media">${mediaHtml}</div>
        ${entry.body ? `<div class="detail-body">${escapeHtml(entry.body)}</div>` : ""}
        ${ownerActions}
        ${detailVotingHtml}
      </article>`;

    document.querySelector("#backToEntries").addEventListener("click", () => { location.hash = "#entries"; });
    document.querySelector("#editOwnEntry")?.addEventListener("click", () => openOwnEdit(entry));
    document.querySelector("[data-vote]")?.addEventListener("click", async () => castVote(entry.id));
  } catch (error) {
    app.innerHTML = `<section class="entry-detail"><button class="back-link" onclick="location.hash='#entries'">← Entries로 돌아가기</button><p>${escapeHtml(error.message || "게시물을 불러오지 못했습니다.")}</p></section>`;
  }
}

function renderAttachment(file) {
  const url = escapeHtml(file.url || "");
  const name = escapeHtml(file.name || "첨부 파일");
  const type = file.type || "";
  if (!url) return `<div class="file-attachment"><span>${name}</span><span>불러올 수 없음</span></div>`;
  if (type.startsWith("image/")) return `<img src="${url}" alt="${name}" loading="lazy">`;
  if (type.startsWith("video/")) return `<video src="${url}" controls preload="metadata"></video>`;
  if (type.startsWith("audio/")) return `<audio src="${url}" controls preload="metadata"></audio>`;
  return `<a class="file-attachment" href="${url}" target="_blank" rel="noopener"><span>${name}</span><span>열기 ↗</span></a>`;
}

function friendlyVoteError(error) {
  const message = String(error?.message || error || "");
  if (message.includes("own_entry_not_allowed")) return "본인이 제출한 작품에는 투표할 수 없습니다.";
  if (message.includes("vote_limit_reached")) return `한 라운드에서 최대 ${MAX_VOTES}개 작품에만 투표할 수 있습니다.`;
  if (message.includes("entry_not_eligible")) return "현재 투표 라운드의 대상 작품이 아닙니다.";
  if (message.includes("voting_closed")) return "현재 투표 기간이 아닙니다.";
  if (message.includes("vote_not_allowed")) return "수강생 명단에 투표 권한이 등록된 계정만 투표할 수 있습니다.";
  return "투표 처리 중 오류가 발생했습니다.";
}

async function castVote(entryId) {
  if (!configured) return;
  if (!session) {
    await signInWithGoogle();
    return;
  }

  await refreshAccess();
  if (!access.can_vote) {
    alert("수강생 명단에 투표 권한이 등록된 계정만 투표할 수 있습니다.");
    return;
  }
  if (!access.voting_open) {
    alert("현재 투표 기간이 아닙니다.");
    return;
  }

  try {
    const { error } = await supabase.rpc("toggle_vote", { p_entry_id: entryId });
    if (error) throw error;

    await loadVoteState();
    const route = parseRoute();
    if (route.section === "entry") await renderEntryDetail(entryId);
    else await renderEntries();
  } catch (error) {
    console.error(error);
    alert(friendlyVoteError(error));
  }
}

function stageLabel(entry) {
  if (entry.publication_stage === "final") return "본선 공개";
  if (entry.publication_stage === "preliminary") return "예선 공개";
  return "대기";
}

function stageChipClass(entry) {
  if (entry.publication_stage === "final") return "final";
  if (entry.publication_stage === "preliminary") return "published";
  return "pending";
}

async function setEntryStage(id, stage) {
  const { error } = await supabase.rpc("admin_set_entry_stage", {
    p_entry_id: id,
    p_stage: stage,
  });
  if (error) throw error;
}

async function setFinalist(id, value) {
  const { error } = await supabase.rpc("admin_set_finalist", {
    p_entry_id: id,
    p_is_finalist: value,
  });
  if (error) throw error;
}

async function deleteEntryAsAdmin(entry) {
  const ok = confirm(
    `“${entry.title}” 작품을 완전히 삭제할까요?\n\n기존 Supabase 및 신규 R2 첨부파일, 제출자 개인정보, 투표 기록을 함께 삭제합니다. 이 작업은 되돌릴 수 없습니다.`
  );
  if (!ok) return;

  try {
    await r2Request("admin-delete-entry", { entryId: entry.id });
    await renderEntries();
  } catch (error) {
    console.error(error);
    alert(`삭제 중 문제가 발생했습니다. 관리자에게 알려 주세요. 재시도할 수 있도록 게시물은 유지됩니다.\n${error.message}`);
  }
}

async function setVotingState(round, open) {
  const { error } = await supabase.rpc("admin_set_voting_state", {
    p_round: round,
    p_open: open,
  });
  if (error) throw error;
  await refreshAccess();
  await renderEntries();
}

async function renderAdminPanel() {
  const host = document.querySelector("#adminPanel");
  if (!host || !access.is_admin) return;

  const [{ data: allEntries, error: entryError }, { data: privateRows, error: privateError }] = await Promise.all([
    supabase
      .from("entries")
      .select("id,title,attachments,is_published,show_author,public_author,public_department,created_at,published_at,publication_stage,is_finalist,upload_state")
      .order("is_finalist", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("entry_private")
      .select("entry_id,author_name,department,submitted_email,created_at"),
  ]);
  if (entryError) throw entryError;
  if (privateError) throw privateError;

  const privateMap = new Map((privateRows || []).map((row) => [row.entry_id, row]));
  const completedEntries = (allEntries || []).filter((entry) => entry.upload_state !== "uploading");
  const uploadingCount = (allEntries || []).length - completedEntries.length;
  const pending = completedEntries.filter((entry) => entry.publication_stage === "hidden");
  const preliminary = completedEntries.filter((entry) => entry.publication_stage === "preliminary");
  const finalPublished = completedEntries.filter((entry) => entry.publication_stage === "final");
  const finalists = completedEntries.filter((entry) => entry.is_finalist);

  host.innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head admin-panel-head-stacked">
        <div class="admin-summary-line">
          <strong>조교 관리</strong>
          <span class="muted">대기 ${pending.length} · 예선 공개 ${preliminary.length} · 본선 공개 ${finalPublished.length} · 본선 진출 ${finalists.length}${uploadingCount ? ` · 업로드 진행/미완료 ${uploadingCount}` : ""}</span>
        </div>
        <div class="admin-actions admin-global-actions">
          <button id="pruneStaleUploads" class="btn secondary" title="24시간 이상 방치된 비공개 업로드를 정리합니다.">미완료 업로드 정리</button>
          <button id="publishAllPreliminary" class="btn primary" ${pending.length ? "" : "disabled"}>대기작 전체 예선 공개</button>
          <button id="publishAllFinalists" class="btn secondary" ${finalists.length ? "" : "disabled"}>본선 진출작 전체 본선 공개</button>
          ${access.voting_open
            ? `<button id="stopVoting" class="btn danger">${currentRoundLabel()} 투표 종료</button>`
            : `
              <button id="startPreliminaryVoting" class="btn secondary">예선 투표 시작</button>
              <button id="startFinalVoting" class="btn secondary">본선 투표 시작</button>`}
        </div>
      </div>
      <div class="admin-list">
        ${completedEntries.map((entry) => {
          const priv = privateMap.get(entry.id) || {};
          const authorLabel = [priv.author_name, priv.department].filter(Boolean).map(escapeHtml).join(" · ") || "이름 미입력";
          const email = escapeHtml(priv.submitted_email || "이메일 정보 없음");
          const finalistText = entry.is_finalist ? "본선 진출 해제" : "본선 진출 지정";
          const authorToggleText = entry.show_author ? "이름 숨기기" : "이름 공개";
          return `
            <div class="admin-row" data-admin-entry="${entry.id}">
              <div class="admin-row-main">
                <div class="admin-chip-stack">
                  <span class="status-chip ${stageChipClass(entry)}">${stageLabel(entry)}</span>
                  ${entry.is_finalist ? `<span class="status-chip finalist">본선 진출</span>` : ""}
                </div>
                <div>
                  <button class="admin-entry-title" data-admin-open="${entry.id}">${escapeHtml(entry.title)}</button>
                  <div class="admin-private-info">${authorLabel} · ${email}</div>
                </div>
              </div>
              <div class="admin-row-actions">
                <button class="btn secondary" data-admin-open="${entry.id}">열람</button>
                <button class="btn secondary" data-finalist-toggle="${entry.id}">${finalistText}</button>
                <button class="btn secondary" data-stage-preliminary="${entry.id}" ${entry.publication_stage === "preliminary" ? "disabled" : ""}>예선 공개</button>
                <button class="btn secondary" data-stage-final="${entry.id}" ${!entry.is_finalist || entry.publication_stage === "final" ? "disabled" : ""} title="본선 진출작만 본선 공개할 수 있습니다.">본선 공개</button>
                <button class="btn secondary" data-author-toggle="${entry.id}" ${entry.publication_stage !== "final" ? "disabled" : ""} title="개인정보 공개/숨김은 본선 공개 단계에서만 변경할 수 있습니다.">${authorToggleText}</button>
                <button class="btn secondary" data-stage-hidden="${entry.id}" ${entry.publication_stage === "hidden" ? "disabled" : ""}>비공개</button>
                <button class="btn danger" data-delete-entry="${entry.id}">삭제</button>
              </div>
            </div>`;
        }).join("") || `<div class="admin-empty">아직 제출된 작품이 없습니다.</div>`}
      </div>
    </section>`;

  host.querySelectorAll("[data-admin-open]").forEach((button) => {
    button.addEventListener("click", () => {
      location.hash = `#entry/${button.dataset.adminOpen}`;
    });
  });

  document.querySelector("#pruneStaleUploads")?.addEventListener("click", async () => {
    if (!confirm("24시간 이상 미완료 상태인 제출과 삭제 후 남은 R2 파일을 정리할까요?")) return;
    try {
      const result = await r2Request("admin-prune-stale");
      alert(`정리 완료: 미완료 제출 ${result.prunedEntries}개, 고아 파일 ${result.prunedObjects}개`);
      await renderEntries();
    } catch (error) {
      alert(`업로드 정리 실패: ${error.message}`);
    }
  });

  document.querySelector("#publishAllPreliminary")?.addEventListener("click", async () => {
    if (!pending.length) return;
    if (!confirm(`${pending.length}개의 대기 작품을 모두 예선 공개할까요? 이름과 학과/학부는 비공개 상태로 공개됩니다.`)) return;
    const { error } = await supabase.rpc("admin_publish_all_preliminary");
    if (error) return alert(`예선 공개 실패: ${error.message}`);
    await renderEntries();
  });

  document.querySelector("#publishAllFinalists")?.addEventListener("click", async () => {
    if (!finalists.length) return;
    if (!confirm(`${finalists.length}개의 본선 진출작을 모두 본선 공개할까요? 이름과 학과/학부가 기본적으로 공개됩니다.`)) return;
    const { error } = await supabase.rpc("admin_publish_all_finalists");
    if (error) return alert(`본선 공개 실패: ${error.message}`);
    await renderEntries();
  });

  document.querySelector("#startPreliminaryVoting")?.addEventListener("click", async () => {
    if (!confirm(`예선 투표를 시작할까요? 학생 1명당 최대 ${MAX_VOTES}개 작품에 투표할 수 있으며 본인 작품은 제외됩니다.`)) return;
    try {
      await setVotingState("preliminary", true);
    } catch (error) {
      alert(`예선 투표 시작 실패: ${error.message}`);
    }
  });

  document.querySelector("#startFinalVoting")?.addEventListener("click", async () => {
    if (!finalists.length) return alert("먼저 본선 진출작을 지정해 주세요.");
    if (!confirm(`본선 투표를 시작할까요? 본선 진출 및 본선 공개된 작품만 투표 대상이며, 학생 1명당 최대 ${MAX_VOTES}표입니다.`)) return;
    try {
      await setVotingState("final", true);
    } catch (error) {
      alert(`본선 투표 시작 실패: ${error.message}`);
    }
  });

  document.querySelector("#stopVoting")?.addEventListener("click", async () => {
    if (!confirm(`${currentRoundLabel()} 투표를 종료할까요? 종료 후에는 표를 추가·취소할 수 없습니다.`)) return;
    try {
      await setVotingState(access.voting_round, false);
    } catch (error) {
      alert(`투표 종료 실패: ${error.message}`);
    }
  });

  host.querySelectorAll("[data-finalist-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.finalistToggle;
      const entry = (allEntries || []).find((item) => item.id === id);
      if (!entry) return;
      try {
        await setFinalist(id, !entry.is_finalist);
        await renderEntries();
      } catch (error) {
        alert(`본선 진출 설정 실패: ${error.message}`);
      }
    });
  });

  host.querySelectorAll("[data-stage-preliminary]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.stagePreliminary;
      try {
        await setEntryStage(id, "preliminary");
        await renderEntries();
      } catch (error) {
        alert(`예선 공개 실패: ${error.message}`);
      }
    });
  });

  host.querySelectorAll("[data-stage-final]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.stageFinal;
      try {
        await setEntryStage(id, "final");
        await renderEntries();
      } catch (error) {
        alert(`본선 공개 실패: ${error.message}`);
      }
    });
  });

  host.querySelectorAll("[data-stage-hidden]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.stageHidden;
      if (!confirm("이 작품을 다시 비공개 상태로 전환할까요?")) return;
      try {
        await setEntryStage(id, "hidden");
        await renderEntries();
      } catch (error) {
        alert(`비공개 전환 실패: ${error.message}`);
      }
    });
  });

  host.querySelectorAll("[data-author-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.authorToggle;
      const entry = (allEntries || []).find((item) => item.id === id);
      const priv = privateMap.get(id) || {};
      if (!entry || entry.publication_stage !== "final") return;
      const next = !entry.show_author;

      const { error } = await supabase
        .from("entries")
        .update({
          show_author: next,
          public_author: next ? (priv.author_name || null) : null,
          public_department: next ? (priv.department || null) : null,
        })
        .eq("id", id);
      if (error) return alert(`개인정보 공개 설정 변경 실패: ${error.message}`);
      await renderEntries();
    });
  });

  host.querySelectorAll("[data-delete-entry]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.deleteEntry;
      const entry = (allEntries || []).find((item) => item.id === id);
      if (!entry) return;
      await deleteEntryAsAdmin(entry);
    });
  });
}

function openOwnEdit(entry) {
  if (!session || !myOwnEntryIds.has(entry.id) || entry.publication_stage !== "hidden" ||
      entry.upload_state !== "ready" || entry.owner_edit_locked) {
    return alert("예선 공개 전인 본인 작품만 수정할 수 있습니다.");
  }
  currentEditEntry = entry;
  editForm.reset();
  editStatus.textContent = "";
  editStatus.classList.remove("error");
  document.querySelector("#editTitle").value = entry.title || "";
  document.querySelector("#editBody").value = entry.body || "";
  // Name/department are never present in the publicly readable entries row;
  // retrieve only this user's private record under Supabase RLS.
  const files = Array.isArray(entry.attachments) ? entry.attachments : [];
  document.querySelector("#editExistingFiles").innerHTML = files.length
    ? files.map((file, i) => `<label class="edit-file-item">
        <input type="checkbox" data-keep-attachment="${escapeHtml(file.path || "")}" checked>
        <span>유지: ${escapeHtml(file.name || `첨부파일 ${i + 1}`)}</span>
      </label>`).join("")
    : `<p class="muted">현재 첨부파일 없음</p>`;
  editDialog.showModal();
  supabase.from("entry_private").select("author_name,department")
    .eq("entry_id", entry.id).maybeSingle().then(({data,error}) => {
      if (error) {
        editStatus.textContent = "이름과 학과를 불러오지 못했습니다. 창을 닫고 다시 시도해 주세요.";
        editStatus.classList.add("error");
        return;
      }
      if (editDialog.open && currentEditEntry?.id === entry.id) {
        document.querySelector("#editAuthor").value = data?.author_name || "";
        document.querySelector("#editDepartment").value = data?.department || "";
      }
    });
}

function closeOwnEdit() {
  if (editSaving) return;
  editDialog.close();
  editForm.reset();
  editStatus.textContent = "";
  currentEditEntry = null;
}

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = currentEditEntry;
  if (!entry || editSaving) return;
  editSaving = true;
  saveOwnEditButton.disabled = true;
  editStatus.classList.remove("error");
  let editId = null;
  let committed = false;
  try {
    const title = document.querySelector("#editTitle").value.trim();
    const author = document.querySelector("#editAuthor").value.trim();
    const department = document.querySelector("#editDepartment").value.trim();
    const body = document.querySelector("#editBody").value.trim();
    const keepPaths = [...editDialog.querySelectorAll("[data-keep-attachment]:checked")]
      .map((checkbox) => checkbox.dataset.keepAttachment);
    const files = [...document.querySelector("#editNewFiles").files];
    if (!title || !author || !department) throw new Error("제목, 이름, 학과/학부는 필수입니다.");
    if (!body && !files.length && !keepPaths.length) throw new Error("본문 또는 첨부파일이 하나 이상 필요합니다.");
    if (files.length + keepPaths.length > 20) throw new Error("기존 첨부파일을 포함해 최대 20개까지 가능합니다.");
    editStatus.textContent = "수정 내용을 임시 저장하는 중…";
    const started = await r2Request("begin-own-edit", {
      entryId: entry.id, title, body, author, department, keepPaths,
    });
    editId = started.editId;
    for (let i = 0; i < files.length; i += 1) {
      await uploadFileToR2(files[i], entry.id, i, files.length,
        { editId, statusTarget: editStatus });
    }
    editStatus.textContent = "수정 내용을 확정하는 중…";
    const result = await r2Request("commit-own-edit", { editId });
    committed = true;
    alert(result.cleanupPending
      ? "수정 완료. 삭제한 첨부파일의 서버 정리는 다음 정리 작업에서 재시도됩니다."
      : "작품 수정이 완료되었습니다.");
    // Do not allow close while save is in flight.
    editSaving = false;
    closeOwnEdit();
    entriesCache = [];
    await loadPublishedEntries();
    if (parseRoute().section === "entry") await renderEntryDetail(entry.id);
    else await renderEntries();
  } catch (error) {
    console.error(error);
    if (editId && !committed) {
      try { await r2Request("cancel-own-edit", { editId }); }
      catch (cleanupError) { console.error("Edit cancellation deferred:", cleanupError); }
    }
    editStatus.textContent = error.message || "수정에 실패했습니다. 원본은 그대로 유지됩니다.";
    editStatus.classList.add("error");
  } finally {
    editSaving = false;
    saveOwnEditButton.disabled = false;
  }
});

document.querySelector("#cancelOwnEdit").addEventListener("click", closeOwnEdit);
document.querySelector("#closeOwnEdit").addEventListener("click", closeOwnEdit);
editDialog.addEventListener("cancel", (event) => {
  if (editSaving) event.preventDefault();
  else currentEditEntry = null;
});

function openComposer() {
  formStatus.textContent = "";
  formStatus.classList.remove("error");
  composer.showModal();
}

function closeComposer() {
  composer.close();
  entryForm.reset();
  formStatus.textContent = "";
  formStatus.classList.remove("error");
}

// Browser uploads large files directly to private R2 via presigned URLs.
// The file's bytes never pass through GitHub Pages or Supabase Storage.
function putR2WithProgress(url, blob, headers = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    for (const [header, value] of Object.entries(headers)) xhr.setRequestHeader(header, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 HTTP ${xhr.status}: 파일 업로드에 실패했습니다.`));
    };
    xhr.onerror = () => reject(new Error("R2 연결 오류: CORS 설정 또는 인터넷 연결을 확인해 주세요."));
    xhr.onabort = () => reject(new Error("R2 업로드가 중단되었습니다."));
    xhr.send(blob);
  });
}

function updateUploadProgress(index, total, completedBytes, sendingBytes, size, target = formStatus) {
  const percent = Math.min(100, Math.floor(100 * (completedBytes + sendingBytes) / size));
  target.textContent = `R2 업로드 중 (${index + 1}/${total}) · ${percent}%`;
}

async function uploadFileToR2(file, entryId, index, total, { editId = null, statusTarget = formStatus } = {}) {
  const started = await r2Request("start-upload", {
    entryId, editId, name: file.name, type: file.type, size: file.size,
  });

  if (started.mode === "single") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await putR2WithProgress(started.url, file, started.headers,
          (loaded) => updateUploadProgress(index, total, 0, loaded, file.size, statusTarget));
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  } else if (started.mode === "multipart") {
    const partSize = started.partSize;
    for (let part = 0; part < started.partCount; part += 1) {
      const start = part * partSize;
      const slice = file.slice(start, Math.min(file.size, start + partSize));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const { url } = await r2Request("sign-part", {
            uploadId: started.uploadId, partNumber: part + 1,
          });
          await putR2WithProgress(url, slice, {},
            (loaded) => updateUploadProgress(index, total, start, loaded, file.size, statusTarget));
          break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    }
  } else {
    throw new Error("알 수 없는 R2 업로드 방식입니다.");
  }

  statusTarget.textContent = `파일 검증 중… (${index + 1}/${total})`;
  await r2Request("finish-upload", { uploadId: started.uploadId });
}

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return;
  if (!session || !access.can_submit) {
    closeComposer();
    if (!session) {
      await signInWithGoogle();
    } else {
      alert("수강생 명단에 제출 권한이 등록된 계정만 작품을 제출할 수 있습니다.");
    }
    return;
  }

  submitEntry.disabled = true;
  formStatus.classList.remove("error");
  let entryId = null;
  let submissionCompleted = false;
  let entryCreated = false;

  try {
    const title = document.querySelector("#entryTitle").value.trim();
    const author = document.querySelector("#entryAuthor").value.trim();
    const department = document.querySelector("#entryDepartment").value.trim();
    const body = document.querySelector("#entryBody").value.trim();
    const files = Array.from(document.querySelector("#entryFiles").files || []);

    if (!title) throw new Error("제목을 입력해 주세요.");
    if (!author) throw new Error("이름을 입력해 주세요.");
    if (!department) throw new Error("학과/학부를 입력해 주세요.");
    if (!body && !files.length) throw new Error("본문 또는 첨부 파일 중 하나는 있어야 합니다.");

    entryId = crypto.randomUUID();

    formStatus.textContent = "비공개 제출 정보를 저장하는 중…";
    const { error: submitError } = await supabase.rpc("submit_entry", {
      p_id: entryId,
      p_title: title,
      p_body: body,
      p_attachments: [],
      p_author_name: author,
      p_department: department,
    });
    if (submitError) throw submitError;
    entryCreated = true;

    for (let index = 0; index < files.length; index += 1) {
      await uploadFileToR2(files[index], entryId, index, files.length);
    }
    formStatus.textContent = "제출 완료 상태를 기록하는 중…";
    await r2Request("finish-submission", { entryId });
    submissionCompleted = true;

    closeComposer();
    alert("제출이 완료되었습니다. 예선 공개 전에는 Entries의 '내 비공개 제출작'에서 열람·수정할 수 있습니다.");
    await renderEntries();
  } catch (error) {
    console.error(error);
    if (entryId && entryCreated && !submissionCompleted) {
      try {
        await r2Request("cancel-submission", { entryId });
      } catch (cleanupError) {
        console.error("R2 cleanup failed:", cleanupError);
        formStatus.textContent = "제출 또는 정리 중 오류가 발생했습니다. 조교에게 알려 주세요. "
          + (error.message || "") + " / 정리: " + cleanupError.message;
        formStatus.classList.add("error");
        return;
      }
    }
    formStatus.textContent = error.message || "제출 중 오류가 발생했습니다.";
    formStatus.classList.add("error");
  } finally {
    submitEntry.disabled = false;
  }
});

async function signInWithGoogle() {
  if (!configured) {
    alert("먼저 Supabase 설정을 완료해 주세요.");
    return;
  }

  sessionStorage.setItem(POST_AUTH_ROUTE_KEY, location.hash || "#entries");
  const redirectTo = `${location.origin}${location.pathname}`;

  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          prompt: "select_account",
        },
      },
    });
    if (error) throw error;
  } catch (error) {
    console.error(error);
    sessionStorage.removeItem(POST_AUTH_ROUTE_KEY);
    alert(error.message || "Google 로그인에 실패했습니다.");
  }
}

// Dialog / navigation wiring
document.querySelector("#closeComposer").addEventListener("click", closeComposer);
document.querySelector("#cancelComposer").addEventListener("click", closeComposer);
composer.addEventListener("click", (event) => {
  const rect = composer.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) closeComposer();
});

menuToggle.addEventListener("click", () => {
  const open = mainNav.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(open));
});
window.addEventListener("hashchange", router);

await router();
