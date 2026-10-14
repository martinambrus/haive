import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMMON_NAME = [0x55, 0x04, 0x03];
const ECDSA_WITH_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];
const SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const utcTime = (date: Date) =>
  der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));

function pem(label: string, body: Buffer): string {
  const lines = body
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** A throwaway P-256 certificate for one DNS name, which signs itself: a test trusts it as `ca`. */
export function selfSignedCertificate(host: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const name = sequence(der(0x31, sequence(oid(COMMON_NAME), der(0x0c, Buffer.from(host)))));
  const now = Date.now();
  const extensions = der(
    0xa3,
    sequence(
      sequence(
        oid(BASIC_CONSTRAINTS),
        der(0x01, Buffer.from([0xff])),
        der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
      ),
      sequence(oid(SUBJECT_ALT_NAME), der(0x04, sequence(der(0x82, Buffer.from(host))))),
    ),
  );
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, ...randomBytes(7)])),
    algorithm,
    name,
    sequence(utcTime(new Date(now - DAY_MS)), utcTime(new Date(now + 2 * DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', toBeSigned, privateKey);
  const certificate = sequence(toBeSigned, algorithm, der(0x03, Buffer.from([0]), signature));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate),
  };
}
