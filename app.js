import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_CONFIG } from "./config.js";

const app = document.querySelector("#app");
const composer = document.querySelector("#composerDialog");
const entryForm = document.querySelector("#entryForm");
const formStatus = document.querySelector("#formStatus");
const submitEntry = document.querySelector("#submitEntry");
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

async function attachSignedUrls(entries) {
  const paths = [];
  for (const entry of entries) {
    for (const file of Array.isArray(entry.attachments) ? entry.attachments : []) {
      if (file.path) paths.push(file.path);
    }
  }
  if (!paths.length) return entries;

  const uniquePaths = [...new Set(paths)];
  const { data, error } = await supabase.storage
    .from(SITE_CONFIG.storageBucket)
    .createSignedUrls(uniquePaths, 1800);
  if (error) {
    console.error(error);
    return entries;
  }

  const urlMap = new Map();
  for (const item of data || []) {
    if (item?.path && item?.signedUrl) urlMap.set(item.path, item.signedUrl);
  }

  return entries.map((entry) => ({
    ...entry,
    attachments: (Array.isArray(entry.attachments) ? entry.attachments : []).map((file) => ({
      ...file,
      url: file.path ? (urlMap.get(file.path) || "") : "",
    })),
  }));
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

    if (!entriesCache.length) {
      host.innerHTML = `<div class="empty-state"><div><strong>현재 공개된 작품이 없습니다.</strong><br>제출 작품은 조교 확인 후 공개됩니다.</div></div>`;
      return;
    }

    const finalists = entriesCache.filter((entry) => entry.is_finalist);
    const others = entriesCache.filter((entry) => !entry.is_finalist);

    host.innerHTML = [
      entriesSectionHtml("본선 진출작", finalists, "finalist-section"),
      entriesSectionHtml(finalists.length ? "예선 출품작" : "출품작", others, "regular-section"),
    ].join("");

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
      let query = supabase
        .from("entries")
        .select("id,title,body,attachments,is_published,published_at,show_author,public_author,public_department,created_at,publication_stage,is_finalist")
        .eq("id", id);

      // 일반 사용자는 비공개 작품을 조회하지 못하고, 조교만 RLS를 통해 열람할 수 있습니다.
      if (!access.is_admin) query = query.neq("publication_stage", "hidden");

      const { data, error } = await query.single();
      if (error) throw error;
      [entry] = await attachSignedUrls([data]);
      await loadVoteState();
    }
    if (!entry) throw new Error("게시물을 찾을 수 없습니다.");

    let privateEntry = null;
    if (access.is_admin) {
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
    const adminPrivateHtml = access.is_admin && privateEntry
      ? `<div class="admin-detail-private"><strong>조교 확인용 제출자 정보</strong><span>${[privateEntry.author_name, privateEntry.department].filter(Boolean).map(escapeHtml).join(" · ")} · ${escapeHtml(privateEntry.submitted_email || "이메일 정보 없음")}</span></div>`
      : "";

    app.innerHTML = `
      <article class="entry-detail">
        <button class="back-link" id="backToEntries">← Entries로 돌아가기</button>
        ${entry.publication_stage === "hidden" && access.is_admin ? `<div class="detail-private-badge">비공개 · 조교 전용 열람</div>` : ""}
        ${entry.is_finalist ? `<div class="detail-finalist-badge">본선 진출작</div>` : ""}
        <h1>${escapeHtml(entry.title)}</h1>
        <div class="detail-meta">${author} · ${formatDate(entry.published_at || entry.created_at)}</div>
        ${adminPrivateHtml}
        <div class="detail-media">${mediaHtml}</div>
        ${entry.body ? `<div class="detail-body">${escapeHtml(entry.body)}</div>` : ""}
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
        </div>
      </article>`;

    document.querySelector("#backToEntries").addEventListener("click", () => { location.hash = "#entries"; });
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
  const paths = (Array.isArray(entry.attachments) ? entry.attachments : [])
    .map((file) => file.path)
    .filter(Boolean);

  const ok = confirm(
    `“${entry.title}” 작품을 완전히 삭제할까요?\n\n게시물, 제출자 개인정보, 해당 작품의 투표 기록이 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`
  );
  if (!ok) return;

  const { error: deleteError } = await supabase.from("entries").delete().eq("id", entry.id);
  if (deleteError) {
    alert(`게시물 삭제 실패: ${deleteError.message}`);
    return;
  }

  if (paths.length) {
    const { error: storageError } = await supabase.storage.from(SITE_CONFIG.storageBucket).remove(paths);
    if (storageError) {
      console.error(storageError);
      alert("게시물은 삭제되었지만 첨부파일 정리에 실패했습니다. Supabase Storage에서 해당 작품 폴더를 확인해 주세요.");
    }
  }

  await renderEntries();
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
      .select("id,title,attachments,is_published,show_author,public_author,public_department,created_at,published_at,publication_stage,is_finalist")
      .order("is_finalist", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("entry_private")
      .select("entry_id,author_name,department,submitted_email,created_at"),
  ]);
  if (entryError) throw entryError;
  if (privateError) throw privateError;

  const privateMap = new Map((privateRows || []).map((row) => [row.entry_id, row]));
  const pending = (allEntries || []).filter((entry) => entry.publication_stage === "hidden");
  const preliminary = (allEntries || []).filter((entry) => entry.publication_stage === "preliminary");
  const finalPublished = (allEntries || []).filter((entry) => entry.publication_stage === "final");
  const finalists = (allEntries || []).filter((entry) => entry.is_finalist);

  host.innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head admin-panel-head-stacked">
        <div class="admin-summary-line">
          <strong>조교 관리</strong>
          <span class="muted">대기 ${pending.length} · 예선 공개 ${preliminary.length} · 본선 공개 ${finalPublished.length} · 본선 진출 ${finalists.length}</span>
        </div>
        <div class="admin-actions admin-global-actions">
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
        ${(allEntries || []).map((entry) => {
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

function prepareAttachmentMetadata(files, entryId) {
  return files.map((file, index) => {
    if (file.size > SITE_CONFIG.maxFileSizeMB * 1024 * 1024) {
      throw new Error(`${file.name}: 파일 크기가 ${SITE_CONFIG.maxFileSizeMB}MB를 초과합니다.`);
    }
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
    const publicName = `첨부파일_${index + 1}.${ext}`;
    return {
      name: publicName,
      type: file.type,
      path: `${entryId}/${crypto.randomUUID()}.${ext}`,
    };
  });
}

async function uploadPreparedFiles(files, metadata) {
  const uploadedPaths = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const meta = metadata[index];
      formStatus.textContent = `파일 업로드 중… (${index + 1}/${files.length})`;
      const { error } = await supabase.storage.from(SITE_CONFIG.storageBucket).upload(meta.path, file, {
        cacheControl: "3600",
        contentType: file.type || undefined,
        upsert: false,
      });
      if (error) throw error;
      uploadedPaths.push(meta.path);
    }
    return uploadedPaths;
  } catch (error) {
    if (uploadedPaths.length) {
      await supabase.storage.from(SITE_CONFIG.storageBucket).remove(uploadedPaths);
    }
    throw error;
  }
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
    const attachments = prepareAttachmentMetadata(files, entryId);

    formStatus.textContent = "비공개 제출 정보를 저장하는 중…";
    const { error: submitError } = await supabase.rpc("submit_entry", {
      p_id: entryId,
      p_title: title,
      p_body: body,
      p_attachments: attachments,
      p_author_name: author,
      p_department: department,
    });
    if (submitError) throw submitError;

    if (files.length) await uploadPreparedFiles(files, attachments);

    closeComposer();
    alert("제출이 완료되었습니다. 작품은 조교 확인 전까지 다른 사람에게 보이지 않습니다.");
    await renderEntries();
  } catch (error) {
    console.error(error);
    if (entryId) {
      await supabase.rpc("delete_own_pending_entry", { p_entry_id: entryId });
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
