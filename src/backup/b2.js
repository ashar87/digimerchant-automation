/**
 * Backblaze B2, through its native API (no SDK): just what the nightly backup
 * needs. List, upload, download and delete files in one bucket.
 *
 * The application key should be restricted to that one bucket, with read and
 * write access only. Its authorisation then names the bucket; otherwise the
 * bucket is looked up by name.
 */
import crypto from 'node:crypto';

const API = 'https://api.backblazeb2.com/b2api/v2';

export const b2Configured = (cfg = {}) => Boolean(cfg.keyId && cfg.appKey && cfg.bucket);

export function createB2({ keyId, appKey, bucket, fetch = globalThis.fetch }) {
  let session = null;

  async function call(url, { method = 'POST', headers = {}, body, raw = false } = {}) {
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).message || text;
      } catch {}
      throw Object.assign(new Error(`Backblaze ${res.status}: ${message.slice(0, 200)}`), { status: res.status });
    }
    return raw ? res : res.json();
  }

  async function auth() {
    if (session) return session;
    const basic = Buffer.from(`${keyId}:${appKey}`).toString('base64');
    const a = await call(`${API}/b2_authorize_account`, { method: 'GET', headers: { Authorization: `Basic ${basic}` } });
    let bucketId = a.allowed?.bucketName === bucket ? a.allowed.bucketId : null;
    if (a.allowed?.bucketName && a.allowed.bucketName !== bucket) throw new Error(`This Backblaze key only opens bucket "${a.allowed.bucketName}", not "${bucket}"`);
    if (!bucketId) {
      const list = await call(`${a.apiUrl}/b2api/v2/b2_list_buckets`, { headers: { Authorization: a.authorizationToken }, body: JSON.stringify({ accountId: a.accountId, bucketName: bucket }) });
      bucketId = list.buckets?.[0]?.bucketId;
      if (!bucketId) throw new Error(`No Backblaze bucket called "${bucket}"`);
    }
    session = { apiUrl: a.apiUrl, downloadUrl: a.downloadUrl, token: a.authorizationToken, bucketId };
    return session;
  }

  const api = async (name, body, { bucketScoped = true } = {}) => {
    const s = await auth();
    return call(`${s.apiUrl}/b2api/v2/${name}`, { headers: { Authorization: s.token }, body: JSON.stringify(bucketScoped ? { bucketId: s.bucketId, ...body } : body) });
  };

  /** Every file under `prefix`: [{ name, id, size }]. */
  async function list(prefix = '') {
    const out = [];
    let start = null;
    do {
      const r = await api('b2_list_file_names', { prefix, maxFileCount: 1000, ...(start ? { startFileName: start } : {}) });
      out.push(...r.files.map((f) => ({ name: f.fileName, id: f.fileId, size: f.contentLength })));
      start = r.nextFileName;
    } while (start);
    return out;
  }

  async function upload(name, buffer) {
    const target = await api('b2_get_upload_url', {});
    return call(target.uploadUrl, {
      headers: {
        Authorization: target.authorizationToken,
        'X-Bz-File-Name': encodeURIComponent(name),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buffer.length),
        'X-Bz-Content-Sha1': crypto.createHash('sha1').update(buffer).digest('hex'),
      },
      body: buffer,
    });
  }

  async function download(name) {
    const s = await auth();
    const res = await call(`${s.downloadUrl}/file/${encodeURIComponent(bucket)}/${name.split('/').map(encodeURIComponent).join('/')}`, { method: 'GET', headers: { Authorization: s.token }, raw: true });
    return Buffer.from(await res.arrayBuffer());
  }

  const remove = (file) => api('b2_delete_file_version', { fileName: file.name, fileId: file.id }, { bucketScoped: false });

  return { list, upload, download, remove };
}
