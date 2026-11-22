import React, { useEffect, useState } from 'react';
import type { ServerOverview } from '../../../shared/types';
import { IconShield, IconWrench } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ServerHardeningProps {
  overview: ServerOverview | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

export const ServerHardening: React.FC<ServerHardeningProps> = ({
  overview,
  onRefresh,
  onNotify,
}) => {
  const [port, setPort] = useState(overview?.config.port ?? 53622);
  const [pubkeyAuth, setPubkeyAuth] = useState(overview?.config.pubkeyAuthentication ?? true);
  const [passwordAuth, setPasswordAuth] = useState(
    overview?.config.passwordAuthentication ?? false
  );
  const [customFwPort, setCustomFwPort] = useState(53622);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!overview) return;
    setPort(overview.config.port);
    setPubkeyAuth(overview.config.pubkeyAuthentication);
    setPasswordAuth(overview.config.passwordAuthentication);
    setCustomFwPort(overview.config.port === 22 ? 53622 : overview.config.port);
  }, [overview?.config.port, overview?.config.pubkeyAuthentication, overview?.config.passwordAuthentication]);

  const handleSaveSshdConfig = async (andRestart: boolean) => {
    if (!passwordAuth && (!overview || overview.authorizedKeys.keys.length === 0)) {
      onNotify('error', '防锁死拦截：尚未配置任何授权公钥，不允许关闭密码登录！');
      return;
    }
    setBusy(true);
    try {
      const res = await window.relayApi.applySshdConfig({
        port,
        pubkeyAuthentication: pubkeyAuth,
        passwordAuthentication: passwordAuth,
      });
      if (!res.ok) {
        onNotify('error', res.message);
        return;
      }
      if (andRestart) {
        const rr = await window.relayApi.controlSshdService('restart');
        onNotify(rr.ok ? 'success' : 'error', rr.ok ? '配置已保存并重启 sshd 生效' : rr.message);
      } else {
        onNotify('success', res.message);
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreBackup = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.restoreSshdConfigBackup();
      onNotify(res.ok ? 'warn' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleAllowPort = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.allowFirewallPort(customFwPort);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDisable22 = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.disablePort22FirewallRule();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleFailureRecovery = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.configureSshdFailureRecovery();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAutoReboot = async (disable: boolean) => {
    setBusy(true);
    try {
      const res = await window.relayApi.setDisableAutoReboot(disable);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">安全加固、防火墙与长期稳定性</h1>
          <p className="page-desc">
            精细化管理 <code className="mono">sshd_config</code>、Windows 防火墙规则、服务异常拉起与 Windows 更新防重启策略
          </p>
        </div>
      </div>

      {/* sshd_config Visual Editor */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconWrench size={16} />
              sshd_config 可视化配置（自动备份与 sshd -t 语法校验）
            </h3>
            <p className="card-subtitle">
              配置文件路径：<code className="mono">{overview?.config.path ?? 'C:\\ProgramData\\ssh\\sshd_config'}</code>
              {overview?.config.hasMatchAdminBlock ? ' · 已检测到 Match Group administrators 块（将完整保留）' : ''}
            </p>
          </div>
          {overview?.config.backupExists && (
            <button className="btn btn-sm" onClick={handleRestoreBackup} disabled={busy}>
              从 .bak 恢复
            </button>
          )}
        </div>

        <div className="grid-3">
          <div className="field">
            <label className="field-label">SSH 监听端口 (Port)</label>
            <input
              className="input mono"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 22)}
            />
          </div>

          <div className="field" style={{ justifyContent: 'center' }}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={pubkeyAuth}
                onChange={(e) => setPubkeyAuth(e.target.checked)}
              />
              <span>PubkeyAuthentication yes</span>
            </label>
          </div>

          <div className="field" style={{ justifyContent: 'center' }}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={!passwordAuth}
                onChange={(e) => setPasswordAuth(!e.target.checked)}
              />
              <span>关闭密码登录 (PasswordAuthentication no)</span>
            </label>
          </div>
        </div>

        <div className="row-wrap" style={{ marginTop: 4 }}>
          <button
            className="btn btn-primary"
            onClick={() => handleSaveSshdConfig(true)}
            disabled={busy}
          >
            校验保存并重启 sshd
          </button>
          <button
            className="btn"
            onClick={() => handleSaveSshdConfig(false)}
            disabled={busy}
          >
            仅校验并保存（稍后重启）
          </button>
        </div>
      </div>

      {/* Firewall Manager */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconShield size={16} />
              Windows 防火墙 SSH 入站规则
            </h3>
            <p className="card-subtitle">
              独立命名规则放行高位端口，禁用 22 端口时绝不误删自定义端口规则
            </p>
          </div>
        </div>

        <div className="row-wrap">
          <input
            className="input mono"
            type="number"
            style={{ width: 130 }}
            value={customFwPort}
            onChange={(e) => setCustomFwPort(Number(e.target.value) || 53622)}
          />
          <button className="btn btn-primary" onClick={handleAllowPort} disabled={busy}>
            放行 TCP {customFwPort}
          </button>
          <button className="btn" onClick={handleDisable22} disabled={busy}>
            精准禁用旧 22 端口规则
          </button>
        </div>

        {overview && overview.firewallRules.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>规则名称</th>
                  <th>显示名称</th>
                  <th>端口</th>
                  <th>动作</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {overview.firewallRules.map((rule) => (
                  <tr key={rule.name}>
                    <td className="mono">{rule.name}</td>
                    <td>{rule.displayName}</td>
                    <td className="mono">{rule.localPort || '--'}</td>
                    <td>{rule.action}</td>
                    <td>
                      <StatusBadge
                        variant={rule.enabled ? 'success' : 'neutral'}
                        label={rule.enabled ? '已启用' : '已禁用'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="callout">未检测到 OpenSSH 相关入站防火墙规则。</div>
        )}
      </div>

      {/* Stability Cards */}
      <div className="grid-2">
        <div className="card stack-sm">
          <div className="row-between">
            <h3 className="card-title">sshd 崩溃自动拉起</h3>
            <StatusBadge
              variant={overview?.service.failureRecoveryConfigured ? 'success' : 'warn'}
              label={overview?.service.failureRecoveryConfigured ? '已启用' : '未配置'}
            />
          </div>
          <p className="card-subtitle">
            {overview?.service.failureRecoveryDetail ||
              '设置服务开机自启，并在异常崩溃时 5 秒后自动重启（sc.exe failure sshd）。'}
          </p>
          <div>
            <button className="btn btn-primary" onClick={handleFailureRecovery} disabled={busy}>
              配置 5 秒崩溃自愈
            </button>
          </div>
        </div>

        <div className="card stack-sm">
          <div className="row-between">
            <h3 className="card-title">禁止 Windows 自动更新重启</h3>
            <StatusBadge
              variant={overview?.updatePolicy.autoRebootDisabled ? 'success' : 'neutral'}
              label={overview?.updatePolicy.autoRebootDisabled ? '已禁用自动重启' : '系统默认'}
            />
          </div>
          <p className="card-subtitle">
            当前注册表值：AUOptions ={' '}
            <code className="mono">{overview?.updatePolicy.auOptions ?? '未设置'}</code>，
            NoAutoRebootWithLoggedOnUsers ={' '}
            <code className="mono">
              {overview?.updatePolicy.noAutoRebootWithLoggedOnUsers ?? '未设置'}
            </code>
          </p>
          <div className="row-wrap">
            <button
              className="btn btn-primary"
              onClick={() => handleToggleAutoReboot(true)}
              disabled={busy}
            >
              禁止自动重启
            </button>
            {overview?.updatePolicy.autoRebootDisabled && (
              <button
                className="btn"
                onClick={() => handleToggleAutoReboot(false)}
                disabled={busy}
              >
                恢复默认策略
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
