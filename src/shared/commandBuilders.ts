import type { BrowserPrefs, NodeProfile } from './types';

/**
 * Builds the exact ssh.exe argument array for either:
 * - Standard SOCKS5 dynamic tunnel (`ssh -D 127.0.0.1:<localPort>`)
 * - Local port forward to Device B's local proxy (`ssh -L 127.0.0.1:<localPort>:127.0.0.1:<remoteProxyPort>`)
 */
export function buildSshTunnelArgs(node: NodeProfile, resolvedKeyPath?: string): string[] {
  const args: string[] = ['-p', String(node.sshPort)];

  if (node.mode === 'localForward') {
    args.push('-L', `127.0.0.1:${node.localPort}:127.0.0.1:${node.remoteProxyPort}`);
  } else {
    args.push('-D', `127.0.0.1:${node.localPort}`);
  }

  if (node.compression === true) {
    args.push('-C');
  }

  const aliveInterval =
    typeof node.serverAliveInterval === 'number' &&
    Number.isInteger(node.serverAliveInterval) &&
    node.serverAliveInterval >= 5 &&
    node.serverAliveInterval <= 300
      ? node.serverAliveInterval
      : 15;

  const aliveCountMax =
    typeof node.serverAliveCountMax === 'number' &&
    Number.isInteger(node.serverAliveCountMax) &&
    node.serverAliveCountMax >= 1 &&
    node.serverAliveCountMax <= 20
      ? node.serverAliveCountMax
      : 3;

  args.push(
    '-N',
    '-o',
    `ServerAliveInterval=${aliveInterval}`,
    '-o',
    `ServerAliveCountMax=${aliveCountMax}`,
    '-o',
    'TCPKeepAlive=yes',
    '-o',
    'IPQoS=none',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'RekeyLimit=1G 1h'
  );

  if (node.preferFastCipher !== false) {
    args.push(
      '-o',
      'Ciphers=aes128-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-gcm@openssh.com'
    );
  }

  if (node.forceIpv4 !== false) {
    args.push('-o', 'AddressFamily=inet');
  }

  const keyPath = (resolvedKeyPath || node.privateKeyPath || '').trim();
  if (keyPath) {
    args.push('-o', 'IdentitiesOnly=yes', '-i', keyPath);
  }

  args.push(`${node.username}@${node.host}`);
  return args;
}

/**
 * Formats a human-readable ssh command preview string.
 */
export function formatSshCommandPreview(node: NodeProfile, resolvedKeyPath?: string): string {
  const args = buildSshTunnelArgs(node, resolvedKeyPath).map((arg) =>
    /\s/.test(arg) ? `"${arg}"` : arg
  );
  return `ssh ${args.join(' ')}`;
}

/**
 * Builds Chromium (Edge / Chrome) arguments for isolated full-site proxy browsing.
 * - Avoids `--host-resolver-rules` by default to prevent warning banners.
 * - Adds `--disable-quic` by default in SOCKS5 mode because OpenSSH `-D` only tunnels TCP
 *   and cannot carry HTTP/3 (QUIC/UDP), preventing 200ms~1s fallback delays on Cloudflare/Google/OpenAI.
 */
