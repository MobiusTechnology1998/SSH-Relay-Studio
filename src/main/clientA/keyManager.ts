import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatKnownHostsTarget } from '../../shared/commandBuilders';
import type {
  ActionResult,
  HostKeyScanResult,
  KeyPairInfo,
  NodeProfile,
  SecurityCheckResult,
} from '../../shared/types';
import { logger } from '../logger';
import {
  execCmd,
  resolveOpenSshBinary,
  sha256FingerprintFromBase64,
  testTcpConnection,
} from '../platform/shell';

function getSshDir(): string {
  return path.join(os.homedir(), '.ssh');
}

function getDefaultPrivateKeyPath(): string {
  return path.join(getSshDir(), 'id_ed25519');
}

function getKnownHostsPath(): string {
  return path.join(getSshDir(), 'known_hosts');
}

export function getKeyPairInfo(customPrivateKeyPath?: string): KeyPairInfo {
  const privateKeyPath = customPrivateKeyPath?.trim() || getDefaultPrivateKeyPath();
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    return {
      exists: false,
      privateKeyPath,
      publicKeyPath,
      publicKey: '',
      fingerprint: '',
    };
  }

  const publicKey = fs.readFileSync(publicKeyPath, 'utf8').replace(/^\uFEFF/, '').trim();
  const parts = publicKey.split(/\s+/);
  const fingerprint = parts.length >= 2 ? sha256FingerprintFromBase64(parts[1]) : '';

  return {
    exists: true,
    privateKeyPath,
    publicKeyPath,
    publicKey,
    fingerprint,
  };
}

