import React, { useEffect, useState } from 'react';
import { formatSshCommandPreview } from '../../../shared/commandBuilders';
import type { AppSettings, NodeProfile, TunnelStatus } from '../../../shared/types';
import { IconGlobe, IconPower, IconRefresh, IconShield } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientDashboardProps {
  settings: AppSettings;
  tunnelStatus: TunnelStatus;
  activeNode: NodeProfile | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
  onNavigate: (tab: string) => void;
}

function formatDuration(sinceMs: number | null, nowMs: number): string {
  if (!sinceMs) return '--:--:--';
  const totalSec = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export const ClientDashboard: React.FC<ClientDashboardProps> = ({
  settings,
  tunnelStatus,
  activeNode,
  onUpdateSettings,
  onNotify,
  onNavigate,
}) => {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (tunnelStatus.state !== 'connected' && tunnelStatus.state !== 'reconnecting') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tunnelStatus.state]);

  const isRunning =
    tunnelStatus.state === 'connected' ||
    tunnelStatus.state === 'connecting' ||
    tunnelStatus.state === 'reconnecting';

  const retryCountdownSec =
    tunnelStatus.state === 'reconnecting' && tunnelStatus.nextRetryAt
      ? Math.max(0, Math.ceil((tunnelStatus.nextRetryAt - now) / 1000))
      : null;

  const statusMeta = {
    disconnected: { label: '隧道未连接', badge: 'neutral' as const },
    connecting: { label: '正在建立 SSH 隧道...', badge: 'warn' as const },
    connected: { label: '加密隧道运行中', badge: 'success' as const },
    reconnecting: {
      label:
        retryCountdownSec !== null && retryCountdownSec > 0
          ? `自动重连中（第 ${tunnelStatus.reconnectCount} 次，${retryCountdownSec}s 后重试）`
          : `断线自动重连中（第 ${tunnelStatus.reconnectCount} 次）`,
      badge: 'warn' as const,
    },
    error: { label: '连接异常', badge: 'danger' as const },
  }[tunnelStatus.state];

  const handleToggleTunnel = async () => {
    setBusy(true);
    try {
      if (isRunning) {
        const res = await window.relayApi.stopTunnel();
        onNotify(res.ok ? 'info' : 'error', res.message);
      } else {
        if (!activeNode) {
          onNotify('warn', '请先添加或导入一个设备 B 中转节点');
          onNavigate('nodes');
          return;
        }
        const res = await window.relayApi.startTunnel(activeNode.id);
        onNotify(res.ok ? 'success' : 'error', res.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReconnect = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.reconnectTunnel();
      onNotify(res.ok ? 'info' : 'error', res.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchBrowser = async () => {
    if (!activeNode) {
      onNotify('warn', '请先选择中转节点');
      return;
    }
    const res = await window.relayApi.launchProxyBrowser(activeNode, settings.browser);
    onNotify(res.ok ? 'success' : 'error', res.message);
  };

  const handleKillOrphans = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.killOrphanSsh();
      onNotify(res.ok ? 'success' : 'error', res.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAutoStartChange = async (checked: boolean) => {
    const res = await window.relayApi.setAutoStart(checked);
    await onUpdateSettings({ autoStart: checked });
    onNotify(res.ok ? 'success' : 'error', res.message);
  };

  const aliveInterval = activeNode?.serverAliveInterval ?? 15;
  const aliveCountMax = activeNode?.serverAliveCountMax ?? 3;

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">隧道控制台</h1>
          <p className="page-desc">
            一键管理加密隧道与弱网自愈守护（主动假死探活、休眠唤醒恢复、1s 起步指数退避重连）
          </p>
        </div>
        <div className="header-actions">
          <button
            className="btn"
            onClick={handleLaunchBrowser}
            disabled={!activeNode}
            title="打开独立用户数据目录的全站代理浏览器窗口"
          >
            <IconGlobe size={16} />
            启动独立代理浏览器
          </button>
        </div>
      </div>

      {/* Hero Connection Control */}
      <div className="hero-connect-card">
        <div className="hero-status-left">
          <div className={`status-orb ${tunnelStatus.state}`}>
            <IconPower size={24} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="hero-status-title">
              <span>{statusMeta.label}</span>
              <StatusBadge variant={statusMeta.badge} label={tunnelStatus.state.toUpperCase()} />
            </div>
            <div className="hero-status-meta">
              {activeNode ? (
                <>
                  <span>
                    节点：<strong>{activeNode.name}</strong>
                  </span>
                  <span className="mono">
                    {activeNode.username}@{activeNode.host}:{activeNode.sshPort}
                  </span>
                  <span className="mono">
                    本地入口：
                    {activeNode.mode === 'socks5' ? 'socks5://' : 'http://'}
                    127.0.0.1:{activeNode.localPort}
                  </span>
                </>
              ) : (
                <span>尚未配置中转节点，请先在「节点管理」中导入设备 B 配对码或手动新建。</span>
              )}
            </div>
          </div>
        </div>

        <div className="row-wrap" style={{ flexShrink: 0 }}>
          {isRunning && (
            <button
              className="btn btn-lg"
              onClick={handleReconnect}
              disabled={busy}
              title="休眠唤醒后立即重建连接"
            >
              <IconRefresh size={16} />
              立即重连
            </button>
          )}
          <button
            className={`btn btn-lg ${isRunning ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleToggleTunnel}
            disabled={busy}
          >
            <IconPower size={17} />
            {isRunning ? '断开隧道' : '启动隧道'}
          </button>
        </div>
      </div>

      {/* Error & Actionable Hint */}
      {tunnelStatus.lastError && (
        <div className="callout callout-danger stack-sm" style={{ gap: 6 }}>
          <div style={{ fontWeight: 650 }}>最近错误信息：{tunnelStatus.lastError}</div>
          {tunnelStatus.diagnosticHint && (
            <div style={{ fontSize: 13 }}>排查建议：{tunnelStatus.diagnosticHint}</div>
          )}
          <div className="row-wrap" style={{ marginTop: 4 }}>
            <button className="btn btn-sm" onClick={() => onNavigate('keys')}>
              前往密钥与指纹向导
            </button>
            <button className="btn btn-sm" onClick={handleKillOrphans}>
              清理残留 ssh.exe
            </button>
          </div>
        </div>
      )}

      {/* Live Metrics */}
      <div className="grid-4">
        <div className="metric-tile">
          <div className="metric-label">本地代理地址</div>
          <div className="metric-value">
            127.0.0.1:{activeNode?.localPort ?? 1080}
          </div>
          <div className="metric-sub">
            {activeNode?.mode === 'localForward'
              ? `转发至 B 端 :${activeNode.remoteProxyPort}`
              : 'SOCKS5 动态隧道 (-D)'}
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">连续运行时长</div>
          <div className="metric-value">
            {formatDuration(tunnelStatus.connectedSince, now)}
          </div>
          <div className="metric-sub">
            心跳保活：{aliveInterval}s × {aliveCountMax}
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">隧道端到端延迟</div>
          <div className="metric-value">
            {tunnelStatus.lastHealthLatencyMs !== null
              ? `${tunnelStatus.lastHealthLatencyMs} ms`
              : '--'}
          </div>
          <div className="metric-sub">
            PID: {tunnelStatus.pid ?? '--'} · 重连: {tunnelStatus.reconnectCount} 次
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">隔离浏览器</div>
          <div className="metric-value">
            {settings.browser.selectedBrowser === 'edge'
              ? 'Edge'
              : settings.browser.selectedBrowser === 'chrome'
              ? 'Chrome'
              : '自定义'}
          </div>
          <div className="metric-sub">
            {settings.browser.disableQuic !== false
              ? '已禁 QUIC（降低 HTTP/3 回退延迟）'
              : '独立用户目录，全站代理'}
          </div>
        </div>
      </div>

      {/* Quick Node Selector & Preferences */}
      <div className="grid-2">
        <div className="card stack-sm">
          <div className="card-header" style={{ marginBottom: 4 }}>
            <div>
              <h3 className="card-title">当前活动节点</h3>
              <p className="card-subtitle">切换节点后重新连接即可生效</p>
            </div>
            <button className="btn btn-sm" onClick={() => onNavigate('nodes')}>
              管理节点
            </button>
          </div>

          {settings.nodes.length === 0 ? (
            <div className="callout callout-accent">
              还没有设备 B 节点。点击上方「管理节点」导入设备 B 导出的配对码，或手动添加 IP 与端口。
            </div>
          ) : (
            <>
              <select
                className="select"
                value={activeNode?.id ?? ''}
                onChange={(e) => onUpdateSettings({ activeNodeId: e.target.value })}
              >
                {settings.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} — {n.host}:{n.sshPort} ({n.mode === 'socks5' ? 'SOCKS5' : '本地转发'})
                  </option>
                ))}
              </select>
              {activeNode && (
                <div className="code-block" style={{ fontSize: 11.5 }}>
                  {formatSshCommandPreview(activeNode)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="card stack-sm">
          <div className="card-header" style={{ marginBottom: 4 }}>
            <div>
              <h3 className="card-title">
                <IconShield size={16} />
                常驻与自启动行为
              </h3>
              <p className="card-subtitle">替代开机启动文件夹 VBS 脚本</p>
            </div>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.autoStart}
              onChange={(e) => handleAutoStartChange(e.target.checked)}
            />
            <span>Windows 开机自动启动本应用</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.autoConnectOnLaunch}
              onChange={(e) => onUpdateSettings({ autoConnectOnLaunch: e.target.checked })}
            />
            <span>应用启动后自动连接当前节点</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.minimizeToTray}
              onChange={(e) => onUpdateSettings({ minimizeToTray: e.target.checked })}
            />
            <span>关闭窗口时最小化到系统托盘（保持隧道在线）</span>
          </label>

          <div className="row-wrap" style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={() => onNavigate('tools')}>
              链路自检 & 出口 IP 核验
            </button>
            <button className="btn btn-sm" onClick={handleKillOrphans} disabled={busy}>
              强制清理残留 ssh.exe
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