export function buildBrowserLaunchArgs(
  node: Pick<NodeProfile, 'mode' | 'localPort' | 'engine'>,
  prefs: BrowserPrefs,
  resolvedUserDataDir: string
): string[] {
  const proxyScheme = node.mode === 'localForward' ? 'http' : 'socks5';
  const args: string[] = [
    `--proxy-server=${proxyScheme}://127.0.0.1:${node.localPort}`,
    `--user-data-dir=${resolvedUserDataDir}`,
  ];

  // OpenSSH -D cannot tunnel UDP/QUIC; Hysteria 2 natively supports UDP ASSOCIATE so keep QUIC enabled there
  if (node.mode === 'socks5' && node.engine !== 'hysteria2' && prefs.disableQuic !== false) {
    args.push('--disable-quic');
  }

  if (prefs.useHostResolverRules) {
    args.push('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
  }

  if (prefs.startUrl && prefs.startUrl.trim()) {
    args.push(prefs.startUrl.trim());
  }

  return args;
}

export interface TerminalProxySnippets {
  powershell: string;
  cmd: string;
  bash: string;
  curlTest: string;
}

/**
 * Generates copy-pasteable terminal environment variable snippets for API / CLI use.
 */
export function buildTerminalProxySnippets(
  node: Pick<NodeProfile, 'mode' | 'localPort'>
): TerminalProxySnippets {
  const url =
    node.mode === 'localForward'
      ? `http://127.0.0.1:${node.localPort}`
      : `socks5h://127.0.0.1:${node.localPort}`;

  const curlFlag =
    node.mode === 'localForward'
      ? `--proxy http://127.0.0.1:${node.localPort}`
      : `--socks5-hostname 127.0.0.1:${node.localPort}`;

  return {
    powershell: `$env:HTTP_PROXY="${url}"\n$env:HTTPS_PROXY="${url}"`,
    cmd: `set HTTP_PROXY=${url}\nset HTTPS_PROXY=${url}`,
    bash: `export HTTP_PROXY="${url}"\nexport HTTPS_PROXY="${url}"`,
    curlTest: `curl.exe ${curlFlag} https://api.ipify.org`,
  };
}

/**
 * Computes reconnect backoff delay (ms) tuned for cross-border weak networks:
 * 1st retry: 1s (instant recovery from transient RST/drop)
 * 2nd retry: 2s
 * 3rd retry: 4s
 * 4th retry: 8s
 * 5th+ retry: 15s cap
 */
export function computeReconnectDelayMs(attempt: number, jitterRatio = 0.15): number {
  const schedule = [1000, 2000, 4000, 8000, 15000];
  const idx = Math.max(0, Math.min(schedule.length - 1, Math.floor(attempt) - 1));
  const base = schedule[idx];
  if (jitterRatio <= 0) return base;
  const delta = base * jitterRatio;
  const randomized = base + (Math.random() * 2 - 1) * delta;
  return Math.max(500, Math.round(randomized));
}

/**
 * Returns true for non-recoverable SSH auth/config errors where blind auto-reconnecting
 * would only spam failed connections until the user fixes credentials or host keys.
 */
export function isHardSshAuthFailure(reason: string): boolean {
  const lower = reason.toLowerCase();
  if (
    lower.includes('host key verification failed') ||
    lower.includes('remote host identification has changed') ||
    lower.includes('permission denied (publickey') ||
    lower.includes('unprotected private key file') ||
    lower.includes('bad permissions') ||
    lower.includes('no matching cipher found')
  ) {
    return true;
  }
  if (
    lower.includes('no such file or directory') &&
    (lower.includes('identity') || lower.includes('.ssh') || lower.includes('id_'))
  ) {
    return true;
  }
  return false;
}

/**
 * Translates common OpenSSH stderr outputs into actionable Chinese diagnostic hints
 * grounded directly in ssh.md troubleshooting rules.
 */
export function diagnoseSshError(stderr: string): string | null {
  const lower = stderr.toLowerCase();

  if (
    lower.includes('host key verification failed') ||
    lower.includes('offending') ||
    lower.includes('remote host identification has changed')
  ) {
    return '主机指纹尚未信任或已变更（换端口后需重新信任）。请前往「密钥与配对」点击「扫描并信任主机指纹」。';
  }

  if (lower.includes('permission denied (publickey')) {
    return '公钥认证被拒绝：请确认已将设备 A 公钥追加到设备 B 的 C:\\ProgramData\\ssh\\administrators_authorized_keys，并在 B 端执行了 icacls 权限收紧。';
  }

  if (lower.includes('unprotected private key file') || lower.includes('bad permissions')) {
    return '本地私钥文件权限过宽被 OpenSSH 拒绝：请仅保留当前用户对私钥文件的读取权限，或重新生成密钥对。';
  }

  if (lower.includes('no matching cipher found')) {
    return '服务端不支持高速加密套件（可能 OpenSSH 版本过老）：请在节点设置中取消勾选「优先高速加密套件」或升级设备 B OpenSSH。';
  }

  if (lower.includes('connection refused')) {
    return '连接被拒绝：请检查设备 B 的 sshd 服务是否正在运行、sshd_config 端口是否正确，以及防火墙/云安全组是否已放行该端口。';
  }

  if (lower.includes('connection timed out') || lower.includes('timed out')) {
    return '连接超时：请检查设备 B 的公网 IP、云平台安全组入方向规则，以及设备 A 与设备 B 之间的网络连通性。';
  }

  if (
    lower.includes('could not request local forwarding') ||
    lower.includes('address already in use') ||
    lower.includes('cannot listen to port')
  ) {
    return '本地代理端口被占用：请更换本地端口（如 1081）或关闭正在占用该端口的旧 ssh.exe / 代理程序。';
  }

  if (lower.includes('no such file or directory') && lower.includes('identity')) {
    return '找不到私钥文件：请前往「密钥与配对」重新生成 ed25519 密钥对，或检查节点配置中的私钥路径。';
  }

  if (
    lower.includes('connection reset') ||
    lower.includes('broken pipe') ||
    lower.includes('client_loop: send disconnect')
  ) {
    return '隧道 TCP 连接被对端或中间网络重置（Connection reset）：已自动触发快速重连。若频繁发生，建议在设备 B 开启 sshd 服务端保活（ClientAliveInterval）并确认节点未开启 SSH 压缩（-C）。';
  }

  return null;
}

/**
 * Decodes OpenSSH octal-escaped byte sequences (e.g. `\262\273...` from Chinese Windows GBK messages)
 * into readable UTF-8 / GB18030 text.
 */
export function decodeOpenSshOctalEscapes(text: string): string {
  if (!text.includes('\\')) return text;

  return text.replace(/(?:\\[0-3][0-7]{2})+/g, (match) => {
    const tokens = match.match(/\\[0-3][0-7]{2}/g);
    if (!tokens || tokens.length === 0) return match;

    const bytes = Uint8Array.from(tokens.map((t) => Number.parseInt(t.slice(1), 8)));

    // Only attempt decoding if high-bit bytes are present (avoid mangling literal ASCII escapes)
    if (!bytes.some((b) => b >= 0x80)) {
      return match;
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        return new TextDecoder('gb18030', { fatal: false }).decode(bytes);
      } catch {
        return match;
      }
    }
  });
}

