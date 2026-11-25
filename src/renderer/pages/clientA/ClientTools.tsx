import React, { useEffect, useState } from 'react';
import { buildTerminalProxySnippets } from '../../../shared/commandBuilders';
import type {
  AppSettings,
  DetectedBrowser,
  DetectedDesktopApp,
  DiagnosticsResult,
  EnvironmentInfo,
  NodeProfile,
  ProxiedAppProfile,
} from '../../../shared/types';
import {
  IconActivity,
  IconCopy,
  IconGlobe,
  IconLaptop,
  IconTerminal,
} from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientToolsProps {
  envInfo: EnvironmentInfo | null;
  settings: AppSettings;
  activeNode: NodeProfile | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onRefreshEnv: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

function createEmptyProxiedApp(): ProxiedAppProfile {
  return {
    id: `app-${Date.now()}`,
    name: '',
    exePath: '',
    args: '',
    cwd: '',
    launchMode: 'auto',
    isolatedProfile: false,
  };
}

export const ClientTools: React.FC<ClientToolsProps> = ({
  envInfo,
  settings,
  activeNode,
  onUpdateSettings,
  onRefreshEnv,
  onNotify,
}) => {
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([]);
  const [detectedApps, setDetectedApps] = useState<DetectedDesktopApp[]>([]);
  const [editingApp, setEditingApp] = useState<ProxiedAppProfile | null>(null);
  const [diagTarget, setDiagTarget] = useState('https://chatgpt.com');
  const [diagResult, setDiagResult] = useState<DiagnosticsResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [engineBusy, setEngineBusy] = useState(false);

  useEffect(() => {
    window.relayApi.detectBrowsers().then(setBrowsers);
    window.relayApi.detectDesktopApps().then(setDetectedApps);
  }, []);

  const proxyTarget = activeNode ?? {
    mode: 'socks5' as const,
    localPort: 1080,
    engine: 'openssh' as const,
  };
  const snippets = buildTerminalProxySnippets(proxyTarget);
  const proxiedApps = settings.proxiedApps ?? [];

  const handleCopy = async (label: string, text: string) => {
    await window.relayApi.copyText(text);
    onNotify('success', `已复制 ${label} 命令`);
  };

  const handlePickAppExe = async () => {
    if (!editingApp) return;
    const picked = await window.relayApi.selectFile('选择要定向代理启动的应用程序 (.exe)', [
      { name: '应用程序', extensions: ['exe'] },
    ]);
    if (picked) {
      const baseName = picked.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') || '';
      setEditingApp({
        ...editingApp,
        exePath: picked,
        name: editingApp.name.trim() ? editingApp.name : baseName,
      });
    }
  };

  const handleSaveProxiedApp = async () => {
    if (!editingApp) return;
    if (!editingApp.exePath.trim()) {
      onNotify('warn', '请选择或填写应用程序 .exe 路径');
      return;
    }
    const cleanName =
      editingApp.name.trim() ||
      editingApp.exePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') ||
      '未命名应用';
    const nextItem: ProxiedAppProfile = {
      ...editingApp,
      name: cleanName,
      exePath: editingApp.exePath.trim(),
      args: editingApp.args?.trim() || '',
      cwd: editingApp.cwd?.trim() || '',
    };

    const exists = proxiedApps.some((a) => a.id === nextItem.id);
    const nextList = exists
      ? proxiedApps.map((a) => (a.id === nextItem.id ? nextItem : a))
      : [...proxiedApps, nextItem];

    await onUpdateSettings({ proxiedApps: nextList });
    setEditingApp(null);
    onNotify('success', `已保存定向代理应用「${nextItem.name}」`);
  };

  const handleQuickAddDetectedApp = async (detected: DetectedDesktopApp) => {
    const alreadyExists = proxiedApps.some(
      (a) => a.exePath.trim().toLowerCase() === detected.exePath.trim().toLowerCase()
    );
    if (alreadyExists) {
      onNotify('info', `「${detected.name}」已在启动列表中`);
      return;
    }
    const item: ProxiedAppProfile = {
      id: `app-${detected.id}-${Date.now()}`,
      name: detected.name,
      exePath: detected.exePath,
      args: '',
      cwd: '',
      launchMode: detected.suggestedMode,
      isolatedProfile: false,
    };
    await onUpdateSettings({ proxiedApps: [...proxiedApps, item] });
    onNotify('success', `已添加「${detected.name}」，点击「代理启动」即可独立走代理`);
  };

  const handleDeleteProxiedApp = async (id: string) => {
    await onUpdateSettings({ proxiedApps: proxiedApps.filter((a) => a.id !== id) });
    onNotify('info', '已从定向代理启动列表移除');
  };

  const handleLaunchProxiedApp = async (item: ProxiedAppProfile) => {
    const res = await window.relayApi.launchProxiedApp(item, proxyTarget);
    onNotify(res.ok ? 'success' : 'error', res.message);
  };

  const handlePickCustomBrowser = async () => {
    const picked = await window.relayApi.selectFile('选择浏览器可执行文件', [
      { name: '可执行文件', extensions: ['exe'] },
    ]);
    if (picked) {
      await onUpdateSettings({
        browser: { ...settings.browser, selectedBrowser: 'custom', customBrowserPath: picked },
      });
    }
  };

  const handleLaunchBrowser = async () => {
    const res = await window.relayApi.launchProxyBrowser(proxyTarget, settings.browser);
    onNotify(res.ok ? 'success' : 'error', res.message);
  };

  const handlePickOpenSshDir = async () => {
    const dir = await window.relayApi.selectDirectory('选择新版 Win32-OpenSSH 目录（含 ssh.exe）');
    if (dir) {
      await onUpdateSettings({ customOpenSshDir: dir });
      await onRefreshEnv();
      onNotify('success', `已设置自定义 OpenSSH 目录: ${dir}`);
    }
  };

  const handleResetOpenSshDir = async () => {
    await onUpdateSettings({ customOpenSshDir: '' });
    await onRefreshEnv();
    onNotify('info', '已恢复自动探测系统 OpenSSH 路径');
  };

  const handleDownloadHysteria = async () => {
    setEngineBusy(true);
    try {
      const res = await window.relayApi.downloadHysteriaBinary('clientA');
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefreshEnv();
    } finally {
      setEngineBusy(false);
    }
  };

  const handleImportHysteria = async () => {
    const file = await window.relayApi.selectFile('选择本地 Hysteria 2 可执行文件', [
      { name: 'Hysteria 2', extensions: ['exe'] },
    ]);
    if (!file) return;
    setEngineBusy(true);
    try {
      const res = await window.relayApi.importHysteriaBinary('clientA', file);
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefreshEnv();
    } finally {
      setEngineBusy(false);
    }
  };

  const handleRunDiagnostics = async () => {
    setDiagBusy(true);
    try {
      const res = await window.relayApi.runDiagnostics(proxyTarget, diagTarget);
      setDiagResult(res);
      if (res.localPortListening && res.exitIp && res.targetSiteOk) {
        onNotify('success', `链路全部通过！当前出口 IP: ${res.exitIp}`);
      } else {
        onNotify('warn', '部分诊断项目未通过，请检查下方详情');
      }
    } finally {
      setDiagBusy(false);
    }
  };

  const unaddedDetectedApps = detectedApps.filter(
    (d) =>
      !proxiedApps.some(
        (a) => a.exePath.trim().toLowerCase() === d.exePath.trim().toLowerCase()
      )
  );

  const launchModeLabel = (mode: ProxiedAppProfile['launchMode']) =>
    mode === 'auto'
      ? '智能识别'
      : mode === 'chromiumArgs'
      ? 'Chromium 参数 + 环境变量'
      : '仅代理环境变量';

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">定向应用启动、代理浏览器与工具</h1>
          <p className="page-desc">
            指定拉起任意桌面应用独立走本地 HTTP + SOCKS5 混合代理（127.0.0.1:{proxyTarget.localPort}），系统与其他软件完全不受影响
          </p>
        </div>
      </div>

      {/* Per-App Isolated Proxy Launcher Card */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconLaptop size={17} />
              定向应用代理启动器（不影响系统和其他软件）
            </h3>
            <p className="card-subtitle">
              仅向拉起的子进程注入独立代理环境（HTTP + SOCKS5 混合端口）与 Electron/Chromium 代理参数；未从此处启动的软件全部保持直连
            </p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setEditingApp(createEmptyProxiedApp())}
          >
            + 添加指定应用 (.exe)
          </button>
        </div>

        {proxiedApps.length > 0 ? (
          <div className="stack-sm">
            {proxiedApps.map((item) => (
              <div key={item.id} className="node-card">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-wrap" style={{ gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: 14.5 }}>{item.name}</strong>
                    <StatusBadge variant="accent" dot={false} label={launchModeLabel(item.launchMode)} />
                    {item.isolatedProfile && (
                      <StatusBadge variant="neutral" dot={false} label="独立数据目录" />
                    )}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {item.exePath}
                    {item.args ? ` ${item.args}` : ''}
                  </div>
                </div>
                <div className="row-wrap" style={{ flexShrink: 0 }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => handleLaunchProxiedApp(item)}
                  >
                    代理启动
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setEditingApp({ ...item })}
                  >
                    编辑
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => handleDeleteProxiedApp(item.id)}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="callout">
            尚未添加应用。点击右上角「+ 添加指定应用 (.exe)」选择任意程序，或直接点击下方已探测到的常用软件一键添加；添加后也会自动出现在首页快捷启动栏。
          </div>
        )}

        {unaddedDetectedApps.length > 0 && (
          <div className="row-wrap" style={{ gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              本机常用应用（点击快速添加）：
            </span>
            {unaddedDetectedApps.map((d) => (
              <button
                key={d.id}
                type="button"
                className="btn btn-sm"
                onClick={() => handleQuickAddDetectedApp(d)}
              >
                + {d.name}
              </button>
            ))}
          </div>
        )}

        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          提示：Cursor、VS Code、Claude、Discord 等 Electron 应用若已在后台打开，请先完全退出原进程再从此处启动（或在编辑中勾选「独立用户数据目录」双开），以确保新进程吃上代理参数。
        </div>
      </div>

      {/* Transport Engines & Win32-OpenSSH Version Card */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">跨国弱网传输内核与 Win32-OpenSSH 版本管理</h3>
            <p className="card-subtitle">
              升级新版 Win32-OpenSSH (v9.5+) 可提升 SSH 吞吐；部署 Hysteria 2 (QUIC) 可彻底消除弱网 TCP-over-TCP 熔断并支持 UDP
            </p>
          </div>
        </div>

        <div className="grid-2">
          <div className="metric-tile stack-sm" style={{ gap: 8 }}>
            <div className="row-between">
              <span className="metric-label">OpenSSH 客户端版本</span>
              <StatusBadge
                variant={
                  envInfo?.sshClientVersion.isLegacy
                    ? 'warn'
                    : envInfo?.sshClientAvailable
                    ? 'success'
                    : 'danger'
                }
                label={
                  envInfo?.sshClientVersion.version
                    ? `v${envInfo.sshClientVersion.version}${envInfo.sshClientVersion.isLegacy ? ' (较旧)' : ''}`
                    : envInfo?.sshClientAvailable
                    ? '可用'
                    : '未检测到'
                }
              />
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
              {envInfo?.sshClientPath || '自动探测'}
            </div>
            {envInfo?.sshClientVersion.isLegacy && (
              <div style={{ fontSize: 12, color: 'var(--warn)' }}>
                检测到旧版 Windows 内置 OpenSSH（&lt; 9.0），建议升级官方 Win32-OpenSSH v9.8+ 提升并发吞吐。
              </div>
            )}
            <div className="row-wrap">
              <button className="btn btn-sm" onClick={handlePickOpenSshDir}>
                指定新版 OpenSSH 目录
              </button>
              {settings.customOpenSshDir && (
                <button className="btn btn-sm btn-ghost" onClick={handleResetOpenSshDir}>
                  恢复默认
                </button>
              )}
              <button
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  window.relayApi.openExternal('https://github.com/PowerShell/Win32-OpenSSH/releases')
                }
              >
                下载新版 Win32-OpenSSH
              </button>
            </div>
          </div>

          <div className="metric-tile stack-sm" style={{ gap: 8 }}>
            <div className="row-between">
              <span className="metric-label">Hysteria 2 (QUIC 弱网加速引擎)</span>
              <StatusBadge
                variant={envInfo?.hysteriaClient.installed ? 'success' : 'neutral'}
                label={
                  envInfo?.hysteriaClient.installed
                    ? `已就绪 (${envInfo.hysteriaClient.version ?? 'v2'})`
                    : '未安装'
                }
              />
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
              {envInfo?.hysteriaClient.path || '自动托管目录'}
            </div>
            <div className="row-wrap">
              {envInfo?.hysteriaClient.installed ? (
                <button className="btn btn-sm" disabled>
                  ✓ 已安装 ({envInfo.hysteriaClient.version ?? 'v2'})
                </button>
              ) : (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleDownloadHysteria}
                  disabled={engineBusy}
                >
                  {engineBusy ? '下载中...' : '一键下载 Hysteria 2'}
                </button>
              )}
              <button
                className="btn btn-sm"
                onClick={handleImportHysteria}
                disabled={engineBusy}
              >
                {envInfo?.hysteriaClient.installed ? '替换本地文件' : '导入本地 hysteria.exe'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Diagnostics Card */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconActivity size={17} />
              一键链路自检与出口 IP 核验
            </h3>
            <p className="card-subtitle">
              检测本地代理监听端口、经由隧道查询出口公网 IP（确认归属设备 B），并测试目标站点响应
            </p>
          </div>
          <button className="btn btn-primary" onClick={handleRunDiagnostics} disabled={diagBusy}>
            {diagBusy ? '正在诊断...' : '运行链路诊断'}
          </button>
        </div>

        <div className="row-wrap">
          <label className="field-label" style={{ marginRight: 6 }}>
            目标检测地址：
          </label>
          <input
            className="input mono"
            style={{ maxWidth: 320 }}
            value={diagTarget}
            onChange={(e) => setDiagTarget(e.target.value)}
          />
        </div>

        {diagResult && (
          <div className="grid-3" style={{ marginTop: 8 }}>
            <div className="metric-tile">
              <div className="row-between">
                <span className="metric-label">本地端口监听</span>
                <StatusBadge
                  variant={diagResult.localPortListening ? 'success' : 'danger'}
                  label={diagResult.localPortListening ? '正常' : '未监听'}
                />
              </div>
              <div className="metric-sub" style={{ marginTop: 8 }}>
                {diagResult.localPortDetail}
              </div>
            </div>

            <div className="metric-tile">
              <div className="row-between">
                <span className="metric-label">隧道出口公网 IP</span>
                <StatusBadge
                  variant={diagResult.exitIp ? 'success' : 'danger'}
                  label={diagResult.exitIp ? '已获取' : '失败'}
                />
              </div>
              <div className="metric-value" style={{ fontSize: 15, marginTop: 6 }}>
                {diagResult.exitIp || '--'}
              </div>
              <div className="metric-sub">{diagResult.exitIpDetail}</div>
            </div>

            <div className="metric-tile">
              <div className="row-between">
                <span className="metric-label">目标站点连通性</span>
                <StatusBadge
                  variant={diagResult.targetSiteOk ? 'success' : 'danger'}
                  label={
                    diagResult.targetSiteLatencyMs
                      ? `${diagResult.targetSiteLatencyMs}ms`
                      : diagResult.targetSiteOk
                      ? '可达'
                      : '异常'
                  }
                />
              </div>
              <div className="metric-sub" style={{ marginTop: 8 }}>
                {diagResult.targetSiteStatus}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Browser Launcher Settings */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconGlobe size={17} />
              独立全站代理浏览器配置
            </h3>
            <p className="card-subtitle">
              独立用户数据目录，与日常浏览器完全隔离、保留登录状态且默认无顶部命令行安全警告横幅
            </p>
          </div>
          <button className="btn btn-primary" onClick={handleLaunchBrowser}>
            立即启动浏览器
          </button>
        </div>

        <div className="grid-2">
          <div className="field">
            <label className="field-label">选择浏览器</label>
            <select
              className="select"
              value={settings.browser.selectedBrowser}
              onChange={(e) =>
                onUpdateSettings({
                  browser: {
                    ...settings.browser,
                    selectedBrowser: e.target.value as AppSettings['browser']['selectedBrowser'],
                  },
                })
              }
            >
              {browsers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} {b.exists ? '（已检测到）' : '（未自动检测到）'}
                </option>
              ))}
              <option value="custom">自定义 Chromium 浏览器路径...</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label">启动默认打开页面（可选）</label>
            <input
              className="input mono"
              value={settings.browser.startUrl}
              onChange={(e) =>
                onUpdateSettings({
                  browser: { ...settings.browser, startUrl: e.target.value },
                })
              }
              placeholder="https://ipinfo.io"
            />
          </div>
        </div>

        {settings.browser.selectedBrowser === 'custom' && (
          <div className="field">
            <label className="field-label">自定义浏览器可执行文件路径</label>
            <div className="row-wrap" style={{ flexWrap: 'nowrap' }}>
              <input
                className="input mono"
                value={settings.browser.customBrowserPath}
                onChange={(e) =>
                  onUpdateSettings({
                    browser: { ...settings.browser, customBrowserPath: e.target.value },
                  })
                }
                placeholder="C:\Program Files\...\chrome.exe"
              />
              <button className="btn" onClick={handlePickCustomBrowser}>
                浏览
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label className="field-label">
            独立用户数据目录（留空则默认使用 %LOCALAPPDATA%\Edge 或 Chrome，支持环境变量）
          </label>
          <input
            className="input mono"
            value={settings.browser.userDataDir}
            onChange={(e) =>
              onUpdateSettings({
                browser: { ...settings.browser, userDataDir: e.target.value },
              })
            }
            placeholder="默认自动创建独立目录"
          />
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.browser.disableQuic !== false}
            onChange={(e) =>
              onUpdateSettings({
                browser: { ...settings.browser, disableQuic: e.target.checked },
              })
            }
          />
          <span>
            推荐：仅在 <strong>OpenSSH SOCKS5 模式</strong>下禁用浏览器 HTTP/3（<code className="mono">--disable-quic</code>，避免 SSH 纯 TCP 通道访问站点时触发 UDP 回退延迟；使用 Hysteria 2 QUIC 加速时会自动保留浏览器 HTTP/3）
          </span>
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.browser.useHostResolverRules}
            onChange={(e) =>
              onUpdateSettings({
                browser: { ...settings.browser, useHostResolverRules: e.target.checked },
              })
            }
          />
          <span>
            高级：启用 <code className="mono">--host-resolver-rules</code>（仅当严格内网出现 ERR_NAME_NOT_RESOLVED 时勾选，启用后浏览器顶部会有提示横幅）
          </span>
        </label>
      </div>

      {/* Terminal / API Proxy Snippets */}
      <details className="advanced-drawer">
        <summary>
          <span className="row-wrap" style={{ gap: 8 }}>
            <IconTerminal size={16} />
            <span>终端与代码 API 代理环境变量（PowerShell / CMD / Bash / curl）</span>
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            127.0.0.1:{proxyTarget.localPort}
          </span>
        </summary>
        <div className="advanced-drawer-body">
          <p className="card-subtitle">
            使用 <code className="mono">socks5h://</code> 强制由设备 B 解析域名；Python 调用 OpenAI/httpx 请安装{' '}
            <code className="mono">httpx[socks]</code>
          </p>

          <div className="grid-2">
            <div className="field">
              <div className="row-between">
                <span className="field-label">PowerShell</span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => handleCopy('PowerShell', snippets.powershell)}
                >
                  <IconCopy size={13} /> 复制
                </button>
              </div>
              <div className="code-block">{snippets.powershell}</div>
            </div>

            <div className="field">
              <div className="row-between">
                <span className="field-label">CMD / 批处理</span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => handleCopy('CMD', snippets.cmd)}
                >
                  <IconCopy size={13} /> 复制
                </button>
              </div>
              <div className="code-block">{snippets.cmd}</div>
            </div>

            <div className="field">
              <div className="row-between">
                <span className="field-label">Git Bash / WSL</span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => handleCopy('Bash', snippets.bash)}
                >
                  <IconCopy size={13} /> 复制
                </button>
              </div>
              <div className="code-block">{snippets.bash}</div>
            </div>

            <div className="field">
              <div className="row-between">
                <span className="field-label">curl 出口 IP 验证</span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => handleCopy('curl', snippets.curlTest)}
                >
                  <IconCopy size={13} /> 复制
                </button>
              </div>
              <div className="code-block">{snippets.curlTest}</div>
            </div>
          </div>
        </div>
      </details>

      {/* Add / Edit Proxied App Modal */}
      <Modal
        open={Boolean(editingApp)}
        title={
          editingApp && proxiedApps.some((a) => a.id === editingApp.id)
            ? '编辑定向代理应用'
            : '添加定向代理应用'
        }
        subtitle="仅对通过本软件拉起的该应用进程生效，绝不修改 Windows 系统代理或影响其他软件"
        onClose={() => setEditingApp(null)}
        footer={
          <>
            <button className="btn" onClick={() => setEditingApp(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={handleSaveProxiedApp}>
              保存应用
            </button>
          </>
        }
      >
        {editingApp && (
          <>
            <div className="field">
              <label className="field-label">应用程序可执行文件 (.exe)</label>
              <div className="row-wrap" style={{ flexWrap: 'nowrap' }}>
                <input
                  className="input mono"
                  value={editingApp.exePath}
                  onChange={(e) => setEditingApp({ ...editingApp, exePath: e.target.value })}
                  placeholder="例如：C:\Users\...\Programs\cursor\Cursor.exe"
                />
                <button className="btn" type="button" onClick={handlePickAppExe}>
                  浏览 .exe
                </button>
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label className="field-label">显示名称</label>
                <input
                  className="input"
                  value={editingApp.name}
                  onChange={(e) => setEditingApp({ ...editingApp, name: e.target.value })}
                  placeholder="例如：Cursor / 代理终端"
                />
              </div>
              <div className="field">
                <label className="field-label">代理注入模式</label>
                <select
                  className="select"
                  value={editingApp.launchMode}
                  onChange={(e) =>
                    setEditingApp({
                      ...editingApp,
                      launchMode: e.target.value as ProxiedAppProfile['launchMode'],
                    })
                  }
                >
                  <option value="auto">智能自动识别（推荐：Electron/Chromium 自动附带 --proxy-server）</option>
                  <option value="envOnly">仅注入代理环境变量（适合终端 / CLI / Python / Telegram 等）</option>
                  <option value="chromiumArgs">强制附加 Chromium --proxy-server + 环境变量</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label className="field-label">附加启动参数（可选）</label>
              <input
                className="input mono"
                value={editingApp.args ?? ''}
                onChange={(e) => setEditingApp({ ...editingApp, args: e.target.value })}
                placeholder="例如：--new-window 或工作区路径"
              />
            </div>

            {editingApp.launchMode !== 'envOnly' && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={Boolean(editingApp.isolatedProfile)}
                  onChange={(e) =>
                    setEditingApp({ ...editingApp, isolatedProfile: e.target.checked })
                  }
                />
                <span>
                  为 Chromium / Electron 应用启用独立用户数据目录（<code className="mono">--user-data-dir</code>，可与普通未代理实例同时双开）
                </span>
              </label>
            )}
          </>
        )}
      </Modal>
    </div>
  );
};
