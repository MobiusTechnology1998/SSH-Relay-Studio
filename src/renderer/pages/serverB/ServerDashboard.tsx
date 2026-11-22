import React, { useState } from 'react';
import { encodePairingToken } from '../../../shared/pairingCodec';
import type { EnvironmentInfo, ServerOverview } from '../../../shared/types';
import { IconCopy, IconRefresh, IconServer, IconShield } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { StatusBadge } from '../../components/StatusBadge';

interface ServerDashboardProps {
  envInfo: EnvironmentInfo | null;
  overview: ServerOverview | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
  onNavigate: (tab: string) => void;
}

export const ServerDashboard: React.FC<ServerDashboardProps> = ({
  envInfo,
  overview,
  loading,
  onRefresh,
  onNotify,
  onNavigate,
}) => {
  const [busy, setBusy] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [exportHost, setExportHost] = useState('');
  const [exportName, setExportName] = useState('');
  const [exportUser, setExportUser] = useState('Administrator');
  const [generatedToken, setGeneratedToken] = useState('');

  const openPairingModal = () => {
    const defaultHost = overview?.detectedPublicIp || overview?.localIps[0] || '';
    const defaultName = envInfo?.hostname ? `中转端 (${envInfo.hostname})` : '设备 B 中转节点';
    const defaultUser = envInfo?.username || 'Administrator';
    setExportHost(defaultHost);
    setExportName(defaultName);
    setExportUser(defaultUser);
    setGeneratedToken('');
    setPairingOpen(true);
  };

  const handleGenerateToken = () => {
    try {
      const token = encodePairingToken({
        version: 1,
        name: exportName,
        host: exportHost,
        sshPort: overview?.config.port ?? 53622,
        username: exportUser,
        hostPublicKey: overview?.hostPublicKey ?? undefined,
        createdAt: Date.now(),
      });
      setGeneratedToken(token);
    } catch (err) {
      onNotify('error', (err as Error).message);
    }
  };

  const handleCopyToken = async () => {
    if (!generatedToken) return;
    await window.relayApi.copyText(generatedToken);
    onNotify('success', '已复制配对码！在设备 A 的「节点管理」中粘贴即可一键导入并信任指纹。');
  };

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    try {
      const res = await window.relayApi.controlSshdService(action);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const svcRunning = overview?.service.status === 'Running';
  const hardened =
    overview &&
    overview.config.port !== 22 &&
    overview.config.pubkeyAuthentication &&
    !overview.config.passwordAuthentication;

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">设备 B 中转端总览</h1>
          <p className="page-desc">
            实时监控 OpenSSH 服务、监听端口、安全加固状态与来源 IP，支持一键导出配对码给设备 A
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={onRefresh} disabled={loading}>
            <IconRefresh size={15} />
            {loading ? '刷新中...' : '刷新状态'}
          </button>
          <button className="btn btn-primary" onClick={openPairingModal}>
            生成设备 A 配对码
          </button>
        </div>
      </div>

      {/* Top Health KPIs */}
      <div className="grid-4">
        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">OpenSSH 服务</span>
            <StatusBadge
              variant={svcRunning ? 'success' : overview?.service.installed ? 'warn' : 'danger'}
              label={
                svcRunning
                  ? '运行中'
                  : overview?.service.installed
                  ? overview.service.status
                  : '未安装'
              }
            />
          </div>
          <div className="metric-value" style={{ marginTop: 8 }}>
            sshd
          </div>
          <div className="metric-sub">
            启动类型：{overview?.service.startType ?? '--'} · 自愈：
            {overview?.service.failureRecoveryConfigured ? '已开启' : '未配置'}
          </div>
        </div>

        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">SSH 监听端口</span>
            <StatusBadge
              variant={overview?.config.port && overview.config.port !== 22 ? 'success' : 'warn'}
              label={overview?.config.port === 22 ? '默认 22' : '高位端口'}
            />
          </div>
          <div className="metric-value" style={{ marginTop: 8 }}>
            TCP {overview?.config.port ?? '--'}
          </div>
          <div className="metric-sub">
            密码登录：{overview?.config.passwordAuthentication ? '未关闭' : '已禁用'}
          </div>
        </div>

        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">已授权公钥</span>
            <StatusBadge
              variant={
                overview &&
                overview.authorizedKeys.keys.length > 0 &&
                overview.authorizedKeys.permissionsValid
                  ? 'success'
                  : 'warn'
              }
              label={overview?.authorizedKeys.permissionsValid ? '权限合规' : '需检查'}
            />
          </div>
          <div className="metric-value" style={{ marginTop: 8 }}>
            {overview?.authorizedKeys.keys.length ?? 0} 台设备
          </div>
          <div className="metric-sub">administrators_authorized_keys</div>
        </div>

        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">防自动更新重启</span>
            <StatusBadge
              variant={overview?.updatePolicy.autoRebootDisabled ? 'success' : 'neutral'}
              label={overview?.updatePolicy.autoRebootDisabled ? '已保护' : '系统默认'}
            />
          </div>
          <div className="metric-value" style={{ marginTop: 8, fontSize: 14.5 }}>
            {overview?.detectedPublicIp || overview?.localIps[0] || '未检测到 IP'}
          </div>
          <div className="metric-sub">检测到的公网/本机 IP</div>
        </div>
      </div>

      {/* Quick Control & Hardening Banner */}
      <div className="grid-2">
        <div className="card stack-sm">
          <div className="card-header" style={{ marginBottom: 4 }}>
            <div>
              <h3 className="card-title">
                <IconServer size={16} />
                sshd 服务控制与监听地址
              </h3>
              <p className="card-subtitle">管理 Windows 内置 OpenSSH Server 运行状态</p>
            </div>
          </div>

          <div className="row-wrap">
            <button
              className="btn btn-primary"
              onClick={() => handleServiceAction('start')}
              disabled={busy || !overview?.service.serviceExists}
            >
              启动 sshd
            </button>
            <button
              className="btn"
              onClick={() => handleServiceAction('restart')}
              disabled={busy || !overview?.service.serviceExists}
            >
              重启 sshd
            </button>
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--danger)' }}
              onClick={() => handleServiceAction('stop')}
              disabled={busy || !overview?.service.serviceExists}
            >
              停止
            </button>
          </div>

          <div className="callout" style={{ marginTop: 4 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>当前 LISTENING 地址：</div>
            {overview && overview.listeningPorts.length > 0 ? (
              <div className="mono" style={{ fontSize: 12.5 }}>
                {overview.listeningPorts.join('   |   ')}
              </div>
            ) : (
              <span>未检测到 SSH 监听端口（请先部署或启动 sshd 服务）</span>
            )}
          </div>
        </div>

        <div className="card stack-sm">
          <div className="card-header" style={{ marginBottom: 4 }}>
            <div>
              <h3 className="card-title">
                <IconShield size={16} />
                安全加固检查摘要
              </h3>
              <p className="card-subtitle">首次部署建议按防锁死向导逐步完成</p>
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => onNavigate('deploy')}>
              打开一键部署向导
            </button>
          </div>

          {hardened ? (
            <div className="callout callout-success">
              当前中转端已完成核心加固：高位端口 TCP {overview?.config.port}、仅限密钥登录、密码登录已关闭。
            </div>
          ) : (
            <div className="callout callout-warn">
              尚未完成完整加固（建议：追加设备 A 公钥 → 切换高位端口如 53622 → 关闭密码登录 → 禁用旧 22 端口规则）。
            </div>
          )}

          <div className="row-wrap">
            <button className="btn btn-sm" onClick={() => onNavigate('serverKeys')}>
              管理设备 A 公钥
            </button>
            <button className="btn btn-sm" onClick={() => onNavigate('hardening')}>
              防火墙与稳定性设置
            </button>
          </div>
        </div>
      </div>

      {/* Active SSH & RDP Connections (Source IP Lookup Tool per ssh.md 2.2) */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">当前活跃连接与设备 A 来源 IP 反查</h3>
            <p className="card-subtitle">
              若设备 A 无法直接查外网 IP，可通过当前连着本机的远程桌面（RDP :3389）或 SSH 连接直接反查设备 A 的出口 IP，用于配置云安全组白名单
            </p>
          </div>
        </div>

        {overview && overview.activeConnections.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>本机地址</th>
                  <th>外部来源 IP</th>
                  <th>完整远端地址</th>
                  <th>PID</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {overview.activeConnections.map((conn, idx) => (
                  <tr key={idx}>
                    <td>
                      <StatusBadge
                        variant={conn.category === 'ssh' ? 'success' : 'accent'}
                        dot={false}
                        label={conn.category === 'ssh' ? 'SSH 隧道' : 'RDP 远程桌面'}
                      />
                    </td>
                    <td className="mono">{conn.localAddress}</td>
                    <td className="mono" style={{ fontWeight: 650 }}>
                      {conn.remoteIp}
                    </td>
                    <td className="mono">{conn.remoteAddress}</td>
                    <td className="mono">{conn.pid}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={async () => {
                          await window.relayApi.copyText(`${conn.remoteIp}/32`);
                          onNotify('success', `已复制 ${conn.remoteIp}/32（可直接粘贴至云安全组源 IP）`);
                        }}
                      >
                        <IconCopy size={13} /> 复制 /32
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="callout">当前暂无活跃的 SSH 或 RDP (3389) 连接记录。</div>
        )}
      </div>

      {/* Pairing Code Export Modal */}
      <Modal
        open={pairingOpen}
        title="生成设备 A 专属配对码"
        subtitle="配对码包含公网 IP、高位 SSH 端口、用户名及本机主机公钥，设备 A 粘贴即可自动配置并信任指纹"
        onClose={() => setPairingOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setPairingOpen(false)}>
              关闭
            </button>
            <button className="btn btn-primary" onClick={handleGenerateToken}>
              生成配对码
            </button>
          </>
        }
      >
        <div className="field">
          <label className="field-label">节点显示名称</label>
          <input
            className="input"
            value={exportName}
            onChange={(e) => setExportName(e.target.value)}
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label className="field-label">设备 B 公网 IP / 域名</label>
            <input
              className="input mono"
              value={exportHost}
              onChange={(e) => setExportHost(e.target.value)}
              placeholder="例如 203.0.113.10"
            />
          </div>
          <div className="field">
            <label className="field-label">登录用户名</label>
            <input
              className="input mono"
              value={exportUser}
              onChange={(e) => setExportUser(e.target.value)}
            />
          </div>
        </div>
        <div className="callout">
          SSH 端口：<strong className="mono">{overview?.config.port ?? 53622}</strong> · 主机公钥：
          <strong>{overview?.hostPublicKey ? '已自动附带（A 端免手输 yes）' : '未读取到'}</strong>
        </div>

        {generatedToken && (
          <div className="stack-sm">
            <div className="code-block" style={{ fontSize: 11.5 }}>
              {generatedToken}
            </div>
            <button className="btn btn-success" onClick={handleCopyToken}>
              <IconCopy size={15} />
              复制配对码发给设备 A
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
};
