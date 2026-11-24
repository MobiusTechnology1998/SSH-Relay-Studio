import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ActionResult, BinaryStatusInfo } from '../../shared/types';
import { logger } from '../logger';
import { execCmd, IS_WINDOWS } from './shell';

const HYSTERIA_WIN_RELEASE_URL =
  'https://github.com/apernet/hysteria/releases/latest/download/hysteria-windows-amd64.exe';
const HYSTERIA_LINUX_RELEASE_URL =
  'https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-amd64';

const SERVER_HYSTERIA_DIR = 'C:\\ProgramData\\SSHRelayStudio\\bin';

export function getDefaultHysteriaBinaryPath(scope: 'clientA' | 'serverB'): string {
  const filename = IS_WINDOWS ? 'hysteria.exe' : 'hysteria';
  if (scope === 'serverB' && IS_WINDOWS) {
    return path.join(SERVER_HYSTERIA_DIR, filename);
  }
  return path.join(app.getPath('userData'), 'bin', filename);
}

export function resolveHysteriaBinaryPath(
  scope: 'clientA' | 'serverB',
  customPath?: string
): string {
  const custom = (customPath || '').trim();
  if (custom && fs.existsSync(custom)) {
    return custom;
  }

  const defaultPath = getDefaultHysteriaBinaryPath(scope);
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  // Fallback: check packaged resources/bin if user bundled hysteria.exe manually
  if (app.isPackaged) {
    const filename = IS_WINDOWS ? 'hysteria.exe' : 'hysteria';
    const bundled = path.join(process.resourcesPath, 'bin', filename);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }

  return defaultPath;
}

export async function inspectHysteriaBinary(
  scope: 'clientA' | 'serverB',
  customPath?: string
): Promise<BinaryStatusInfo> {
  const binPath = resolveHysteriaBinaryPath(scope, customPath);
  if (!fs.existsSync(binPath)) {
    return {
      installed: false,
      path: binPath,
      version: null,
    };
  }

  const res = await execCmd(binPath, ['version'], { timeoutMs: 5000 });
  const text = `${res.stdout}\n${res.stderr}`.trim();
  const verMatch = text.match(/Version:\s*([^\s\r\n]+)/i) || text.match(/(v\d+\.\d+\.\d+[^\s]*)/i);
  const version = verMatch ? verMatch[1] : res.code === 0 ? 'installed' : null;

  return {
    installed: res.code === 0 || Boolean(version),
    path: binPath,
    version,
  };
}

/**
 * Downloads the official Hysteria 2 single-file binary directly from GitHub Releases
 * (`apernet/hysteria`) and validates it with `hysteria version`.
 */
export async function downloadHysteriaBinary(
  scope: 'clientA' | 'serverB',
  customUrl?: string
): Promise<ActionResult<BinaryStatusInfo>> {
  const targetPath = getDefaultHysteriaBinaryPath(scope);
  const downloadUrl =
    (customUrl || '').trim() ||
    (IS_WINDOWS ? HYSTERIA_WIN_RELEASE_URL : HYSTERIA_LINUX_RELEASE_URL);

  logger.info(scope, `正在从官方源下载 Hysteria 2 QUIC 引擎: ${downloadUrl}`);

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.download`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    let response: Response;
    try {
      response = await fetch(downloadUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'SSH-Relay-Studio' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength < 1024 * 1024) {
      throw new Error(`下载的文件体积异常 (${arrayBuf.byteLength} bytes)，可能被网络拦截`);
    }

    fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));
    if (!IS_WINDOWS) {
      fs.chmodSync(tmpPath, 0o755);
    }
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    fs.renameSync(tmpPath, targetPath);

    const info = await inspectHysteriaBinary(scope);
    if (!info.installed) {
      throw new Error('二进制校验失败（hysteria version 返回异常）');
    }

    logger.success(
      scope,
      `Hysteria 2 QUIC 引擎下载并校验成功 (${info.version ?? 'unknown'}) -> ${targetPath}`
    );
    return {
      ok: true,
      message: `Hysteria 2 QUIC 引擎已就绪（版本 ${info.version ?? 'latest'}）`,
      data: info,
    };
  } catch (err) {
    const msg = `下载 Hysteria 2 失败: ${(err as Error).message}。若当前网络无法直连 GitHub，请手动下载 hysteria-windows-amd64.exe 后点击「导入本地文件」。`;
    logger.error(scope, msg);
    return { ok: false, message: msg };
  }
}

/**
 * Copies a user-selected local hysteria.exe binary into the managed bin directory and verifies it.
 */
export async function importLocalHysteriaBinary(
  scope: 'clientA' | 'serverB',
  sourceFilePath: string
): Promise<ActionResult<BinaryStatusInfo>> {
  const cleanSrc = sourceFilePath.trim();
  if (!cleanSrc || !fs.existsSync(cleanSrc)) {
    return { ok: false, message: '所选 Hysteria 2 可执行文件不存在' };
  }

  const targetPath = getDefaultHysteriaBinaryPath(scope);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (path.resolve(cleanSrc) !== path.resolve(targetPath)) {
      fs.copyFileSync(cleanSrc, targetPath);
    }
    if (!IS_WINDOWS) {
      fs.chmodSync(targetPath, 0o755);
    }
    const info = await inspectHysteriaBinary(scope);
    if (!info.installed) {
      return {
        ok: false,
        message: '导入的文件未通过 hysteria version 校验，请确认选择的是正确的 Hysteria 2 可执行文件',
      };
    }
    logger.success(scope, `已导入并校验本地 Hysteria 2 引擎 (${info.version}) -> ${targetPath}`);
    return {
      ok: true,
      message: `已成功导入 Hysteria 2（版本 ${info.version}）`,
      data: info,
    };
  } catch (err) {
    const msg = `导入 Hysteria 2 失败: ${(err as Error).message}`;
    logger.error(scope, msg);
    return { ok: false, message: msg };
  }
}
