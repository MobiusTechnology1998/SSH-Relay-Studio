import { describe, expect, it } from 'vitest';
import { parseSshdConfig, updateSshdConfig } from '../src/shared/sshConfigParser';

const DEFAULT_WIN_SSHD_CONFIG = `# This is the sshd server system-wide configuration file.
#Port 22
#AddressFamily any
#ListenAddress 0.0.0.0

#PubkeyAuthentication yes
#PasswordAuthentication yes

Subsystem\tsftp\tsftp-server.exe

Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
`;

describe('sshConfigParser', () => {
  it('parses default commented Windows sshd_config', () => {
    const parsed = parseSshdConfig(DEFAULT_WIN_SSHD_CONFIG);
    expect(parsed.port).toBe(22);
    expect(parsed.pubkeyAuthentication).toBe(true);
    expect(parsed.passwordAuthentication).toBe(true);
    expect(parsed.hasMatchAdminBlock).toBe(true);
  });

  it('uncomments and updates Port, PubkeyAuthentication, PasswordAuthentication while preserving Match Group administrators', () => {
    const updated = updateSshdConfig(DEFAULT_WIN_SSHD_CONFIG, {
      port: 53622,
      pubkeyAuthentication: true,
      passwordAuthentication: false,
    });

    expect(updated).toContain('Port 53622');
    expect(updated).toContain('PubkeyAuthentication yes');
    expect(updated).toContain('PasswordAuthentication no');
    expect(updated).toContain('Match Group administrators');
    expect(updated).toContain('AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys');

    // Ensure directives stay BEFORE Match block
    const portIdx = updated.indexOf('Port 53622');
    const matchIdx = updated.indexOf('Match Group administrators');
    expect(portIdx).toBeGreaterThan(-1);
    expect(portIdx).toBeLessThan(matchIdx);

    const reparsed = parseSshdConfig(updated);
    expect(reparsed.port).toBe(53622);
    expect(reparsed.pubkeyAuthentication).toBe(true);
    expect(reparsed.passwordAuthentication).toBe(false);
    expect(reparsed.hasMatchAdminBlock).toBe(true);
  });

  it('inserts missing directives strictly BEFORE Match block', () => {
    const minimal = `Subsystem sftp sftp-server.exe\n\nMatch Group administrators\n  AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\n`;
    const updated = updateSshdConfig(minimal, {
      port: 53622,
      pubkeyAuthentication: true,
      passwordAuthentication: false,
    });

    const matchIdx = updated.indexOf('Match Group administrators');
    expect(updated.indexOf('Port 53622')).toBeLessThan(matchIdx);
    expect(updated.indexOf('PasswordAuthentication no')).toBeLessThan(matchIdx);
    expect(parseSshdConfig(updated).port).toBe(53622);
  });

  it('writes keepalive directives before Match block and reparses them accurately', () => {
    const updated = updateSshdConfig(DEFAULT_WIN_SSHD_CONFIG, {
      port: 53622,
      pubkeyAuthentication: true,
      passwordAuthentication: false,
      tcpKeepAlive: true,
      clientAliveInterval: 30,
      clientAliveCountMax: 3,
    });

    const matchIdx = updated.indexOf('Match Group administrators');
    expect(updated.indexOf('TCPKeepAlive yes')).toBeGreaterThan(-1);
    expect(updated.indexOf('TCPKeepAlive yes')).toBeLessThan(matchIdx);
    expect(updated.indexOf('ClientAliveInterval 30')).toBeGreaterThan(-1);
    expect(updated.indexOf('ClientAliveInterval 30')).toBeLessThan(matchIdx);
    expect(updated.indexOf('ClientAliveCountMax 3')).toBeGreaterThan(-1);
    expect(updated.indexOf('ClientAliveCountMax 3')).toBeLessThan(matchIdx);

    const reparsed = parseSshdConfig(updated);
    expect(reparsed.tcpKeepAlive).toBe(true);
    expect(reparsed.clientAliveInterval).toBe(30);
    expect(reparsed.clientAliveCountMax).toBe(3);
  });

  it('writes performance directives (UseDNS, Compression, MaxSessions, MaxStartups) strictly before Match block', () => {
    const updated = updateSshdConfig(DEFAULT_WIN_SSHD_CONFIG, {
      port: 53622,
      pubkeyAuthentication: true,
      passwordAuthentication: false,
      useDns: false,
      compression: 'no',
      maxSessions: 64,
      maxStartups: '30:50:100',
    });

    const matchIdx = updated.indexOf('Match Group administrators');
    expect(updated.indexOf('UseDNS no')).toBeGreaterThan(-1);
    expect(updated.indexOf('UseDNS no')).toBeLessThan(matchIdx);
    expect(updated.indexOf('Compression no')).toBeGreaterThan(-1);
    expect(updated.indexOf('Compression no')).toBeLessThan(matchIdx);
    expect(updated.indexOf('MaxSessions 64')).toBeGreaterThan(-1);
    expect(updated.indexOf('MaxSessions 64')).toBeLessThan(matchIdx);
    expect(updated.indexOf('MaxStartups 30:50:100')).toBeGreaterThan(-1);
    expect(updated.indexOf('MaxStartups 30:50:100')).toBeLessThan(matchIdx);

    const reparsed = parseSshdConfig(updated);
    expect(reparsed.useDns).toBe(false);
    expect(reparsed.compression).toBe('no');
    expect(reparsed.maxSessions).toBe(64);
    expect(reparsed.maxStartups).toBe('30:50:100');
  });

  it('rejects out-of-range ports and invalid MaxStartups syntax', () => {
    expect(() =>
      updateSshdConfig(DEFAULT_WIN_SSHD_CONFIG, {
        port: 70000,
        pubkeyAuthentication: true,
        passwordAuthentication: false,
      })
    ).toThrow();

    expect(() =>
      updateSshdConfig(DEFAULT_WIN_SSHD_CONFIG, {
        port: 53622,
        pubkeyAuthentication: true,
        passwordAuthentication: false,
        maxStartups: 'invalid:format',
      })
    ).toThrow();
  });
});
