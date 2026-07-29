import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authenticateBearer } from '../src/auth.js';
import { loadMcpRuntime } from '../src/config.js';

describe('MCP configuration and client authentication', () => {
  it('defaults to HTTPS and keeps plaintext HTTP opt-in', async () => {
    const runtime = await loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_UPSTREAM_API_KEY: 'upstream-api-key-with-at-least-16-characters',
        CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS: "[{name:'reader',key:'reader-api-key-with-at-least-16-characters'}]"
      }
    });
    expect(runtime.config.enabled).toBe(true);
    expect(runtime.config.http.enabled).toBe(false);
    expect(runtime.config.https).toMatchObject({
      enabled: true,
      port: 8_193
    });
    expect(runtime.config.upstream.baseUrl).toBe('http://127.0.0.1:8192');
  });

  it('can disable MCP without requiring transports or secrets', async () => {
    const runtime = await loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_ENABLED: 'false',
        CRYPTOTRACKER_MCP_HTTP_ENABLED: 'false',
        CRYPTOTRACKER_MCP_HTTPS_ENABLED: 'false'
      }
    });
    expect(runtime.config.enabled).toBe(false);
    expect(runtime.secrets.clientApiKeys).toEqual([]);
    expect(runtime.secrets.upstreamApiKey).toBeNull();
  });

  it('automatically loads conventional config and secrets files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-mcp-conventional-config-'));
    await writeFile(join(directory, 'config.json5'), `{
      enabled: false,
      http: { enabled: false },
      https: { enabled: false },
    }`);
    await writeFile(join(directory, 'secrets.json5'), '{}');
    const previousDirectory = process.cwd();
    try {
      process.chdir(directory);
      const runtime = await loadMcpRuntime({ env: {} });
      expect(runtime.config.enabled).toBe(false);
      expect(runtime.configPath).toBe(join(directory, 'config.json5'));
      expect(runtime.secretsPath).toBe(join(directory, 'secrets.json5'));
    } finally {
      process.chdir(previousDirectory);
    }
  });

  it('supports HTTP and HTTPS independently through environment overrides', async () => {
    const runtime = await loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_HTTP_ENABLED: 'true',
        CRYPTOTRACKER_MCP_HTTP_PORT: '9010',
        CRYPTOTRACKER_MCP_HTTPS_ENABLED: 'false',
        CRYPTOTRACKER_MCP_UPSTREAM_BASE_URL: 'https://cryptotracker:8194',
        CRYPTOTRACKER_MCP_UPSTREAM_API_KEY: 'upstream-api-key-with-at-least-16-characters',
        CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS: "[{name:'reader',key:'reader-api-key-with-at-least-16-characters'}]"
      }
    });
    expect(runtime.config.http).toMatchObject({
      enabled: true,
      port: 9_010
    });
    expect(runtime.config.https.enabled).toBe(false);
    expect(runtime.config.upstream.baseUrl).toBe('https://cryptotracker:8194');
  });

  it('loads separate upstream and client keys from files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-mcp-config-'));
    await writeFile(join(directory, 'upstream.key'), 'upstream-file-key-with-at-least-16-characters\n');
    await writeFile(join(directory, 'reader.key'), 'reader-file-key-with-at-least-16-characters\n');
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(secretsPath, `{
      upstreamApiKeyFile: './upstream.key',
      clientApiKeys: [{
        name: 'reader',
        keyFile: './reader.key',
        role: 'read',
      }],
    }`);
    const runtime = await loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_SECRETS_PATH: secretsPath
      }
    });
    expect(runtime.secrets.upstreamApiKey).toBe('upstream-file-key-with-at-least-16-characters');
    expect(runtime.secrets.clientApiKeys[0]?.key).toBe('reader-file-key-with-at-least-16-characters');
  });

  it('does not let empty Compose key variables mask secrets-file client keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-mcp-compose-secrets-'));
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(secretsPath, `{
      upstreamApiKey: 'upstream-file-key-with-at-least-16-characters',
      clientApiKeys: [{
        name: 'reader',
        key: 'reader-file-key-with-at-least-16-characters',
        role: 'read',
      }],
    }`);
    const runtime = await loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_SECRETS_PATH: secretsPath,
        CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS: '',
        CRYPTOTRACKER_MCP_READWRITE_CLIENT_API_KEYS: ''
      }
    });
    expect(runtime.secrets.clientApiKeys).toEqual([{
      name: 'reader',
      key: 'reader-file-key-with-at-least-16-characters',
      role: 'read'
    }]);
  });

  it('timing-safely authenticates named Bearer API keys and rejects reuse', async () => {
    const runtime = await loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_UPSTREAM_API_KEY: 'upstream-api-key-with-at-least-16-characters',
        CRYPTOTRACKER_MCP_READWRITE_CLIENT_API_KEYS: "[{name:'automation',key:'client-api-key-with-at-least-16-characters'}]"
      }
    });
    expect(authenticateBearer({
      authorization: 'Bearer client-api-key-with-at-least-16-characters',
      secrets: runtime.secrets
    })).toEqual({
      name: 'automation',
      role: 'readwrite'
    });
    expect(authenticateBearer({
      authorization: 'Bearer incorrect-api-key-value',
      secrets: runtime.secrets
    })).toBeNull();

    await expect(loadMcpRuntime({
      env: {
        CRYPTOTRACKER_MCP_UPSTREAM_API_KEY: 'same-api-key-with-at-least-16-characters',
        CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS: "[{name:'reader',key:'same-api-key-with-at-least-16-characters'}]"
      }
    })).rejects.toThrow(/must differ/);
  });
});
