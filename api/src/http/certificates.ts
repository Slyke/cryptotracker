import { generateKeyPairSync, randomBytes, createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../errors.js';

const derLength = ({ length }: { length: number }) => {
  if (length < 128) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const der = ({ tag, value }: { tag: number; value: Buffer }) => Buffer.concat([
  Buffer.from([tag]),
  derLength({ length: value.length }),
  value
]);
const sequence = (...items: Buffer[]) => der({ tag: 0x30, value: Buffer.concat(items) });
const set = (...items: Buffer[]) => der({ tag: 0x31, value: Buffer.concat(items) });
const explicit = ({ tag, value }: { tag: number; value: Buffer }) => der({ tag: 0xa0 + tag, value });
const utf8String = ({ value }: { value: string }) => der({ tag: 0x0c, value: Buffer.from(value, 'utf8') });
const ascii = ({ tag, value }: { tag: number; value: string }) => der({ tag, value: Buffer.from(value, 'ascii') });
const nullValue = () => der({ tag: 0x05, value: Buffer.alloc(0) });
const octetString = ({ value }: { value: Buffer }) => der({ tag: 0x04, value });
const bitString = ({ value, unusedBits = 0 }: { value: Buffer; unusedBits?: number }) => (
  der({ tag: 0x03, value: Buffer.concat([Buffer.from([unusedBits]), value]) })
);
const boolean = ({ value }: { value: boolean }) => der({ tag: 0x01, value: Buffer.from([value ? 0xff : 0]) });

const integer = ({ value }: { value: bigint | Buffer }) => {
  let bytes: Buffer;
  if (typeof value === 'bigint') {
    const output: number[] = [];
    let remaining = value;
    if (remaining === 0n) output.push(0);
    while (remaining > 0n) {
      output.unshift(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    bytes = Buffer.from(output);
  } else {
    bytes = value;
  }
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der({ tag: 0x02, value: bytes });
};

const oid = ({ value }: { value: string }) => {
  const parts = value.split('.').map(Number);
  const encoded = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let remaining = part >> 7;
    while (remaining > 0) {
      stack.unshift((remaining & 0x7f) | 0x80);
      remaining >>= 7;
    }
    encoded.push(...stack);
  }
  return der({ tag: 0x06, value: Buffer.from(encoded) });
};

const utcTime = ({ date }: { date: Date }) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  const rendered = `${String(date.getUTCFullYear()).slice(-2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der({ tag: 0x17, value: Buffer.from(rendered, 'ascii') });
};

const algorithmIdentifier = () => sequence(
  oid({ value: '1.2.840.113549.1.1.11' }),
  nullValue()
);
const commonName = ({ value }: { value: string }) => sequence(set(sequence(
  oid({ value: '2.5.4.3' }),
  utf8String({ value })
)));
const extension = ({
  oidValue,
  critical = false,
  value
}: {
  oidValue: string;
  critical?: boolean;
  value: Buffer;
}) => sequence(
  oid({ value: oidValue }),
  ...(critical ? [boolean({ value: true })] : []),
  octetString({ value })
);

const extensions = () => explicit({
  tag: 3,
  value: sequence(
    extension({
      oidValue: '2.5.29.19',
      critical: true,
      value: sequence(boolean({ value: false }))
    }),
    extension({
      oidValue: '2.5.29.15',
      critical: true,
      value: bitString({ value: Buffer.from([0xa0]), unusedBits: 5 })
    }),
    extension({
      oidValue: '2.5.29.37',
      value: sequence(oid({ value: '1.3.6.1.5.5.7.3.1' }))
    }),
    extension({
      oidValue: '2.5.29.17',
      value: sequence(
        ascii({ tag: 0x82, value: 'localhost' }),
        ascii({ tag: 0x82, value: 'cryptotracker' }),
        ascii({ tag: 0x82, value: 'cryptotracker-mcp' }),
        der({ tag: 0x87, value: Buffer.from([127, 0, 0, 1]) })
      )
    })
  )
});

const toPem = ({ label, value }: { label: string; value: Buffer }) => {
  const body = value.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};

const generateSelfSignedCertificate = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2_048
  });
  const now = Date.now();
  const subject = commonName({ value: 'cryptotracker' });
  const tbs = sequence(
    explicit({ tag: 0, value: integer({ value: 2n }) }),
    integer({ value: randomBytes(16) }),
    algorithmIdentifier(),
    subject,
    sequence(
      utcTime({ date: new Date(now - 60 * 60_000) }),
      utcTime({ date: new Date(now + 10 * 365 * 24 * 60 * 60_000) })
    ),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions()
  );
  const signer = createSign('RSA-SHA256');
  signer.update(tbs);
  signer.end();
  const certificate = sequence(
    tbs,
    algorithmIdentifier(),
    bitString({ value: signer.sign(privateKey) })
  );
  return {
    cert: toPem({ label: 'CERTIFICATE', value: certificate }),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
};

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
    const generated = generateSelfSignedCertificate();
    writeFileSync(certPath, generated.cert, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(keyPath, generated.key, { encoding: 'utf8', mode: 0o600 });
  }
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new AppError({
      errorKey: 'CONFIG_VALIDATION_FAILED',
      reason: 'HTTPS is enabled but its certificate or private key file is missing.',
      status: 500,
      context: {
        certPath,
        keyPath
      }
    });
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath)
  };
};

export const certificateInternals = {
  generateSelfSignedCertificate
};
