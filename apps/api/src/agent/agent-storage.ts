import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentTraceEntry } from '@bio/contracts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { DEFAULT_READING_FONT_SIZE, isReadingFontSize, type ReadingFontSize } from '@bio/contracts';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Local development persistence. One API process owns this directory. */
@Injectable()
export class AgentStorage {
  readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('AGENT_DATA_DIR', '../../.bio-agent'));
  }

  assertId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException('Expected a UUID v4');
  }

  private readingPreferencePath(user?: string): string {
    const directory = join(this.root, 'reading-preferences', user ? createHash('sha256').update(user).digest('hex') : 'local-preview');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, 'font-size.json');
  }

  readingFontSize(user?: string): ReadingFontSize {
    const path = this.readingPreferencePath(user);
    if (!existsSync(path)) return DEFAULT_READING_FONT_SIZE;
    const value = JSON.parse(readFileSync(path, 'utf8')) as { fontSize?: unknown };
    return isReadingFontSize(value.fontSize) ? value.fontSize : DEFAULT_READING_FONT_SIZE;
  }

  saveReadingFontSize(fontSize: ReadingFontSize, user?: string): void {
    if (!isReadingFontSize(fontSize)) throw new BadRequestException('Invalid reading font size');
    const path = this.readingPreferencePath(user);
    // One API process; synchronous read/adjust/write cannot interleave across calls.
    writeFileSync(`${path}.tmp`, JSON.stringify({ fontSize }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  conversationDirectory(id: string, user?: string): string {
    this.assertId(id);
    const directory = user ? join(this.root, 'users', createHash('sha256').update(user).digest('hex'), 'conversations', id) : join(this.root, 'conversations', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  appendTrace(entry: AgentTraceEntry): void {
    this.assertId(entry.runId);
    const directory = join(this.root, 'traces');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Synchronous writes keep local event order and surface disk failures immediately.
    appendFileSync(join(directory, `${entry.runId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** The run.started trace has already created the directory. */
  async appendObservation(entry: AgentTraceEntry): Promise<void> {
    this.assertId(entry.runId);
    await appendFile(join(this.root, 'traces', `${entry.runId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  localManuscripts() {
    const root = join(this.root, 'conversations');
    if (!existsSync(root)) return [];
    return readdirSync(root).filter(id => UUID.test(id)).flatMap(conversationId => {
      const path = join(root, conversationId, 'panel.json');
      if (!existsSync(path)) return [];
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return (value.documents ?? []).map((document: import('@bio/contracts').PanelDocument) => ({ conversationId, document }));
    });
  }

  readTrace(runId: string): AgentTraceEntry[] {
    this.assertId(runId);
    const path = join(this.root, 'traces', `${runId}.jsonl`);
    if (!existsSync(path)) throw new NotFoundException('Run not found');
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as AgentTraceEntry).sort((a, b) => a.sequence - b.sequence);
  }
}
