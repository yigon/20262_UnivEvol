import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_CONFIG } from "./config.js";

const app = document.querySelector("#app");
const composer = document.querySelector("#composerDialog");
const entryForm = document.querySelector("#entryForm");
const formStatus = document.querySelector("#formStatus");
const submitEntry = document.querySelector("#submitEntry");
const menuToggle = document.querySelector("#menuToggle");
const mainNav = document.querySelector("#mainNav");

const authDialog = document.querySelector("#authDialog");
const authEmail = document.querySelector("#authEmail");
const authOtp = document.querySelector("#authOtp");
const otpArea = document.querySelector("#otpArea");
const authStatus = document.querySelector("#authStatus");
const sendOtpButton = document.querySelector("#sendOtp");
const verifyOtpButton = document.querySelector("#verifyOtp");

const taLine = document.querySelector("#taLine");
taLine.textContent = SITE_CONFIG.taLine;

const configured = !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
let supabase = null;
let session = null;
let access = {
  email: "",
  is_admin: false,
  can_submit: false,
  can_vote: false,
  voting_open: false,
};

let entriesCache = [];
let voteCounts = new Map();
let myVoteEntryId = null;
let pendingAuthEmail = "";

if (configured) {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data } = await supabase.auth.getSession();
  session = data.session;
  await refreshAccess();

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    setTimeout(async () => {
      await refreshAccess();
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
    access = { email: "", is_admin: false, can_submit: false, can_vote: false, voting_open: false };
    return;
  }
  access = {
    email: data?.email || session?.user?.email || "",
    is_admin: Boolean(data?.is_admin),
    can_submit: Boolean(data?.can_submit),
    can_vote: Boolean(data?.can_vote),
    voting_open: Boolean(data?.voting_open),
  };
}

function authControlsHtml() {
  if (!configured) return "";
  if (!session) {
    return `<button id="loginButton" class="btn secondary">로그인</button>`;
  }
  const label = access.is_admin ? "조교 로그인" : escapeHtml(access.email || session.user.email || "로그인됨");
  return `
    <span class="auth-user-label">${label}</span>
    <button id="logoutButton" class="btn secondary">로그아웃</button>`;
}

function wireAuthControls() {
  document.querySelector("#loginButton")?.addEventListener("click", openAuthDialog);
  document.querySelector("#logoutButton")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });
}

async function loadPublishedEntries() {
  if (!configured) {
    entriesCache = [];
    voteCounts = new Map();
    myVoteEntryId = null;
    return;
  }

  const { data: entries, error: entriesError } = await supabase
    .from("entries")
    .select("id,title,body,attachments,is_published,published_at,show_author,public_author,public_department,created_at")
    .eq("is_published", true)
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
  myVoteEntryId = null;

  const { data: counts, error: countError } = await supabase.rpc("get_vote_counts");
  if (countError) throw countError;
  for (const row of counts || []) voteCounts.set(row.entry_id, Number(row.vote_count || 0));

  if (session) {
    const { data: vote, error: voteError } = await supabase
      .from("votes")
      .select("entry_id")
      .eq("voter_id", session.user.id)
      .maybeSingle();
    if (voteError) throw voteError;
    myVoteEntryId = vote?.entry_id || null;
  }
}

