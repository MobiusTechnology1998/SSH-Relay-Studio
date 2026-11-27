import type { NodeProfile, OpenSshVersionInfo } from './types';

export interface HysteriaServerYamlParams {
  udpPort: number;
  certPath: string;
  keyPath: string;
  authToken: string;
  obfsPassword?: string;
  maxUpMbps: number;
  maxDownMbps: number;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function toYamlPath(filePath: string): string {
  // Go on Windows accepts forward slashes natively, avoiding YAML backslash escape issues
  return filePath.replace(/\\/g, '/');
}

export const DEFAULT_QUIC_UP_MBPS = 20;
export const DEFAULT_QUIC_DOWN_MBPS = 50;
export const DEFAULT_QUIC_HOP_INTERVAL_SEC = 30;

/**
 * Validates and normalizes an optional Hysteria 2 UDP port hopping spec
 * (e.g. "53620-53650" or "53623,53630-53640"), falling back to single `fallbackPort`.
 */
export function normalizeQuicPortSpec(
  portRange: string | undefined,
  fallbackPort: number
): { portSpec: string; isMultiPort: boolean } {
  const raw = (portRange || '').trim();
  if (!raw) {
    if (!Number.isInteger(fallbackPort) || fallbackPort < 1 || fallbackPort > 65535) {
      throw new Error(`无效 QUIC UDP 端口: ${fallbackPort}`);
    }
    return { portSpec: String(fallbackPort), isMultiPort: false };
  }

  const parts = raw
    .split(',')
    .map((segment) => segment.replace(/\s+/g, ''))
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error(`无效 QUIC 端口跳跃范围: ${portRange}`);
  }

  const normalizedParts: string[] = [];
  let isMultiPort = parts.length > 1;

  for (const part of parts) {
    const singleMatch = part.match(/^(\d+)$/);
    if (singleMatch) {
      const p = Number.parseInt(singleMatch[1], 10);
      if (p < 1 || p > 65535) {
        throw new Error(`QUIC 端口超出 1-65535 范围: ${part}`);
      }
      normalizedParts.push(String(p));
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start < 1 || end > 65535 || start > end) {
        throw new Error(`无效 QUIC 端口跳跃区间: ${part}`);
      }
      if (end > start) {
        isMultiPort = true;
      }
      normalizedParts.push(start === end ? String(start) : `${start}-${end}`);
      continue;
    }

    throw new Error(`无效 QUIC 端口跳跃格式: ${part}（示例：53620-53650）`);
  }

  return {
    portSpec: normalizedParts.join(','),
    isMultiPort,
  };
}

/**
 * Generates a production Hysteria 2 server YAML config tuned for cross-border weak networks.
 */
export function buildHysteriaServerYaml(params: HysteriaServerYamlParams): string {
  if (!Number.isInteger(params.udpPort) || params.udpPort < 1 || params.udpPort > 65535) {
    throw new Error(`无效 QUIC UDP 端口: ${params.udpPort}`);
  }
  if (!params.authToken.trim()) {
    throw new Error('QUIC 鉴权密钥不能为空');
  }

  const upMbps = Math.max(5, Math.min(10000, Math.round(params.maxUpMbps || 200)));
  const downMbps = Math.max(5, Math.min(10000, Math.round(params.maxDownMbps || 200)));

  const lines: string[] = [
    `listen: :${params.udpPort}`,
    '',
    'tls:',
    `  cert: ${yamlQuote(toYamlPath(params.certPath))}`,
    `  key: ${yamlQuote(toYamlPath(params.keyPath))}`,
    '',
    'auth:',
    '  type: password',
    `  password: ${yamlQuote(params.authToken.trim())}`,
    '',
  ];

  if (params.obfsPassword && params.obfsPassword.trim()) {
    lines.push(
      'obfs:',
      '  type: salamander',
      '  salamander:',
      `    password: ${yamlQuote(params.obfsPassword.trim())}`,
      ''
    );
  }

  lines.push(
    'quic:',
    '  initStreamReceiveWindow: 8388608',
    '  maxStreamReceiveWindow: 8388608',
    '  initConnReceiveWindow: 20971520',
    '  maxConnReceiveWindow: 20971520',
    '  maxIdleTimeout: 60s',
    '  maxIncomingStreams: 1024',
    '  disablePathMTUDiscovery: false',
    '',
    'bandwidth:',
    `  up: ${upMbps} mbps`,
    `  down: ${downMbps} mbps`,
    '',
    'ignoreClientBandwidth: false',
    '',
    'masquerade:',
    '  type: string',
    '  string:',
    '    content: "Service Unavailable"',
    '    statusCode: 503',
    ''
  );

  return lines.join('\n');
}

/**
 * Generates a Hysteria 2 client YAML config tuned for cross-border high-RTT & packet-loss links:
 * - Conservative Brutal default (20/50 Mbps) to avoid UDP QoS throttling on congested cross-border links
 * - Optional UDP port hopping (`quicPortRange` + `transport.udp.hopInterval`)
 * - Enlarged QUIC stream (8MB) & connection (20MB) receive windows for high-BDP cross-border links
 * - fastOpen: true (0-RTT-like stream open) + resilient 5s QUIC keepalive / 60s idle timeout
 * - Strict TLS SHA-256 certificate pinning (pinSHA256) against Device B's self-signed cert
 * - Native SOCKS5 (TCP + UDP ASSOCIATE) or HTTP listener on 127.0.0.1:<localPort>
 */
