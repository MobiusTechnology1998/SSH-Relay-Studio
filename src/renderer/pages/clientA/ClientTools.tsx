import React, { useEffect, useState } from 'react';
import { buildTerminalProxySnippets } from '../../../shared/commandBuilders';
import type {
  AppSettings,
  DetectedBrowser,
  DiagnosticsResult,
  EnvironmentInfo,
  NodeProfile,
} from '../../../shared/types';
import { IconActivity, IconCopy, IconGlobe, IconTerminal } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientToolsProps {
  envInfo: EnvironmentInfo | null;
  settings: AppSettings;
  activeNode: NodeProfile | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onRefreshEnv: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
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
  const [diagTarget, setDiagTarget] = useState('https://chatgpt.com');
  const [diagResult, setDiagResult] = useState<DiagnosticsResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [engineBusy, setEngineBusy] = useState(false);

  useEffect(() => {
    window.relayApi.detectBrowsers().then(setBrowsers);
  }, []);

  const proxyTarget = activeNode ?? { mode: 'socks5' as const, localPort: 1080 };
  const snippets = buildTerminalProxySnippets(proxyTarget);

  const handleCopy = async (label: string, text: string) => {
    await window.relayApi.copyText(text);
    onNotify('success', `已复制 ${label} 命令`);
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

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">代理浏览器、内核管理与链路诊断</h1>
          <p className="page-desc">
            管理 OpenSSH / QUIC (Hysteria 2) 传输内核、独立全站代理浏览器、终端代理变量与链路自检
          </p>
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
            推荐：SOCKS5 模式下禁用 QUIC / HTTP3（<code className="mono">--disable-quic</code>，避免访问 Cloudflare/Google/OpenAI 等站点时因 UDP 不可达导致超时回退，无警告横幅）
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
    </div>
  );
};
