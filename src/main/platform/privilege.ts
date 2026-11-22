import { app } from 'electron';
import { execCmd, IS_WINDOWS, runPowerShell } from './shell';
import type { ActionResult } from '../../shared/types';

let cachedAdminStatus: boolean | null = null;

/**
 * Checks if the current process is running with Windows Administrator privileges.
 */
export async function checkIsAdmin(forceRefresh = false): Promise<boolean> {
  if (!IS_WINDOWS) {
    return false;
  }
  if (cachedAdminStatus !== null && !forceRefresh) {
    return cachedAdminStatus;
  }
  const res = await execCmd('net', ['session'], { timeoutMs: 4000 });
  cachedAdminStatus = res.code === 0;
  return cachedAdminStatus;
}

/**
 * Relaunches the current Electron application with UAC Administrator elevation,
 * preserving the selected role (`--role=serverB`) so the user lands directly on Device B.
 */
export async function relaunchAsAdmin(targetRole: 'serverB' | 'clientA' = 'serverB'): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return {
      ok: false,
      message: '当前非 Windows 环境，无需 UAC 提权。',
    };
  }

  const exePath = process.execPath;
  const args: string[] = [];

  // In dev mode (electron.exe <appPath>), preserve the app path argument
  if (!app.isPackaged && process.argv.length > 1) {
    args.push(process.argv[1]);
  }
  args.push(`--role=${targetRole}`, '--elevated-relaunch');

  const escapedExe = exePath.replace(/'/g, "''");
  const escapedArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(', ');

  const psScript = `
    try {
      Start-Process -FilePath '${escapedExe}' -ArgumentList @(${escapedArgs}) -Verb RunAs
      Write-Output "OK"
    } catch {
      Write-Error $_.Exception.Message
      exit 1
    }
  `;

  // Release single instance lock before launching elevated instance
  app.releaseSingleInstanceLock();
  const res = await runPowerShell(psScript, 15000);
  if (res.code !== 0) {
    // Re-acquire lock if user cancelled UAC prompt
    app.requestSingleInstanceLock();
    return {
      ok: false,
      message: `管理员提权已取消或失败: ${res.stderr.trim() || '用户拒绝 UAC 请求'}`,
    };
  }

  setTimeout(() => {
    app.quit();
  }, 300);

  return {
    ok: true,
    message: '正在以管理员身份重新启动应用...',
  };
}
