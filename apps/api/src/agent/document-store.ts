import { Injectable, Optional, UnauthorizedException, NotFoundException, ConflictException } from '@nestjs/common';
import type { PanelDocument } from '@bio/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryService } from '../memory/memory.service.js';
import { AgentStorage } from './agent-storage.js';
import { editDocument } from './document-edit.js';
import type { PanelUpdate } from './panel-workspace.js';

export interface DocumentRevision { document: PanelDocument; conversationId: string; summary: string; createdAt: string }
interface Entry { conversationId: string; document: PanelDocument; revisions: DocumentRevision[] }
export const legacyDocumentId = (conversationId: string, id: string) => `legacy_${createHash('sha256').update(JSON.stringify([conversationId, id])).digest('hex').slice(0, 40)}`;

/** Database is authoritative; the local single-process adapter is for development only. */
@Injectable()
export class DocumentStore {
  constructor(private readonly storage: AgentStorage, @Optional() private readonly memory?: MemoryService) {}
  private identity(user?: string): string {
    if (this.memory?.enabled && !user) throw new UnauthorizedException('User identity required');
    return user ?? 'local';
  }
  private path(user: string) {
    const directory = join(this.storage.root, 'documents', createHash('sha256').update(user).digest('hex'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, 'documents.json');
  }
  private local(user: string): Entry[] {
    const path = this.path(user);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Entry[] : [];
  }
  private write(user: string, entries: Entry[]) {
    const path = this.path(user), temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
  /** Idempotent import. An old session snapshot can never overwrite a newer document. */
  async importLegacy(user?: string) {
    this.identity(user);
    const legacy = this.memory?.enabled ? await this.memory.manuscripts(user!) : this.storage.localManuscripts();
    for (const entry of legacy) {
      const document = { ...entry.document, schemaVersion: 1 as const, id: legacyDocumentId(entry.conversationId, entry.document.id) };
      // New panel snapshots contain canonical IDs; they are only caches, never import sources.
      if ((entry.document as PanelDocument).schemaVersion === 1) continue;
      await this.save(user, entry.conversationId, document, 0, '导入旧会话文稿', true);
    }
  }
  async list(user?: string): Promise<Array<{ conversationId: string; document: PanelDocument }>> {
    const owner = this.identity(user);
    if (!this.memory?.pool) return this.local(owner).map(({ document, conversationId }) => ({ document, conversationId }));
    const result = await this.memory.pool.query('SELECT origin_conversation_id,body FROM bio_documents WHERE user_id=$1 ORDER BY updated_at DESC,id', [owner]);
    return result.rows.map(row => ({ conversationId: row.origin_conversation_id as string, document: row.body as PanelDocument }));
  }
  async get(user: string | undefined, id: string): Promise<PanelDocument> {
    const owner = this.identity(user);
    const document = this.memory?.pool
      ? (await this.memory.pool.query('SELECT body FROM bio_documents WHERE user_id=$1 AND id=$2', [owner, id])).rows[0]?.body
      : this.local(owner).find(item => item.document.id === id)?.document;
    if (!document) throw new NotFoundException('文稿不存在');
    return document;
  }
  async history(user: string | undefined, id: string): Promise<DocumentRevision[]> {
    const owner = this.identity(user);
    await this.get(user, id);
    if (!this.memory?.pool) return this.local(owner).find(item => item.document.id === id)!.revisions.slice().reverse();
    const result = await this.memory.pool.query('SELECT body,conversation_id,summary,created_at FROM bio_document_revisions WHERE user_id=$1 AND document_id=$2 ORDER BY version DESC', [owner, id]);
    return result.rows.map(row => ({ document: row.body, conversationId: row.conversation_id, summary: row.summary, createdAt: row.created_at.toISOString() }));
  }
  async edit(user: string | undefined, conversationId: string, input: PanelUpdate, summary = 'Agent 修改文稿') {
    let previous: PanelDocument | undefined;
    try { previous = await this.get(user, input.documentId); } catch (error) { if (!(error instanceof NotFoundException)) throw error; }
    const document = editDocument(previous, input);
    await this.save(user, conversationId, document, input.expectedVersion, summary);
    return document;
  }
  async restore(user: string | undefined, conversationId: string, id: string, expectedVersion: number, sourceVersion: number) {
    const source = (await this.history(user, id)).find(item => item.document.version === sourceVersion);
    if (!source) throw new NotFoundException('历史版本不存在');
    const document = { ...source.document, schemaVersion: 1 as const, version: expectedVersion + 1 };
    await this.save(user, conversationId, document, expectedVersion, `恢复到版本 ${sourceVersion}`);
    return document;
  }
  private async save(user: string | undefined, conversationId: string, document: PanelDocument, expectedVersion: number, summary: string, importing = false) {
    const owner = this.identity(user), createdAt = new Date().toISOString();
    if (!this.memory?.pool) {
      const entries = this.local(owner), index = entries.findIndex(item => item.document.id === document.id);
      if (importing && index >= 0) return;
      if ((entries[index]?.document.version ?? 0) !== expectedVersion) throw new ConflictException('文稿版本冲突，请重新读取');
      const revision = { document, conversationId, summary, createdAt };
      if (index < 0) entries.push({ conversationId, document, revisions: [revision] });
      else entries[index] = { ...entries[index]!, document, revisions: [...entries[index]!.revisions, revision] };
      this.write(owner, entries); return;
    }
    const client = await this.memory.pool.connect();
    try {
      await client.query('BEGIN');
      // Includes creation races and cross-conversation edits; never rely on the Agent run lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['document', owner, document.id])]);
      const existing = (await client.query('SELECT version FROM bio_documents WHERE user_id=$1 AND id=$2', [owner, document.id])).rows[0];
      if (importing && existing) { await client.query('COMMIT'); return; }
      if ((existing?.version ?? 0) !== expectedVersion) throw new ConflictException('文稿版本冲突，请重新读取');
      await client.query(`INSERT INTO bio_documents(user_id,id,origin_conversation_id,version,body) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id,id) DO UPDATE SET version=EXCLUDED.version,body=EXCLUDED.body,updated_at=now()`, [owner, document.id, conversationId, document.version, JSON.stringify(document)]);
      await client.query('INSERT INTO bio_document_revisions(user_id,document_id,version,body,conversation_id,summary) VALUES($1,$2,$3,$4,$5,$6)',
        [owner, document.id, document.version, JSON.stringify(document), conversationId, summary]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
