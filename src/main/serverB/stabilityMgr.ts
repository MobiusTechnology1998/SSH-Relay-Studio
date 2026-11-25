import { parseRegQueryDwords } from '../../shared/commandBuilders';
import type {
  ActionResult,
  ServerSystemTuningState,
  WindowsUpdatePolicyState,
} from '../../shared/types';
import { logger } from '../logger';
import { execCmd, IS_WINDOWS, runPowerShell } from '../platform/shell';

export async function getWindowsUpdatePolicy(): Promise<WindowsUpdatePolicyState> {
  if (!IS_WINDOWS) {
    return {
      auOptions: null,
      noAutoRebootWithLoggedOnUsers: null,
      autoRebootDisabled: false,
    };
  }

  // Fast native Win32 registry query (~20ms) instead of spawning an extra PowerShell process
  const res = await execCmd(
    'reg.exe',
    ['query', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'],
    { timeoutMs: 6000 }
  );
  if (res.code !== 0 || !res.stdout) {
    return {
      auOptions: null,
      noAutoRebootWithLoggedOnUsers: null,
      autoRebootDisabled: false,
    };
  }

  const dwords = parseRegQueryDwords(res.stdout);
  const auOptions = typeof dwords.AUOptions === 'number' ? dwords.AUOptions : null;
  const noAutoReboot =
    typeof dwords.NoAutoRebootWithLoggedOnUsers === 'number'
      ? dwords.NoAutoRebootWithLoggedOnUsers
      : null;
  return {
    auOptions,
    noAutoRebootWithLoggedOnUsers: noAutoReboot,
    autoRebootDisabled: auOptions === 2 && noAutoReboot === 1,
  };
}

export async function setDisableAutoReboot(disable: boolean): Promise<ActionResult<WindowsUpdatePolicyState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上修改 Windows Update 策略' };
  }

  const current = await getWindowsUpdatePolicy();
  if (disable && current.autoRebootDisabled) {
    return {
      ok: true,
      message: '禁止 Windows 自动更新重启策略已生效，无需重复配置',
      data: current,
    };
  }
  if (!disable && !current.autoRebootDisabled && current.auOptions === null && current.noAutoRebootWithLoggedOnUsers === null) {
    return {
      ok: true,
      message: '当前已是系统默认更新策略，无需重复修改',
      data: current,
    };
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
    $sleepSupported = $true
    try {
      $pwrOut = powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null
      $joined = ($pwrOut -join "\`n")
      $hexMatches = [regex]::Matches($joined, '0x([0-9a-fA-F]{8})')
      if ($hexMatches.Count -ge 2) {
        $acHex = $hexMatches[$hexMatches.Count - 2].Groups[1].Value
        $acSec = [Convert]::ToInt32($acHex, 16)
      } else {
        # Cloud VMs / Servers without ACPI S3 sleep do not expose STANDBYIDLE
        $sleepSupported = $false
      }
    } catch {
      $sleepSupported = $false
    }

    [PSCustomObject]@{
      standbyTimeoutAcSec = $acSec
      sleepSupported = $sleepSupported
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
    // Cloud VMs without sleep support (sleepSupported === false) cannot sleep, so sleep is effectively disabled
    const sleepDisabled = standbyTimeoutAcSec === 0 || parsed.sleepSupported === false;
    const tcpAutoTuning = String(parsed.tcpAutoTuning || 'Unknown');
    const tcpCongestionProvider = String(parsed.tcpCongestionProvider || 'Unknown');
    const tcpEcnCapability = String(parsed.tcpEcnCapability || 'Unknown');
    const tcpTimestamps = String(parsed.tcpTimestamps || 'Unknown');

    const autoTuneOk = /^normal$/i.test(tcpAutoTuning);
    const timestampsOk = /^enabled$/i.test(tcpTimestamps);
    const ecnOk = /^disabled$/i.test(tcpEcnCapability);

    return {
      sleepDisabled,
      standbyTimeoutAcSec,
      tcpAutoTuning,
      tcpCongestionProvider,
      tcpEcnCapability,
      tcpTimestamps,
      tuned: sleepDisabled && autoTuneOk && timestampsOk && ecnOk,
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
 * - Enables TCP Receive Window Auto-Tuning (Normal), CUBIC (fallback CTCP) via `netsh int tcp set supplemental`
 *   (because `Set-NetTCPSetting -SettingName Internet -CongestionProvider` is read-only on Windows Server/Win10+),
 *   enables TCP Timestamps, and disables ECN.
 */
export async function applyServerSystemTuning(): Promise<ActionResult<ServerSystemTuningState>> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上应用系统网络与电源调优' };
  }

  const current = await getServerSystemTuning();
  if (current.tuned && /^(cubic|ctcp)$/i.test(current.tcpCongestionProvider)) {
    return {
      ok: true,
      message: `跨国弱网 TCP 与防休眠调优已生效（拥塞控制: ${current.tcpCongestionProvider}），无需重复应用`,
      data: current,
    };
  }

  const psScript = `
    $ErrorActionPreference = 'Continue'
    powercfg -change -standby-timeout-ac 0 2>$null | Out-Null
    powercfg -change -hibernate-timeout-ac 0 2>$null | Out-Null

    try {
      Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
        Disable-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue | Out-Null
      }
    } catch {}

    # Set global TCP window auto-tuning, timestamps, and disable ECN
    netsh int tcp set global autotuninglevel=normal ecncapability=disabled timestamps=enabled 2>$null | Out-Null
    try {
      Set-NetTCPSetting -SettingName Internet -AutoTuningLevelLocal Normal -EcnCapability Disabled -Timestamps Enabled -ErrorAction SilentlyContinue | Out-Null
    } catch {}

    # Official way to switch Internet template CongestionProvider on Windows 10/11 & Server 2019/2022
    $cubicRes = netsh int tcp set supplemental template=internet congestionprovider=cubic 2>&1
    if ($LASTEXITCODE -ne 0) {
      netsh int tcp set supplemental template=internet congestionprovider=ctcp 2>$null | Out-Null
    }
  `;

  const res = await runPowerShell(psScript, 25000);
  const next = await getServerSystemTuning();

  if (res.code !== 0 && !next.tuned) {
    const msg = `应用系统网络与电源调优失败（请确认已以管理员身份运行）: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg, data: next };
  }

  logger.success(
    'serverB',
    `已完成设备 B 跨国弱网系统调优: 防休眠=${next.sleepDisabled ? '已生效' : '未生效'}, 拥塞控制=${next.tcpCongestionProvider}, AutoTuning=${next.tcpAutoTuning}, Timestamps=${next.tcpTimestamps}, ECN=${next.tcpEcnCapability}`
  );
  return {
    ok: true,
    message: next.tuned
      ? `弱网系统调优已生效（拥塞控制: ${next.tcpCongestionProvider}，窗口: ${next.tcpAutoTuning}，防休眠已开启）`
      : `已执行调优命令，当前状态：拥塞控制=${next.tcpCongestionProvider}、窗口=${next.tcpAutoTuning}、Timestamps=${next.tcpTimestamps}`,
    data: next,
  };
}
