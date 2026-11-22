import { describe, expect, it } from 'vitest';
import {
  buildBrowserLaunchArgs,
  buildSshTunnelArgs,
  buildTerminalProxySnippets,
  decodeOpenSshOctalEscapes,
  diagnoseSshError,
  formatKnownHostsTarget,
  isNonFatalChannelOpenError,
} from '../src/shared/commandBuilders';
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
  it('builds optimized SOCKS5 dynamic tunnel args without -C by default', () => {
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
    expect(args[args.length - 1]).toBe('Administrator@203.0.113.10');
  });

  it('supports optional SSH compression (-C) and custom keepalive settings', () => {
    const args = buildSshTunnelArgs({
      ...BASE_NODE,
      compression: true,
      serverAliveInterval: 20,
      serverAliveCountMax: 5,
    });
    expect(args).toContain('-C');
    expect(args).toContain('ServerAliveInterval=20');
    expect(args).toContain('ServerAliveCountMax=5');
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

  it('builds isolated browser args without --host-resolver-rules by default', () => {
    const args = buildBrowserLaunchArgs(BASE_NODE, BASE_BROWSER, 'C:\\Users\\A\\AppData\\Local\\Edge');
    expect(args).toContain('--proxy-server=socks5://127.0.0.1:1080');
    expect(args).toContain('--user-data-dir=C:\\Users\\A\\AppData\\Local\\Edge');
    expect(args.some((a) => a.includes('--host-resolver-rules'))).toBe(false);
  });

  it('includes --host-resolver-rules only when explicitly opted in', () => {
    const args = buildBrowserLaunchArgs(
      BASE_NODE,
      { ...BASE_BROWSER, useHostResolverRules: true },
      'C:\\Edge'
    );
    expect(args.some((a) => a.startsWith('--host-resolver-rules='))).toBe(true);
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
  });

  it('formats known_hosts target properly for port 22 and custom ports', () => {
    expect(formatKnownHostsTarget('1.2.3.4', 22)).toBe('1.2.3.4');
    expect(formatKnownHostsTarget('1.2.3.4', 53622)).toBe('[1.2.3.4]:53622');
  });
});
