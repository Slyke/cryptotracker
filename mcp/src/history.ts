import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { McpRuntimeConfig } from './config.js';
import type { McpLogger } from './logger.js';

export interface HistoryEntry {
  timestamp: string;
  requestId: string;
  identityName: string;
  role: 'read' | 'readwrite';
  toolName: string;
  action: string;
  applied: boolean;
  result: string;
  sourceIp: string | null;
  arguments: unknown;
}

interface HistorySearch {
  limit?: number;
  identityName?: string | undefined;
  toolName?: string | undefined;
  result?: string | undefined;
}

export class HistoryStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: McpRuntimeConfig['history'],
    private readonly logger: McpLogger
  ) {
    this.filePath = resolve(config.path);
  }

  private async readEntries(): Promise<HistoryEntry[]> {
    if (!this.config.enabled) return [];
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed as HistoryEntry[] : [];
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT'
      ) return [];
      this.logger.error({
        event: 'MCP_HISTORY_READ_FAILED',
        message: 'Unable to read the MCP history store.',
        correlationId: null,
        context: { path: this.filePath },
        error
      });
      return [];
    }
  }

  async append(entry: HistoryEntry) {
    if (!this.config.enabled) return;
    this.writeQueue = this.writeQueue.then(async () => {
      const entries = await this.readEntries();
      entries.push(entry);
      const bounded = entries.slice(-this.config.maxEntries);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(bounded, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await rename(temporaryPath, this.filePath);
    }).catch((error) => {
      this.logger.error({
        event: 'MCP_HISTORY_WRITE_FAILED',
        message: 'Unable to append to the MCP history store.',
        correlationId: entry.requestId,
        context: { path: this.filePath },
        error
      });
    });
    await this.writeQueue;
  }

  async search({
    limit = 50,
    identityName,
    toolName,
    result
  }: HistorySearch = {}) {
    await this.writeQueue;
    return (await this.readEntries())
      .filter((entry) => !identityName || entry.identityName === identityName)
      .filter((entry) => !toolName || entry.toolName === toolName)
      .filter((entry) => !result || entry.result === result)
      .slice(-limit)
      .reverse();
  }
}
