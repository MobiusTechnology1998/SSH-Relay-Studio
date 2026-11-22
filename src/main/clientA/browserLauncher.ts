import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBrowserLaunchArgs } from '../../shared/commandBuilders';
import type { ActionResult, BrowserPrefs, DetectedBrowser, NodeProfile } from '../../shared/types';
import { logger } from '../logger';
import { IS_WINDOWS } from '../platform/shell';

export function detectInstalledBrowsers(): DetectedBrowser[] {
  if (!IS_WINDOWS) {
    return [
      {
        id: 'edge',
        name: 'Microsoft Edge',
        path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        exists: false,
      },
      {
        id: 'chrome',
        name: 'Google Chrome',
        path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        exists: false,
      },
    ];
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const chromeCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  const foundEdge = edgeCandidates.find((p) => fs.existsSync(p));
  const foundChrome = chromeCandidates.find((p) => fs.existsSync(p));

  return [
    {
      id: 'edge',
      name: 'Microsoft Edge',
      path: foundEdge || edgeCandidates[0],
      exists: Boolean(foundEdge),
    },
    {
      id: 'chrome',
      name: 'Google Chrome',
      path: foundChrome || chromeCandidates[0],
      exists: Boolean(foundChrome),
    },
  ];
}

export function resolveDefaultBrowserProfileDir(browserId: BrowserPrefs['selectedBrowser']): string {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const folderName =
    browserId === 'chrome'
      ? 'Chrome-GPT'
      : browserId === 'edge'
      ? 'Edge-GPT'
      : 'Browser-GPT';
  return path.join(localAppData, folderName);
}

export function launchProxyBrowser(
  node: Pick<NodeProfile, 'mode' | 'localPort'>,
  prefs: BrowserPrefs
): ActionResult {
  const detected = detectInstalledBrowsers();
  let exePath = '';

  if (prefs.selectedBrowser === 'custom') {
    exePath = prefs.customBrowserPath.trim();
  } else {
    const match = detected.find((b) => b.id === prefs.selectedBrowser);
    exePath = match?.path || '';
  }

  if (!exePath) {
    return { ok: false, message: '未指定浏览器可执行文件路径' };
  }

  if (!fs.existsSync(exePath)) {
    return {
      ok: false,
      message: `找不到浏览器程序: ${exePath}。请在浏览器设置中切换其他浏览器或指定自定义路径。`,
    };
  }

  const userDataDir =
    prefs.userDataDir.trim() || resolveDefaultBrowserProfileDir(prefs.selectedBrowser);
  const args = buildBrowserLaunchArgs(node, prefs, userDataDir);

  try {
    const child = spawn(exePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    logger.success(
      'clientA',
      `已启动独立代理浏览器: ${path.basename(exePath)} (代理 127.0.0.1:${node.localPort}, 数据目录 ${userDataDir})`
    );
    return {
      ok: true,
      message: `已启动独立代理浏览器窗口（数据目录: ${userDataDir}）`,
    };
  } catch (err) {
    const msg = `启动浏览器失败: ${(err as Error).message}`;
    logger.error('clientA', msg);
    return { ok: false, message: msg };
  }
}
