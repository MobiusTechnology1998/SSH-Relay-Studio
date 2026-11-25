import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppRole,
  AppSettings,
  EnvironmentInfo,
  LogEntry,
  ServerOverview,
  TunnelStatus,
} from '../shared/types';
import {
  IconActivity,
  IconKey,
  IconLaptop,
  IconNodes,
  IconPower,
  IconServer,
  IconShield,
} from './components/Icons';
import { LogDrawer } from './components/LogDrawer';
import { RoleSelector } from './components/RoleSelector';
import { StatusBadge } from './components/StatusBadge';
import { ClientDashboard } from './pages/clientA/ClientDashboard';
import { ClientKeysPairing } from './pages/clientA/ClientKeysPairing';
import { ClientNodes } from './pages/clientA/ClientNodes';
import { ClientTools } from './pages/clientA/ClientTools';
import { ServerDashboard } from './pages/serverB/ServerDashboard';
import { ServerHardening } from './pages/serverB/ServerHardening';
import { ServerKeys } from './pages/serverB/ServerKeys';

interface ToastItem {
  id: number;
  type: 'success' | 'error' | 'warn' | 'info';
  message: string;
}

const DEFAULT_TUNNEL_STATUS: TunnelStatus = {
  state: 'disconnected',
  nodeId: null,
  nodeName: null,
  mode: 'socks5',
  activeEngine: 'openssh',
  fallbackActive: false,
  localPort: 1080,
  pid: null,
  connectedSince: null,
  reconnectCount: 0,
  nextRetryAt: null,
  lastHealthCheckAt: null,
  lastHealthLatencyMs: null,
  poolSize: 3,
  healthyWorkers: 0,
  activeConnections: 0,
  totalBytesUp: 0,
  totalBytesDown: 0,
  speedUpBps: 0,
  speedDownBps: 0,
  workers: [],
  lastError: null,
  diagnosticHint: null,
};

