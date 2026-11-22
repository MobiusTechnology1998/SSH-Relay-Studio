import React, { useEffect, useState } from 'react';
import { buildTerminalProxySnippets } from '../../../shared/commandBuilders';
import type {
  AppSettings,
  DetectedBrowser,
  DiagnosticsResult,
  NodeProfile,
} from '../../../shared/types';
import { IconActivity, IconCopy, IconGlobe, IconTerminal } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientToolsProps {
  settings: AppSettings;
  activeNode: NodeProfile | null;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

export const ClientTools: React.FC<ClientToolsProps> = ({
  settings,
  activeNode,
  onUpdateSettings,
  onNotify,
}) => {
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([]);
  const [diagTarget, setDiagTarget] = useState('https://chatgpt.com');
  const [diagResult, setDiagResult] = useState<DiagnosticsResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

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
          <h1 className="page-title">代理浏览器、终端辅助与链路诊断</h1>
          <p className="page-desc">
            配置环境隔离的全站代理浏览器、复制 API/终端代理变量，以及一键核验出口 IP 与目标站连通性
          </p>
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
            独立用户数据目录（留空则默认使用 %LOCALAPPDATA%\Edge-GPT 或 Chrome-GPT）
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
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconTerminal size={17} />
              终端与代码 API 代理环境变量
            </h3>
            <p className="card-subtitle">
              使用 <code className="mono">socks5h://</code> 强制由设备 B 解析域名；Python 调用 OpenAI/httpx 请安装{' '}
              <code className="mono">httpx[socks]</code>
            </p>
          </div>
        </div>

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
    </div>
  );
};
