import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentTraceEntry } from '@bio/contracts';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

  conversationDirectory(id: string): string {
    this.assertId(id);
    const directory = join(this.root, 'conversations', id);
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

  readTrace(runId: string): AgentTraceEntry[] {
    this.assertId(runId);
    const path = join(this.root, 'traces', `${runId}.jsonl`);
    if (!existsSync(path)) throw new NotFoundException('Run not found');
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as AgentTraceEntry);
  }
}