function getCover(entry) {
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  return attachments.find((file) => file.type?.startsWith("image/") && file.url) || null;
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
      <div id="entriesGrid" class="entries-grid"></div>
    </section>`;

  wireAuthControls();
  document.querySelector("#openComposer").addEventListener("click", () => {
    if (!session) return openAuthDialog();
    if (!access.can_submit) {
      alert("수강생 명단에 제출 권한이 등록된 계정만 작품을 제출할 수 있습니다.");
      return;
    }
    openComposer();
  });

  const status = document.querySelector("#entriesStatus");
  const grid = document.querySelector("#entriesGrid");

  try {
    await refreshAccess();
    await loadPublishedEntries();
    if (access.is_admin) await renderAdminPanel();

    const voteText = access.voting_open ? " · 투표 진행 중" : " · 투표 마감/대기";
    status.textContent = configured
      ? `${entriesCache.length}개의 공개 작품${voteText}`
      : "Supabase를 연결하면 게시물이 여기에 표시됩니다.";

    if (!entriesCache.length) {
      grid.innerHTML = `<div class="empty-state"><div><strong>현재 공개된 작품이 없습니다.</strong><br>제출 작품은 조교 확인 후 공개됩니다.</div></div>`;
      return;
    }
    grid.replaceChildren(...entriesCache.map(makeEntryCard));
  } catch (error) {
    console.error(error);
    status.textContent = "게시물을 불러오지 못했습니다.";
    grid.innerHTML = `<div class="empty-state"><div>데이터베이스 연결을 확인해 주세요.<br><span class="muted">${escapeHtml(error.message || "Unknown error")}</span></div></div>`;
  }
}

function makeEntryCard(entry) {
  const article = document.createElement("article");
  article.className = "entry-card";
  const cover = getCover(entry);
  const media = cover
    ? `<img class="entry-card-cover" src="${escapeHtml(cover.url)}" alt="${escapeHtml(entry.title)} 대표 이미지" loading="lazy" data-open-entry="${entry.id}">`
    : `<div class="entry-card-placeholder" data-open-entry="${entry.id}">MY UNIVERSE STORY</div>`;

  const authorBits = entry.show_author
    ? [entry.public_author, entry.public_department].filter(Boolean).map(escapeHtml).join(" · ")
    : "익명";
  const selected = myVoteEntryId === entry.id;

  article.innerHTML = `
    ${media}
    <div class="entry-card-body">
      <button class="entry-card-title" data-open-entry="${entry.id}">${escapeHtml(entry.title)}</button>
      <div class="entry-card-meta">${authorBits} · ${formatDate(entry.published_at || entry.created_at)}</div>
    </div>
    <div class="entry-card-footer">
      <button class="vote-btn ${selected ? "selected" : ""}" data-vote="${entry.id}" ${access.voting_open ? "" : "disabled"}>
        <span>${selected ? "✓ 내 투표" : "투표"}</span>
        <span class="vote-count">${voteCounts.get(entry.id) || 0}</span>
      </button>
    </div>`;

  article.querySelectorAll("[data-open-entry]").forEach((node) => {
    node.addEventListener("click", () => { location.hash = `#entry/${entry.id}`; });
  });
  article.querySelector("[data-vote]").addEventListener("click", async () => {
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
      const { data, error } = await supabase
        .from("entries")
        .select("id,title,body,attachments,is_published,published_at,show_author,public_author,public_department,created_at")
        .eq("id", id)
        .eq("is_published", true)
        .single();
      if (error) throw error;
      [entry] = await attachSignedUrls([data]);
      await loadVoteState();
    }
    if (!entry) throw new Error("게시물을 찾을 수 없습니다.");

    const mediaHtml = (Array.isArray(entry.attachments) ? entry.attachments : []).map(renderAttachment).join("");
    const author = entry.show_author
      ? [entry.public_author, entry.public_department].filter(Boolean).map(escapeHtml).join(" · ")
      : "익명";
    const selected = myVoteEntryId === entry.id;

    app.innerHTML = `
      <article class="entry-detail">
        <button class="back-link" id="backToEntries">← Entries로 돌아가기</button>
        <h1>${escapeHtml(entry.title)}</h1>
        <div class="detail-meta">${author} · ${formatDate(entry.published_at || entry.created_at)}</div>
        <div class="detail-media">${mediaHtml}</div>
        ${entry.body ? `<div class="detail-body">${escapeHtml(entry.body)}</div>` : ""}
        <div class="detail-actions">
          <button class="vote-btn ${selected ? "selected" : ""}" data-vote="${entry.id}" ${access.voting_open ? "" : "disabled"}>
            <span>${selected ? "✓ 내 투표" : "투표"}</span>
            <span class="vote-count">${voteCounts.get(entry.id) || 0}</span>
          </button>
        </div>
      </article>`;

    document.querySelector("#backToEntries").addEventListener("click", () => { location.hash = "#entries"; });
    document.querySelector("[data-vote]").addEventListener("click", async () => castVote(entry.id));
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

async function castVote(entryId) {
  if (!configured) return;
  if (!session) {
    openAuthDialog();
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
    if (myVoteEntryId === entryId) {
      const { error } = await supabase.from("votes").delete().eq("voter_id", session.user.id);
      if (error) throw error;
    } else if (myVoteEntryId) {
      const { error } = await supabase
        .from("votes")
        .update({ entry_id: entryId, updated_at: new Date().toISOString() })
        .eq("voter_id", session.user.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("votes").insert({
        voter_id: session.user.id,
        entry_id: entryId,
      });
      if (error) throw error;
    }

    await loadVoteState();
    const route = parseRoute();
    if (route.section === "entry") await renderEntryDetail(entryId);
    else await renderEntries();
  } catch (error) {
    console.error(error);
    alert("투표 처리 중 오류가 발생했습니다.");
  }
}

async function renderAdminPanel() {
  const host = document.querySelector("#adminPanel");
  if (!host || !access.is_admin) return;

  const [{ data: allEntries, error: entryError }, { data: privateRows, error: privateError }] = await Promise.all([
    supabase
      .from("entries")
      .select("id,title,is_published,show_author,public_author,public_department,created_at,published_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("entry_private")
      .select("entry_id,author_name,department,submitted_email,created_at"),
  ]);
  if (entryError) throw entryError;
  if (privateError) throw privateError;

  const privateMap = new Map((privateRows || []).map((row) => [row.entry_id, row]));
  const pending = (allEntries || []).filter((entry) => !entry.is_published);
  const published = (allEntries || []).filter((entry) => entry.is_published);

  host.innerHTML = `
    <section class="admin-panel">
      <div class="admin-panel-head">
        <div>
          <strong>조교 관리</strong>
          <span class="muted">대기 ${pending.length} · 공개 ${published.length}</span>
        </div>
        <div class="admin-actions">
          <button id="toggleVoting" class="btn secondary">투표 ${access.voting_open ? "닫기" : "열기"}</button>
          <button id="publishAll" class="btn primary" ${pending.length ? "" : "disabled"}>대기작 전체 공개</button>
        </div>
      </div>
      <div class="admin-list">
        ${(allEntries || []).map((entry) => {
          const priv = privateMap.get(entry.id) || {};
          const authorLabel = [priv.author_name, priv.department].filter(Boolean).map(escapeHtml).join(" · ") || "이름 미입력";
          const email = escapeHtml(priv.submitted_email || "이메일 정보 없음");
          return `
            <div class="admin-row" data-admin-entry="${entry.id}">
              <div class="admin-row-main">
                <span class="status-chip ${entry.is_published ? "published" : "pending"}">${entry.is_published ? "공개" : "대기"}</span>
                <div>
                  <strong>${escapeHtml(entry.title)}</strong>
                  <div class="admin-private-info">${authorLabel} · ${email}</div>
                </div>
              </div>
              <div class="admin-row-actions">
                <button class="btn secondary" data-author-toggle="${entry.id}">${entry.show_author ? "이름 숨기기" : "이름 공개"}</button>
                <button class="btn secondary" data-publish-toggle="${entry.id}">${entry.is_published ? "비공개로 전환" : "공개"}</button>
              </div>
            </div>`;
        }).join("") || `<div class="admin-empty">아직 제출된 작품이 없습니다.</div>`}
      </div>
    </section>`;

  document.querySelector("#publishAll")?.addEventListener("click", async () => {
    if (!pending.length) return;
    if (!confirm(`${pending.length}개의 대기 작품을 모두 공개할까요? 이름/학과 공개 설정은 현재 상태를 유지합니다.`)) return;
    const { error } = await supabase
      .from("entries")
      .update({ is_published: true, published_at: new Date().toISOString() })
      .eq("is_published", false);
    if (error) return alert(`공개 처리 실패: ${error.message}`);
    await renderEntries();
  });

  document.querySelector("#toggleVoting")?.addEventListener("click", async () => {
    const next = !access.voting_open;
    if (!confirm(`투표를 ${next ? "시작" : "종료"}할까요?`)) return;
    const { error } = await supabase
      .from("site_settings")
      .update({ voting_open: next, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (error) return alert(`투표 설정 변경 실패: ${error.message}`);
    await refreshAccess();
    await renderEntries();
  });

  host.querySelectorAll("[data-publish-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.publishToggle;
      const entry = (allEntries || []).find((item) => item.id === id);
      if (!entry) return;
      const next = !entry.is_published;
      const { error } = await supabase
        .from("entries")
        .update({
          is_published: next,
          published_at: next ? new Date().toISOString() : null,
        })
        .eq("id", id);
      if (error) return alert(`상태 변경 실패: ${error.message}`);
      await renderEntries();
    });
  });

  host.querySelectorAll("[data-author-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.authorToggle;
      const entry = (allEntries || []).find((item) => item.id === id);
      const priv = privateMap.get(id) || {};
      if (!entry) return;
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
    // 원본 파일명에 학생 이름이 들어 있을 수 있으므로 공개 메타데이터에는 저장하지 않습니다.
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
    openAuthDialog();
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

function openAuthDialog() {
  if (!configured) {
    alert("먼저 Supabase 설정을 완료해 주세요.");
    return;
  }
  authStatus.textContent = "";
  authStatus.classList.remove("error");
  authOtp.value = "";
  otpArea.hidden = true;
  verifyOtpButton.hidden = true;
  sendOtpButton.hidden = false;
  authDialog.showModal();
}

function closeAuthDialog() {
  authDialog.close();
  authStatus.textContent = "";
  authStatus.classList.remove("error");
}

sendOtpButton.addEventListener("click", async () => {
  const email = authEmail.value.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    authStatus.textContent = "올바른 이메일 주소를 입력해 주세요.";
    authStatus.classList.add("error");
    return;
  }

  sendOtpButton.disabled = true;
  authStatus.classList.remove("error");
  authStatus.textContent = "인증 코드를 보내는 중…";
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) throw error;
    pendingAuthEmail = email;
    otpArea.hidden = false;
    verifyOtpButton.hidden = false;
    sendOtpButton.hidden = true;
    authStatus.textContent = "이메일로 받은 6자리 코드를 입력하세요.";
    authOtp.focus();
  } catch (error) {
    console.error(error);
    authStatus.textContent = error.message || "인증 메일 전송에 실패했습니다.";
    authStatus.classList.add("error");
  } finally {
    sendOtpButton.disabled = false;
  }
});

verifyOtpButton.addEventListener("click", async () => {
  const token = authOtp.value.trim();
  if (!/^\d{6}$/.test(token)) {
    authStatus.textContent = "6자리 인증 코드를 입력해 주세요.";
    authStatus.classList.add("error");
    return;
  }

  verifyOtpButton.disabled = true;
  authStatus.classList.remove("error");
  authStatus.textContent = "인증 중…";
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email: pendingAuthEmail || authEmail.value.trim().toLowerCase(),
      token,
      type: "email",
    });
    if (error) throw error;
    session = data.session;
    await refreshAccess();
    closeAuthDialog();

    if (!access.is_admin && !access.can_submit && !access.can_vote) {
      alert("로그인은 되었지만 현재 수강생 명단에 등록된 계정이 아닙니다.");
    }
    await router();
  } catch (error) {
    console.error(error);
    authStatus.textContent = error.message || "인증에 실패했습니다.";
    authStatus.classList.add("error");
  } finally {
    verifyOtpButton.disabled = false;
  }
});

// Dialog / navigation wiring
document.querySelector("#closeComposer").addEventListener("click", closeComposer);
document.querySelector("#cancelComposer").addEventListener("click", closeComposer);
composer.addEventListener("click", (event) => {
  const rect = composer.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) closeComposer();
});

document.querySelector("#closeAuth").addEventListener("click", closeAuthDialog);
authDialog.addEventListener("click", (event) => {
  const rect = authDialog.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) closeAuthDialog();
});

menuToggle.addEventListener("click", () => {
  const open = mainNav.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(open));
});
window.addEventListener("hashchange", router);

await router();
