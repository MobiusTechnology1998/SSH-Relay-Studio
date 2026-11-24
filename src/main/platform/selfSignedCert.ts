import crypto from 'crypto';

/**
 * Zero-dependency pure Node.js X.509 v3 self-signed ECDSA P-256 TLS certificate generator.
 * Works identically on Windows 10/11/Server 2019/2022 and Linux without requiring openssl.exe
 * or touching the Windows Certificate Store.
 */

function derEncodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derWrap(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derWrap(0x31, Buffer.concat(items));
}

function derInteger(buf: Buffer): Buffer {
  let trimmed = buf;
  while (trimmed.length > 1 && trimmed[0] === 0x00 && (trimmed[1] & 0x80) === 0) {
    trimmed = trimmed.subarray(1);
  }
  if (trimmed[0] & 0x80) {
    trimmed = Buffer.concat([Buffer.from([0x00]), trimmed]);
  }
  return derWrap(0x02, trimmed);
}

function derBitString(buf: Buffer): Buffer {
  return derWrap(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derOctetString(buf: Buffer): Buffer {
  return derWrap(0x04, buf);
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map((p) => Number.parseInt(p, 10));
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const enc: number[] = [val & 0x7f];
    val >>>= 7;
    while (val > 0) {
      enc.unshift((val & 0x7f) | 0x80);
      val >>>= 7;
    }
    out.push(...enc);
  }
  return derWrap(0x06, Buffer.from(out));
}

function derUtf8String(str: string): Buffer {
  return derWrap(0x0c, Buffer.from(str, 'utf8'));
}

function derGeneralizedTime(date: Date): Buffer {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const s =
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return derWrap(0x18, Buffer.from(s, 'ascii'));
}

function derName(cn: string): Buffer {
  const cnAtv = derSeq(derOid('2.5.4.3'), derUtf8String(cn));
  return derSeq(derSet(cnAtv));
}

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface GeneratedSelfSignedCert {
  certPem: string;
  keyPem: string;
  /** Colon-separated uppercase SHA-256 fingerprint matching Hysteria 2 `tls.pinSHA256` */
  pinSha256: string;
}

/**
 * Generates an ECDSA P-256 self-signed X.509 v3 server certificate with SAN DNSName = `sni`,
 * valid for `validityDays` (default 10 years), plus its SHA-256 pin.
 */
export function generateSelfSignedTlsCert(
  sni = 'www.bing.com',
  validityDays = 3650
): GeneratedSelfSignedCert {
  const cleanSni = sni.trim() || 'www.bing.com';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // Serial number: 16 positive random bytes
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] &= 0x7f;
  if (serialBytes[0] === 0) serialBytes[0] = 1;

  // ecdsa-with-SHA256: 1.2.840.10045.4.3.2
  const sigAlg = derSeq(derOid('1.2.840.10045.4.3.2'));

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000); // -1 day for clock skew
  const notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

  const issuer = derName(cleanSni);
  const subject = derName(cleanSni);

  // X.509 v3 Extensions:
  // 1. BasicConstraints (2.5.29.19): CA=FALSE
  const extBasicConstraints = derSeq(
    derOid('2.5.29.19'),
    Buffer.from([0x01, 0x01, 0xff]), // critical = TRUE
    derOctetString(derSeq())
  );
  // 2. KeyUsage (2.5.29.15): digitalSignature (bit 0 -> 0x80, unused bits = 7)
  const extKeyUsage = derSeq(
    derOid('2.5.29.15'),
    Buffer.from([0x01, 0x01, 0xff]), // critical = TRUE
    derOctetString(derWrap(0x03, Buffer.from([0x07, 0x80])))
  );
  // 3. ExtKeyUsage (2.5.29.37): id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
  const extExtKeyUsage = derSeq(
    derOid('2.5.29.37'),
    derOctetString(derSeq(derOid('1.3.6.1.5.5.7.3.1')))
  );
  // 4. SubjectAltName (2.5.29.17): dNSName [2] IA5String
  const sanEntry = derWrap(0x82, Buffer.from(cleanSni, 'ascii'));
  const extSan = derSeq(derOid('2.5.29.17'), derOctetString(derSeq(sanEntry)));

  const extensions = derWrap(
    0xa3,
    derSeq(extBasicConstraints, extKeyUsage, extExtKeyUsage, extSan)
  );

  // TBSCertificate
  const versionV3 = derWrap(0xa0, derInteger(Buffer.from([0x02]))); // v3 = 2
  const tbsCert = derSeq(
    versionV3,
    derInteger(serialBytes),
    sigAlg,
    issuer,
    derSeq(derGeneralizedTime(notBefore), derGeneralizedTime(notAfter)),
    subject,
    spkiDer,
    extensions
  );

  const signature = crypto.sign('sha256', tbsCert, privateKey);
  const certDer = derSeq(tbsCert, sigAlg, derBitString(signature));
  const certPem = toPem(certDer, 'CERTIFICATE');

  // Verify with Node.js built-in X509Certificate parser and extract canonical SHA-256 pin
  const x509 = new crypto.X509Certificate(certPem);
  const pinSha256 = x509.fingerprint256;

  return {
    certPem,
    keyPem,
    pinSha256,
  };
}
