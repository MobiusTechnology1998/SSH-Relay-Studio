import { describe, expect, it } from 'vitest';
import {
  buildBrowserLaunchArgs,
  buildSshTunnelArgs,
  buildTerminalProxySnippets,
  computeNodeConfigHash,
  computeReconnectDelayMs,
  decodeOpenSshOctalEscapes,
  diagnoseSshError,
  formatKnownHostsTarget,
  isHardSshAuthFailure,
  isNonFatalChannelOpenError,
  isPort22FirewallRule,
} from '../src/shared/commandBuilders';
import { parseScQfailureOutput } from '../src/main/serverB/opensshService';
import {
  expandWindowsEnvVars,
  resolveDefaultBrowserProfileDir,
} from '../src/main/clientA/browserLauncher';
import type { BrowserPrefs, NodeProfile } from '../src/shared/types';

const BASE_NODE: NodeProfile = {
  id: 'n1',
  name: 'SG Relay',
  host: '203.0.113.10',
  sshPort: 53622,
  username: 'Administrator',
  mode: 'socks5',
  localPort: 1080,
  remoteProxyPort: 7890,
  privateKeyPath: '',
};

const BASE_BROWSER: BrowserPrefs = {
  selectedBrowser: 'edge',
  customBrowserPath: '',
  userDataDir: '',
  useHostResolverRules: false,
  startUrl: 'https://ipinfo.io',
};

