/**
 * Supabase Edge Function: R2 storage adapter for UnivEvol.
 *
 * Public: sign-read (published entries; completed hidden entries for submitter/admin).
 * Private: start-upload, sign-part, finish-upload, finish-submission,
 *          cancel-submission, admin-delete-entry.
 *
 * IMPORTANT: Deploy with verify_jwt = false; each private action explicitly
 * checks the user's real Google/Supabase session via auth.getUser(accessToken).
 * service_role and R2 credentials MUST remain server-side secrets.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

const MB = 1024 * 1024;
const PART_SIZE = 16 * MB;           // R2 parts must be >= 5 MiB (except the final part).
// The current course deployment deliberately uses single PUTs. Multipart has
// shown Edge Runtime stream errors with 90MB submissions; the configured 2GiB
// per-file cap is below R2's 5GiB single-PUT maximum.
const MULTIPART_AT = Number.POSITIVE_INFINITY;
const UPLOAD_URL_TTL = 900;        // 15 minutes, enough for a slow 16 MiB part.
const READ_URL_TTL = 3600;         // 1 hour for videos seeking/range requests.
// Single PUT is supported by R2 up to 5GiB; never offer a larger limit.
const MAX_BYTES = Math.min(5 * 1024 ** 3, Number(Deno.env.get("R2_MAX_FILE_BYTES") || 2 * 1024 ** 3));
const MAX_FILES = Number(Deno.env.get("R2_MAX_FILES_PER_ENTRY") || 20);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = Deno.env.get("R2_BUCKET") || "";
const ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";
const KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
const SECRET_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
const LEGACY_BUCKET = "entry-media";
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "https://yigon.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const r2 = new S3Client({
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  region: "auto",
  forcePathStyle: true,
  // Prevent recent AWS SDK versions from adding an optional CRC32 header
  // that was not included when the browser's presigned PUT was generated.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY },
});

class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function json(data: unknown, status = 200, origin = "") {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization, apikey, x-client-info, content-type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function ensure(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new RequestError(message, status);
}

const isUuid = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

function extensionFromName(name: unknown): string {
  const last = typeof name === "string" ? name.split(".").pop()?.toLowerCase() : "";
  return last && /^[a-z0-9]{1,10}$/.test(last) ? last : "bin";
}

function normalizeType(type: unknown): string {
  return typeof type === "string" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(type) && type.length <= 120
    ? type : "application/octet-stream";
}

async function getIdentity(req: Request): Promise<{ id: string; email: string } | null> {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") || "");
  if (!match) return null;
  const { data, error } = await admin.auth.getUser(match[1]);
  if (error || !data.user?.id || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

async function isAdmin(identity: { id: string; email: string } | null) {
  if (!identity) return false;
  const { data, error } = await admin.from("admin_users").select("email");
  if (error) throw error;
  return (data || []).some((row) => String(row.email).toLowerCase() === identity.email);
}

async function ownsUploadingEntry(entryId: string, userId: string) {
  const [{ data: entry, error: ee }, { data: owner, error: oe }] = await Promise.all([
    admin.from("entries").select("id,upload_state,publication_stage")
      .eq("id", entryId).maybeSingle(),
    admin.from("entry_private").select("submitted_by")
      .eq("entry_id", entryId).maybeSingle(),
  ]);
  if (ee || oe) throw ee || oe;
  ensure(entry && owner?.submitted_by === userId
    && entry.upload_state === "uploading" && entry.publication_stage === "hidden",
  "본인 제출 중인 비공개 작품에서만 파일을 변경할 수 있습니다.", 403);
}

async function getUpload(uploadId: unknown, identity: { id: string; email: string }) {
  ensure(isUuid(uploadId), "올바르지 않은 업로드 ID입니다.");
  const { data, error } = await admin.from("r2_uploads").select("*").eq("id", uploadId).maybeSingle();
  if (error) throw error;
  ensure(data && data.submitted_by === identity.id, "업로드에 접근할 권한이 없습니다.", 403);
  return data;
}

function requiredIdentity(identity: { id: string; email: string } | null) {
  ensure(identity, "Google 로그인이 필요합니다.", 401);
  return identity;
}

async function headMatches(row: { object_key: string; size_bytes: number }) {
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: row.object_key }));
    return Number(head.ContentLength) === Number(row.size_bytes);
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function startUpload(body: Record<string, unknown>, identity: { id: string; email: string }) {
  ensure(isUuid(body.entryId), "올바르지 않은 작품 ID입니다.");
  await ownsUploadingEntry(body.entryId, identity.id);
  const size = Number(body.size);
  ensure(Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES,
    `파일 크기는 1바이트 이상 ${Math.round(MAX_BYTES / MB)}MiB 이하여야 합니다.`);
  const { count, error: countErr } = await admin.from("r2_uploads")
    .select("id", { head: true, count: "exact" }).eq("entry_id", body.entryId);
  if (countErr) throw countErr;
  ensure((count ?? 0) < MAX_FILES, `한 작품에 첨부할 수 있는 파일은 최대 ${MAX_FILES}개입니다.`);

  const extension = extensionFromName(body.name);
  const contentType = normalizeType(body.type);
  const uploadMode = size >= MULTIPART_AT ? "multipart" : "single";
  const objectKey = `${body.entryId}/${crypto.randomUUID()}.${extension}`;
  const { data: row, error } = await admin.from("r2_uploads").insert({
    entry_id: body.entryId,
    object_key: objectKey,
    submitted_by: identity.id,
    size_bytes: size,
    extension,
    content_type: contentType,
    upload_mode: uploadMode,
  }).select("id").single();
  if (error) throw error;

  try {
    if (uploadMode === "single") {
      const command = new PutObjectCommand({ Bucket: BUCKET, Key: objectKey, ContentType: contentType });
      const url = await getSignedUrl(r2, command, { expiresIn: UPLOAD_URL_TTL });
      return { uploadId: row.id, mode: "single", url, headers: { "Content-Type": contentType } };
    }
    const created = await r2.send(new CreateMultipartUploadCommand({
      Bucket: BUCKET, Key: objectKey, ContentType: contentType,
    }));
    ensure(created.UploadId, "R2 multipart 생성에 실패했습니다.", 502);
    const { error: updateError } = await admin.from("r2_uploads")
      .update({ multipart_upload_id: created.UploadId }).eq("id", row.id);
    if (updateError) {
      await r2.send(new AbortMultipartUploadCommand({
        Bucket: BUCKET, Key: objectKey, UploadId: created.UploadId,
      })).catch(() => {});
      throw updateError;
    }
    return {
      uploadId: row.id, mode: "multipart", partSize: PART_SIZE,
      partCount: Math.ceil(size / PART_SIZE),
    };
  } catch (err) {
    await admin.from("r2_uploads").delete().eq("id", row.id);
    throw err;
  }
}

async function signPart(body: Record<string, unknown>, identity: { id: string; email: string }) {
  const row = await getUpload(body.uploadId, identity);
  await ownsUploadingEntry(row.entry_id, identity.id);
  ensure(row.upload_status === "pending" && row.upload_mode === "multipart" && row.multipart_upload_id,
    "진행 중인 분할 업로드가 아닙니다.");
  const part = Number(body.partNumber);
  ensure(Number.isInteger(part) && part >= 1 && part <= Math.ceil(row.size_bytes / PART_SIZE),
    "올바르지 않은 파트 번호입니다.");
  const url = await getSignedUrl(r2, new UploadPartCommand({
    Bucket: BUCKET, Key: row.object_key, UploadId: row.multipart_upload_id, PartNumber: part,
  }), { expiresIn: UPLOAD_URL_TTL });
  return { url };
}

async function finishUpload(body: Record<string, unknown>, identity: { id: string; email: string }) {
  const row = await getUpload(body.uploadId, identity);
  if (row.upload_status === "attached") return { ok: true };
  await ownsUploadingEntry(row.entry_id, identity.id);

  // Multipart uploads are completed server-side; browser-supplied ETags are never trusted.
  if (!(await headMatches(row)) && row.upload_mode === "multipart") {
    ensure(row.multipart_upload_id, "누락된 multipart upload ID입니다.", 409);
    const partsResponse = await r2.send(new ListPartsCommand({
      Bucket: BUCKET, Key: row.object_key, UploadId: row.multipart_upload_id,
      MaxParts: 1000,
    }));
    const parts = (partsResponse.Parts || []).sort((a, b) => (a.PartNumber || 0) - (b.PartNumber || 0));
    const expectedCount = Math.ceil(Number(row.size_bytes) / PART_SIZE);
    ensure(parts.length === expectedCount && !partsResponse.IsTruncated, "업로드된 파일 조각이 부족합니다.", 409);
    for (let i = 0; i < parts.length; i += 1) {
      const expectedSize = Math.min(PART_SIZE, Number(row.size_bytes) - i * PART_SIZE);
      ensure(parts[i].PartNumber === i + 1 && Number(parts[i].Size) === expectedSize && parts[i].ETag,
        "업로드된 파일 조각의 크기 또는 순서가 맞지 않습니다.", 409);
    }
    await r2.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET, Key: row.object_key, UploadId: row.multipart_upload_id,
      MultipartUpload: {
        Parts: parts.map((part) => ({ PartNumber: part.PartNumber, ETag: part.ETag })),
      },
    }));
  }
  ensure(await headMatches(row), "R2에 업로드한 파일의 크기가 일치하지 않습니다.", 409);
  const { error } = await admin.rpc("r2_finalize_upload", { p_upload_id: row.id });
  if (error) throw error;
  return { ok: true };
}

async function finishSubmission(body: Record<string, unknown>, identity: { id: string; email: string }) {
  ensure(isUuid(body.entryId), "올바르지 않은 작품 ID입니다.");
  await ownsUploadingEntry(body.entryId, identity.id);
  const { error } = await admin.rpc("r2_complete_submission", { p_entry_id: body.entryId });
  if (error) throw error;
  return { ok: true };
}

async function deleteFilesForEntry(entryId: string, entry: { attachments: unknown }) {
  const { data: uploads, error } = await admin.from("r2_uploads")
    .select("object_key,upload_mode,multipart_upload_id,upload_status").eq("entry_id", entryId);
  if (error) throw error;

  for (const row of uploads || []) {
    if (row.upload_mode === "multipart" && row.upload_status === "pending" && row.multipart_upload_id) {
      await r2.send(new AbortMultipartUploadCommand({
        Bucket: BUCKET, Key: row.object_key, UploadId: row.multipart_upload_id,
      })).catch((err) => {
        const code = (err as { name?: string }).name;
        if (code !== "NoSuchUpload" && code !== "NoSuchKey") throw err;
      });
    }
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: row.object_key }));
  }
  const legacyPaths = (Array.isArray(entry.attachments) ? entry.attachments : [])
    .filter((file) => file && (file.storage === undefined || file.storage === "supabase") && typeof file.path === "string")
    .map((file) => file.path);
  if (legacyPaths.length) {
    // Existing files remain in the private Supabase bucket until the work is deleted.
    const { error: legacyError } = await admin.storage.from(LEGACY_BUCKET).remove(legacyPaths);
    if (legacyError) throw legacyError;
  }
}

async function deleteEntry(body: Record<string, unknown>, identity: { id: string; email: string }, administrator: boolean) {
  ensure(isUuid(body.entryId), "올바르지 않은 작품 ID입니다.");
  const { data: entry, error } = await admin.from("entries")
    .select("id,attachments,publication_stage,upload_state").eq("id", body.entryId).maybeSingle();
  if (error) throw error;
  ensure(entry, "존재하지 않는 작품입니다.", 404);
  if (!administrator) {
    ensure(entry.publication_stage === "hidden" && entry.upload_state === "uploading",
      "제출 진행 중인 작품만 취소할 수 있습니다.", 403);
    await ownsUploadingEntry(body.entryId, identity.id);
  }
  await deleteFilesForEntry(body.entryId, entry);
  // Keep tombstones for one day: a still-valid signed PUT may arrive after deletion.
  // Mark before deleting the entry so a failed DB operation remains retryable.
  const { error: manifestError } = await admin.from("r2_uploads")
    .update({ deleted_at: new Date().toISOString() }).eq("entry_id", body.entryId);
  if (manifestError) throw manifestError;
  // Delete DB last. In case of a storage failure the entry remains retryable.
  const { error: deleteError } = await admin.from("entries").delete().eq("id", body.entryId);
  if (deleteError) throw deleteError;
  return { ok: true };
}

async function pruneStaleUploads() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await admin.from("r2_uploads")
    .select("id,entry_id,object_key,upload_mode,multipart_upload_id,upload_status,deleted_at")
    .lt("created_at", cutoff).limit(200);
  if (error) throw error;
  let prunedEntries = 0;
  let prunedObjects = 0;
  const handledEntries = new Set<string>();
  for (const row of rows || []) {
    if (handledEntries.has(row.entry_id)) continue;
    const { data: entry, error: ee } = await admin.from("entries")
      .select("id,attachments,upload_state,publication_stage,created_at")
      .eq("id", row.entry_id).maybeSingle();
    if (ee) throw ee;
    if (entry && !(entry.upload_state === "uploading" && entry.publication_stage === "hidden"
      && new Date(entry.created_at).toISOString() < cutoff)) continue;
    if (entry) {
      // All files must be older than 24h; prevent removing an active new upload.
      const { data: recent, error: re } = await admin.from("r2_uploads")
        .select("id").eq("entry_id", row.entry_id).gte("created_at", cutoff).limit(1);
      if (re) throw re;
      if (recent?.length) continue;
      await deleteFilesForEntry(entry.id, entry);
      const { error: de } = await admin.from("entries").delete().eq("id", entry.id);
      if (de) throw de;
      prunedEntries += 1;
    } else {
      // Orphaned manifest from a deleted entry; uploaded object may have been
      // recreated using a presigned URL after the initial deletion.
      const { data: records, error: rErr } = await admin.from("r2_uploads")
        .select("id,object_key,multipart_upload_id,upload_mode,upload_status")
        .eq("entry_id", row.entry_id);
      if (rErr) throw rErr;
      for (const record of records || []) {
        if (record.upload_mode === "multipart" && record.upload_status === "pending" && record.multipart_upload_id) {
          await r2.send(new AbortMultipartUploadCommand({
            Bucket: BUCKET, Key: record.object_key, UploadId: record.multipart_upload_id,
          })).catch((err) => {
            if (!(["NoSuchUpload", "NoSuchKey"].includes((err as { name?: string }).name || ""))) throw err;
          });
        }
        await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: record.object_key }));
        prunedObjects += 1;
      }
    }
    const { error: cleanupError } = await admin.from("r2_uploads").delete().eq("entry_id", row.entry_id);
    if (cleanupError) throw cleanupError;
    handledEntries.add(row.entry_id);
  }
  return { ok: true, prunedEntries, prunedObjects };
}

async function signRead(
  body: Record<string, unknown>,
  administrator: boolean,
  identity: { id: string; email: string } | null,
) {
  const files = body.files;
  ensure(Array.isArray(files) && files.length <= 100, "한 번에 최대 100개 파일의 주소를 요청할 수 있습니다.");
  if (!files.length) return { items: [] };
  const valid = files.filter((v) => isUuid(v?.entryId) && typeof v.path === "string" && v.path.length < 500);
  ensure(valid.length === files.length, "파일 요청 형식이 올바르지 않습니다.");
  const ids = [...new Set(valid.map((v) => v.entryId))];
  const { data: entries, error } = await admin.from("entries")
    .select("id,attachments,publication_stage,upload_state").in("id", ids);
  if (error) throw error;
  // The private table is queried only on the server. Never trust the entryId
  // supplied by the browser as evidence of ownership.
  const hiddenIds = (entries || []).filter((entry) =>
    entry.publication_stage === "hidden" && entry.upload_state === "ready"
  ).map((entry) => entry.id);
  const owners = new Map<string, string>();
  if (identity && hiddenIds.length && !administrator) {
    const { data: privateRows, error: ownerError } = await admin.from("entry_private")
      .select("entry_id,submitted_by").in("entry_id", hiddenIds);
    if (ownerError) throw ownerError;
    for (const row of privateRows || []) owners.set(row.entry_id, row.submitted_by);
  }
  // Explicit tuple and Map value types prevent inference as Map<unknown, unknown>.
  type ReadableEntry = {
    id: string;
    attachments: unknown;
    publication_stage: string;
    upload_state: string;
  };
  const visible = new Map<string, ReadableEntry>((entries || []).filter((entry) =>
    administrator
    || (entry.publication_stage !== "hidden" && entry.upload_state === "ready")
    || (entry.publication_stage === "hidden" && entry.upload_state === "ready"
      && identity !== null && owners.get(entry.id) === identity.id)
  ).map((entry): [string, ReadableEntry] => [entry.id, entry]));

  const signed = [];
  for (const file of valid) {
    const entry = visible.get(file.entryId);
    if (!entry) continue;
    const listed = (Array.isArray(entry.attachments) ? entry.attachments : [])
      .some((meta) => meta?.storage === "r2" && meta.path === file.path);
    if (!listed) continue;
    const url = await getSignedUrl(r2,
      new GetObjectCommand({ Bucket: BUCKET, Key: file.path }), { expiresIn: READ_URL_TTL });
    signed.push({ entryId: file.entryId, path: file.path, url });
  }
  return { items: signed };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (origin && !allowedOrigins.includes(origin)) return json({ error: "Origin not allowed" }, 403);
  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = { "Vary": "Origin" };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "authorization, apikey, x-client-info, content-type";
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    }
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") return json({ error: "POST required" }, 405, origin);
  try {
    ensure(SUPABASE_URL && SERVICE_KEY && ACCOUNT_ID && BUCKET && KEY_ID && SECRET_KEY,
      "서버 측 R2/Supabase secrets 설정이 완료되지 않았습니다.", 503);
    const payload = await req.json();
    ensure(payload && typeof payload === "object", "JSON 요청을 확인해 주세요.");
    const body = payload as Record<string, unknown>;
    const action = body.action;
    const identity = await getIdentity(req);
    const administrator = (action === "sign-read" || action === "admin-delete-entry")
      ? await isAdmin(identity) : false;

    let result: unknown;
    if (action === "sign-read") result = await signRead(body, administrator, identity);
    else if (action === "start-upload") result = await startUpload(body, requiredIdentity(identity));
    else if (action === "sign-part") result = await signPart(body, requiredIdentity(identity));
    else if (action === "finish-upload") result = await finishUpload(body, requiredIdentity(identity));
    else if (action === "finish-submission") result = await finishSubmission(body, requiredIdentity(identity));
    else if (action === "cancel-submission") result = await deleteEntry(body, requiredIdentity(identity), false);
    else if (action === "admin-delete-entry") {
      ensure(administrator, "조교 권한이 필요합니다.", 403);
      result = await deleteEntry(body, requiredIdentity(identity), true);
    } else if (action === "admin-prune-stale") {
      ensure(await isAdmin(identity), "조교 권한이 필요합니다.", 403);
      result = await pruneStaleUploads();
    } else throw new RequestError("알 수 없는 작업입니다.", 404);

    return json(result, 200, origin);
  } catch (error) {
    console.error("r2-storage:", error);
    const err = error as { message?: string; status?: number };
    return json({ error: err instanceof RequestError ? err.message : "서버 처리 중 오류가 발생했습니다." },
      err instanceof RequestError ? err.status : 500, origin);
  }
});