export function buildHysteriaClientYaml(
  node: NodeProfile,
  listenPortOverride?: number
): string {
  const host = node.host.trim();
  const udpPort = node.quicUdpPort ?? 53623;
  const auth = (node.quicAuthToken || '').trim();
  const pin = (node.quicCertPinSha256 || '').trim();
  const sni = (node.quicSni || 'www.bing.com').trim();
  const obfs = (node.quicObfsPassword || '').trim();
  const upMbps = Math.max(5, Math.min(2000, Math.round(node.quicUpMbps ?? DEFAULT_QUIC_UP_MBPS)));
  const downMbps = Math.max(10, Math.min(5000, Math.round(node.quicDownMbps ?? DEFAULT_QUIC_DOWN_MBPS)));
  const hopSec = Math.max(
    10,
    Math.min(300, Math.round(node.quicHopIntervalSec ?? DEFAULT_QUIC_HOP_INTERVAL_SEC))
  );
  const listenPort = listenPortOverride ?? node.localPort;

  if (!host) {
    throw new Error('节点主机地址不能为空');
  }
  if (!auth) {
    throw new Error('缺少 QUIC 鉴权密钥，请重新导入设备 B 配对码或手动填写');
  }

  const { portSpec, isMultiPort } = normalizeQuicPortSpec(node.quicPortRange, udpPort);
  const serverAddr =
    host.includes(':') && !host.startsWith('[') ? `[${host}]:${portSpec}` : `${host}:${portSpec}`;

  const lines: string[] = [
    `server: ${yamlQuote(serverAddr)}`,
    `auth: ${yamlQuote(auth)}`,
    '',
  ];

  if (isMultiPort) {
    lines.push(
      'transport:',
      '  type: udp',
      '  udp:',
      `    hopInterval: ${hopSec}s`,
      ''
    );
  }

  if (obfs) {
    lines.push(
      'obfs:',
      '  type: salamander',
      '  salamander:',
      `    password: ${yamlQuote(obfs)}`,
      ''
    );
  }

  lines.push('tls:', `  sni: ${yamlQuote(sni)}`);
  if (pin) {
    // Hysteria 2 enforces strict SHA256 cert pinning while skipping public CA validation
    lines.push('  insecure: true', `  pinSHA256: ${yamlQuote(pin)}`);
  } else {
    lines.push('  insecure: true');
  }

  lines.push(
    '',
    'bandwidth:',
    `  up: ${upMbps} mbps`,
    `  down: ${downMbps} mbps`,
    '',
    'quic:',
    '  initStreamReceiveWindow: 8388608',
    '  maxStreamReceiveWindow: 8388608',
    '  initConnReceiveWindow: 20971520',
    '  maxConnReceiveWindow: 20971520',
    '  maxIdleTimeout: 60s',
    '  keepAlivePeriod: 5s',
    '  disablePathMTUDiscovery: false',
    '',
    'fastOpen: true',
    'lazy: false',
    ''
  );

  if (node.mode === 'localForward') {
    lines.push('http:', `  listen: 127.0.0.1:${listenPort}`, '');
  } else {
    lines.push('socks5:', `  listen: 127.0.0.1:${listenPort}`, '');
  }

  return lines.join('\n');
}

/**
 * Parses `ssh -V` / `sshd -V` output (e.g. `OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2`)
 * and flags legacy Win32-OpenSSH builds (< 9.0) that suffer lower throughput and older channel loops.
 */
export function parseOpenSshVersion(output: string): OpenSshVersionInfo {
  const raw = output.trim().split(/\r?\n/)[0]?.trim() || '';
  const match = raw.match(/OpenSSH(?:_for_Windows)?[_-](\d+)\.(\d+)/i);
  if (!match) {
    return {
      raw,
      version: null,
      major: null,
      minor: null,
      isLegacy: false,
    };
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return {
    raw,
    version: `${major}.${minor}`,
    major,
    minor,
    isLegacy: major < 9,
  };
}

/**
 * Translates common Hysteria 2 client/server error outputs into actionable Chinese hints.
 */
export function diagnoseHysteriaError(stderr: string): string | null {
  const lower = stderr.toLowerCase();
  if (lower.includes('no recent network activity') || lower.includes('timeout')) {
    return 'QUIC/UDP 握手超时：请检查设备 B 云安全组与 Windows 防火墙是否放行了 UDP 端口，或当前网络屏蔽了 UDP（已开启自动回退时将无缝切回 OpenSSH 通道）。';
  }
  if (lower.includes('authentication failed') || lower.includes('401') || lower.includes('403')) {
    return 'QUIC 鉴权失败：请确认设备 A 与设备 B 的 QUIC 鉴权密钥及 Salamander 混淆密码一致（建议重新导出配对码）。';
  }
  if (lower.includes('pin') || lower.includes('certificate')) {
    return 'TLS 证书指纹（pinSHA256）校验失败：设备 B 证书可能已重新生成，请重新导出配对码导入。';
  }
  if (lower.includes('address already in use') || lower.includes('bind:')) {
    return '本地监听端口被占用：请更换本地端口或关闭占用端口的进程。';
  }
  return null;
}
