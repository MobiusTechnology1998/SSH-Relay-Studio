import { describe, expect, it } from 'vitest';
import { decodePairingToken, encodePairingToken } from '../src/shared/pairingCodec';

describe('pairingCodec', () => {
  it('round-trips a full Device B pairing payload with hostPublicKey', () => {
    const token = encodePairingToken({
      version: 1,
      name: '新加坡中转服务器',
      host: '203.0.113.42',
      sshPort: 53622,
      username: 'Administrator',
      hostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostPubKeyExample1234567890',
      createdAt: 1700000000000,
    });

    expect(token.startsWith('SSHR1:')).toBe(true);
    const decoded = decodePairingToken(token);
    expect(decoded.name).toBe('新加坡中转服务器');
    expect(decoded.host).toBe('203.0.113.42');
    expect(decoded.sshPort).toBe(53622);
    expect(decoded.username).toBe('Administrator');
    expect(decoded.hostPublicKey).toContain('ssh-ed25519');
  });

  it('throws readable error for invalid prefix or corrupted token', () => {
    expect(() => decodePairingToken('INVALID:abc')).toThrow(/SSHR1:/);
    expect(() => decodePairingToken('SSHR1:!!!corrupted')).toThrow();
  });
});
