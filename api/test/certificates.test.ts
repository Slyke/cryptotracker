import { createPrivateKey, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificateInternals } from '../src/http/certificates.js';

describe('HTTPS certificates', () => {
  it('generates a self-signed localhost certificate and a non-exported private key', () => {
    const generated = certificateInternals.generateSelfSignedCertificate();
    const certificate = new X509Certificate(generated.cert);
    expect(certificate.subject).toContain('CN=cryptotracker');
    expect(certificate.subjectAltName).toContain('DNS:localhost');
    expect(certificate.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(certificate.checkPrivateKey(
      createPrivateKey(generated.key)
    )).toBe(true);
  });
});
