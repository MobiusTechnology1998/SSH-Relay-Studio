import type { ActionResult, FirewallRuleInfo } from '../../shared/types';
import { logger } from '../logger';
import { IS_WINDOWS, runPowerShell } from '../platform/shell';

export async function listSshFirewallRules(): Promise<FirewallRuleInfo[]> {
  if (!IS_WINDOWS) {
    return [];
  }

  const psScript = `
    $rules = Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -like '*OpenSSH*' -or
        $_.Name -like 'SSH-Port-*' -or
        $_.Name -like 'Hysteria2-UDP-*' -or
        $_.DisplayName -like '*OpenSSH*'
      }
    $result = @()
    foreach ($r in $rules) {
      $pf = $r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
      $result += [PSCustomObject]@{
        name = $r.Name
        displayName = $r.DisplayName
        enabled = ($r.Enabled.ToString() -eq 'True')
        action = $r.Action.ToString()
        localPort = if ($pf -and $pf.LocalPort) { ($pf.Protocol + ' ' + ($pf.LocalPort -join ',')) } else { '' }
      }
    }
    ConvertTo-Json -InputObject $result -Compress
  `;

  const res = await runPowerShell(psScript, 15000);
  if (res.code !== 0 || !res.stdout.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(res.stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function allowFirewallPort(port: number): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上配置系统防火墙' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: `无效端口号: ${port}` };
  }

  const ruleName = port === 22 ? 'OpenSSH-Server-In-TCP' : `SSH-Port-${port}`;
  const displayName =
    port === 22 ? 'OpenSSH Server (sshd)' : `OpenSSH Server (TCP ${port})`;

  const psScript = `
    $ErrorActionPreference = 'Stop'
    $existing = Get-NetFirewallRule -Name '${ruleName}' -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
      Enable-NetFirewallRule -Name '${ruleName}'
      Set-NetFirewallRule -Name '${ruleName}' -Action Allow -Direction Inbound
    } else {
      New-NetFirewallRule -Name '${ruleName}' -DisplayName '${displayName}' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort ${port} | Out-Null
    }
    Write-Output 'OK'
  `;

  const res = await runPowerShell(psScript, 15000);
  if (res.code !== 0) {
    const msg = `放行防火墙端口 ${port} 失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  logger.success('serverB', `已放行 Windows 防火墙入站规则 ${ruleName} (TCP ${port})`);
  return {
    ok: true,
    message: `已放行 Windows 防火墙 TCP ${port} 端口（规则名: ${ruleName}）`,
  };
}

export async function allowUdpFirewallPort(port: number): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上配置系统防火墙' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: `无效 UDP 端口号: ${port}` };
  }

  const ruleName = `Hysteria2-UDP-${port}`;
  const displayName = `SSH Relay Studio QUIC (UDP ${port})`;

  const psScript = `
    $ErrorActionPreference = 'Stop'
    $existing = Get-NetFirewallRule -Name '${ruleName}' -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
      Enable-NetFirewallRule -Name '${ruleName}'
      Set-NetFirewallRule -Name '${ruleName}' -Action Allow -Direction Inbound
    } else {
      New-NetFirewallRule -Name '${ruleName}' -DisplayName '${displayName}' -Enabled True -Direction Inbound -Protocol UDP -Action Allow -LocalPort ${port} | Out-Null
    }
    Write-Output 'OK'
  `;

  const res = await runPowerShell(psScript, 15000);
  if (res.code !== 0) {
    const msg = `放行防火墙 UDP 端口 ${port} 失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  logger.success('serverB', `已放行 Windows 防火墙入站规则 ${ruleName} (UDP ${port})`);
  return {
    ok: true,
    message: `已放行 Windows 防火墙 UDP ${port} 端口（规则名: ${ruleName}）`,
  };
}

/**
 * Precisely disables ONLY the old port 22 OpenSSH firewall rule(s) without ever touching
 * custom high-port rules such as SSH-Port-53622 (per ssh.md section 4.1 step 5).
 */
export async function disablePort22FirewallRule(): Promise<ActionResult> {
  if (!IS_WINDOWS) {
    return { ok: false, message: '仅支持在 Windows 设备 B 上禁用防火墙规则' };
  }

  const psScript = `
    $ErrorActionPreference = 'Stop'
    $disabled = @()
    $rules = Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq 'OpenSSH Server (sshd)' -or $_.Name -eq 'OpenSSH-Server-In-TCP' }
    foreach ($r in $rules) {
      $pf = $r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
      if ($null -eq $pf -or $pf.LocalPort -contains '22' -or $pf.LocalPort -eq '22') {
        Disable-NetFirewallRule -Name $r.Name
        $disabled += $r.Name
      }
    }
    Write-Output ($disabled -join ',')
  `;

  const res = await runPowerShell(psScript, 15000);
  if (res.code !== 0) {
    const msg = `禁用旧 22 端口规则失败: ${res.stderr.trim() || res.stdout.trim()}`;
    logger.error('serverB', msg);
    return { ok: false, message: msg };
  }

  const countText = res.stdout.trim();
  logger.success(
    'serverB',
    countText
      ? `已精准禁用旧 22 端口防火墙规则: ${countText}`
      : '未发现处于启用状态的 22 端口默认规则'
  );
  return {
    ok: true,
    message: countText
      ? `已精准禁用旧 22 端口防火墙规则 (${countText})，高位端口规则未受影响。`
      : '未发现需要禁用的 22 端口规则（或已处于禁用状态）',
  };
}
