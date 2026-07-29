import type { RateLimitConfig } from './config.js';

type RateCategory = 'read' | 'write' | 'destructive';

interface RateWindow {
  count: number;
  resetAtMs: number;
}

export class McpRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now = () => Date.now()
  ) {}

  check({
    identityName,
    category
  }: {
    identityName: string;
    category: RateCategory;
  }) {
    const key = `${identityName}:${category}`;
    const nowMs = this.now();
    const existing = this.windows.get(key);
    const window = !existing || nowMs >= existing.resetAtMs
      ? {
          count: 0,
          resetAtMs: nowMs + this.config.windowSeconds * 1_000
        }
      : existing;
    window.count += 1;
    this.windows.set(key, window);
    const limit = this.config[category];
    return {
      allowed: window.count <= limit,
      limit,
      remaining: Math.max(0, limit - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMs - nowMs) / 1_000))
    };
  }
}
