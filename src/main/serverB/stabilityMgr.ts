import type {
  ActionResult,
  ServerSystemTuningState,
  WindowsUpdatePolicyState,
} from '../../shared/types';
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

export async function getServerSystemTuning(): Promise<ServerSystemTuningState> {
  if (!IS_WINDOWS) {
    return {
      sleepDisabled: false,
      standbyTimeoutAcSec: null,
      tcpAutoTuning: 'Unknown',
      tcpCongestionProvider: 'Unknown',
      tcpEcnCapability: 'Unknown',
      tcpTimestamps: 'Unknown',
      tuned: false,
    };
  }

  // Use locale-independent Get-NetTCPSetting and hex parsing for powercfg AC standby timeout
  const psScript = `
    $tcp = Get-NetTCPSetting -SettingName Internet -ErrorAction SilentlyContinue | Select-Object -First 1
    $acSec = $null
    try {
      $pwrOut = powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null
      $hexMatches = [regex]::Matches(($pwrOut -join "\`n"), '0x([0-9a-fA-F]{8})')
      if ($hexMatches.Count -ge 2) {
        # The last two 8-digit hex values in STANDBYIDLE output are AC index then DC index
        $acHex = $hexMatches[$hexMatches.Count - 2].Groups[1].Value
        $acSec = [Convert]::ToInt32($acHex, 16)
      }
    } catch {}

    [PSCustomObject]@{
      standbyTimeoutAcSec = $acSec
      tcpAutoTuning = if ($tcp) { [string]$tcp.AutoTuningLevelLocal } else { 'Unknown' }
      tcpCongestionProvider = if ($tcp) { [string]$tcp.CongestionProvider } else { 'Unknown' }
      tcpEcnCapability = if ($tcp) { [string]$tcp.EcnCapability } else { 'Unknown' }
      tcpTimestamps = if ($tcp) { [string]$tcp.Timestamps } else { 'Unknown' }
    } | ConvertTo-Json -Compress
  `;

  const res = await runPowerShell(psScript, 15000);
  try {
    const parsed = JSON.parse(res.stdout.trim() || '{}');
    const standbyTimeoutAcSec =
      typeof parsed.standbyTimeoutAcSec === 'number' ? parsed.standbyTimeoutAcSec : null;
    const sleepDisabled = standbyTimeoutAcSec === 0;
    const tcpAutoTuning = String(parsed.tcpAutoTuning || 'Unknown');
    const tcpCongestionProvider = String(parsed.tcpCongestionProvider || 'Unknown');
    const tcpEcnCapability = String(parsed.tcpEcnCapability || 'Unknown');
    const tcpTimestamps = String(parsed.tcpTimestamps || 'Unknown');

    const congestionOk = /^(cubic|ctcp)$/i.test(tcpCongestionProvider);
    const autoTuneOk = /^normal$/i.test(tcpAutoTuning);
    const timestampsOk = /^enabled$/i.test(tcpTimestamps);

    return {
      sleepDisabled,
      standbyTimeoutAcSec,
      tcpAutoTuning,
      tcpCongestionProvider,
      tcpEcnCapability,
      tcpTimestamps,
      tuned: sleepDisabled && congestionOk && autoTuneOk && timestampsOk,
    };
  } catch {
    return {
      sleepDisabled: false,
      standbyTimeoutAcSec: null,
      tcpAutoTuning: 'Unknown',
      tcpCongestionProvider: 'Unknown',
      tcpEcnCapability: 'Unknown',
      tcpTimestamps: 'Unknown',
      tuned: false,
    };
  }
}

/**
 * Tunes Windows Device B for cross-border high-RTT weak-network relay stability & throughput:
 * - Disables AC sleep & hibernate so relay never suspends
 * - Disables physical NIC power-off saving (best effort)
 * - Enables TCP Receive Window Auto-Tuning (Normal), CUBIC (fallback CTCP) congestion control,
 *   TCP Timestamps (for accurate cross-border RTT/PAWS), and disables ECN (avoids middlebox drops).
 */
export async function applyServerSystemTuning(): Promise<ActionResult<ServerSystemTuningState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上应用系统网络与电源调优' };
  }

  const psScript = `
    $ErrorActionPreference = 'Stop'
    powercfg -change -standby-timeout-ac 0 | Out-Null
    powercfg -change -hibernate-timeout-ac 0 | Out-Null

    # Disable physical NIC sleep saving where supported (cloud vNICs may not support this, ignore errors)
    try {
      Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
        Disable-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue | Out-Null
      }
    } catch {}

    # Tune Internet TCP template for cross-border high-RTT & packet loss
    Set-NetTCPSetting -SettingName Internet -AutoTuningLevelLocal Normal -EcnCapability Disabled -Timestamps Enabled -ErrorAction Stop | Out-Null

    # Prefer CUBIC (best for cross-border high-RTT weak networks), fallback to CTCP on older Server versions
    try {
      Set-NetTCPSetting -SettingName Internet -CongestionProvider CUBIC -ErrorAction Stop | Out-Null
    } catch {
      try {
        Set-NetTCPSetting -SettingName Internet -CongestionProvider CTCP -ErrorAction Stop | Out-Null
      } catch {}
    }
  `;

  const res = await runPowerShell(psScript, 25000);
  if (res.code !== 0) {
    const msg = `应用系统网络与电源调优失败（请确认已以管理员身份运行）: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  const next = await getServerSystemTuning();
  logger.success(
    'serverB',
    `已完成设备 B 跨国弱网系统调优: 防休眠=${next.sleepDisabled ? '已关闭休眠' : '未知'}, 拥塞控制=${next.tcpCongestionProvider}, AutoTuning=${next.tcpAutoTuning}, Timestamps=${next.tcpTimestamps}, ECN=${next.tcpEcnCapability}`
  );
  return {
    ok: true,
    message: `已完成弱网系统调优（拥塞控制: ${next.tcpCongestionProvider}，接收窗口: ${next.tcpAutoTuning}，已禁止系统休眠）`,
    data: next,
  };
}
