import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  buildHysteriaClientYaml,
  buildHysteriaServerYaml,
  diagnoseHysteriaError,
  parseOpenSshVersion,
} from '../src/shared/hysteriaConfig';
import { generateSelfSignedTlsCert } from '../src/main/platform/selfSignedCert';
import type { NodeProfile } from '../src/shared/types';

const QUIC_NODE: NodeProfile = {
  id: 'q1',
  name: 'Tokyo QUIC',
  host: '203.0.113.20',
  sshPort: 53622,
  username: 'Administrator',
  mode: 'socks5',
  localPort: 1080,
  remoteProxyPort: 7890,
  privateKeyPath: '',
  engine: 'hysteria2',
  quicUdpPort: 53623,
  quicAuthToken: 'secret-token-123',
  quicCertPinSha256: 'AA:BB:CC:DD:EE:FF',
  quicSni: 'www.bing.com',
  quicObfsPassword: 'obfs-pass-456',
  quicUpMbps: 50,
  quicDownMbps: 200,
};

describe('hysteriaConfig & selfSignedCert', () => {
  it('generates a cryptographically valid X.509 v3 ECDSA P-256 self-signed TLS cert with SHA-256 pin', () => {
    const generated = generateSelfSignedTlsCert('www.bing.com');
    expect(generated.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(generated.keyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(generated.pinSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const x509 = new crypto.X509Certificate(generated.certPem);
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.subject).toContain('CN=www.bing.com');
    expect(x509.subjectAltName).toContain('DNS:www.bing.com');
    expect(x509.fingerprint256).toBe(generated.pinSha256);

    // Ensure private key matches certificate public key
    const privKey = crypto.createPrivateKey(generated.keyPem);
    expect(x509.checkPrivateKey(privKey)).toBe(true);
  });

  it('builds Hysteria 2 server YAML with forward-slash Windows paths and Salamander obfs', () => {
    const yaml = buildHysteriaServerYaml({
      udpPort: 53623,
      certPath: 'C:\\ProgramData\\SSHRelayStudio\\quic\\server.crt',
      keyPath: 'C:\\ProgramData\\SSHRelayStudio\\quic\\server.key',
      authToken: 'my-secret',
      obfsPassword: 'my-obfs',
      maxUpMbps: 300,
      maxDownMbps: 500,
    });

    expect(yaml).toContain('listen: :53623');
    expect(yaml).toContain('cert: "C:/ProgramData/SSHRelayStudio/quic/server.crt"');
    expect(yaml).toContain('key: "C:/ProgramData/SSHRelayStudio/quic/server.key"');
    expect(yaml).toContain('password: "my-secret"');
    expect(yaml).toContain('type: salamander');
    expect(yaml).toContain('password: "my-obfs"');
    expect(yaml).toContain('up: 300 mbps');
    expect(yaml).toContain('down: 500 mbps');
  });

  it('builds Hysteria 2 client YAML with Brutal bandwidth, large QUIC windows, pinSHA256, and SOCKS5/HTTP listener', () => {
    const socksYaml = buildHysteriaClientYaml(QUIC_NODE);
    expect(socksYaml).toContain('server: "203.0.113.20:53623"');
    expect(socksYaml).toContain('auth: "secret-token-123"');
    expect(socksYaml).toContain('pinSHA256: "AA:BB:CC:DD:EE:FF"');
    expect(socksYaml).toContain('type: salamander');
    expect(socksYaml).toContain('up: 50 mbps');
    expect(socksYaml).toContain('down: 200 mbps');
    expect(socksYaml).toContain('fastOpen: true');
    expect(socksYaml).toContain('socks5:\n  listen: 127.0.0.1:1080');

    const httpYaml = buildHysteriaClientYaml({
      ...QUIC_NODE,
      mode: 'localForward',
      localPort: 7890,
      quicObfsPassword: '',
    });
    expect(httpYaml).not.toContain('salamander');
    expect(httpYaml).toContain('http:\n  listen: 127.0.0.1:7890');
  });

  it('parses Win32-OpenSSH and portable OpenSSH versions and flags legacy < 9.0 builds', () => {
    const legacy = parseOpenSshVersion('OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2');
    expect(legacy.version).toBe('8.1');
    expect(legacy.major).toBe(8);
    expect(legacy.isLegacy).toBe(true);

    const modern = parseOpenSshVersion('OpenSSH_for_Windows_9.8p1, LibreSSL 3.9.2');
    expect(modern.version).toBe('9.8');
    expect(modern.major).toBe(9);
    expect(modern.isLegacy).toBe(false);

    const linux = parseOpenSshVersion('OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13');
    expect(linux.version).toBe('9.6');
    expect(linux.isLegacy).toBe(false);
  });

  it('diagnoses common Hysteria 2 errors into Chinese guidance', () => {
    expect(diagnoseHysteriaError('timeout: no recent network activity')).toContain('UDP');
    expect(diagnoseHysteriaError('authentication failed (403)')).toContain('鉴权');
    expect(diagnoseHysteriaError('tls: certificate pin mismatch')).toContain('pinSHA256');
  });
});
