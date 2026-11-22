import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendAuthorizedKey,
  parseAuthorizedKeys,
  removeAuthorizedKey,
} from '../../shared/authorizedKeys';
import type { ActionResult, AuthorizedKeysState } from '../../shared/types';
import { logger } from '../logger';
import { execCmd, IS_WINDOWS, sha256FingerprintFromBase64 } from '../platform/shell';

export const ADMIN_AUTH_KEYS_PATH = 'C:\\ProgramData\\ssh\\administrators_authorized_keys';

export function resolveAuthorizedKeysPath(
  useAdminPath: boolean,
  customPath?: string
): { filePath: string; isAdminPath: boolean } {
  if (customPath && customPath.trim()) {
    const p = customPath.trim();
    return {
      filePath: p,
      isAdminPath: p.toLowerCase().endsWith('administrators_authorized_keys'),
    };
  }
  if (useAdminPath) {
    return { filePath: ADMIN_AUTH_KEYS_PATH, isAdminPath: true };
  }
  return {
    filePath: path.join(os.homedir(), '.ssh', 'authorized_keys'),
    isAdminPath: false,
  };
}

/**
 * Checks whether icacls ACL on administrators_authorized_keys only grants Administrators and SYSTEM
 * (no inherited Users/Everyone/Authenticated Users permissions).
 */
export async function inspectAuthorizedKeysPermissions(
  filePath: string
): Promise<{ valid: boolean; raw: string }> {
  if (!IS_WINDOWS) {
    return { valid: false, raw: '非 Windows 环境' };
  }
  if (!fs.existsSync(filePath)) {
    return { valid: false, raw: '公钥文件尚未创建' };
  }

  const res = await execCmd('icacls.exe', [filePath], { timeoutMs: 8000 });
  const raw = (res.stdout || res.stderr).trim();
  if (res.code !== 0) {
    return { valid: false, raw: raw || '无法读取 ACL 权限' };
  }

  // Check ACL entries: should not contain (I) inherited markers or Users / Everyone / Authenticated Users
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Successfully processed') && !l.startsWith('已成功处理'));

  const hasInherited = lines.some((l) => /\(I\)/.test(l));
  const hasBroadPrincipal = lines.some((l) =>
    /(BUILTIN\\Users|Everyone|Authenticated Users|NT AUTHORITY\\Authenticated Users|Users:|Everyone:)/i.test(
      l
    )
  );
  const hasAdmins = lines.some((l) => /Administrators/i.test(l));
  const hasSystem = lines.some((l) => /SYSTEM/i.test(l));

  return {
    valid: !hasInherited && !hasBroadPrincipal && hasAdmins && hasSystem,
    raw,
  };
}

/**
 * Tightens ACL permissions using Windows well-known SIDs so it works identically on Chinese & English Windows:
 * - *S-1-5-32-544 = BUILTIN\Administrators
 * - *S-1-5-18     = NT AUTHORITY\SYSTEM
 */
export async function tightenAuthorizedKeysPermissions(
  filePath: string
): Promise<ActionResult<{ valid: boolean; raw: string }>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上执行 icacls 权限收紧' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: `文件不存在: ${filePath}` };
  }

  const res = await execCmd(
    'icacls.exe',
    [filePath, '/inheritance:r', '/grant', '*S-1-5-32-544:F', '/grant', '*S-1-5-18:F'],
    { timeoutMs: 10000 }
  );

  if (res.code !== 0) {
    const msg = `icacls 权限收紧失败（请确认已以管理员身份运行）: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  const check = await inspectAuthorizedKeysPermissions(filePath);
  logger.success('serverB', `已收紧 ${filePath} 权限（仅保留 Administrators 与 SYSTEM 完全控制）`);
  return {
    ok: true,
    message: '已成功收紧公钥文件权限（仅 Administrators 与 SYSTEM 可访问）',
    data: check,
  };
}

export async function getAuthorizedKeysState(
  useAdminPath: boolean,
  customPath?: string
): Promise<AuthorizedKeysState> {
  const { filePath, isAdminPath } = resolveAuthorizedKeysPath(useAdminPath, customPath);

  if (!IS_WINDOWS || !fs.existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      isAdminPath,
      keys: [],
      permissionsValid: false,
      permissionsRaw: IS_WINDOWS ? '尚未创建公钥文件' : '非 Windows 环境',
    };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const keys = parseAuthorizedKeys(raw, sha256FingerprintFromBase64);
  const perms = isAdminPath
    ? await inspectAuthorizedKeysPermissions(filePath)
    : { valid: true, raw: '普通用户目录无需 administrators_authorized_keys 专属 ACL' };

  return {
    filePath,
    exists: true,
    isAdminPath,
    keys,
    permissionsValid: perms.valid,
    permissionsRaw: perms.raw,
  };
}

export async function addAuthorizedKeyToServer(
  useAdminPath: boolean,
  customPath: string | undefined,
  publicKeyText: string,
  labelComment?: string
): Promise<ActionResult<AuthorizedKeysState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上写入授权公钥' };
  }

  const { filePath, isAdminPath } = resolveAuthorizedKeysPath(useAdminPath, customPath);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  let result: { content: string; added: boolean; duplicate: boolean };
  try {
    result = appendAuthorizedKey(existing, publicKeyText, labelComment);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  if (result.duplicate) {
    const state = await getAuthorizedKeysState(useAdminPath, customPath);
    return {
      ok: true,
      message: '该公钥已存在于授权列表中，无需重复添加。',
      data: state,
    };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write UTF-8 without BOM + LF line endings (critical for Windows OpenSSH)
    fs.writeFileSync(filePath, result.content, 'utf8');
  } catch (err) {
    const msg = `写入公钥文件失败（请确认已以管理员身份运行）: ${(err as Error).message}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  if (isAdminPath) {
    const aclRes = await tightenAuthorizedKeysPermissions(filePath);
    if (!aclRes.ok) {
      const state = await getAuthorizedKeysState(useAdminPath, customPath);
      return {
        ok: false,
        message: `公钥已写入，但自动收紧权限失败: ${aclRes.message}`,
        data: state,
      };
    }
  }

  logger.success('serverB', `已追加设备公钥至 ${filePath} 并完成权限校验`);
  const nextState = await getAuthorizedKeysState(useAdminPath, customPath);
  return {
    ok: true,
    message: isAdminPath
      ? '已追加公钥并自动执行 icacls 收紧文件权限（原有其他设备公钥已完整保留）'
      : '已成功追加公钥至授权列表',
    data: nextState,
  };
}

export async function deleteAuthorizedKeyFromServer(
  useAdminPath: boolean,
  customPath: string | undefined,
  keyData: string
): Promise<ActionResult<AuthorizedKeysState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上移除授权公钥' };
  }

  const { filePath, isAdminPath } = resolveAuthorizedKeysPath(useAdminPath, customPath);
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: '公钥文件不存在' };
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const updated = removeAuthorizedKey(existing, keyData);

  try {
    fs.writeFileSync(filePath, updated, 'utf8');
    if (isAdminPath) {
      await tightenAuthorizedKeysPermissions(filePath);
    }
    logger.warn('serverB', `已从 ${filePath} 移除一条授权公钥`);
    const nextState = await getAuthorizedKeysState(useAdminPath, customPath);
    return { ok: true, message: '已移除该授权公钥', data: nextState };
  } catch (err) {
    return { ok: false, message: `移除公钥失败: ${(err as Error).message}` };
  }
}
