import type { ActionResult, OpenSshServiceStatus } from '../../shared/types';
import { logger } from '../logger';
import { detectOpenSshVersion, execCmd, IS_WINDOWS, runPowerShell } from '../platform/shell';

/**
 * Pure parser for `sc.exe qfailure sshd` supporting both English (`RESTART`) and Chinese (`重新启动`) Windows.
 */
export function parseScQfailureOutput(output: string): boolean {
  return /(RESTART|重新启动|重啟|NEUSTART|RED[EÉ]MARRER)/i.test(output) && /\b5000\b/.test(output);
}

export async function getOpenSshServiceStatus(): Promise<OpenSshServiceStatus> {
  if (!IS_WINDOWS) {
    return {
      installed: false,
      capabilityName: 'OpenSSH.Server~~~~0.0.1.0',
      serviceExists: false,
      status: 'NotInstalled',
      startType: 'Unknown',
      failureRecoveryConfigured: false,
      failureRecoveryDetail: '非 Windows 环境（仅在 Windows 目标机上检测）',
      sshdVersion: await detectOpenSshVersion('ssh'),
    };
  }

  const psScript = `
    $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue | Select-Object -First 1
    $regFailureOk = $false
    try {
      $fa = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\sshd' -Name 'FailureActions' -ErrorAction SilentlyContinue).FailureActions
      # SERVICE_FAILURE_ACTIONS binary layout: 20-byte header, then { uint32 Type (1=RESTART), uint32 DelayMs } entries
      if ($fa -and $fa.Length -ge 28) {
        $actionType = [BitConverter]::ToUInt32($fa, 20)
        $delayMs = [BitConverter]::ToUInt32($fa, 24)
        if ($actionType -eq 1 -and $delayMs -gt 0 -and $delayMs -le 60000) {
          $regFailureOk = $true
        }
      }
    } catch {}
    $obj = [PSCustomObject]@{
      serviceExists = [bool]($null -ne $svc)
      status = if ($svc) { $svc.Status.ToString() } else { 'NotInstalled' }
      startType = if ($svc) { $svc.StartType.ToString() } else { 'Unknown' }
      installed = if ($cap) { $cap.State -eq 'Installed' } else { [bool]($null -ne $svc) }
      capabilityName = if ($cap) { $cap.Name } else { 'OpenSSH.Server~~~~0.0.1.0' }
      regFailureOk = $regFailureOk
    }
    $obj | ConvertTo-Json -Compress
  `;

  const [res, sshdVersion] = await Promise.all([
    runPowerShell(psScript, 20000),
    detectOpenSshVersion('sshd'),
  ]);
  let parsed: {
    serviceExists?: boolean;
    status?: string;
    startType?: string;
    installed?: boolean;
    capabilityName?: string;
    regFailureOk?: boolean;
  } = {};

  try {
    if (res.stdout.trim()) {
      parsed = JSON.parse(res.stdout.trim());
    }
  } catch {
    logger.warn('serverB', `解析 OpenSSH 服务状态输出失败: ${res.stdout}`);
  }

  // Locale-independent check: prefer Windows registry FailureActions binary, fallback to sc.exe qfailure
  let failureRecoveryConfigured = Boolean(parsed.regFailureOk);
  let failureRecoveryDetail = failureRecoveryConfigured
    ? '已配置（异常退出 5 秒自动拉起，重置周期 86400 秒）'
    : '未配置崩溃自动重启';
  if (parsed.serviceExists && !failureRecoveryConfigured) {
    const qf = await execCmd('sc.exe', ['qfailure', 'sshd'], { timeoutMs: 8000 });
    const out = `${qf.stdout}\n${qf.stderr}`;
    const hasRestart = parseScQfailureOutput(out);
    failureRecoveryConfigured = hasRestart;
    failureRecoveryDetail = hasRestart
      ? '已配置（异常退出 5 秒自动拉起，重置周期 86400 秒）'
      : '未配置崩溃自动拉起策略';
  }

  const normalizedStatus: OpenSshServiceStatus['status'] =
    parsed.status === 'Running'
      ? 'Running'
      : parsed.status === 'Stopped'
      ? 'Stopped'
      : parsed.serviceExists
      ? 'Unknown'
      : 'NotInstalled';

  return {
    installed: Boolean(parsed.installed || parsed.serviceExists),
    capabilityName: parsed.capabilityName || 'OpenSSH.Server~~~~0.0.1.0',
    serviceExists: Boolean(parsed.serviceExists),
    status: normalizedStatus,
    startType: parsed.startType || 'Unknown',
    failureRecoveryConfigured,
    failureRecoveryDetail,
    sshdVersion,
  };
}

export async function installOpenSshServer(): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上安装 OpenSSH Server' };
  }

  logger.info('serverB', '正在检测并安装 Windows 内置 OpenSSH Server 组件...');
  const psScript = `
    $ErrorActionPreference = 'Stop'
    $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
    if ($null -eq $cap) {
      throw '系统未找到 OpenSSH.Server 可选功能，请确认 Windows 版本（需 Win10 1809+ 或 Server 2019+）。'
    }
    if ($cap.State -ne 'Installed') {
      Add-WindowsCapability -Online -Name $cap.Name | Out-Null
    }
    Start-Service sshd
    Set-Service -Name sshd -StartupType Automatic
    Write-Output "Installed:$($cap.Name)"
  `;

  const res = await runPowerShell(psScript, 180000);
  if (res.code !== 0) {
    const msg = `安装 OpenSSH Server 失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  logger.success('serverB', 'OpenSSH Server 已安装并启动（已设为开机自启）');
  return { ok: true, message: 'OpenSSH Server 已安装、启动并设为开机自启' };
}

export async function controlSshdService(
  action: 'start' | 'stop' | 'restart'
): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上控制 sshd 服务' };
  }

  const cmdMap = {
    start: 'Start-Service sshd; Set-Service -Name sshd -StartupType Automatic',
    stop: 'Stop-Service sshd -Force',
    restart: 'Restart-Service sshd -Force; Set-Service -Name sshd -StartupType Automatic',
  };

  const res = await runPowerShell(`$ErrorActionPreference = 'Stop'; ${cmdMap[action]}`, 20000);
  if (res.code !== 0) {
    const msg = `执行 sshd ${action} 失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
  logger.success('serverB', `sshd 服务${label}成功`);
  return { ok: true, message: `sshd 服务已${label}` };
}

export async function configureSshdFailureRecovery(): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上配置服务自愈' };
  }

  const current = await getOpenSshServiceStatus();
  if (current.serviceExists && current.startType === 'Automatic' && current.failureRecoveryConfigured) {
    return { ok: true, message: 'sshd 开机自启与崩溃 5 秒自愈已生效，无需重复配置' };
  }

  // Set Automatic start + sc.exe failure recovery (note required space after '=' in sc.exe)
  const autoRes = await runPowerShell(
    `$ErrorActionPreference = 'Stop'; Set-Service -Name sshd -StartupType Automatic`,
    10000
  );
  if (autoRes.code !== 0) {
    const msg = `设置 sshd 开机自启失败: ${autoRes.stderr.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  const scRes = await execCmd(
    'sc.exe',
    ['failure', 'sshd', 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/5000'],
    { timeoutMs: 10000 }
  );

  if (scRes.code !== 0) {
    const msg = `配置 sshd 崩溃自愈失败: ${scRes.stderr.trim() || scRes.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  logger.success('serverB', '已配置 sshd 开机自启及崩溃 5 秒自动拉起策略');
  return { ok: true, message: '已成功配置 sshd 开机自启与崩溃 5 秒自动重启' };
}
