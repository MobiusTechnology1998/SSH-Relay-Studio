import React, { useEffect, useState } from 'react';
import { isFirewallPortAllowed, isPort22FirewallRule } from '../../../shared/commandBuilders';
import { encodePairingToken } from '../../../shared/pairingCodec';
import type { EnvironmentInfo, ServerOverview } from '../../../shared/types';
import { IconCheck, IconCopy, IconRefresh, IconServer } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ServerDashboardProps {
  envInfo: EnvironmentInfo | null;
  overview: ServerOverview | null;
  loading: boolean;
  onRefresh: (force?: boolean) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
  onNavigate: (tab: string) => void;
}

interface DeployLogItem {
  label: string;
  state: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

export const ServerDashboard: React.FC<ServerDashboardProps> = ({
  envInfo,
  overview,
  loading,
  onRefresh,
  onNotify,
  onNavigate,
}) => {
  const [pubKeyInput, setPubKeyInput] = useState('');
  const [targetPort, setTargetPort] = useState(53622);
  const [enableQuic, setEnableQuic] = useState(true);
  const [quicUdpPort, setQuicUdpPort] = useState(53623);
  const [exportHost, setExportHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [deployLogs, setDeployLogs] = useState<DeployLogItem[]>([]);
  const [copiedRecently, setCopiedRecently] = useState(false);

  useEffect(() => {
    if (!overview) return;
    if (overview.config.port && overview.config.port !== 22) {
      setTargetPort(overview.config.port);
    }
    if (overview.quicServer.udpPort) {
      setQuicUdpPort(overview.quicServer.udpPort);
    }
    if (!exportHost) {
      const candidate = overview.detectedPublicIp || overview.localIps[0] || '';
      if (candidate) setExportHost(candidate);
    }
  }, [
    overview?.config.port,
    overview?.quicServer.udpPort,
    overview?.detectedPublicIp,
    overview?.localIps,
  ]);

  const svcRunning = overview?.service.status === 'Running';
  const step1Done = Boolean(
    overview && overview.authorizedKeys.keys.length > 0 && overview.authorizedKeys.permissionsValid
  );
  const sshHardened = Boolean(
    svcRunning &&
      overview &&
      overview.config.port === targetPort &&
      overview.config.port !== 22 &&
      overview.config.pubkeyAuthentication &&
      !overview.config.passwordAuthentication &&
      Boolean(isFirewallPortAllowed(overview.firewallRules, 'TCP', targetPort)) &&
      overview.service.failureRecoveryConfigured &&
      overview.updatePolicy.autoRebootDisabled &&
      overview.systemTuning.tuned
  );
  const quicReady = Boolean(
    overview?.quicServer.running &&
      overview?.quicServer.configured &&
      overview?.quicServer.udpPort === quicUdpPort &&
      overview?.quicServer.startupTaskConfigured
  );
  const step2Done = sshHardened && (!enableQuic || quicReady);

  const port22StillEnabled = Boolean(
    overview?.firewallRules.some((r) => isPort22FirewallRule(r))
  );

  const handleAuthorizeKey = async () => {
    if (!pubKeyInput.trim()) {
      onNotify('warn', '请先粘贴设备 A 复制的 ssh-ed25519 公钥');
      return;
    }
    setBusy(true);
    try {
      const res = await window.relayApi.addServerAuthorizedKey(pubKeyInput, 'Device-A');
      onNotify(res.ok ? 'success' : 'error', res.message);
      if (res.ok) setPubKeyInput('');
      await onRefresh(false);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fact-driven, idempotent 1-click turnkey provisioning for Device B:
   * Inspects live discovered state first and ONLY executes steps that are not yet satisfied
   * (never duplicates rules, never restarts already-hardened sshd, never re-registers matching tasks).
   */
  const handleOneClickDeploy = async () => {
    if (!step1Done) {
      onNotify('error', '防锁死拦截：请先完成第 1 步（粘贴并授权至少 1 个设备 A 公钥）');
      return;
    }

    const steps: DeployLogItem[] = [
      { label: '1. 检查并启动 OpenSSH Server', state: 'pending' },
      { label: `2. 放行 TCP ${targetPort}、加固 sshd_config（禁用密码 + 弱网高并发）`, state: 'pending' },
      { label: '3. 检查崩溃 5s 自愈、禁自动更新重启与跨国弱网 TCP 调优', state: 'pending' },
    ];
    if (enableQuic) {
      steps.push({ label: `4. 部署并启动 QUIC (Hysteria 2) 跨国弱网引擎 (UDP ${quicUdpPort})`, state: 'pending' });
    }
    setDeployLogs([...steps]);
    setBusy(true);

    const mark = (idx: number, state: DeployLogItem['state'], detail?: string) => {
      steps[idx] = { ...steps[idx], state, detail };
      setDeployLogs([...steps]);
    };

    try {
      // Discover latest real system facts before making any changes
      const fresh = await window.relayApi.getServerOverview(false);

      // Step 1: OpenSSH Server
      mark(0, 'active');
      if (fresh.service.status === 'Running') {
        mark(0, 'done', '已运行（跳过）');
      } else {
        const installRes = await window.relayApi.installOpenSshServer();
        if (!installRes.ok) {
          mark(0, 'error', installRes.message);
          onNotify('error', installRes.message);
          return;
        }
        mark(0, 'done', '已启动');
      }

      // Step 2: Firewall + Hardened Weak-Network sshd_config + Restart (only if drifted)
      mark(1, 'active');
      const tcpAlreadyAllowed = Boolean(
        isFirewallPortAllowed(fresh.firewallRules, 'TCP', targetPort)
      );
      if (!tcpAlreadyAllowed) {
        const fwRes = await window.relayApi.allowFirewallPort(targetPort);
        if (!fwRes.ok) {
          mark(1, 'error', fwRes.message);
          onNotify('error', fwRes.message);
          return;
        }
      }

      const cfgAlreadyOptimal =
        fresh.config.port === targetPort &&
        fresh.config.pubkeyAuthentication &&
        !fresh.config.passwordAuthentication &&
        fresh.config.tcpKeepAlive &&
        fresh.config.clientAliveInterval > 0 &&
        fresh.config.clientAliveCountMax >= 1 &&
        !fresh.config.useDns &&
        fresh.config.compression === 'no' &&
        fresh.config.maxSessions >= 64;

      if (!cfgAlreadyOptimal) {
        const cfgRes = await window.relayApi.applySshdConfig({
          port: targetPort,
          pubkeyAuthentication: true,
          passwordAuthentication: false,
          tcpKeepAlive: true,
          clientAliveInterval: 30,
          clientAliveCountMax: 3,
          useDns: false,
          compression: 'no',
          maxSessions: 64,
          maxStartups: '30:50:100',
        });
        if (!cfgRes.ok) {
          mark(1, 'error', cfgRes.message);
          onNotify('error', cfgRes.message);
          return;
        }
        const restartRes = await window.relayApi.controlSshdService('restart');
        if (!restartRes.ok) {
          mark(1, 'error', restartRes.message);
          onNotify('error', restartRes.message);
          return;
        }
        mark(1, 'done', `TCP ${targetPort} 已生效`);
      } else {
        mark(1, 'done', `TCP ${targetPort} 已生效（跳过重启）`);
      }

      // Step 3: Crash recovery + Anti-reboot + TCP CUBIC / Anti-sleep (only run missing ones)
      mark(2, 'active');
      const pendingTasks: Array<Promise<{ ok: boolean; message: string }>> = [];
      if (!fresh.service.failureRecoveryConfigured) {
        pendingTasks.push(window.relayApi.configureSshdFailureRecovery());
      }
      if (!fresh.updatePolicy.autoRebootDisabled) {
        pendingTasks.push(window.relayApi.setDisableAutoReboot(true));
      }
      if (!fresh.systemTuning.tuned) {
        pendingTasks.push(window.relayApi.applyServerSystemTuning());
      }

      if (pendingTasks.length === 0) {
        mark(2, 'done', '全部已生效（跳过）');
      } else {
        const results = await Promise.all(pendingTasks);
        const stErrs = results.filter((r) => !r.ok).map((r) => r.message);
        if (stErrs.length > 0) {
          mark(2, 'error', stErrs.join(' | '));
          onNotify('warn', `部分稳定性项未完全生效：${stErrs[0]}`);
        } else {
          mark(2, 'done', '全部已生效');
        }
      }

      // Step 4 (Optional): QUIC / Hysteria 2 (skip already-running matching engine & existing task)
      if (enableQuic) {
        mark(3, 'active', '检查内核、服务与开机自启状态...');
        if (!fresh.quicServer.binaryInstalled) {
          const dlRes = await window.relayApi.downloadHysteriaBinary('serverB');
          if (!dlRes.ok) {
            mark(3, 'error', '自动下载失败（可到「高级设置」导入本地 hysteria.exe）');
            onNotify('warn', `OpenSSH 已全部就绪，但 QUIC 自动下载失败：${dlRes.message}`);
            await onRefresh(false);
            return;
          }
        }

        const quicAlreadyRunningMatch =
          fresh.quicServer.running &&
          fresh.quicServer.configured &&
          fresh.quicServer.udpPort === quicUdpPort &&
          Boolean(fresh.quicServer.obfsPassword);

        if (!quicAlreadyRunningMatch) {
          const quicRes = await window.relayApi.deployQuicServer({
            udpPort: quicUdpPort,
            sni: fresh.quicServer.sni || 'www.bing.com',
            maxUpMbps: fresh.quicServer.maxUpMbps || 200,
            maxDownMbps: fresh.quicServer.maxDownMbps || 200,
            enableObfs: true,
          });
          if (!quicRes.ok) {
            mark(3, 'error', quicRes.message);
            onNotify('error', quicRes.message);
            await onRefresh(false);
            return;
          }
        }

        if (!fresh.quicServer.startupTaskConfigured) {
          await window.relayApi.configureQuicStartupTask();
        }
        mark(
          3,
          'done',
          quicAlreadyRunningMatch && fresh.quicServer.startupTaskConfigured
            ? `UDP ${quicUdpPort} 已就绪（跳过）`
            : `UDP ${quicUdpPort} 运行中`
        );
      }

      onNotify('success', '中转端已按当前状态完成补齐与优化！现在可直接复制配对码发给设备 A。');
      await onRefresh(false);
    } finally {
      setBusy(false);
    }
  };

  const handleOneClickCopyPairing = async () => {
    const host = (exportHost || overview?.detectedPublicIp || overview?.localIps[0] || '').trim();
    if (!host) {
      onNotify('error', '请先填写设备 B 的公网 IP 或域名');
      return;
    }

    try {
      const qs = overview?.quicServer;
      const quic =
        qs && qs.configured && qs.authToken && qs.certPinSha256
          ? {
              udpPort: qs.udpPort,
              authToken: qs.authToken,
              certPinSha256: qs.certPinSha256,
              sni: qs.sni,
              obfsPassword: qs.obfsPassword || undefined,
            }
          : undefined;

      const token = encodePairingToken({
        version: 1,
        name: envInfo?.hostname ? `中转端 (${envInfo.hostname})` : '设备 B 中转节点',
        host,
        sshPort: overview?.config.port ?? targetPort,
        username: envInfo?.username || 'Administrator',
        hostPublicKey: overview?.hostPublicKey ?? undefined,
        quic,
        createdAt: Date.now(),
      });

      await window.relayApi.copyText(token);
      setCopiedRecently(true);
      setTimeout(() => setCopiedRecently(false), 3000);
      onNotify(
        'success',
        quic
          ? '已生成并复制配对码（含 SSH 指纹 + QUIC 跨国加速参数），直接粘贴到设备 A 即可！'
          : '已生成并复制配对码（含 SSH 主机指纹），直接粘贴到设备 A 即可！'
      );
    } catch (err) {
      onNotify('error', (err as Error).message);
    }
  };

  const handleClosePort22 = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.disablePort22FirewallRule();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh(false);
    } finally {
      setBusy(false);
    }
  };

  const handleServiceAction = async (action: 'start' | 'restart' | 'stop') => {
    setBusy(true);
    try {
      const res = await window.relayApi.controlSshdService(action);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">设备 B · 一键部署与总览</h1>
          <p className="page-desc">
            三步完成中转服务器部署：授权设备 A 公钥 → 一键全自动加固与弱网加速 → 复制配对码
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => onRefresh(true)} disabled={loading || busy}>
            <IconRefresh size={15} />
            {loading ? '刷新中...' : '刷新状态'}
          </button>
        </div>
      </div>

      {/* Compact 3-KPI Health Strip */}
      <div className="grid-3">
        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">OpenSSH 通道</span>
            <StatusBadge
              variant={svcRunning ? 'success' : 'warn'}
              label={svcRunning ? `TCP ${overview?.config.port}` : '未运行'}
            />
          </div>
          <div className="metric-value" style={{ marginTop: 6, fontSize: 15 }}>
            sshd{' '}
            {overview?.service.sshdVersion?.version
              ? `v${overview.service.sshdVersion.version}`
              : ''}
          </div>
          <div className="metric-sub">
            {overview?.config.passwordAuthentication ? '密码登录未关闭' : '仅密钥登录'} · 崩溃自愈
            {overview?.service.failureRecoveryConfigured ? '已开启' : '未配置'}
          </div>
        </div>

        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">QUIC 跨国加速 (Hysteria 2)</span>
            <StatusBadge
              variant={quicReady ? 'success' : 'neutral'}
              label={quicReady ? `UDP ${overview?.quicServer.udpPort}` : '未启用'}
            />
          </div>
          <div className="metric-value" style={{ marginTop: 6, fontSize: 15 }}>
            {quicReady ? '运行中 (Brutal)' : '待开启'}
          </div>
          <div className="metric-sub">
            {quicReady
              ? `自启任务：${overview?.quicServer.startupTaskConfigured ? '已配置' : '未配置'}`
              : '推荐开启，大幅提升跨国丢包弱网速度'}
          </div>
        </div>

        <div className="metric-tile">
          <div className="row-between">
            <span className="metric-label">公网 IP / 授权设备</span>
            <StatusBadge
              variant={step1Done ? 'success' : 'warn'}
              label={`${overview?.authorizedKeys.keys.length ?? 0} 台设备`}
            />
          </div>
          <div className="metric-value" style={{ marginTop: 6, fontSize: 15 }}>
            {overview?.detectedPublicIp || overview?.localIps[0] || '--'}
          </div>
          <div className="metric-sub">
            系统弱网调优：{overview?.systemTuning.tuned ? '已生效' : '待优化'}
          </div>
        </div>
      </div>

      {/* Turnkey 3-Step Setup Flow */}
      <div className="stack-sm">
        {/* Step 1: Authorize Device A Public Key */}
        <div className="step-item">
          <div className={`step-num ${step1Done ? 'done' : 'active'}`}>
            {step1Done ? <IconCheck size={14} /> : '1'}
          </div>
          <div className="step-body">
            <div className="step-title">
              粘贴并授权设备 A 公钥（防锁死前提）
              <StatusBadge
                variant={step1Done ? 'success' : 'warn'}
                label={
                  step1Done
                    ? `已授权 ${overview?.authorizedKeys.keys.length} 台 · ACL 合规`
                    : '待完成'
                }
              />
            </div>

            {step1Done ? (
              <div className="row-between" style={{ marginTop: 4 }}>
                <span className="step-desc" style={{ margin: 0 }}>
                  设备 A 公钥已写入并自动收紧 Windows 权限，可安全进入下一步。
                </span>
                <button className="btn btn-sm" onClick={() => onNavigate('serverKeys')}>
                  管理 / 添加更多设备
                </button>
              </div>
            ) : (
              <div className="stack-sm" style={{ marginTop: 8 }}>
                <p className="step-desc" style={{ margin: 0 }}>
                  在设备 A 打开本软件首页点击「复制本机公钥」，粘贴到下方即可自动写入并收紧权限：
                </p>
                <textarea
                  className="textarea"
                  rows={2}
                  value={pubKeyInput}
                  onChange={(e) => setPubKeyInput(e.target.value)}
                  placeholder="粘贴 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... 公钥"
                />
                <div>
                  <button
                    className="btn btn-primary"
                    onClick={handleAuthorizeKey}
                    disabled={busy || !pubKeyInput.trim()}
                  >
                    {busy ? '正在写入并收紧权限...' : '授权该设备 A 公钥'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Step 2: True 1-Click Full Provisioning & Optimization */}
        <div className="step-item">
          <div className={`step-num ${step2Done ? 'done' : 'active'}`}>
            {step2Done ? <IconCheck size={14} /> : '2'}
          </div>
          <div className="step-body">
            <div className="step-title">
              一键全自动部署、安全加固与跨国弱网加速
              <StatusBadge
                variant={step2Done ? 'success' : 'warn'}
                label={step2Done ? '已全部就绪' : '一键完成'}
              />
            </div>
            <p className="step-desc">
              单次点击自动完成：安装启动 OpenSSH → 切换高位端口并关闭密码登录 → 放行防火墙 → 崩溃自愈/防重启/TCP CUBIC 调优 → 可选一键启用 QUIC (Hysteria 2) 跨国加速。
            </p>

            <div className="row-wrap" style={{ marginBottom: 10 }}>
              <label className="field-label">SSH 端口：</label>
              <input
                className="input mono"
                type="number"
                style={{ width: 100 }}
                value={targetPort}
                onChange={(e) => setTargetPort(Number(e.target.value) || 53622)}
                disabled={busy}
              />
              <label className="checkbox-row" style={{ marginLeft: 8 }}>
                <input
                  type="checkbox"
                  checked={enableQuic}
                  onChange={(e) => setEnableQuic(e.target.checked)}
                  disabled={busy}
                />
                <span>同时启用 QUIC 跨国弱网加速 (UDP</span>
              </label>
              <input
                className="input mono"
                type="number"
                style={{ width: 92 }}
                value={quicUdpPort}
                onChange={(e) => setQuicUdpPort(Number(e.target.value) || 53623)}
                disabled={busy || !enableQuic}
              />
              <span style={{ fontSize: 13 }}>)</span>
            </div>

            <div className="row-wrap">
              <button
                className={`btn ${step2Done ? '' : 'btn-primary'}`}
                onClick={handleOneClickDeploy}
                disabled={busy || !step1Done || step2Done}
              >
                {step2Done
                  ? '✓ 中转端已全部部署并优化就绪'
                  : busy
                  ? '正在全自动部署与调优中...'
                  : '一键全自动部署与优化'}
              </button>
              {step2Done && (
                <button className="btn btn-ghost btn-sm" onClick={() => onNavigate('hardening')}>
                  进入高级设置微调参数
                </button>
              )}
            </div>

            {deployLogs.length > 0 && (
              <div className="progress-log-list" style={{ marginTop: 10 }}>
                {deployLogs.map((item, idx) => (
                  <div key={idx} className={`progress-log-item ${item.state}`}>
                    <span>
                      {item.state === 'done'
                        ? '✓'
                        : item.state === 'active'
                        ? '⏳'
                        : item.state === 'error'
                        ? '✕'
                        : '○'}
                    </span>
                    <span>{item.label}</span>
                    {item.detail && <span className="mono">({item.detail})</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="callout callout-accent" style={{ marginTop: 10, fontSize: 12.5 }}>
              <strong>云安全组提醒：</strong>请在云服务器控制台放行入站{' '}
              <strong className="mono">TCP {targetPort}</strong>
              {enableQuic ? (
                <>
                  {' '}与 <strong className="mono">UDP {quicUdpPort}</strong>
                </>
              ) : null}
              （来源 <code className="mono">0.0.0.0/0</code>，已强制仅密钥/强鉴权认证）。
            </div>
          </div>
        </div>

        {/* Step 3: 1-Click Copy Pairing Code */}
        <div className="step-item">
          <div className={`step-num ${step2Done ? 'active' : ''}`}>3</div>
          <div className="step-body">
            <div className="step-title">
              一键复制配对码，发给设备 A 直接导入
              {quicReady && (
                <StatusBadge variant="success" dot={false} label="自动附带 QUIC + SSH 指纹" />
              )}
            </div>
            <p className="step-desc">
              无需手动填 IP/端口/指纹，点击下方按钮自动生成并复制完整配对码，粘贴到设备 A 首页即可立刻连接。
            </p>
            <div className="row-wrap">
              <input
                className="input mono"
                style={{ width: 220 }}
                value={exportHost}
                onChange={(e) => setExportHost(e.target.value)}
                placeholder="设备 B 公网 IP 或域名"
              />
              <button
                className={`btn ${copiedRecently ? 'btn-success' : 'btn-primary'}`}
                onClick={handleOneClickCopyPairing}
                disabled={!exportHost.trim()}
              >
                <IconCopy size={15} />
                {copiedRecently ? '✓ 已复制配对码！快去设备 A 粘贴' : '一键生成并复制配对码'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Contextual Security Tip: Close Legacy Port 22 after A verifies */}
      {sshHardened && port22StillEnabled && (
        <div className="callout callout-warn row-between">
          <div>
            <strong>安全建议：</strong>本机旧的 <code className="mono">TCP 22</code> 防火墙规则仍处于启用状态。确认设备 A 通过新端口{' '}
            <code className="mono">{overview?.config.port}</code> 连接成功后，建议立即关闭旧 22 端口。
          </div>
          <button className="btn btn-sm btn-primary" onClick={handleClosePort22} disabled={busy}>
            关闭旧 22 端口规则
          </button>
        </div>
      )}

      {/* Minimal Service Controls Footer Card */}
      <div className="card row-between">
        <div className="row-wrap" style={{ gap: 10 }}>
          <IconServer size={16} />
          <span style={{ fontWeight: 600 }}>sshd 服务快捷控制</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {overview?.listeningPorts.length
              ? `监听: ${overview.listeningPorts.join(', ')}`
              : '未监听'}
          </span>
        </div>
        <div className="row-wrap">
          {!svcRunning ? (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => handleServiceAction('start')}
              disabled={busy || !overview?.service.serviceExists}
            >
              启动 sshd
            </button>
          ) : (
            <>
              <button
                className="btn btn-sm"
                onClick={() => handleServiceAction('restart')}
                disabled={busy}
              >
                重启 sshd
              </button>
              <button
                className="btn btn-sm btn-ghost"
                style={{ color: 'var(--danger)' }}
                onClick={() => handleServiceAction('stop')}
                disabled={busy}
              >
                停止
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
