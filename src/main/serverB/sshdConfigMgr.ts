import fs from 'fs';
import path from 'path';
import {
  parseSshdConfig,
  type SshdConfigUpdate,
  updateSshdConfig,
} from '../../shared/sshConfigParser';
import type { ActionResult, SshdConfigState } from '../../shared/types';
import { logger } from '../logger';
import { execCmd, IS_WINDOWS, resolveOpenSshBinary } from '../platform/shell';

const SSH_PROGRAM_DATA_DIR = 'C:\\ProgramData\\ssh';
const SSHD_CONFIG_PATH = path.join(SSH_PROGRAM_DATA_DIR, 'sshd_config');
const SSHD_CONFIG_BAK_PATH = path.join(SSH_PROGRAM_DATA_DIR, 'sshd_config.bak');

export function readSshdConfigState(): SshdConfigState {
  if (!IS_WINDOWS || !fs.existsSync(SSHD_CONFIG_PATH)) {
    return {
      exists: false,
      path: SSHD_CONFIG_PATH,
      backupExists: IS_WINDOWS && fs.existsSync(SSHD_CONFIG_BAK_PATH),
      port: 22,
      pubkeyAuthentication: true,
      passwordAuthentication: true,
      hasMatchAdminBlock: false,
      rawContent: '',
    };
  }

  const rawContent = fs.readFileSync(SSHD_CONFIG_PATH, 'utf8');
  const parsed = parseSshdConfig(rawContent);
  return {
    exists: true,
    path: SSHD_CONFIG_PATH,
    backupExists: fs.existsSync(SSHD_CONFIG_BAK_PATH),
    port: parsed.port,
    pubkeyAuthentication: parsed.pubkeyAuthentication,
    passwordAuthentication: parsed.passwordAuthentication,
    hasMatchAdminBlock: parsed.hasMatchAdminBlock,
    rawContent,
  };
}

/**
 * Safely updates C:\ProgramData\ssh\sshd_config:
 * 1. Backs up original to sshd_config.bak (if missing) + in-memory snapshot for rollback
 * 2. Updates Port, PubkeyAuthentication, PasswordAuthentication before Match blocks
 * 3. Validates syntax with `sshd.exe -t`
 * 4. Automatically rolls back on syntax failure
 */
export async function applySshdConfigUpdate(
  update: SshdConfigUpdate
): Promise<ActionResult<SshdConfigState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上修改 sshd_config' };
  }

  if (!fs.existsSync(SSHD_CONFIG_PATH)) {
    return {
      ok: false,
      message: `未找到 ${SSHD_CONFIG_PATH}，请先安装并至少启动一次 OpenSSH Server 服务以生成默认配置。`,
    };
  }

  const originalContent = fs.readFileSync(SSHD_CONFIG_PATH, 'utf8');
  let nextContent: string;
  try {
    nextContent = updateSshdConfig(originalContent, update);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  // Create initial backup if not present
  try {
    if (!fs.existsSync(SSHD_CONFIG_BAK_PATH)) {
      fs.writeFileSync(SSHD_CONFIG_BAK_PATH, originalContent, 'utf8');
      logger.info('serverB', `已备份原始配置文件至 ${SSHD_CONFIG_BAK_PATH}`);
    }
    fs.writeFileSync(SSHD_CONFIG_PATH, nextContent, 'utf8');
  } catch (err) {
    const msg = `写入 sshd_config 失败（请确认已以管理员身份运行）: ${(err as Error).message}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  // Syntax check via sshd.exe -t
  const sshdExe = resolveOpenSshBinary('sshd');
  const check = await execCmd(sshdExe, ['-t'], { timeoutMs: 10000 });
  if (check.code !== 0) {
    // Immediate automatic rollback!
    try {
      fs.writeFileSync(SSHD_CONFIG_PATH, originalContent, 'utf8');
    } catch {
      // Best effort
    }
    const errDetail = check.stderr.trim() || check.stdout.trim() || '语法校验返回非零退出码';
    const msg = `sshd.exe -t 语法校验未通过，已自动回滚原配置！原因: ${errDetail}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg, data: readSshdConfigState() };
  }

  logger.success(
    'serverB',
    `sshd_config 已更新并通过 sshd.exe -t 校验 (Port=${update.port}, Pubkey=${update.pubkeyAuthentication ? 'yes' : 'no'}, Password=${update.passwordAuthentication ? 'yes' : 'no'})`
  );

  return {
    ok: true,
    message: `配置已保存并通过 sshd.exe -t 语法校验（端口 ${update.port}）。请确保防火墙和云安全组放行后再重启 sshd。`,
    data: readSshdConfigState(),
  };
}

export async function restoreSshdConfigBackup(): Promise<ActionResult<SshdConfigState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上恢复配置备份' };
  }
  if (!fs.existsSync(SSHD_CONFIG_BAK_PATH)) {
    return { ok: false, message: `未找到备份文件 ${SSHD_CONFIG_BAK_PATH}` };
  }

  try {
    fs.copyFileSync(SSHD_CONFIG_BAK_PATH, SSHD_CONFIG_PATH);
    logger.warn('serverB', '已从 sshd_config.bak 恢复原始配置');
    return {
      ok: true,
      message: '已从 sshd_config.bak 恢复配置，请重启 sshd 服务使其生效。',
      data: readSshdConfigState(),
    };
  } catch (err) {
    return { ok: false, message: `恢复备份失败: ${(err as Error).message}` };
  }
}

/**
 * Reads Device B's SSH host ed25519 public key (if present) so it can be embedded in the Pairing Code
 * for automatic host fingerprint verification on Device A.
 */
export function readHostPublicKey(): string | null {
  if (!IS_WINDOWS) return null;
  const candidates = [
    path.join(SSH_PROGRAM_DATA_DIR, 'ssh_host_ed25519_key.pub'),
    path.join(SSH_PROGRAM_DATA_DIR, 'ssh_host_ecdsa_key.pub'),
    path.join(SSH_PROGRAM_DATA_DIR, 'ssh_host_rsa_key.pub'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const line = fs.readFileSync(file, 'utf8').trim();
        if (line) return line;
      } catch {
        // Continue trying next key
      }
    }
  }
  return null;
}
