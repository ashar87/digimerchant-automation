/**
 * Just enough multipart/form-data parsing for one invoice upload with a few
 * text fields. Returns { fields: URLSearchParams, files: [{ name, filename, mime, data }] }.
 */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Upload is missing its boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = new URLSearchParams();
  const files = [];

  let start = body.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break; // closing boundary
    start += 2; // CRLF after the boundary
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = body.slice(start, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd);
    if (next === -1) break;
    const data = body.slice(headerEnd + 4, next - 2); // drop the CRLF before the next boundary
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    if (name !== undefined) {
      if (filename !== undefined) {
        if (filename) files.push({ name, filename: filename.split(/[\\/]/).pop(), mime: mime || 'application/octet-stream', data });
      } else fields.append(name, data.toString('utf8'));
    }
    start = next;
  }
  return { fields, files };
}
