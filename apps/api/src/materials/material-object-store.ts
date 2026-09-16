import OSS from 'ali-oss';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';

/** Private objects only. Caller never supplies a bucket, prefix, or object key. */
export class MaterialObjectStore {
  private readonly client: OSS;
  constructor(config: ConfigService) {
    const accessKeyId = config.get<string>('MATERIAL_OSS_ACCESS_KEY_ID');
    const accessKeySecret = config.get<string>('MATERIAL_OSS_ACCESS_KEY_SECRET');
    const bucket = config.get<string>('MATERIAL_OSS_BUCKET');
    const region = config.get<string>('MATERIAL_OSS_REGION');
    if (!accessKeyId || !accessKeySecret || !bucket || !region) throw new Error('Private material OSS configuration is incomplete');
    this.client = new OSS({ accessKeyId, accessKeySecret, bucket, region, secure: true, timeout: 60000 });
  }
  private key(user: string, id: string, kind: 'original' | 'thumbnail') {
    if (!user || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid material identity');
    return `bio-v3/users/${createHash('sha256').update(user).digest('hex')}/materials/${id}/${kind === 'thumbnail' ? 'thumbnail.webp' : 'original'}`;
  }
  async put(user: string, id: string, kind: 'original' | 'thumbnail', buffer: Buffer, mime: string) {
    try {
      await this.client.put(this.key(user, id, kind), buffer, { headers: {
        'Content-Type': mime, 'Cache-Control': 'private, no-store',
        'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true',
      } });
    } catch { throw new ServiceUnavailableException('资料存储暂时不可用，请稍后重试'); }
  }
  async get(user: string, id: string, kind: 'original' | 'thumbnail'): Promise<Buffer> {
    try { return (await this.client.get(this.key(user, id, kind))).content as Buffer; }
    catch { throw new ServiceUnavailableException('资料暂时无法读取，请稍后重试'); }
  }
  async remove(user: string, id: string, kind: 'original' | 'thumbnail') {
    try { await this.client.delete(this.key(user, id, kind)); }
    catch { throw new ServiceUnavailableException('资料暂时无法删除，请稍后重试'); }
  }
}
