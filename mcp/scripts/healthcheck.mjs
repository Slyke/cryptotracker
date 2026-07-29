import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import JSON5 from 'json5';

const configPath = process.env.CRYPTOTRACKER_MCP_CONFIG_PATH?.trim()
  || (existsSync('config.json5') ? 'config.json5' : null);
const fileConfig = configPath && existsSync(configPath)
  ? JSON5.parse(readFileSync(configPath, 'utf8'))
  : {};
const booleanValue = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
};
const enabled = booleanValue(
  process.env.CRYPTOTRACKER_MCP_ENABLED,
  fileConfig.enabled ?? true
);
if (!enabled) process.exit(0);

const httpsEnabled = booleanValue(
  process.env.CRYPTOTRACKER_MCP_HTTPS_ENABLED,
  fileConfig.https?.enabled ?? true
);
const protocol = httpsEnabled ? 'https:' : 'http:';
const port = httpsEnabled
  ? Number(process.env.CRYPTOTRACKER_MCP_HTTPS_PORT ?? fileConfig.https?.port ?? 8193)
  : Number(process.env.CRYPTOTRACKER_MCP_HTTP_PORT ?? fileConfig.http?.port ?? 8195);
const client = httpsEnabled ? https : http;

const request = (path) => new Promise((resolve, reject) => {
  const outgoing = client.request({
    protocol,
    hostname: '127.0.0.1',
    port,
    path,
    method: 'GET',
    rejectUnauthorized: false,
    timeout: 5_000
  }, (response) => {
    response.resume();
    response.once('end', () => (
      response.statusCode && response.statusCode >= 200 && response.statusCode < 300
        ? resolve()
        : reject(new Error(`${path} returned ${response.statusCode}`))
    ));
  });
  outgoing.once('timeout', () => outgoing.destroy(new Error(`${path} timed out`)));
  outgoing.once('error', reject);
  outgoing.end();
});

await request('/healthz');
if (!process.argv.includes('--liveness')) await request('/readyz');