export const App: React.FC = () => {
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>(DEFAULT_TUNNEL_STATUS);
  const [serverOverview, setServerOverview] = useState<ServerOverview | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const notify = useCallback(
    (type: ToastItem['type'], message: string) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev.slice(-3), { id, type, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4200);
    },
    []
  );

  const refreshEnvInfo = useCallback(async () => {
    const env = await window.relayApi.getEnvInfo();
    setEnvInfo(env);
  }, []);

  const refreshServerOverview = useCallback(async (forceRefresh = false) => {
    setServerLoading(true);
    try {
      const data = await window.relayApi.getServerOverview(forceRefresh);
      setServerOverview(data);
    } finally {
      setServerLoading(false);
    }
  }, []);

  useEffect(() => {
    let unsubTunnel = () => {};
    let unsubLogs = () => {};

    async function bootstrap() {
      const [env, loadedSettings, status, initialLogs] = await Promise.all([
        window.relayApi.getEnvInfo(),
        window.relayApi.getSettings(),
        window.relayApi.getTunnelStatus(),
        window.relayApi.getLogs(),
      ]);
      setEnvInfo(env);
      setSettings(loadedSettings);
      setTunnelStatus(status);
      setLogs(initialLogs);

      if (loadedSettings.role === 'serverB') {
        setActiveTab('serverDashboard');
        refreshServerOverview();
      } else {
        setActiveTab('dashboard');
      }

      unsubTunnel = window.relayApi.onTunnelStatus((next) => setTunnelStatus(next));
      unsubLogs = window.relayApi.onLogEntry((entry) =>
        setLogs((prev) => [...prev.slice(-399), entry])
      );
    }

    bootstrap();
    return () => {
      unsubTunnel();
      unsubLogs();
    };
  }, [refreshServerOverview]);

  const handleUpdateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.relayApi.updateSettings(patch);
    setSettings(next);
  }, []);

  const handleSelectRole = useCallback(
    async (role: Exclude<AppRole, 'unset'>) => {
      const next = await window.relayApi.setRole(role);
      setSettings(next);
      if (role === 'serverB') {
        setActiveTab('serverDashboard');
        refreshServerOverview();
      } else {
        setActiveTab('dashboard');
      }
    },
    [refreshServerOverview]
  );

  const handleRelaunchAdmin = async () => {
    const res = await window.relayApi.relaunchAsAdmin('serverB');
    notify(res.ok ? 'info' : 'error', res.message);
  };

  const activeNode = useMemo(() => {
    if (!settings || settings.nodes.length === 0) return null;
    return (
      settings.nodes.find((n) => n.id === settings.activeNodeId) ?? settings.nodes[0]
    );
  }, [settings]);

  if (!settings) {
    return (
      <div className="role-landing">
        <div style={{ color: 'var(--text-muted)' }}>正在加载 SSH Relay Studio...</div>
      </div>
    );
  }

  if (settings.role === 'unset') {
    return <RoleSelector onSelect={handleSelectRole} />;
  }

  const isClientA = settings.role === 'clientA';

  const clientNav = [
    { id: 'dashboard', label: '隧道控制台', icon: <IconPower size={17} /> },
    { id: 'nodes', label: '中转节点管理', icon: <IconNodes size={17} /> },
    { id: 'keys', label: '密钥与免密配对', icon: <IconKey size={17} /> },
    { id: 'tools', label: '浏览器与诊断', icon: <IconActivity size={17} /> },
  ];

  const serverNav = [
    { id: 'serverDashboard', label: '一键部署与总览', icon: <IconServer size={17} /> },
    { id: 'serverKeys', label: '设备公钥与连接', icon: <IconKey size={17} /> },
    { id: 'hardening', label: '高级设置', icon: <IconShield size={17} /> },
  ];

  const navItems = isClientA ? clientNav : serverNav;

  return (
    <div className="app-shell" data-role={settings.role}>
      {/* Left Navigation Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">
            {isClientA ? <IconLaptop size={18} /> : <IconServer size={18} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-title">SSH Relay Studio</div>
            <div className="brand-sub">
              {isClientA ? '设备 A · 使用端' : '设备 B · 中转端'}
            </div>
          </div>
        </div>

        <div className="role-switcher-box">
          <div className="role-pill-toggle">
            <button
              type="button"
              className={`role-pill-btn ${isClientA ? 'active' : ''}`}
              onClick={() => handleSelectRole('clientA')}
            >
              设备 A 使用端
            </button>
            <button
              type="button"
              className={`role-pill-btn ${!isClientA ? 'active' : ''}`}
              onClick={() => handleSelectRole('serverB')}
            >
              设备 B 中转端
            </button>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">
            {isClientA ? '客户端功能' : '中转服务端功能'}
          </div>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => {
                setActiveTab(item.id);
                if (!isClientA) {
                  void refreshServerOverview(false);
                }
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="env-meta-row">
            <span>本机</span>
            <span className="mono" style={{ color: 'var(--text-primary)' }}>
              {envInfo?.hostname || '--'}
            </span>
          </div>
          <div className="env-meta-row">
            <span>权限</span>
            {envInfo?.isAdmin ? (
              <StatusBadge variant="success" label="管理员" />
            ) : (
              <StatusBadge variant="neutral" label="普通用户" />
            )}
          </div>
          {isClientA && (
            <div className="env-meta-row">
              <span>隧道</span>
              <StatusBadge
                variant={
                  tunnelStatus.state === 'connected'
                    ? 'success'
                    : tunnelStatus.state === 'error'
                    ? 'danger'
                    : tunnelStatus.state === 'disconnected'
                    ? 'neutral'
                    : 'warn'
                }
                label={
                  tunnelStatus.state === 'connected'
                    ? `:${tunnelStatus.localPort}`
                    : tunnelStatus.state === 'reconnecting'
                    ? '重连中'
                    : tunnelStatus.state === 'connecting'
                    ? '连接中'
                    : tunnelStatus.state === 'error'
                    ? '异常'
                    : '未连接'
                }
              />
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-column">
        {!isClientA && envInfo && envInfo.isWindows && !envInfo.isAdmin && (
          <div className="top-alert-bar">
            <span>
              <strong>需要管理员权限：</strong>设备 B 的 OpenSSH 安装、sshd_config 修改、icacls 与防火墙配置需要以管理员身份运行。
            </span>
            <button className="btn btn-sm btn-primary" onClick={handleRelaunchAdmin}>
              以管理员身份重启
            </button>
          </div>
        )}

        {envInfo && !envInfo.isWindows && (
          <div className="top-alert-bar info">
            <span>
              当前为非 Windows 预览环境（{envInfo.platform}）；所有 Windows OpenSSH / PowerShell / 防火墙 / 注册表操作将在 Windows 目标设备上自动生效。
            </span>
          </div>
        )}

        <main className="main-scroll">
          {isClientA ? (
            <>
              {activeTab === 'dashboard' && (
                <ClientDashboard
                  envInfo={envInfo}
                  settings={settings}
                  tunnelStatus={tunnelStatus}
                  activeNode={activeNode}
                  onUpdateSettings={handleUpdateSettings}
                  onRefreshEnv={refreshEnvInfo}
                  onNotify={notify}
                  onNavigate={setActiveTab}
                />
              )}
              {activeTab === 'nodes' && (
                <ClientNodes
                  settings={settings}
                  onUpdateSettings={handleUpdateSettings}
                  onNotify={notify}
                />
              )}
              {activeTab === 'keys' && (
                <ClientKeysPairing activeNode={activeNode} onNotify={notify} />
              )}
              {activeTab === 'tools' && (
                <ClientTools
                  envInfo={envInfo}
                  settings={settings}
                  activeNode={activeNode}
                  onUpdateSettings={handleUpdateSettings}
                  onRefreshEnv={refreshEnvInfo}
                  onNotify={notify}
                />
              )}
            </>
          ) : (
            <>
              {activeTab === 'serverDashboard' && (
                <ServerDashboard
                  envInfo={envInfo}
                  overview={serverOverview}
                  loading={serverLoading}
                  onRefresh={(force) => refreshServerOverview(Boolean(force))}
                  onNotify={notify}
                  onNavigate={setActiveTab}
                />
              )}
              {activeTab === 'serverKeys' && (
                <ServerKeys
                  overview={serverOverview}
                  onRefresh={() => refreshServerOverview(false)}
                  onNotify={notify}
                />
              )}
              {activeTab === 'hardening' && (
                <ServerHardening
                  overview={serverOverview}
                  onRefresh={() => refreshServerOverview(false)}
                  onNotify={notify}
                />
              )}
            </>
          )}
        </main>

        <LogDrawer
          logs={logs}
          open={logDrawerOpen}
          onToggle={() => setLogDrawerOpen((v) => !v)}
          onClear={async () => {
            await window.relayApi.clearLogs();
            setLogs([]);
          }}
          onCopyAll={async () => {
            const text = logs
              .map(
                (l) =>
                  `${new Date(l.timestamp).toISOString()} [${l.source}] [${l.level.toUpperCase()}] ${l.message}`
              )
              .join('\n');
            await window.relayApi.copyText(text);
            notify('success', '已复制全部运行日志');
          }}
        />
      </div>

      {/* Toast Notifications */}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast-item ${t.type}`}>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
