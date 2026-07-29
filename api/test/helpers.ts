import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, secretsSchema } from '../src/config/schema.js';
import type { LoadedRuntime } from '../src/config/load.js';
import { openDatabase, type AppDatabase } from '../src/db/index.js';
import { Logger } from '../src/logging/logger.js';

export const createTestRuntime = async ({
  databaseKind = 'sqlite',
  config = {},
  secrets = {},
  sqlitePath
}: {
  databaseKind?: 'sqlite' | 'postgres';
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  sqlitePath?: string;
} = {}): Promise<LoadedRuntime> => {
  const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-test-'));
  const parsedConfig = configSchema.parse({
    auth: {
      local: {
        enabled: true
      }
    },
    logging: {
      sinks: {
        console: {
          enabled: false
        }
      }
    },
    ...config
  });
  const parsedSecrets = secretsSchema.parse({
    sessionSecret: 'test-session-secret-with-at-least-32-characters',
    localPassword: 'test-password',
    ...secrets
  });
  return {
    config: parsedConfig,
    secrets: parsedSecrets,
    databaseKind,
    sqlitePath: sqlitePath ?? join(directory, 'cryptotracker.sqlite'),
    configPath: null,
    secretsPath: null
  };
};

export const openMigratedTestDatabase = async ({
  runtime
}: {
  runtime?: LoadedRuntime;
} = {}): Promise<{
  db: AppDatabase;
  runtime: LoadedRuntime;
}> => {
  const resolvedRuntime = runtime ?? await createTestRuntime();
  const db = await openDatabase({ runtime: resolvedRuntime });
  await db.migrate();
  return { db, runtime: resolvedRuntime };
};

export const createTestLogger = ({ runtime }: { runtime: LoadedRuntime }) => (
  new Logger(runtime.config.logging)
);
