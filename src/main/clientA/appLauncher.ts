import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildProxiedAppLaunchSpec } from '../../shared/commandBuilders';
import type {
  ActionResult,
  DetectedDesktopApp,
  NodeProfile,
  ProxiedAppProfile,
} from '../../shared/types';
import { logger } from '../logger';
import { IS_WINDOWS } from '../platform/shell';
import { expandWindowsEnvVars } from './browserLauncher';

/**
 * Checks sibling files beside an executable to accurately detect Electron / Chromium apps
 * (e.g. `resources/app.asar`, `chrome_100_percent.pak`, `libEGL.dll`).
 */
function hasElectronOrChromiumRuntimeFiles(exePath: string): boolean {
  try {
    const dir = path.dirname(exePath);
    const probes = [
      path.join(dir, 'resources', 'app.asar'),
      path.join(dir, 'chrome_100_percent.pak'),
      path.join(dir, 'icudtl.dat'),
    ];
    return probes.some((p) => fs.existsSync(p));
  } catch {
    return false;
  }
}

/**
 * Fast, zero-scan detection of popular Windows developer/AI/chat applications
 * so users can add them to the per-app proxy launcher in one click.
 */
export function detectCommonDesktopApps(): DetectedDesktopApp[] {
  if (!IS_WINDOWS) {
    return [];
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';

  const candidates: Array<{
    id: string;
    name: string;
    category: DetectedDesktopApp['category'];
    suggestedMode: DetectedDesktopApp['suggestedMode'];
    paths: string[];
  }> = [
    {
      id: 'cursor',
      name: 'Cursor',
      category: 'editor',
      suggestedMode: 'auto',
      paths: [path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe')],
    },
    {
      id: 'vscode',
      name: 'VS Code',
      category: 'editor',
      suggestedMode: 'auto',
      paths: [
        path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(programFiles, 'Microsoft VS Code', 'Code.exe'),
      ],
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      category: 'editor',
      suggestedMode: 'auto',
      paths: [path.join(localAppData, 'Programs', 'Windsurf', 'Windsurf.exe')],
    },
    {
      id: 'claude',
      name: 'Claude Desktop',
      category: 'other',
      suggestedMode: 'auto',
      paths: [path.join(localAppData, 'AnthropicClaude', 'claude.exe')],
    },
    {
      id: 'wt',
      name: 'Windows Terminal',
      category: 'terminal',
      suggestedMode: 'envOnly',
      paths: [path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')],
    },
    {
      id: 'pwsh',
      name: 'PowerShell',
      category: 'terminal',
      suggestedMode: 'envOnly',
      paths: [
        path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ],
    },
    {
      id: 'git-bash',
      name: 'Git Bash',
      category: 'terminal',
      suggestedMode: 'envOnly',
      paths: [
        path.join(programFiles, 'Git', 'git-bash.exe'),
        path.join(programFilesX86, 'Git', 'git-bash.exe'),
      ],
    },
    {
      id: 'telegram',
      name: 'Telegram',
      category: 'chat',
      suggestedMode: 'envOnly',
      paths: [
        path.join(process.env.APPDATA || '', 'Telegram Desktop', 'Telegram.exe'),
        path.join(localAppData, 'Telegram Desktop', 'Telegram.exe'),
      ],
    },
    {
      id: 'discord',
      name: 'Discord',
      category: 'chat',
      suggestedMode: 'auto',
      paths: [path.join(localAppData, 'Discord', 'Update.exe')],
    },
    {
      id: 'postman',
      name: 'Postman',
      category: 'other',
      suggestedMode: 'auto',
      paths: [path.join(localAppData, 'Postman', 'Postman.exe')],
    },
    {
      id: 'obsidian',
      name: 'Obsidian',
      category: 'other',
      suggestedMode: 'auto',
      paths: [path.join(localAppData, 'Programs', 'obsidian', 'Obsidian.exe')],
    },
    {
      id: 'chrome',
      name: 'Google Chrome',
      category: 'browser',
      suggestedMode: 'chromiumArgs',
      paths: [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      category: 'browser',
      suggestedMode: 'chromiumArgs',
      paths: [
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    },
  ];

  const detected: DetectedDesktopApp[] = [];
  for (const item of candidates) {
    const found = item.paths.find((p) => p && fs.existsSync(p));
    if (found) {
      detected.push({
        id: item.id,
        name: item.name,
        exePath: found,
        category: item.category,
        suggestedMode: item.suggestedMode,
      });
    }
  }
  return detected;
}

function resolveIsolatedAppProfileDir(appId: string): string {
  const safeId = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseDir =
    process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(baseDir, 'SSHRelayStudio', 'AppProfiles', safeId);
}

/**
 * Launches a single specified application with process-scoped proxy environment variables
 * (and Chromium/Electron `--proxy-server` flags when applicable).
 * Does NOT modify Windows system proxy settings or affect any other running application.
 */
export function launchProxiedApp(
  appProfile: ProxiedAppProfile,
  node: Pick<NodeProfile, 'mode' | 'localPort' | 'engine'>,
  fallbackActive = false
): ActionResult {
  const resolvedExe = expandWindowsEnvVars(appProfile.exePath.trim());
  if (!resolvedExe) {
    return { ok: false, message: '请先指定要代理启动的程序路径（.exe）' };
  }
  if (!fs.existsSync(resolvedExe)) {
    return { ok: false, message: `找不到可执行文件：${resolvedExe}` };
  }

  const hasElectronRuntime = hasElectronOrChromiumRuntimeFiles(resolvedExe);
  const isolatedProfileDir = appProfile.isolatedProfile
    ? resolveIsolatedAppProfileDir(appProfile.id)
    : undefined;

  const spec = buildProxiedAppLaunchSpec(appProfile, node, {
    hasElectronSiblingFiles: hasElectronRuntime,
    fallbackActive,
    isolatedProfileDir,
  });

  const resolvedCwd = appProfile.cwd?.trim()
    ? expandWindowsEnvVars(appProfile.cwd.trim())
    : path.dirname(resolvedExe);
  const effectiveCwd = fs.existsSync(resolvedCwd) ? resolvedCwd : undefined;

  try {
    const child = spawn(resolvedExe, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: effectiveCwd,
      env: {
        ...process.env,
        ...spec.envPatch,
      },
    });
    child.unref();

    const modeDesc =
      spec.effectiveMode === 'chromiumArgs'
        ? '环境变量 + Chromium/Electron --proxy-server'
        : '独立进程代理环境变量 (HTTP_PROXY / ALL_PROXY)';

    logger.success(
      'clientA',
      `已定向代理启动「${appProfile.name}」(${path.basename(resolvedExe)}) -> ${spec.httpProxyUrl} [${modeDesc}]（系统与其他应用未受影响）`
    );

    return {
      ok: true,
      message: `已定向代理启动「${appProfile.name}」（仅该进程走 127.0.0.1:${node.localPort}，系统与其他应用不受影响）`,
    };
  } catch (err) {
    const msg = `启动「${appProfile.name}」失败: ${(err as Error).message}`;
    logger.error('clientA', msg);
    return { ok: false, message: msg };
  }
}
