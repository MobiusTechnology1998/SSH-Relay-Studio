import React, { useEffect, useState } from 'react';
import { isPort22FirewallRule } from '../../../shared/commandBuilders';
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
  const [tcpKeepAlive, setTcpKeepAlive] = useState(overview?.config.tcpKeepAlive ?? true);
  const [clientAliveInterval, setClientAliveInterval] = useState(
    overview?.config.clientAliveInterval && overview.config.clientAliveInterval > 0
      ? overview.config.clientAliveInterval
      : 30
  );
  const [clientAliveCountMax, setClientAliveCountMax] = useState(
    overview?.config.clientAliveCountMax ?? 3
  );
  const [useDns, setUseDns] = useState(overview?.config.useDns ?? false);
  const [disableCompression, setDisableCompression] = useState(
    (overview?.config.compression ?? 'no') === 'no'
  );
  const [maxSessions, setMaxSessions] = useState(
    overview?.config.maxSessions && overview.config.maxSessions >= 16
      ? overview.config.maxSessions
      : 64
  );
  const [maxStartups, setMaxStartups] = useState(
    overview?.config.maxStartups && overview.config.maxStartups !== '10:30:100'
      ? overview.config.maxStartups
      : '30:50:100'
  );
  const [customFwPort, setCustomFwPort] = useState(53622);
  const [quicUdpPort, setQuicUdpPort] = useState(overview?.quicServer.udpPort ?? 53623);
  const [quicSni, setQuicSni] = useState(overview?.quicServer.sni ?? 'www.bing.com');
  const [quicMaxUpMbps, setQuicMaxUpMbps] = useState(overview?.quicServer.maxUpMbps ?? 200);
  const [quicMaxDownMbps, setQuicMaxDownMbps] = useState(overview?.quicServer.maxDownMbps ?? 200);
  const [quicEnableObfs, setQuicEnableObfs] = useState(
    overview?.quicServer.configured ? Boolean(overview.quicServer.obfsPassword) : true
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!overview) return;
    setPort(overview.config.port);
    setPubkeyAuth(overview.config.pubkeyAuthentication);
    setPasswordAuth(overview.config.passwordAuthentication);
    setTcpKeepAlive(overview.config.tcpKeepAlive);
    setClientAliveInterval(
      overview.config.clientAliveInterval > 0 ? overview.config.clientAliveInterval : 30
    );
    setClientAliveCountMax(overview.config.clientAliveCountMax || 3);
    setUseDns(overview.config.useDns);
    setDisableCompression(overview.config.compression === 'no');
    setMaxSessions(overview.config.maxSessions >= 16 ? overview.config.maxSessions : 64);
    setMaxStartups(
      overview.config.maxStartups && overview.config.maxStartups !== '10:30:100'
        ? overview.config.maxStartups
        : '30:50:100'
    );
    setCustomFwPort(overview.config.port === 22 ? 53622 : overview.config.port);
    setQuicUdpPort(overview.quicServer.udpPort || 53623);
    setQuicSni(overview.quicServer.sni || 'www.bing.com');
    setQuicMaxUpMbps(overview.quicServer.maxUpMbps || 200);
    setQuicMaxDownMbps(overview.quicServer.maxDownMbps || 200);
    if (overview.quicServer.configured) {
      setQuicEnableObfs(Boolean(overview.quicServer.obfsPassword));
    }
  }, [
    overview?.config.port,
    overview?.config.pubkeyAuthentication,
    overview?.config.passwordAuthentication,
    overview?.config.tcpKeepAlive,
    overview?.config.clientAliveInterval,
    overview?.config.clientAliveCountMax,
    overview?.config.useDns,
    overview?.config.compression,
    overview?.config.maxSessions,
    overview?.config.maxStartups,
    overview?.quicServer.udpPort,
    overview?.quicServer.sni,
    overview?.quicServer.maxUpMbps,
    overview?.quicServer.maxDownMbps,
    overview?.quicServer.configured,
    overview?.quicServer.obfsPassword,
  ]);

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
        tcpKeepAlive,
        clientAliveInterval,
        clientAliveCountMax,
        useDns,
        compression: disableCompression ? 'no' : 'delayed',
        maxSessions,
        maxStartups,
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

  const handleApplySystemTuning = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.applyServerSystemTuning();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadQuicServer = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.downloadHysteriaBinary('serverB');
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleImportQuicServer = async () => {
    const file = await window.relayApi.selectFile('选择本地 Hysteria 2 可执行文件', [
      { name: 'Hysteria 2', extensions: ['exe'] },
    ]);
    if (!file) return;
    setBusy(true);
    try {
      const res = await window.relayApi.importHysteriaBinary('serverB', file);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleDeployQuicServer = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.deployQuicServer({
        udpPort: quicUdpPort,
        sni: quicSni,
        maxUpMbps: quicMaxUpMbps,
        maxDownMbps: quicMaxDownMbps,
        enableObfs: quicEnableObfs,
      });
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleStopQuicServer = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.stopQuicServer();
      onNotify(res.ok ? 'info' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleConfigureQuicTask = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.configureQuicStartupTask();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const isSshdDirty = Boolean(
    !overview ||
      port !== overview.config.port ||
      pubkeyAuth !== overview.config.pubkeyAuthentication ||
      passwordAuth !== overview.config.passwordAuthentication ||
      tcpKeepAlive !== overview.config.tcpKeepAlive ||
      clientAliveInterval !== overview.config.clientAliveInterval ||
      clientAliveCountMax !== overview.config.clientAliveCountMax ||
      useDns !== overview.config.useDns ||
      (disableCompression ? 'no' : 'delayed') !== overview.config.compression ||
      maxSessions !== overview.config.maxSessions ||
      maxStartups.trim() !== overview.config.maxStartups
  );

  const isQuicDirty = Boolean(
    !overview?.quicServer.configured ||
      quicUdpPort !== overview.quicServer.udpPort ||
      quicSni.trim() !== overview.quicServer.sni ||
      quicMaxUpMbps !== overview.quicServer.maxUpMbps ||
      quicMaxDownMbps !== overview.quicServer.maxDownMbps ||
      quicEnableObfs !== Boolean(overview.quicServer.obfsPassword)
  );

  const hasEnabledPort22Rule = Boolean(
    overview?.firewallRules.some((r) => r.enabled && isPort22FirewallRule(r))
  );

  const stabilityAllGood = Boolean(
    overview?.service.failureRecoveryConfigured &&
      overview?.updatePolicy.autoRebootDisabled &&
      overview?.systemTuning.tuned
  );

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">高级设置</h1>
          <p className="page-desc">
            底层参数微调、防火墙规则明细、系统稳定性与 QUIC 服务端手动控制；日常配置推荐在「一键部署与总览」全自动完成
          </p>
        </div>
      </div>

      {/* 1. QUIC (Hysteria 2) Server Engine */}
      <details className="advanced-drawer" open>
        <summary>
          <span className="row-wrap" style={{ gap: 8 }}>
            <span>QUIC (Hysteria 2) 跨国弱网服务端参数</span>
            <StatusBadge
              variant={
                overview?.quicServer.running
                  ? 'success'
                  : overview?.quicServer.binaryInstalled
                  ? 'warn'
                  : 'neutral'
              }
              label={
                overview?.quicServer.running
                  ? `运行中 (UDP :${overview.quicServer.udpPort})`
                  : overview?.quicServer.binaryInstalled
                  ? '已安装未启动'
                  : '未安装'
              }
            />
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {overview?.quicServer.configured
              ? `UDP :${overview.quicServer.udpPort} · SNI ${overview.quicServer.sni}`
              : '点击展开配置'}
          </span>
        </summary>
        <div className="advanced-drawer-body">
          <p className="card-subtitle">
            基于 UDP QUIC + Brutal 拥塞控制 + Salamander 混淆，消除 TCP-over-TCP 队头阻塞；修改后重新在首页复制配对码即可同步至设备 A。
          </p>

          <div className="row-wrap">
            {overview?.quicServer.binaryInstalled ? (
              <button className="btn btn-sm" disabled>
                ✓ 已安装 ({overview.quicServer.binaryVersion ?? 'v2'})
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                onClick={handleDownloadQuicServer}
                disabled={busy}
              >
                一键下载 Hysteria 2
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={handleImportQuicServer}
              disabled={busy}
            >
              {overview?.quicServer.binaryInstalled ? '替换本地文件' : '导入本地 hysteria.exe'}
            </button>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {overview?.quicServer.binaryInstalled
                ? overview.quicServer.binaryPath
                : '尚未安装 hysteria.exe（单文件约 15MB）'}
            </span>
          </div>

          <div className="grid-4">
            <div className="field">
              <label className="field-label">QUIC 监听 UDP 端口</label>
              <input
                className="input mono"
                type="number"
                value={quicUdpPort}
                onChange={(e) => setQuicUdpPort(Number(e.target.value) || 53623)}
              />
            </div>
            <div className="field">
              <label className="field-label">自签名 TLS 伪装 SNI</label>
              <input
                className="input mono"
                value={quicSni}
                onChange={(e) => setQuicSni(e.target.value)}
                placeholder="www.bing.com"
              />
            </div>
            <div className="field">
              <label className="field-label">服务端上行上限 (Mbps)</label>
              <input
                className="input mono"
                type="number"
                min={10}
                max={10000}
                value={quicMaxUpMbps}
                onChange={(e) => setQuicMaxUpMbps(Math.max(10, Number(e.target.value) || 200))}
              />
            </div>
            <div className="field">
              <label className="field-label">服务端下行上限 (Mbps)</label>
              <input
                className="input mono"
                type="number"
                min={10}
                max={10000}
                value={quicMaxDownMbps}
                onChange={(e) => setQuicMaxDownMbps(Math.max(10, Number(e.target.value) || 200))}
              />
            </div>
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={quicEnableObfs}
              onChange={(e) => setQuicEnableObfs(e.target.checked)}
            />
            <span>启用 Salamander UDP 流量混淆（推荐：有效缓解跨国运营商对 QUIC/UDP 的 QoS 限速）</span>
          </label>

          {overview?.quicServer.configured && (
            <div className="callout" style={{ fontSize: 12 }}>
              <div>
                TLS 证书指纹 <code className="mono">{overview.quicServer.certPinSha256}</code>
              </div>
              <div>
                开机自启计划任务：
                <strong>
                  {overview.quicServer.startupTaskConfigured ? '已配置（重启自动拉起）' : '未配置'}
                </strong>
                {' · '}请在云控制台安全组入方向放行{' '}
                <strong className="mono">UDP {overview.quicServer.udpPort}</strong>
              </div>
            </div>
          )}

          {overview?.quicServer.lastError && (
            <div className="callout callout-danger" style={{ fontSize: 12.5 }}>
              最近错误：{overview.quicServer.lastError}
            </div>
          )}

          <div className="row-wrap">
            <button
              className={`btn ${!overview?.quicServer.running || isQuicDirty ? 'btn-primary' : ''}`}
              onClick={handleDeployQuicServer}
              disabled={
                busy ||
                !overview?.quicServer.binaryInstalled ||
                (Boolean(overview?.quicServer.running) && !isQuicDirty)
              }
            >
              {overview?.quicServer.running && !isQuicDirty
                ? `✓ QUIC 服务运行中 (UDP :${overview.quicServer.udpPort})`
                : overview?.quicServer.running
                ? '保存修改并重启 QUIC'
                : '一键生成证书、放行 UDP 并启动 QUIC'}
            </button>
            {overview?.quicServer.running && (
              <button className="btn btn-danger" onClick={handleStopQuicServer} disabled={busy}>
                停止 QUIC 服务
              </button>
            )}
            {overview?.quicServer.configured && (
              <button
                className="btn"
                onClick={handleConfigureQuicTask}
                disabled={busy || Boolean(overview?.quicServer.startupTaskConfigured)}
              >
                {overview?.quicServer.startupTaskConfigured
                  ? '✓ 已配置开机自启任务'
                  : '配置开机自启与崩溃自愈'}
              </button>
            )}
          </div>
        </div>
      </details>

      {/* 2. sshd_config Visual Editor */}
      <details className="advanced-drawer">
        <summary>
          <span className="row-wrap" style={{ gap: 8 }}>
            <IconWrench size={15} />
            <span>sshd_config 底层参数编辑（自动备份与 sshd -t 语法校验）</span>
            <StatusBadge
              variant={
                overview?.config.port !== 22 && !overview?.config.passwordAuthentication
                  ? 'success'
                  : 'warn'
              }
              label={
                overview
                  ? `TCP :${overview.config.port} · ${
                      overview.config.passwordAuthentication ? '密码未关' : '仅公钥'
                    }`
                  : '读取中'
              }
            />
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {isSshdDirty ? '有未保存修改' : '已同步'}
          </span>
        </summary>
        <div className="advanced-drawer-body">
          <div className="row-between">
            <p className="card-subtitle">
              配置文件路径：<code className="mono">{overview?.config.path ?? 'C:\\ProgramData\\ssh\\sshd_config'}</code>
              {overview?.config.hasMatchAdminBlock ? ' · 已检测到 Match Group administrators 块（将完整保留）' : ''}
            </p>
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

          <div className="grid-3">
            <div className="field" style={{ justifyContent: 'center' }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={tcpKeepAlive}
                  onChange={(e) => setTcpKeepAlive(e.target.checked)}
                />
                <span>TCPKeepAlive yes（防止 NAT/防火墙踢断）</span>
              </label>
            </div>

            <div className="field">
              <label className="field-label">服务端心跳间隔 ClientAliveInterval（秒）</label>
              <input
                className="input mono"
                type="number"
                min={0}
                max={3600}
                value={clientAliveInterval}
                onChange={(e) => setClientAliveInterval(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>

            <div className="field">
              <label className="field-label">心跳最大重试 ClientAliveCountMax</label>
              <input
                className="input mono"
                type="number"
                min={1}
                max={20}
                value={clientAliveCountMax}
                onChange={(e) => setClientAliveCountMax(Math.max(1, Number(e.target.value) || 3))}
              />
            </div>
          </div>

          <div className="grid-3">
            <div className="field" style={{ justifyContent: 'center' }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={!useDns}
                  onChange={(e) => setUseDns(!e.target.checked)}
                />
                <span>禁用反向 DNS（UseDNS no，加速握手）</span>
              </label>
            </div>

            <div className="field" style={{ justifyContent: 'center' }}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={disableCompression}
                  onChange={(e) => setDisableCompression(e.target.checked)}
                />
                <span>禁用服务端压缩（Compression no）</span>
              </label>
            </div>

            <div className="field">
              <label className="field-label">并发会话上限 MaxSessions</label>
              <input
                className="input mono"
                type="number"
                min={1}
                max={1000}
                value={maxSessions}
                onChange={(e) => setMaxSessions(Math.max(1, Number(e.target.value) || 64))}
              />
            </div>
          </div>

          <div className="grid-3">
            <div className="field">
              <label className="field-label">并发握手上限 MaxStartups（防多隧道/快速重连被限流）</label>
              <input
                className="input mono"
                value={maxStartups}
                onChange={(e) => setMaxStartups(e.target.value)}
                placeholder="30:50:100"
              />
            </div>
          </div>

          <div className="row-wrap" style={{ marginTop: 4 }}>
            <button
              className={`btn ${isSshdDirty ? 'btn-primary' : ''}`}
              onClick={() => handleSaveSshdConfig(true)}
              disabled={busy || !isSshdDirty}
            >
              {isSshdDirty ? '校验保存并重启 sshd' : '✓ 当前 sshd_config 已是最新'}
            </button>
            {isSshdDirty && (
              <button
                className="btn"
                onClick={() => handleSaveSshdConfig(false)}
                disabled={busy}
              >
                仅校验并保存（稍后重启）
              </button>
            )}
          </div>
        </div>
      </details>

      {/* 3. Windows Firewall Rules */}
      <details className="advanced-drawer">
        <summary>
          <span className="row-wrap" style={{ gap: 8 }}>
            <IconShield size={15} />
            <span>Windows 防火墙 SSH / QUIC 入站规则</span>
            <StatusBadge
              variant={hasEnabledPort22Rule ? 'warn' : 'success'}
              label={hasEnabledPort22Rule ? '存在已启用的 22 端口规则' : '规则已加固'}
            />
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            共 {overview?.firewallRules.length ?? 0} 条规则
          </span>
        </summary>
        <div className="advanced-drawer-body">
          <p className="card-subtitle">
            独立命名规则放行高位端口，禁用 22 端口时绝不误删自定义端口规则。
          </p>

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
            <button
              className="btn"
              onClick={handleDisable22}
              disabled={busy || !hasEnabledPort22Rule}
            >
              {hasEnabledPort22Rule ? '精准禁用旧 22 端口规则' : '✓ 旧 22 端口规则已关闭'}
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
            <div className="callout">未检测到 OpenSSH / QUIC 相关入站防火墙规则。</div>
          )}
        </div>
      </details>

      {/* 4. Stability & Cross-Border TCP Stack Tuning */}
      <details className="advanced-drawer" open={!stabilityAllGood}>
        <summary>
          <span className="row-wrap" style={{ gap: 8 }}>
            <span>服务崩溃自愈、防更新重启与跨国 TCP 协议栈调优</span>
            <StatusBadge
              variant={stabilityAllGood ? 'success' : 'warn'}
              label={stabilityAllGood ? '全部已调优' : '存在待优化项'}
            />
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            TCP {overview?.systemTuning.tcpCongestionProvider ?? '--'}
          </span>
        </summary>
        <div className="advanced-drawer-body">
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
                <button
                  className={`btn ${overview?.service.failureRecoveryConfigured ? '' : 'btn-primary'}`}
                  onClick={handleFailureRecovery}
                  disabled={busy || Boolean(overview?.service.failureRecoveryConfigured)}
                >
                  {overview?.service.failureRecoveryConfigured
                    ? '✓ 已启用 5 秒崩溃自愈'
                    : '配置 5 秒崩溃自愈'}
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
                  className={`btn ${overview?.updatePolicy.autoRebootDisabled ? '' : 'btn-primary'}`}
                  onClick={() => handleToggleAutoReboot(true)}
                  disabled={busy || Boolean(overview?.updatePolicy.autoRebootDisabled)}
                >
                  {overview?.updatePolicy.autoRebootDisabled
                    ? '✓ 已禁止自动重启'
                    : '禁止自动重启'}
                </button>
                {overview?.updatePolicy.autoRebootDisabled && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleToggleAutoReboot(false)}
                    disabled={busy}
                  >
                    恢复默认策略
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="card stack-sm">
            <div className="row-between">
              <div>
                <h3 className="card-title">跨国弱网 TCP 协议栈与防休眠调优</h3>
                <p className="card-subtitle">
                  开启 CUBIC/CTCP 高延迟抗丢包拥塞控制、接收窗口自动扩展、TCP Timestamps，关闭易引发跨网丢包的 ECN，并禁用电源休眠与网卡节能
                </p>
              </div>
              <StatusBadge
                variant={overview?.systemTuning.tuned ? 'success' : 'warn'}
                label={overview?.systemTuning.tuned ? '已调优' : '待优化'}
              />
            </div>

            <div className="grid-4">
              <div className="metric-tile">
                <div className="metric-label">防休眠策略</div>
                <div className="metric-value" style={{ fontSize: 15 }}>
                  {overview?.systemTuning.sleepDisabled ? '永不休眠' : '系统默认'}
                </div>
                <div className="metric-sub">
                  {overview?.systemTuning.standbyTimeoutAcSec === null
                    ? '云主机无休眠项'
                    : 'AC 休眠超时 = 0'}
                </div>
              </div>
              <div className="metric-tile">
                <div className="metric-label">拥塞控制算法</div>
                <div className="metric-value" style={{ fontSize: 15 }}>
                  {overview?.systemTuning.tcpCongestionProvider ?? '--'}
                </div>
                <div className="metric-sub">推荐 CUBIC / CTCP</div>
              </div>
              <div className="metric-tile">
                <div className="metric-label">接收窗口自动调优</div>
                <div className="metric-value" style={{ fontSize: 15 }}>
                  {overview?.systemTuning.tcpAutoTuning ?? '--'}
                </div>
                <div className="metric-sub">推荐 Normal</div>
              </div>
              <div className="metric-tile">
                <div className="metric-label">Timestamps / ECN</div>
                <div className="metric-value" style={{ fontSize: 14 }}>
                  {overview?.systemTuning.tcpTimestamps ?? '--'} /{' '}
                  {overview?.systemTuning.tcpEcnCapability ?? '--'}
                </div>
                <div className="metric-sub">推荐 Enabled / Disabled</div>
              </div>
            </div>

            <div>
              <button
                className={`btn ${overview?.systemTuning.tuned ? '' : 'btn-primary'}`}
                onClick={handleApplySystemTuning}
                disabled={busy || Boolean(overview?.systemTuning.tuned)}
              >
                {overview?.systemTuning.tuned
                  ? '✓ 跨国弱网 TCP 与防休眠已调优'
                  : '一键应用跨国弱网 TCP 与防休眠调优'}
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
};
