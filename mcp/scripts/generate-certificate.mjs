import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const certPath = process.env.CRYPTOTRACKER_CERT_PATH ?? '/app/data/certs/server.crt';
const keyPath = process.env.CRYPTOTRACKER_KEY_PATH ?? '/app/data/certs/server.key';

if (existsSync(certPath) && existsSync(keyPath)) process.exit(0);
mkdirSync(dirname(certPath), { recursive: true });
mkdirSync(dirname(keyPath), { recursive: true });
const generated = spawnSync('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-sha256',
  '-days',
  '3650',
  '-subj',
  '/CN=cryptotracker',
  '-addext',
  'subjectAltName=DNS:localhost,DNS:cryptotracker,DNS:cryptotracker-mcp,IP:127.0.0.1',
  '-keyout',
  keyPath,
  '-out',
  certPath
], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
if (generated.status !== 0) {
  throw new Error(`Unable to generate the shared self-signed certificate: ${generated.stderr || generated.stdout}`);
}
chmodSync(keyPath, 0o600);
chmodSync(certPath, 0o644);
