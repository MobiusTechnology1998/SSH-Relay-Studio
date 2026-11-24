import React, { useEffect, useState } from 'react';
import { computeNodeConfigHash, formatSshCommandPreview } from '../../../shared/commandBuilders';
import { decodePairingToken } from '../../../shared/pairingCodec';
import type {
  AppSettings,
  EnvironmentInfo,
  KeyPairInfo,
  NodeProfile,
  TunnelStatus,
} from '../../../shared/types';
import {
  IconCheck,
  IconCopy,
  IconGlobe,
  IconKey,
  IconPower,
  IconRefresh,
  IconShield,
} from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientDashboardProps {
  envInfo: EnvironmentInfo | null;
  settings: AppSettings;
  tunnelStatus: TunnelStatus;
  activeNode: NodeProfile | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onRefreshEnv: () => Promise<void>;
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

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export const ClientDashboard: React.FC<ClientDashboardProps> = ({
  envInfo,
  settings,
  tunnelStatus,
  activeNode,
  onUpdateSettings,
  onRefreshEnv,
  onNotify,
  onNavigate,
}) => {
  const [busy, setBusy] = useState(false);
  const [quicInstallBusy, setQuicInstallBusy] = useState(false);
  const [keyInfo, setKeyInfo] = useState<KeyPairInfo | null>(null);
  const [pairingInput, setPairingInput] = useState('');
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (settings.nodes.length === 0) {
      window.relayApi.getKeyPairInfo().then(setKeyInfo);
    }
  }, [settings.nodes.length]);

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

  const engineLabel =
    tunnelStatus.activeEngine === 'hysteria2'
      ? 'QUIC · Hysteria 2'
      : tunnelStatus.fallbackActive
      ? 'OpenSSH (QUIC 自动回退)'
      : 'OpenSSH 多隧道池';

  const statusMeta = {
    disconnected: { label: '隧道未连接', badge: 'neutral' as const },
    connecting: {
      label:
        tunnelStatus.activeEngine === 'hysteria2'
          ? '正在建立 QUIC 弱网加速隧道...'
          : '正在建立并行 SSH 隧道池...',
      badge: 'warn' as const,
    },
    connected: {
      label:
        tunnelStatus.activeEngine === 'hysteria2'
          ? 'QUIC (Hysteria 2) 加速运行中'
          : `并行隧道运行中（${tunnelStatus.healthyWorkers}/${tunnelStatus.poolSize} 通道健康）`,
      badge: 'success' as const,
    },
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

  const handleRotatePool = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.rotateTunnelPool();
      onNotify(res.ok ? 'success' : 'error', res.message);
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
  const configDrifted = Boolean(
    isRunning &&
      activeNode &&
      tunnelStatus.runningConfigHash &&
      computeNodeConfigHash(activeNode) !== tunnelStatus.runningConfigHash
  );

  const handleApplyDriftedConfig = async () => {
    if (!activeNode) return;
    setBusy(true);
    try {
      const res = await window.relayApi.startTunnel(activeNode.id);
      onNotify(res.ok ? 'success' : 'error', res.ok ? `已按最新配置重连：${activeNode.name}` : res.message);
    } finally {
      setBusy(false);
    }
  };

  const handleOneClickKeyCopy = async () => {
    setOnboardingBusy(true);
    try {
      let currentKey = keyInfo;
      if (!currentKey?.exists || !currentKey.publicKey) {
        const gen = await window.relayApi.generateKeyPair(false);
        if (!gen.ok || !gen.data?.publicKey) {
          onNotify('error', gen.message || '生成密钥对失败');
          return;
        }
        currentKey = gen.data;
        setKeyInfo(gen.data);
      }
      await window.relayApi.copyText(currentKey.publicKey);
      onNotify('success', '已复制本机 ed25519 公钥！请发送并粘贴到设备 B 首页的第 1 步。');
    } finally {
      setOnboardingBusy(false);
    }
  };

  const handleQuickImportPairing = async () => {
    if (!pairingInput.trim()) {
      onNotify('warn', '请粘贴设备 B 生成的 SSHR1:... 配对码');
      return;
    }
    setOnboardingBusy(true);
    try {
      const payload = decodePairingToken(pairingInput);
      const hasQuic = Boolean(payload.quic);
      const newNode: NodeProfile = {
        id: `node-${Date.now()}`,
        name: payload.name,
        host: payload.host,
        sshPort: payload.sshPort,
        username: payload.username,
        mode: 'socks5',
        localPort: 1080,
        remoteProxyPort: 7890,
        privateKeyPath: '',
        expectedHostKey: payload.hostPublicKey,
        poolSize: 3,
        forceIpv4: true,
        preferFastCipher: true,
        healthCheckEnabled: true,
        healthCheckIntervalSec: 25,
        engine: hasQuic ? 'hysteria2' : 'openssh',
        autoFallbackToSsh: true,
        quicUdpPort: payload.quic?.udpPort ?? 53623,
        quicAuthToken: payload.quic?.authToken,
        quicCertPinSha256: payload.quic?.certPinSha256,
        quicSni: payload.quic?.sni ?? 'www.bing.com',
        quicObfsPassword: payload.quic?.obfsPassword,
        quicUpMbps: 50,
        quicDownMbps: 200,
      };

      if (payload.hostPublicKey) {
        const parts = payload.hostPublicKey.trim().split(/\s+/);
        if (parts.length >= 2) {
          await window.relayApi.trustHostKeys(payload.host, payload.sshPort, [
            { keyType: parts[0], keyData: parts[1] },
          ]);
        }
      }

      await onUpdateSettings({
        nodes: [...settings.nodes, newNode],
        activeNodeId: newNode.id,
      });
      setPairingInput('');
      onNotify(
        'success',
        hasQuic
          ? `配对完成！已导入「${newNode.name}」并自动启用 QUIC 加速与主机指纹信任，点击「启动隧道」即可使用。`
          : `配对完成！已导入「${newNode.name}」并自动信任主机指纹，点击「启动隧道」即可使用。`
      );
    } catch (err) {
      onNotify('error', (err as Error).message);
    } finally {
      setOnboardingBusy(false);
    }
  };

  const handleDownloadQuicClient = async () => {
    setQuicInstallBusy(true);
    try {
      const res = await window.relayApi.downloadHysteriaBinary('clientA');
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefreshEnv();
    } finally {
      setQuicInstallBusy(false);
    }
  };

  const handleImportQuicClient = async () => {
    const file = await window.relayApi.selectFile('选择本地 Hysteria 2 可执行文件', [
      { name: 'Hysteria 2', extensions: ['exe'] },
    ]);
    if (!file) return;
    setQuicInstallBusy(true);
    try {
      const res = await window.relayApi.importHysteriaBinary('clientA', file);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefreshEnv();
    } finally {
      setQuicInstallBusy(false);
    }
  };

  const missingQuicClient = Boolean(
    activeNode?.engine === 'hysteria2' && envInfo && !envInfo.hysteriaClient.installed
  );

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">隧道控制台</h1>
          <p className="page-desc">
            支持 OpenSSH 多隧道并行连接池与 Hysteria 2 QUIC 跨国弱网引擎（UDP 受阻时自动无缝回退 OpenSSH）
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

      {/* Zero-Friction First-Time Onboarding when no nodes configured */}
      {settings.nodes.length === 0 ? (
        <div className="card stack-md">
          <div className="card-header" style={{ marginBottom: 0 }}>
            <div>
              <h3 className="card-title">首次使用 · 2 步极速配对设备 B</h3>
              <p className="card-subtitle">
                无需手工填写 IP、端口或信任指纹，按顺序完成以下两步即可一键启动跨国加速
              </p>
            </div>
            <button className="btn btn-sm" onClick={() => onNavigate('nodes')}>
              手动创建节点
            </button>
          </div>

          <div className="step-item">
            <div className={`step-num ${keyInfo?.exists ? 'done' : 'active'}`}>
              {keyInfo?.exists ? <IconCheck size={14} /> : '1'}
            </div>
            <div className="step-body">
              <div className="step-title">
                <IconKey size={15} />
                获取本机公钥并发送给设备 B
                <StatusBadge
                  variant={keyInfo?.exists ? 'success' : 'warn'}
                  label={keyInfo?.exists ? '密钥已就绪' : '待生成'}
                />
              </div>
              <p className="step-desc">
                点击下方按钮将自动生成（如尚未创建）并复制本机 <code className="mono">ed25519</code> 公钥，粘贴到设备 B 首页的第 1 步完成免密授权。
              </p>
              <div className="row-wrap">
                <button
                  className="btn btn-primary"
                  onClick={handleOneClickKeyCopy}
                  disabled={onboardingBusy}
                >
                  <IconCopy size={15} />
                  {keyInfo?.exists ? '一键复制本机公钥（发给设备 B）' : '一键生成并复制本机公钥'}
                </button>
                {keyInfo?.fingerprint && (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    指纹：{keyInfo.fingerprint}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="step-item">
            <div className="step-num active">2</div>
            <div className="step-body">
              <div className="step-title">粘贴设备 B 生成的配对码（SSHR1:...）</div>
              <p className="step-desc">
                在设备 B 首页点击「一键生成并复制配对码」后粘贴到此处，将自动导入节点、启用 QUIC 加速并信任 SSH 主机指纹。
              </p>
              <div className="stack-sm">
                <textarea
                  className="textarea"
                  rows={3}
                  value={pairingInput}
                  onChange={(e) => setPairingInput(e.target.value)}
                  placeholder="SSHR1:eyJ2ZXJzaW9uIjoxLC..."
                />
                <div className="row-wrap">
                  <button
                    className="btn btn-primary"
                    onClick={handleQuickImportPairing}
                    disabled={onboardingBusy || !pairingInput.trim()}
                  >
                    {onboardingBusy ? '正在解析导入...' : '一键导入并就绪'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Hero Connection Control */
        <div className="hero-connect-card">
          <div className="hero-status-left">
            <div className={`status-orb ${tunnelStatus.state}`}>
              <IconPower size={24} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="hero-status-title">
                <span>{statusMeta.label}</span>
                <StatusBadge variant={statusMeta.badge} label={engineLabel} />
                {tunnelStatus.fallbackActive && (
                  <StatusBadge variant="warn" label="已容灾回退" />
                )}
              </div>
              <div className="hero-status-meta">
                {activeNode ? (
                  <>
                    <span>
                      节点：<strong>{activeNode.name}</strong>
                    </span>
                    <span className="mono">
                      {activeNode.engine === 'hysteria2' && !tunnelStatus.fallbackActive
                        ? `QUIC ${activeNode.host}:${activeNode.quicUdpPort ?? 53623}`
                        : `${activeNode.username}@${activeNode.host}:${activeNode.sshPort}`}
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
            {tunnelStatus.state === 'connected' && (
              <button
                className="btn btn-lg"
                onClick={handleRotatePool}
                disabled={busy}
                title="先建立新通道再优雅排空旧通道，业务不断流"
              >
                <IconRefresh size={16} />
                无感轮换
              </button>
            )}
            {isRunning && (
              <button
                className="btn btn-lg"
                onClick={handleReconnect}
                disabled={busy}
                title="强制断开并重建全部连接"
              >
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
      )}

      {/* In-Place Missing QUIC Client Kernel Banner */}
      {missingQuicClient && (
        <div className="callout callout-warn row-between" style={{ gap: 12 }}>
          <div>
            <strong>缺少 QUIC 加速内核：</strong>当前节点已配置 Hysteria 2 (QUIC) 跨国加速，但本机尚未安装{' '}
            <code className="mono">hysteria.exe</code>（若直接启动将自动回退至 OpenSSH 多隧道）。
          </div>
          <div className="row-wrap" style={{ flexShrink: 0 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleDownloadQuicClient}
              disabled={quicInstallBusy}
            >
              {quicInstallBusy ? '正在下载...' : '一键下载 QUIC 内核'}
            </button>
            <button
              className="btn btn-sm"
              onClick={handleImportQuicClient}
              disabled={quicInstallBusy}
            >
              导入本地文件
            </button>
          </div>
        </div>
      )}

      {/* Config Drift Banner */}
      {configDrifted && activeNode && (
        <div className="callout callout-warn row-between">
          <div>
            <strong>节点配置已变更：</strong>当前运行的隧道仍在使用旧配置，点击右侧按钮立即按最新设置重连生效。
          </div>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleApplyDriftedConfig}
            disabled={busy}
          >
            立即应用并重连
          </button>
        </div>
      )}

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
          <div className="metric-label">并行连接池 / 活跃流</div>
          <div className="metric-value">
            {tunnelStatus.healthyWorkers}/{tunnelStatus.poolSize} · {tunnelStatus.activeConnections} 连接
          </div>
          <div className="metric-sub">
            127.0.0.1:{activeNode?.localPort ?? 1080} (
            {activeNode?.mode === 'localForward'
              ? `转发 :${activeNode.remoteProxyPort}`
              : 'SOCKS5 调度'}
            )
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">连续运行时长</div>
          <div className="metric-value">
            {formatDuration(tunnelStatus.connectedSince, now)}
          </div>
          <div className="metric-sub">
            心跳：{aliveInterval}s × {aliveCountMax} · 重连 {tunnelStatus.reconnectCount} 次
          </div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">最优通道延迟</div>
          <div className="metric-value">
            {tunnelStatus.lastHealthLatencyMs !== null
              ? `${tunnelStatus.lastHealthLatencyMs} ms`
              : '--'}
          </div>
          <div className="metric-sub">
            上行 {formatBytes(tunnelStatus.totalBytesUp)} · 下行{' '}
            {formatBytes(tunnelStatus.totalBytesDown)}
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

      {/* Per-worker Multi-Tunnel Pool Telemetry */}
      {tunnelStatus.workers.length > 0 && (
        <div className="card stack-sm">
          <div className="row-between">
            <div>
              <h3 className="card-title">多隧道连接池实时状态（最少连接 + 低延迟优先调度）</h3>
              <p className="card-subtitle">
                单条通道出现跨国丢包或假死时会自动摘除并后台重建，其余健康通道零感知接管流量
              </p>
            </div>
            <StatusBadge
              variant={tunnelStatus.healthyWorkers > 0 ? 'success' : 'warn'}
              label={`健康 ${tunnelStatus.healthyWorkers}/${tunnelStatus.poolSize}`}
            />
          </div>
          <div className="grid-3">
            {tunnelStatus.workers.map((w) => {
              const badgeVariant =
                w.state === 'healthy'
                  ? 'success'
                  : w.state === 'draining'
                  ? 'accent'
                  : w.state === 'stopped'
                  ? 'neutral'
                  : 'warn';
              const stateText =
                w.state === 'healthy'
                  ? '健康'
                  : w.state === 'starting'
                  ? '建连中'
                  : w.state === 'reconnecting'
                  ? `重连中 (#${w.reconnectCount})`
                  : w.state === 'draining'
                  ? '排空下线'
                  : '已停止';
              return (
                <div key={w.id} className="metric-tile">
                  <div className="row-between">
                    <span className="metric-label">通道 #{w.slotIndex + 1}</span>
                    <StatusBadge variant={badgeVariant} label={stateText} />
                  </div>
                  <div className="metric-value" style={{ fontSize: 14, marginTop: 6 }}>
                    {w.latencyMs !== null ? `${w.latencyMs} ms` : '-- ms'} · {w.activeConnections} 连接
                  </div>
                  <div className="metric-sub mono">
                    127.0.0.1:{w.internalPort} · PID {w.pid ?? '--'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
