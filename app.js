import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_CONFIG } from "./config.js";

const app = document.querySelector("#app");
const composer = document.querySelector("#composerDialog");
const entryForm = document.querySelector("#entryForm");
const menuToggle = document.querySelector("#menuToggle");
const mainNav = document.querySelector("#mainNav");
const formStatus = document.querySelector("#formStatus");
const submitEntry = document.querySelector("#submitEntry");

document.querySelector("#taLine").textContent = SITE_CONFIG.taLine;

const configured = !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
let supabase = null;
if (configured) {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
const voterId = getOrCreateVoterId();
let entriesCache = [];
let likesCache = new Map();
let likedByMe = new Set();

function getOrCreateVoterId() {
  const key = "evoluniverse-voter-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
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
    return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
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
  renderTemplate("#homeTemplate");
}

function setupBanner() {
  return configured ? "" : `
    <div class="setup-banner">
      현재는 백엔드 연결 전 미리보기 상태입니다. <code>config.js</code>에 Supabase URL과 anon key를 넣고
      <code>supabase-schema.sql</code>을 실행하면 게시/좋아요/파일 업로드가 활성화됩니다.
    </div>`;
}

async function loadEntriesAndLikes() {
  if (!configured) {
    entriesCache = [];
    likesCache = new Map();
    likedByMe = new Set();
    return;
  }

  const [{ data: entries, error: entriesError }, { data: likes, error: likesError }] = await Promise.all([
    supabase.from("entries").select("*").order("created_at", { ascending: false }),
    supabase.from("likes").select("entry_id,voter_id"),
  ]);

  if (entriesError) throw entriesError;
  if (likesError) throw likesError;

  entriesCache = entries || [];
  likesCache = new Map();
  likedByMe = new Set();
  for (const like of likes || []) {
    likesCache.set(like.entry_id, (likesCache.get(like.entry_id) || 0) + 1);
    if (like.voter_id === voterId) likedByMe.add(like.entry_id);
  }
}

function getCover(entry) {
  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
  return attachments.find((file) => file.type?.startsWith("image/")) || null;
}

async function renderEntries() {
  app.innerHTML = `
    <section class="entries-page">
      <div class="entries-title-row">
        <h1>Entries</h1>
        <div class="entries-tools"><button id="openComposer" class="btn primary">+ 새 글 올리기</button></div>
      </div>
      ${setupBanner()}
      <div id="entriesStatus" class="entries-status">게시물을 불러오는 중…</div>
      <div id="entriesGrid" class="entries-grid"></div>
    </section>`;

  document.querySelector("#openComposer").addEventListener("click", openComposer);
  const status = document.querySelector("#entriesStatus");
  const grid = document.querySelector("#entriesGrid");

  try {
    await loadEntriesAndLikes();
    status.textContent = configured ? `${entriesCache.length}개의 게시물` : "Supabase를 연결하면 게시물이 여기에 표시됩니다.";
    if (!entriesCache.length) {
      grid.innerHTML = `<div class="empty-state"><div><strong>아직 게시물이 없습니다.</strong><br>첫 작품을 올려보세요.</div></div>`;
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
  const authorBits = [entry.author, entry.department].filter(Boolean).map(escapeHtml).join(" · ");

  article.innerHTML = `
    ${media}
    <div class="entry-card-body">
      <button class="entry-card-title" data-open-entry="${entry.id}">${escapeHtml(entry.title)}</button>
      <div class="entry-card-meta">${authorBits || formatDate(entry.created_at)}</div>
    </div>
    <div class="entry-card-footer">
      <button class="like-btn ${likedByMe.has(entry.id) ? "liked" : ""}" data-like="${entry.id}" aria-label="좋아요">
        <span class="heart">${likedByMe.has(entry.id) ? "♥" : "♡"}</span><span data-like-count>${likesCache.get(entry.id) || 0}</span>
      </button>
    </div>`;

  article.querySelectorAll("[data-open-entry]").forEach((node) => {
    node.addEventListener("click", () => { location.hash = `#entry/${entry.id}`; });
  });
  article.querySelector("[data-like]").addEventListener("click", async (event) => {
    event.stopPropagation();
    await toggleLike(entry.id, event.currentTarget);
  });
  return article;
}

async function renderEntryDetail(id) {
  app.innerHTML = `<section class="entry-detail"><p>게시물을 불러오는 중…</p></section>`;
  try {
    if (!entriesCache.length) await loadEntriesAndLikes();
    let entry = entriesCache.find((item) => item.id === id);
    if (!entry && configured) {
      const { data, error } = await supabase.from("entries").select("*").eq("id", id).single();
      if (error) throw error;
      entry = data;
    }
    if (!entry) throw new Error("게시물을 찾을 수 없습니다.");

    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    const mediaHtml = attachments.map(renderAttachment).join("");
    const meta = [entry.author, entry.department, formatDate(entry.created_at)].filter(Boolean).map(escapeHtml).join(" · ");
    const liked = likedByMe.has(entry.id);

    app.innerHTML = `
      <article class="entry-detail">
        <button class="back-link" id="backToEntries">← Entries로 돌아가기</button>
        <h1>${escapeHtml(entry.title)}</h1>
        <div class="detail-meta">${meta}</div>
        <div class="detail-media">${mediaHtml}</div>
        ${entry.body ? `<div class="detail-body">${escapeHtml(entry.body)}</div>` : ""}
        <div class="detail-actions">
          <button class="like-btn ${liked ? "liked" : ""}" data-like="${entry.id}" aria-label="좋아요">
            <span class="heart">${liked ? "♥" : "♡"}</span><span data-like-count>${likesCache.get(entry.id) || 0}</span>
          </button>
        </div>
      </article>`;
    document.querySelector("#backToEntries").addEventListener("click", () => { location.hash = "#entries"; });
    document.querySelector("[data-like]").addEventListener("click", async (event) => toggleLike(entry.id, event.currentTarget));
  } catch (error) {
    app.innerHTML = `<section class="entry-detail"><button class="back-link" onclick="location.hash='#entries'">← Entries로 돌아가기</button><p>${escapeHtml(error.message)}</p></section>`;
  }
}

function renderAttachment(file) {
  const url = escapeHtml(file.url || "");
  const name = escapeHtml(file.name || "첨부 파일");
  const type = file.type || "";
  if (type.startsWith("image/")) return `<img src="${url}" alt="${name}" loading="lazy">`;
  if (type.startsWith("video/")) return `<video src="${url}" controls preload="metadata"></video>`;
  if (type.startsWith("audio/")) return `<audio src="${url}" controls preload="metadata"></audio>`;
  return `<a class="file-attachment" href="${url}" target="_blank" rel="noopener"><span>${name}</span><span>열기 ↗</span></a>`;
}

async function toggleLike(entryId, button) {
  if (!configured) {
    alert("먼저 config.js에서 Supabase를 연결해 주세요.");
    return;
  }
  button.disabled = true;
  const alreadyLiked = likedByMe.has(entryId);
  try {
    if (alreadyLiked) {
      const { error } = await supabase.from("likes").delete().eq("entry_id", entryId).eq("voter_id", voterId);
      if (error) throw error;
      likedByMe.delete(entryId);
      likesCache.set(entryId, Math.max(0, (likesCache.get(entryId) || 1) - 1));
    } else {
      const { error } = await supabase.from("likes").insert({ entry_id: entryId, voter_id: voterId });
      if (error && error.code !== "23505") throw error;
      likedByMe.add(entryId);
      likesCache.set(entryId, (likesCache.get(entryId) || 0) + 1);
    }
    button.classList.toggle("liked", !alreadyLiked);
    button.querySelector(".heart").textContent = !alreadyLiked ? "♥" : "♡";
    button.querySelector("[data-like-count]").textContent = likesCache.get(entryId) || 0;
  } catch (error) {
    console.error(error);
    alert("좋아요 처리 중 오류가 발생했습니다.");
  } finally {
    button.disabled = false;
  }
}

function openComposer() {
  if (!configured) {
    alert("먼저 config.js에서 Supabase를 연결해 주세요. README.md의 1~3단계를 따라 하면 됩니다.");
    return;
  }
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

async function uploadFiles(files) {
  const attachments = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.size > SITE_CONFIG.maxFileSizeMB * 1024 * 1024) {
      throw new Error(`${file.name}: 파일 크기가 ${SITE_CONFIG.maxFileSizeMB}MB를 초과합니다.`);
    }
    formStatus.textContent = `파일 업로드 중… (${index + 1}/${files.length})`;
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(SITE_CONFIG.storageBucket).upload(path, file, {
      cacheControl: "3600",
      contentType: file.type || undefined,
      upsert: false,
    });
    if (error) throw error;
    const { data } = supabase.storage.from(SITE_CONFIG.storageBucket).getPublicUrl(path);
    attachments.push({ name: file.name, type: file.type, url: data.publicUrl, path });
  }
  return attachments;
}

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return;
  submitEntry.disabled = true;
  formStatus.classList.remove("error");
  try {
    const title = document.querySelector("#entryTitle").value.trim();
    const author = document.querySelector("#entryAuthor").value.trim();
    const department = document.querySelector("#entryDepartment").value.trim();
    const body = document.querySelector("#entryBody").value.trim();
    const files = Array.from(document.querySelector("#entryFiles").files || []);
    if (!title) throw new Error("제목을 입력해 주세요.");
    if (!body && !files.length) throw new Error("본문 또는 첨부 파일 중 하나는 있어야 합니다.");

    const attachments = files.length ? await uploadFiles(files) : [];
    formStatus.textContent = "게시물 저장 중…";
    const { error } = await supabase.from("entries").insert({ title, author, department, body, attachments });
    if (error) throw error;

    closeComposer();
    await renderEntries();
  } catch (error) {
    console.error(error);
    formStatus.textContent = error.message || "게시 중 오류가 발생했습니다.";
    formStatus.classList.add("error");
  } finally {
    submitEntry.disabled = false;
  }
});

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
router();
