import type { PairingPayload, QuicPairingInfo } from './types';

const TOKEN_PREFIX = 'SSHR1:';

function toBase64Utf8(str: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf8').toString('base64url');
  }
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Utf8(b64url: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64url, 'base64url').toString('utf8');
  }
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function sanitizeQuicInfo(raw: unknown): QuicPairingInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  const udpPort = Number(q.udpPort);
  const authToken = typeof q.authToken === 'string' ? q.authToken.trim() : '';
  const certPinSha256 = typeof q.certPinSha256 === 'string' ? q.certPinSha256.trim() : '';
  const sni = typeof q.sni === 'string' && q.sni.trim() ? q.sni.trim() : 'www.bing.com';
  const obfsPassword =
    typeof q.obfsPassword === 'string' && q.obfsPassword.trim()
      ? q.obfsPassword.trim()
      : undefined;

  if (!Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65535 || !authToken || !certPinSha256) {
    return undefined;
  }

  return {
    udpPort,
    authToken,
    certPinSha256,
    sni,
    obfsPassword,
  };
}

export function encodePairingToken(payload: PairingPayload): string {
  if (!payload.host.trim()) {
    throw new Error('中转端主机 IP 或域名不能为空');
  }
  if (!Number.isInteger(payload.sshPort) || payload.sshPort < 1 || payload.sshPort > 65535) {
    throw new Error('SSH 端口无效');
  }
  const quic = sanitizeQuicInfo(payload.quic);
  const json = JSON.stringify({
    version: 1,
    name: payload.name.trim() || `中转节点 (${payload.host.trim()})`,
    host: payload.host.trim(),
    sshPort: payload.sshPort,
    username: payload.username.trim() || 'Administrator',
    hostPublicKey: payload.hostPublicKey?.trim() || undefined,
    quic,
    createdAt: payload.createdAt || Date.now(),
  });
  return `${TOKEN_PREFIX}${toBase64Utf8(json)}`;
}

export function decodePairingToken(token: string): PairingPayload {
  const cleaned = token.trim();
  if (!cleaned.startsWith(TOKEN_PREFIX)) {
    throw new Error('配对码格式无效，应以 SSHR1: 开头');
  }
  const rawBody = cleaned.slice(TOKEN_PREFIX.length).trim();
  if (!rawBody) {
    throw new Error('配对码内容为空');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Utf8(rawBody));
  } catch {
    throw new Error('配对码解码失败，请确认是否完整复制');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('配对码数据结构无效');
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`不支持的配对码版本: ${String(obj.version)}`);
  }
  if (typeof obj.host !== 'string' || !obj.host.trim()) {
    throw new Error('配对码缺少主机地址');
  }
  const sshPort = Number(obj.sshPort);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error('配对码中的 SSH 端口无效');
  }
  const username =
    typeof obj.username === 'string' && obj.username.trim() ? obj.username.trim() : 'Administrator';
  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : `中转节点 (${obj.host.trim()})`;

  return {
    version: 1,
    name,
    host: obj.host.trim(),
    sshPort,
    username,
    hostPublicKey:
      typeof obj.hostPublicKey === 'string' && obj.hostPublicKey.trim()
        ? obj.hostPublicKey.trim()
        : undefined,
    quic: sanitizeQuicInfo(obj.quic),
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
  };
}
