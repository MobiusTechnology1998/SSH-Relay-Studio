import { describe, expect, it } from 'vitest';
import {
  buildBrowserLaunchArgs,
  buildSshTunnelArgs,
  buildTerminalProxySnippets,
  diagnoseSshError,
  formatKnownHostsTarget,
} from '../src/shared/commandBuilders';
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
  it('builds standard SOCKS5 dynamic tunnel args matching ssh.md 5.1', () => {
    const args = buildSshTunnelArgs(BASE_NODE, 'C:\\Users\\A\\.ssh\\id_ed25519');
    expect(args).toContain('-p');
    expect(args).toContain('53622');
    expect(args).toContain('-D');
    expect(args).toContain('127.0.0.1:1080');
    expect(args).toContain('ServerAliveInterval=30');
    expect(args).toContain('ServerAliveCountMax=3');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args).toContain('BatchMode=yes');
    expect(args[args.length - 1]).toBe('Administrator@203.0.113.10');
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
    const args = buildBrowserLaunchArgs(BASE_NODE, BASE_BROWSER, 'C:\\Users\\A\\AppData\\Local\\Edge-GPT');
    expect(args).toContain('--proxy-server=socks5://127.0.0.1:1080');
    expect(args).toContain('--user-data-dir=C:\\Users\\A\\AppData\\Local\\Edge-GPT');
    expect(args.some((a) => a.includes('--host-resolver-rules'))).toBe(false);
  });

  it('includes --host-resolver-rules only when explicitly opted in', () => {
    const args = buildBrowserLaunchArgs(
      BASE_NODE,
      { ...BASE_BROWSER, useHostResolverRules: true },
      'C:\\Edge-GPT'
    );
    expect(args.some((a) => a.startsWith('--host-resolver-rules='))).toBe(true);
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
  });

  it('formats known_hosts target properly for port 22 and custom ports', () => {
    expect(formatKnownHostsTarget('1.2.3.4', 22)).toBe('1.2.3.4');
    expect(formatKnownHostsTarget('1.2.3.4', 53622)).toBe('[1.2.3.4]:53622');
  });
});
