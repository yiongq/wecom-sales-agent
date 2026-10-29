// 12 R3：先有界读取，再交给原生 multipart 解析；不信任 Content-Length。
export const WEB_UPLOAD_MAX_BYTES = Math.floor(8.1 * 1024 * 1024);

export async function readWebUpload(request: Request): Promise<{ ok: true; file: File; cid: string } | { ok: false; status: 400 | 413 }> {
  if (Number(request.headers.get('content-length')) > WEB_UPLOAD_MAX_BYTES) {
    void request.body?.cancel().catch(() => {});
    return { ok: false, status: 413 };
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > WEB_UPLOAD_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(chunk.value);
    }
    const data = await new Response(Buffer.concat(chunks, size), { headers: { 'content-type': contentType } }).formData();
    const fields = [...data.keys()];
    const file = data.get('file');
    const cid = data.get('cid');
    if (
      fields.length !== 2 ||
      data.getAll('file').length !== 1 ||
      data.getAll('cid').length !== 1 ||
      !(file instanceof File) ||
      typeof cid !== 'string' ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(cid)
    )
      return { ok: false, status: 400 };
    return { ok: true, file, cid };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }
}
