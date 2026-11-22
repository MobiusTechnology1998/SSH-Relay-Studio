import type { ActionResult, WindowsUpdatePolicyState } from '../../shared/types';
import { logger } from '../logger';
import { IS_WINDOWS, runPowerShell } from '../platform/shell';

export async function getWindowsUpdatePolicy(): Promise<WindowsUpdatePolicyState> {
  if (!IS_WINDOWS) {
    return {
      auOptions: null,
      noAutoRebootWithLoggedOnUsers: null,
      autoRebootDisabled: false,
    };
  }

  const psScript = `
    $auPath = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
    if (Test-Path $auPath) {
      $props = Get-ItemProperty -Path $auPath -ErrorAction SilentlyContinue
      [PSCustomObject]@{
        auOptions = $props.AUOptions
        noAutoRebootWithLoggedOnUsers = $props.NoAutoRebootWithLoggedOnUsers
      } | ConvertTo-Json -Compress
    } else {
      '{"auOptions":null,"noAutoRebootWithLoggedOnUsers":null}'
    }
  `;

  const res = await runPowerShell(psScript, 10000);
  try {
    const parsed = JSON.parse(res.stdout.trim() || '{}');
    const auOptions = typeof parsed.auOptions === 'number' ? parsed.auOptions : null;
    const noAutoReboot =
      typeof parsed.noAutoRebootWithLoggedOnUsers === 'number'
        ? parsed.noAutoRebootWithLoggedOnUsers
        : null;
    return {
      auOptions,
      noAutoRebootWithLoggedOnUsers: noAutoReboot,
      autoRebootDisabled: auOptions === 2 && noAutoReboot === 1,
    };
  } catch {
    return {
      auOptions: null,
      noAutoRebootWithLoggedOnUsers: null,
      autoRebootDisabled: false,
    };
  }
}

export async function setDisableAutoReboot(disable: boolean): Promise<ActionResult<WindowsUpdatePolicyState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上修改 Windows Update 策略' };
  }

  const psScript = disable
    ? `
      $ErrorActionPreference = 'Stop'
      $auPath = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
      if (!(Test-Path $auPath)) { New-Item -Path $auPath -Force | Out-Null }
      Set-ItemProperty -Path $auPath -Name 'AUOptions' -Value 2 -Type DWord
      Set-ItemProperty -Path $auPath -Name 'NoAutoRebootWithLoggedOnUsers' -Value 1 -Type DWord
      gpupdate /force | Out-Null
    `
    : `
      $ErrorActionPreference = 'Stop'
      $auPath = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
      if (Test-Path $auPath) {
        Remove-ItemProperty -Path $auPath -Name 'AUOptions' -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path $auPath -Name 'NoAutoRebootWithLoggedOnUsers' -ErrorAction SilentlyContinue
      }
      gpupdate /force | Out-Null
    `;

  const res = await runPowerShell(psScript, 30000);
  if (res.code !== 0) {
    const msg = `修改 Windows 更新自动重启策略失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  const next = await getWindowsUpdatePolicy();
  logger.success(
    'serverB',
    disable
      ? '已禁用 Windows 更新自动安装与强制重启（AUOptions=2, NoAutoRebootWithLoggedOnUsers=1）'
      : '已恢复 Windows 更新默认重启策略'
  );

  return {
    ok: true,
    message: disable
      ? '已禁止 Windows 自动更新重启干扰（已执行 gpupdate /force 生效）'
      : '已恢复系统默认 Windows 更新策略',
    data: next,
  };
}