/**
 * Decodes raw stdout/stderr buffer from OpenSSH (handling both UTF-8 and Windows GBK/GB18030)
 * and expands OpenSSH octal escapes.
 */
export function decodeSshOutputChunk(chunk: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    try {
      text = new TextDecoder('gb18030', { fatal: false }).decode(chunk);
    } catch {
      text = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
    }
  }
  return decodeOpenSshOctalEscapes(text);
}

/**
 * Returns true for non-fatal single-channel dynamic forwarding errors
 * (e.g. browser background DNS probe failing on Device B), which do not drop the main SSH tunnel.
 */
export function isNonFatalChannelOpenError(line: string): boolean {
  return /^channel\s+\d+:\s+open failed:/i.test(line.trim());
}

/**
 * Formats a known_hosts host identifier matching OpenSSH conventions:
 * Port 22 -> `host`, non-22 -> `[host]:port`.
 */
export function formatKnownHostsTarget(host: string, port: number): string {
  const cleanHost = host.trim();
  return port === 22 ? cleanHost : `[${cleanHost}]:${port}`;
}

/**
 * Computes a deterministic fingerprint of all connection-affecting fields of a NodeProfile
 * so the UI can reliably detect when a running tunnel's settings have drifted.
 */
export function computeNodeConfigHash(node: NodeProfile): string {
  return JSON.stringify([
    node.id,
    node.host.trim(),
    node.sshPort,
    node.username.trim(),
    node.mode,
    node.localPort,
    node.remoteProxyPort,
    node.privateKeyPath.trim(),
    Boolean(node.compression),
    node.serverAliveInterval ?? 15,
    node.serverAliveCountMax ?? 3,
    node.forceIpv4 !== false,
    node.preferFastCipher !== false,
    node.healthCheckEnabled !== false,
    node.healthCheckIntervalSec ?? 25,
    node.poolSize ?? 3,
    node.rotationIntervalMin ?? 0,
    node.engine ?? 'openssh',
    node.autoFallbackToSsh !== false,
    node.quicUdpPort ?? 53623,
    node.quicAuthToken ?? '',
    node.quicCertPinSha256 ?? '',
    node.quicSni ?? 'www.bing.com',
    node.quicObfsPassword ?? '',
    node.quicUpMbps ?? 50,
    node.quicDownMbps ?? 200,
  ]);
}

/**
 * Accurately matches an enabled Windows Firewall inbound rule for port 22,
 * regardless of whether `localPort` is formatted as `"22"`, `"TCP 22"`, or `"TCP 22,2222"`.
 */
export function isPort22FirewallRule(rule: {
  name: string;
  displayName: string;
  enabled: boolean;
  localPort: string;
}): boolean {
  if (!rule.enabled) return false;
  if (rule.name === 'OpenSSH-Server-In-TCP' || rule.displayName === 'OpenSSH Server (sshd)') {
    return true;
  }
  const tokens = rule.localPort
    .replace(/^(TCP|UDP)\s+/i, '')
    .split(/[,\s]+/)
    .map((t) => t.trim());
  return tokens.includes('22');
}
