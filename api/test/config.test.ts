import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { configurationHelpers, loadRuntime } from '../src/config/load.js';

const requiredEnvironment = {
  CRYPTOTRACKER_SESSION_SECRET: 'environment-session-secret-with-32-characters',
  CRYPTOTRACKER_AUTH_LOCAL_PASSWORD: 'environment-password'
};

describe('configuration', () => {
  it('provides the required Canadian defaults and explicit provider defaults', () => {
    const config = configSchema.parse({});
    expect(config.ui.locale).toBe('en-CA');
    expect(config.ui.timezone).toBe('America/Vancouver');
    expect(config.ui.defaultPrimaryCurrency).toBe('CAD');
    expect(config.ui.defaultWatchedAssets).toEqual(['bitcoin']);
    expect(config.providers.market.coinbase.baseUrl).toBe('https://api.exchange.coinbase.com');
    expect(config.providers.market.coinGecko.rate.minimumSpacingMs).toBe(6_000);
    expect(config.providers.market.coinGecko.rate.burst).toBe(1);
    expect(config.providers.chains.ethereum.baseUrl).toBe('https://api.etherscan.io');
    expect(config.api.port).toBe(8_192);
    expect(config.api.https.port).toBe(8_194);
    expect(() => configSchema.parse({
      api: {
        port: 8_192,
        https: {
          enabled: true,
          port: 8_192
        }
      }
    })).toThrow(/must differ/);
  });

  it('applies documented environment values over JSON5 secrets and config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-config-'));
    const configPath = join(directory, 'config.json5');
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(configPath, "{ ui: { defaultPrimaryCurrency: 'USD' } }", 'utf8');
    await writeFile(secretsPath, "{ sessionSecret: 'file-secret', localPassword: 'file-password' }", 'utf8');
    const runtime = await loadRuntime({
      env: {
        ...requiredEnvironment,
        CRYPTOTRACKER_CONFIG_PATH: configPath,
        CRYPTOTRACKER_SECRETS_PATH: secretsPath,
        CRYPTOTRACKER_DEFAULT_PRIMARY_CURRENCY: 'cad'
      }
    });
    expect(runtime.config.ui.defaultPrimaryCurrency).toBe('CAD');
    expect(runtime.secrets.localPassword).toBe('environment-password');
    expect(runtime.secrets.sessionSecret).toBe(requiredEnvironment.CRYPTOTRACKER_SESSION_SECRET);
  });

  it('loads HTTPS and a named API key from direct deployment overrides', async () => {
    const runtime = await loadRuntime({
      env: {
        ...requiredEnvironment,
        CRYPTOTRACKER_API_KEY_ENABLED: 'true',
        CRYPTOTRACKER_API_KEY: 'environment-api-key-with-32-characters',
        CRYPTOTRACKER_API_KEY_NAME: 'automation-reader',
        CRYPTOTRACKER_HTTPS_ENABLED: 'true',
        CRYPTOTRACKER_HTTPS_PORT: '9443',
        CRYPTOTRACKER_HTTPS_CERT_PATH: '/mounted/server.crt',
        CRYPTOTRACKER_HTTPS_KEY_PATH: '/mounted/server.key',
        CRYPTOTRACKER_HTTPS_GENERATE_SELF_SIGNED: 'false'
      }
    });
    expect(runtime.config.auth.apiKey).toEqual({
      enabled: true,
      headerName: 'X-API-Key'
    });
    expect(runtime.config.api.https).toEqual({
      enabled: true,
      port: 9_443,
      certPath: '/mounted/server.crt',
      keyPath: '/mounted/server.key',
      generateSelfSigned: false
    });
    expect(runtime.secrets.apiKeys).toEqual([{
      name: 'automation-reader',
      key: 'environment-api-key-with-32-characters',
      role: 'read'
    }]);
  });

  it('loads an API key from a file relative to the secrets file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-key-file-'));
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(join(directory, 'mcp-reader.key'), 'file-backed-api-key-with-32-characters\n', 'utf8');
    await writeFile(
      secretsPath,
      `{
        sessionSecret: 'file-session-secret-with-at-least-32-characters',
        localPassword: 'file-password',
        apiKeys: [{
          name: 'file-reader',
          keyFile: './mcp-reader.key',
          role: 'read',
        }],
      }`,
      'utf8'
    );
    const runtime = await loadRuntime({
      env: {
        CRYPTOTRACKER_SECRETS_PATH: secretsPath
      }
    });
    expect(runtime.secrets.apiKeys).toEqual([{
      name: 'file-reader',
      key: 'file-backed-api-key-with-32-characters',
      role: 'read'
    }]);
  });

  it('adds a direct sidecar API key without removing file-configured keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-sidecar-key-'));
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(secretsPath, `{
      sessionSecret: 'file-session-secret-with-at-least-32-characters',
      localPassword: 'file-password',
      apiKeys: [{
        name: 'existing-reader',
        key: 'existing-reader-key-with-at-least-16-characters',
        role: 'read',
      }],
    }`, 'utf8');
    const runtime = await loadRuntime({
      env: {
        CRYPTOTRACKER_SECRETS_PATH: secretsPath,
        CRYPTOTRACKER_API_KEY: 'sidecar-upstream-key-with-at-least-16-characters',
        CRYPTOTRACKER_API_KEY_NAME: 'cryptotracker-mcp',
        CRYPTOTRACKER_API_KEY_ROLE: 'readwrite'
      }
    });
    expect(runtime.secrets.apiKeys.map((entry) => entry.name)).toEqual([
      'existing-reader',
      'cryptotracker-mcp'
    ]);
  });

  it('resolves generic environment references in JSON5 values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-config-'));
    const configPath = join(directory, 'config.json5');
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(
      configPath,
      "{ appName: '${TEST_APP_NAME}', ui: { defaultWatchedAssets: ['${TEST_ASSET}'] } }",
      'utf8'
    );
    await writeFile(
      secretsPath,
      "{ providers: { coinGeckoApiKey: '${TEST_API_SECRET}' } }",
      'utf8'
    );

    const runtime = await loadRuntime({
      env: {
        ...requiredEnvironment,
        CRYPTOTRACKER_CONFIG_PATH: configPath,
        CRYPTOTRACKER_SECRETS_PATH: secretsPath,
        TEST_APP_NAME: 'Environment Tracker',
        TEST_ASSET: 'ethereum',
        TEST_API_SECRET: 'environment-api-secret'
      }
    });

    expect(runtime.config.appName).toBe('Environment Tracker');
    expect(runtime.config.ui.defaultWatchedAssets).toEqual(['ethereum']);
    expect(runtime.secrets.providers.coinGeckoApiKey).toBe('environment-api-secret');
  });

  it('resolves an unset environment reference to null and a set empty value to an empty string', async () => {
    expect(configurationHelpers.resolveEnvironmentReferences({
      value: {
        unset: '${TEST_UNSET}',
        empty: '${TEST_EMPTY}',
        unchanged: 'prefix-${TEST_EMPTY}'
      },
      env: {
        TEST_EMPTY: ''
      }
    })).toEqual({
      unset: null,
      empty: '',
      unchanged: 'prefix-${TEST_EMPTY}'
    });

    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-config-'));
    const configPath = join(directory, 'config.json5');
    const secretsPath = join(directory, 'secrets.json5');
    await writeFile(configPath, '{}', 'utf8');
    await writeFile(
      secretsPath,
      "{ providers: { coinGeckoApiKey: '${TEST_EMPTY}' }, kraken: { apiKey: '${TEST_UNSET}', apiSecret: '${TEST_UNSET}' } }",
      'utf8'
    );

    const runtime = await loadRuntime({
      env: {
        ...requiredEnvironment,
        CRYPTOTRACKER_CONFIG_PATH: configPath,
        CRYPTOTRACKER_SECRETS_PATH: secretsPath,
        TEST_EMPTY: ''
      }
    });

    expect(runtime.secrets.providers.coinGeckoApiKey).toBe('');
    expect(runtime.secrets.kraken.apiKey).toBeNull();
    expect(runtime.secrets.kraken.apiSecret).toBeNull();
  });

  it('rejects ambiguous booleans and incomplete integrations', async () => {
    expect(() => configurationHelpers.parseBoolean({
      key: 'TEST',
      value: 'yes'
    })).toThrow(/must be true/);
    await expect(loadRuntime({
      env: {
        ...requiredEnvironment,
        CRYPTOTRACKER_KRAKEN_API_KEY: 'only-one-half'
      }
    })).rejects.toMatchObject({
      errorKey: 'CONFIG_KRAKEN_CREDENTIALS_INCOMPLETE'
    });
  });

  it('requires trusted-header allow rules with OR-capable inputs', () => {
    const result = configSchema.safeParse({
      auth: {
        local: { enabled: false },
        header: {
          enabled: true,
          trustedCidrs: ['127.0.0.1/32'],
          allowedUsers: [],
          allowedGroups: []
        }
      }
    });
    expect(result.success).toBe(false);
  });
});