describe('commandBuilders', () => {
  it('builds optimized SOCKS5 dynamic tunnel args with weak-network tuning by default', () => {
    const args = buildSshTunnelArgs(BASE_NODE, 'C:\\Users\\A\\.ssh\\id_ed25519');
    expect(args).toContain('-p');
    expect(args).toContain('53622');
    expect(args).toContain('-D');
    expect(args).toContain('127.0.0.1:1080');
    expect(args).not.toContain('-C');
    expect(args).toContain('ServerAliveInterval=15');
    expect(args).toContain('ServerAliveCountMax=3');
    expect(args).toContain('TCPKeepAlive=yes');
    expect(args).toContain('IPQoS=none');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('PreferredAuthentications=publickey');
    expect(args).toContain('RekeyLimit=1G 1h');
    expect(args).toContain(
      'Ciphers=aes128-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-gcm@openssh.com'
    );
    expect(args).toContain('AddressFamily=inet');
    expect(args).toContain('IdentitiesOnly=yes');
    expect(args[args.length - 1]).toBe('Administrator@203.0.113.10');
  });

  it('supports opting out of fast cipher / IPv4 and opting into -C compression', () => {
    const args = buildSshTunnelArgs({
      ...BASE_NODE,
      compression: true,
      serverAliveInterval: 20,
      serverAliveCountMax: 5,
      preferFastCipher: false,
      forceIpv4: false,
    });
    expect(args).toContain('-C');
    expect(args).toContain('ServerAliveInterval=20');
    expect(args).toContain('ServerAliveCountMax=5');
    expect(args.some((a) => a.startsWith('Ciphers='))).toBe(false);
    expect(args).not.toContain('AddressFamily=inet');
  });

  it('builds local port forward (-L) args when Device B uses upstream Clash/v2rayN', () => {
    const args = buildSshTunnelArgs({
      ...BASE_NODE,
      mode: 'localForward',
      localPort: 7890,
      remoteProxyPort: 7890,
    });
    expect(args).toContain('-L');
    expect(args).toContain('127.0.0.1:7890:127.0.0.1:7890');
    expect(args).not.toContain('-D');
  });

  it('builds isolated browser args with --disable-quic in socks5 mode and without --host-resolver-rules by default', () => {
    const args = buildBrowserLaunchArgs(BASE_NODE, BASE_BROWSER, 'C:\\Users\\A\\AppData\\Local\\Edge');
    expect(args).toContain('--proxy-server=socks5://127.0.0.1:1080');
    expect(args).toContain('--user-data-dir=C:\\Users\\A\\AppData\\Local\\Edge');
    expect(args).toContain('--disable-quic');
    expect(args.some((a) => a.includes('--host-resolver-rules'))).toBe(false);
  });

  it('omits --disable-quic when explicitly disabled, in localForward mode, or in hysteria2 QUIC mode', () => {
    const optOut = buildBrowserLaunchArgs(
      BASE_NODE,
      { ...BASE_BROWSER, disableQuic: false },
      'C:\\Edge'
    );
    expect(optOut).not.toContain('--disable-quic');

    const localFwd = buildBrowserLaunchArgs(
      { mode: 'localForward', localPort: 7890 },
      BASE_BROWSER,
      'C:\\Edge'
    );
    expect(localFwd).not.toContain('--disable-quic');

    const quicEngine = buildBrowserLaunchArgs(
      { mode: 'socks5', localPort: 1080, engine: 'hysteria2' },
      BASE_BROWSER,
      'C:\\Edge'
    );
    expect(quicEngine).not.toContain('--disable-quic');
  });

  it('includes --host-resolver-rules only when explicitly opted in', () => {
    const args = buildBrowserLaunchArgs(
      BASE_NODE,
      { ...BASE_BROWSER, useHostResolverRules: true },
      'C:\\Edge'
    );
    expect(args.some((a) => a.startsWith('--host-resolver-rules='))).toBe(true);
  });

  it('computes exponential backoff reconnect delays with cap and jitter bounds', () => {
    expect(computeReconnectDelayMs(1, 0)).toBe(1000);
    expect(computeReconnectDelayMs(2, 0)).toBe(2000);
    expect(computeReconnectDelayMs(3, 0)).toBe(4000);
    expect(computeReconnectDelayMs(4, 0)).toBe(8000);
    expect(computeReconnectDelayMs(5, 0)).toBe(15000);
    expect(computeReconnectDelayMs(12, 0)).toBe(15000);

    for (let i = 0; i < 20; i++) {
      const jittered = computeReconnectDelayMs(3, 0.15);
      expect(jittered).toBeGreaterThanOrEqual(3400);
      expect(jittered).toBeLessThanOrEqual(4600);
    }
  });

  it('distinguishes hard SSH auth/config failures from transient network drops', () => {
    expect(isHardSshAuthFailure('Host key verification failed.')).toBe(true);
    expect(isHardSshAuthFailure('Permission denied (publickey).')).toBe(true);
    expect(isHardSshAuthFailure('Unable to negotiate: no matching cipher found.')).toBe(true);
    expect(isHardSshAuthFailure('Identity file C:\\Users\\A\\.ssh\\id_ed25519: No such file or directory')).toBe(true);
    expect(isHardSshAuthFailure('client_loop: send disconnect: Connection reset')).toBe(false);
    expect(isHardSshAuthFailure('Connection timed out')).toBe(false);
  });

  it('resolves default browser profile dirs without -GPT suffix and expands Windows env vars', () => {
    expect(resolveDefaultBrowserProfileDir('edge').endsWith('Edge')).toBe(true);
    expect(resolveDefaultBrowserProfileDir('chrome').endsWith('Chrome')).toBe(true);
    expect(resolveDefaultBrowserProfileDir('custom').endsWith('Browser')).toBe(true);
    expect(resolveDefaultBrowserProfileDir('edge')).not.toContain('GPT');

    expect(
      expandWindowsEnvVars('%LOCALAPPDATA%\\Chrome', {
        LOCALAPPDATA: 'C:\\Users\\LuCan\\AppData\\Local',
      })
    ).toBe('C:\\Users\\LuCan\\AppData\\Local\\Chrome');

    expect(
      expandWindowsEnvVars('%localappdata%\\Edge', {
        LOCALAPPDATA: 'C:\\Users\\LuCan\\AppData\\Local',
      })
    ).toBe('C:\\Users\\LuCan\\AppData\\Local\\Edge');
  });

  it('decodes OpenSSH octal-escaped GBK errors and distinguishes non-fatal channel errors', () => {
    const raw =
      'channel 13: open failed: connect failed: \\262\\273\\326\\252\\265\\300\\325\\342\\321\\371\\265\\304\\326\\367\\273\\372\\241\\243';
    const decoded = decodeOpenSshOctalEscapes(raw);
    expect(decoded).toBe('channel 13: open failed: connect failed: 不知道这样的主机。');
    expect(isNonFatalChannelOpenError(decoded)).toBe(true);
    expect(isNonFatalChannelOpenError('client_loop: send disconnect: Connection reset')).toBe(false);
  });

  it('generates socks5h snippets for socks5 mode and http snippets for localForward mode', () => {
    const s1 = buildTerminalProxySnippets(BASE_NODE);
    expect(s1.powershell).toContain('socks5h://127.0.0.1:1080');
    expect(s1.curlTest).toContain('--socks5-hostname 127.0.0.1:1080');

    const s2 = buildTerminalProxySnippets({ mode: 'localForward', localPort: 7890 });
    expect(s2.powershell).toContain('http://127.0.0.1:7890');
    expect(s2.curlTest).toContain('--proxy http://127.0.0.1:7890');
  });

  it('diagnoses common SSH errors into actionable hints', () => {
    expect(diagnoseSshError('Host key verification failed.')).toContain('指纹');
    expect(diagnoseSshError('Permission denied (publickey).')).toContain('administrators_authorized_keys');
    expect(diagnoseSshError('Connection refused')).toContain('sshd');
    expect(diagnoseSshError('client_loop: send disconnect: Connection reset')).toContain('Connection reset');
    expect(diagnoseSshError('no matching cipher found')).toContain('高速加密套件');
  });

  it('formats known_hosts target properly for port 22 and custom ports', () => {
    expect(formatKnownHostsTarget('1.2.3.4', 22)).toBe('1.2.3.4');
    expect(formatKnownHostsTarget('1.2.3.4', 53622)).toBe('[1.2.3.4]:53622');
  });

  it('parses sc.exe qfailure output on both English and Chinese Windows', () => {
    expect(parseScQfailureOutput('FAILURE_ACTIONS: RESTART -- Delay = 5000 milliseconds.')).toBe(true);
    expect(parseScQfailureOutput('故障操作: 重新启动 -- 延迟 = 5000 毫秒。')).toBe(true);
    expect(parseScQfailureOutput('FAILURE_ACTIONS: NONE')).toBe(false);
  });

  it('accurately detects enabled port 22 firewall rules with or without protocol prefixes', () => {
    expect(
      isPort22FirewallRule({
        name: 'OpenSSH-Server-In-TCP',
        displayName: 'OpenSSH Server (sshd)',
        enabled: true,
        localPort: 'TCP 22',
      })
    ).toBe(true);
    expect(
      isPort22FirewallRule({
        name: 'Custom-22',
        displayName: 'Custom',
        enabled: true,
        localPort: 'TCP 22,2222',
      })
    ).toBe(true);
    expect(
      isPort22FirewallRule({
        name: 'SSH-Port-53622',
        displayName: 'OpenSSH Server (TCP 53622)',
        enabled: true,
        localPort: 'TCP 53622',
      })
    ).toBe(false);
    expect(
      isPort22FirewallRule({
        name: 'OpenSSH-Server-In-TCP',
        displayName: 'OpenSSH Server (sshd)',
        enabled: false,
        localPort: 'TCP 22',
      })
    ).toBe(false);
  });

  it('detects node config drift via deterministic config hash', () => {
    const h1 = computeNodeConfigHash(BASE_NODE);
    const h2 = computeNodeConfigHash({ ...BASE_NODE, notes: 'changed note only' });
    const h3 = computeNodeConfigHash({ ...BASE_NODE, poolSize: 5 });
    const h4 = computeNodeConfigHash({ ...BASE_NODE, engine: 'hysteria2' });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).not.toBe(h4);
  });
});
