import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const loadHttpsCertificates = ({
  certPath,
  keyPath,
  generateSelfSigned
}: {
  certPath: string;
  keyPath: string;
  generateSelfSigned: boolean;
}) => {
  if ((!existsSync(certPath) || !existsSync(keyPath)) && generateSelfSigned) {
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
      encoding: 'utf8'
    });
    if (generated.status !== 0) {
      throw new Error(`Unable to generate the shared self-signed certificate: ${generated.stderr || generated.stdout}`);
    }
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o644);
  }
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error('MCP HTTPS is enabled but its certificate or private key is missing.');
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath)
  };
};
