import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { MaterialsService } from './materials.service.js';

interface RemoteFile { name: string; uri: string; mimeType: string; expirationTime: string; state: string }
/** References are server-only, scoped by account and credential; never accepted from clients. */
export class GeminiFiles {
  private pending = new Map<string, Promise<RemoteFile>>();
  constructor(private config: ConfigService, private materials: MaterialsService) {}
  async get(id: string, user?: string): Promise<RemoteFile> {
    // Authorize even on cache hits (including deleted files).
    await this.materials.get(id, user);
    const key = this.config.get<string>('GEMINI_API_KEY')?.trim();
    if (!key) throw new ServiceUnavailableException('Gemini 尚未配置');
    const base = this.config.get<string>('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const scope = createHash('sha256').update(JSON.stringify([user ?? null, base, key])).digest('hex');
    const dir = join(this.materials.root, '.gemini-files', scope);
    const path = join(dir, `${id}.json`);
    let task = this.pending.get(path);
    if (!task) {
      task = this.prepare(id, user, base, key, dir, path);
      this.pending.set(path, task);
    }
    try { return await task; } finally { if (this.pending.get(path) === task) this.pending.delete(path); }
  }
  private async prepare(id: string, user: string | undefined, base: string, key: string, dir: string, path: string): Promise<RemoteFile> {
    try {
      const cached = JSON.parse(await readFile(path, 'utf8')) as RemoteFile;
      if (cached.state === 'ACTIVE' && Date.parse(cached.expirationTime) > Date.now() + 5 * 60_000) return cached;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const { buffer, mimeType, item } = await this.materials.modelFile(id, user);
    if (mimeType === 'application/pdf' && (buffer.length > 50 * 1024 * 1024 || (item.pageCount ?? 0) > 1000)) throw new BadRequestException('PDF 超过模型限制，请拆分为不超过 50 MB、1000 页的文件。');
    const headers = { 'x-goog-api-key': key };
    const start = await fetch(`${base.replace(/\/v1beta$/, '')}/upload/v1beta/files`, {
      method: 'POST', signal: AbortSignal.timeout(30000), headers: { ...headers, 'Content-Type': 'application/json', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(buffer.length), 'X-Goog-Upload-Header-Content-Type': mimeType },
      body: JSON.stringify({ file: { display_name: id } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!start.ok || !uploadUrl || new URL(uploadUrl).origin !== new URL(base).origin) throw new ServiceUnavailableException('文件上传准备失败，请重试');
    const upload = await fetch(uploadUrl, { method: 'POST', signal: AbortSignal.timeout(90000), headers: { ...headers, 'Content-Type': mimeType, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: new Uint8Array(buffer) });
    if (!upload.ok) throw new ServiceUnavailableException('文件上传失败，请重试');
    let file = ((await upload.json()) as { file: RemoteFile }).file;
    const deadline = Date.now() + 90000;
    while (file?.state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!/^files\/[\w-]+$/.test(file.name)) throw new ServiceUnavailableException('文件引用无效');
      const response = await fetch(`${base}/${file.name}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new ServiceUnavailableException('文件处理状态读取失败');
      file = await response.json() as RemoteFile;
    }
    if (file?.state !== 'ACTIVE' || !file.uri || !Number.isFinite(Date.parse(file.expirationTime))) throw new ServiceUnavailableException('文件尚未处理成功，请稍后重试');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(file), { mode: 0o600 });
    await rename(temp, path);
    return file;
  }
}
