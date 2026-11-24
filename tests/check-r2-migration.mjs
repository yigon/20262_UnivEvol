// Offline structural regression checks; no live Supabase/R2 credentials required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = read('app.js');
const schema = read('supabase/migrations/202611250001_r2_storage.sql');
const edge = read('supabase/functions/r2-storage/index.ts');
const html = read('index.html');
const config = read('config.js');

assert.match(app, /function storageOf\(file\)[\s\S]*?file\.storage === "r2" \? "r2" : "supabase"/);
assert.match(app, /r2Request\("sign-read"/);
assert.match(app, /r2Request\("start-upload"/);
assert.match(app, /r2Request\("sign-part"/);
assert.match(app, /r2Request\("finish-upload"/);
assert.match(app, /r2Request\("finish-submission"/);
assert.match(app, /r2Request\("cancel-submission"/);
assert.match(app, /r2Request\("admin-delete-entry"/);
assert.match(app, /r2Request\("admin-prune-stale"/);
assert.match(app, /\.createSignedUrls\(paths, 1800\)/); // legacy media stays readable
assert.doesNotMatch(app, /\.upload\(meta\.path,\s*file/); // legacy writes must be gone
assert.doesNotMatch(app, /maxFileSizeMB/);
assert.match(html, /id="entryFiles"[^>]*multiple/);
assert.doesNotMatch(html, /id="entryFiles"[^>]*accept=/); // all file types

assert.match(schema, /add column if not exists upload_state/);
assert.match(schema, /r2_uploads/);
assert.match(schema, /grant execute on function public\.r2_finalize_upload\(uuid\) to service_role/);
assert.match(schema, /drop policy if exists "Eligible user can upload own pending media"/);
assert.match(schema, /drop policy if exists "Admin can delete entries"/);
assert.match(schema, /revoke execute on function public\.delete_own_pending_entry\(uuid\) from authenticated/);
assert.match(schema, /where publication_stage = 'hidden' and upload_state = 'ready'/);
assert.match(edge, /admin\.auth\.getUser/);
assert.match(edge, /multipart_upload_id/);
assert.match(edge, /new ListPartsCommand/);
assert.match(edge, /new HeadObjectCommand/);
assert.match(edge, /new DeleteObjectCommand/);
assert.match(edge, /entry\.publication_stage !== "hidden" && entry\.upload_state === "ready"/);
assert.doesNotMatch(config, /R2_SECRET_ACCESS_KEY\s*=/);
assert.match(config, /SUPABASE_ANON_KEY/);

console.log('PASS: 26 static checks (legacy reads, R2 uploads, multipart, auth, moderation, cleanup).');