export async function generateEd25519KeyPair(
  forceOverwrite = false
): Promise<ActionResult<KeyPairInfo>> {
  const sshDir = getSshDir();
  const privateKeyPath = getDefaultPrivateKeyPath();
  const publicKeyPath = `${privateKeyPath}.pub`;

  fs.mkdirSync(sshDir, { recursive: true });

  if (fs.existsSync(privateKeyPath) && !forceOverwrite) {
    const info = getKeyPairInfo(privateKeyPath);
    return {
      ok: true,
      message: '已存在默认 ed25519 密钥对，直接复用。',
      data: info,
    };
  }

  if (forceOverwrite) {
    if (fs.existsSync(privateKeyPath)) fs.unlinkSync(privateKeyPath);
    if (fs.existsSync(publicKeyPath)) fs.unlinkSync(publicKeyPath);
  }

  const sshKeygen = resolveOpenSshBinary('ssh-keygen');
  const comment = `${os.userInfo().username}@${os.hostname()}`;
  const res = await execCmd(
    sshKeygen,
    ['-t', 'ed25519', '-N', '', '-C', comment, '-f', privateKeyPath],
    { timeoutMs: 15000 }
  );

  if (res.code !== 0) {
    const msg = `生成密钥失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('clientA', msg);
    return { ok: false, message: msg };
  }

  const info = getKeyPairInfo(privateKeyPath);
  logger.success('clientA', `已生成免密 ed25519 密钥对 (${info.fingerprint})`);
  return {
    ok: true,
    message: '成功生成 ed25519 密钥对（空密码短语，支持后台静默自动重连）',
    data: info,
  };
}

export function isHostKeyTrusted(host: string, port: number, keyData?: string): boolean {
  if (!host.trim()) return false;
  const khPath = getKnownHostsPath();
  if (!fs.existsSync(khPath)) return false;

  const target = formatKnownHostsTarget(host, port);
  const content = fs.readFileSync(khPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const hosts = parts[0].split(',');
    if (hosts.includes(target)) {
      if (!keyData || parts[2] === keyData) {
        return true;
      }
    }
  }
  return false;
}

export async function scanHostKeys(host: string, port: number): Promise<HostKeyScanResult> {
  const cleanHost = host.trim();
  if (!cleanHost) {
    return {
      success: false,
      host: cleanHost,
      port,
      entries: [],
      alreadyTrusted: false,
      error: '请先填写设备 B 的 IP 或域名',
    };
  }

  const keyscan = resolveOpenSshBinary('ssh-keyscan');
  const res = await execCmd(
    keyscan,
    ['-T', '15', '-p', String(port), '-t', 'ed25519,rsa,ecdsa', cleanHost],
    { timeoutMs: 20000 }
  );

  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const entries: HostKeyScanResult['entries'] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const keyType = parts[1];
      const keyData = parts[2];
      entries.push({
        keyType,
        keyData,
        fingerprint: sha256FingerprintFromBase64(keyData),
        rawLine: `${formatKnownHostsTarget(cleanHost, port)} ${keyType} ${keyData}`,
      });
    }
  }

  if (entries.length === 0) {
    const errText = res.stderr.trim() || '未扫描到主机公钥，请确认端口可达且 sshd 正在运行';
    logger.warn('clientA', `扫描主机指纹失败 (${cleanHost}:${port}): ${errText}`);
    return {
      success: false,
      host: cleanHost,
      port,
      entries: [],
      alreadyTrusted: false,
      error: errText,
    };
  }

  const alreadyTrusted = entries.some((e) =>
    isHostKeyTrusted(cleanHost, port, e.keyData)
  );

  logger.info(
    'clientA',
    `扫描到 ${cleanHost}:${port} 的 ${entries.length} 条主机指纹 (已信任: ${alreadyTrusted ? '是' : '否'})`
  );

  return {
    success: true,
    host: cleanHost,
    port,
    entries,
    alreadyTrusted,
  };
}

/**
 * Writes trusted host key lines into ~/.ssh/known_hosts (replacing stale entries for the same host:port).
 */
export function trustHostKeys(
  host: string,
  port: number,
  keyLines: Array<{ keyType: string; keyData: string }>
): ActionResult {
  if (!host.trim() || keyLines.length === 0) {
    return { ok: false, message: '缺少有效的主机公钥条目' };
  }

  const sshDir = getSshDir();
  fs.mkdirSync(sshDir, { recursive: true });
  const khPath = getKnownHostsPath();
  const target = formatKnownHostsTarget(host, port);

  let existingLines: string[] = [];
  if (fs.existsSync(khPath)) {
    existingLines = fs
      .readFileSync(khPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
  }

  // Check if all requested host keys already exist identically (no-op if unchanged)
  const allAlreadyPresent = keyLines.every((k) =>
    existingLines.some((line) => {
      const parts = line.trim().split(/\s+/);
      return (
        parts.length >= 3 &&
        parts[0].split(',').includes(target) &&
        parts[1] === k.keyType &&
        parts[2] === k.keyData
      );
    })
  );
  if (allAlreadyPresent) {
    return {
      ok: true,
      message: `主机 ${target} 的指纹已在信任列表中，无需重复写入。`,
    };
  }

  // Remove old entries for the exact target+keyType so port re-installs don't cause conflict
  const newTypes = new Set(keyLines.map((k) => k.keyType));
  const filtered = existingLines.filter((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) return true;
    const hosts = parts[0].split(',');
    if (hosts.includes(target) && newTypes.has(parts[1])) {
      return false;
    }
    return true;
  });

  for (const k of keyLines) {
    filtered.push(`${target} ${k.keyType} ${k.keyData}`);
  }

  fs.writeFileSync(khPath, filtered.join('\n') + '\n', 'utf8');
  logger.success('clientA', `已将 ${target} 的 ${keyLines.length} 条主机指纹写入 known_hosts`);
  return {
    ok: true,
    message: `已成功信任 ${target} 的主机指纹，后续后台静默连接将不会因指纹校验失败而拒连。`,
  };
}

/**
 * Verifies the two key security checks from ssh.md section 4.1 step 4:
 * 1. TCP reachability to host:port
 * 2. Passwordless publickey login works and returns Device B hostname
 * 3. Password login is strictly rejected when PubkeyAuthentication=no
 */
export async function runSecurityVerification(node: NodeProfile): Promise<SecurityCheckResult> {
  const tcp = await testTcpConnection(node.host, node.sshPort, 6000);
  if (!tcp.reachable) {
    return {
      tcpReachable: false,
      tcpDetail: tcp.detail,
      keyAuthPassed: false,
      remoteHostname: '',
      keyAuthDetail: '因 TCP 不可达跳过测试',
      passwordAuthDisabled: false,
      passwordAuthDetail: '因 TCP 不可达跳过测试',
    };
  }

  const sshBin = resolveOpenSshBinary('ssh');
  const keyPath = node.privateKeyPath?.trim() || getDefaultPrivateKeyPath();
  const target = `${node.username}@${node.host}`;

  // Test 1: Passwordless key login
  const keyRes = await execCmd(
    sshBin,
    [
      '-p',
      String(node.sshPort),
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-i',
      keyPath,
      target,
      'hostname',
    ],
    { timeoutMs: 12000 }
  );

  const keyAuthPassed = keyRes.code === 0 && keyRes.stdout.trim().length > 0;
  const remoteHostname = keyAuthPassed ? keyRes.stdout.trim().split(/\r?\n/)[0] : '';
  const keyAuthDetail = keyAuthPassed
    ? `免密登录成功，设备 B 主机名: ${remoteHostname}`
    : `免密登录失败: ${keyRes.stderr.trim() || `exit code ${keyRes.code}`}`;

  // Test 2: Confirm password auth is disabled (PubkeyAuthentication=no + BatchMode=yes)
  // Note: On OpenSSH, when PasswordAuthentication=no, ssh -v reports "Authentications that can continue: publickey"
  // and returns "Permission denied (publickey)". If password auth is still enabled, stderr includes "password".
  const passRes = await execCmd(
    sshBin,
    [
      '-p',
      String(node.sshPort),
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      target,
      'hostname',
    ],
    { timeoutMs: 12000 }
  );

  const stderrLower = passRes.stderr.toLowerCase();
  const mentionsPassword = stderrLower.includes('password');
  const mentionsPublickeyOnly =
    stderrLower.includes('permission denied (publickey') && !mentionsPassword;

  const passwordAuthDisabled = passRes.code !== 0 && mentionsPublickeyOnly;
  let passwordAuthDetail = '';
  if (passwordAuthDisabled) {
    passwordAuthDetail = '已确认：密码登录已彻底关闭（返回 Permission denied (publickey)）';
  } else if (mentionsPassword) {
    passwordAuthDetail =
      '警告：设备 B 仍允许密码认证！请前往设备 B 的「安全加固」关闭 PasswordAuthentication。';
  } else if (stderrLower.includes('host key verification failed')) {
    passwordAuthDetail = '未完成：请先扫描并信任该端口的主机指纹。';
  } else {
    passwordAuthDetail = `检测结果未明确: ${passRes.stderr.trim() || '无法确认'}`;
  }

  logger.info(
    'clientA',
    `安全校验结果 (${node.host}:${node.sshPort}) -> TCP:${tcp.reachable}, 免密:${keyAuthPassed}, 禁密码:${passwordAuthDisabled}`
  );

  return {
    tcpReachable: true,
    tcpDetail: tcp.detail,
    keyAuthPassed,
    remoteHostname,
    keyAuthDetail,
    passwordAuthDisabled,
    passwordAuthDetail,
  };
}
