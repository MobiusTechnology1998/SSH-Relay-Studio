import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  shell,
  Tray,
} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SshdConfigUpdate } from '../shared/sshConfigParser';
import type {
  AppRole,
  AppSettings,
  BrowserPrefs,
  EnvironmentInfo,
  NodeProfile,
  QuicServerConfigInput,
  ServerOverview,
  TunnelStatus,
} from '../shared/types';
import { setAutoStartEnabled } from './clientA/autostart';
import { detectInstalledBrowsers, launchProxyBrowser } from './clientA/browserLauncher';
import { runTunnelDiagnostics } from './clientA/diagnostics';
import {
  generateEd25519KeyPair,
  getKeyPairInfo,
  runSecurityVerification,
  scanHostKeys,
  trustHostKeys,
} from './clientA/keyManager';
import { tunnelManager } from './clientA/tunnelManager';
import { logger } from './logger';
import {
  downloadHysteriaBinary,
  importLocalHysteriaBinary,
  inspectHysteriaBinary,
} from './platform/binaryMgr';
import { checkIsAdmin, relaunchAsAdmin } from './platform/privilege';
import {
  detectOpenSshVersion,
  IS_WINDOWS,
  resolveOpenSshBinary,
  setCustomOpenSshDir,
} from './platform/shell';
import {
  addAuthorizedKeyToServer,
  deleteAuthorizedKeyFromServer,
  getAuthorizedKeysState,
  resolveAuthorizedKeysPath,
  tightenAuthorizedKeysPermissions,
} from './serverB/authKeysMgr';
import {
  allowFirewallPort,
  disablePort22FirewallRule,
  listSshFirewallRules,
} from './serverB/firewallMgr';
import { detectServerPublicIp, inspectNetworkState } from './serverB/networkMonitor';
import {
  configureSshdFailureRecovery,
  controlSshdService,
  getOpenSshServiceStatus,
  installOpenSshServer,
} from './serverB/opensshService';
import { quicServerMgr } from './serverB/quicServerMgr';
import {
  applySshdConfigUpdate,
  readHostPublicKey,
  readSshdConfigState,
  restoreSshdConfigBackup,
} from './serverB/sshdConfigMgr';
import {
  applyServerSystemTuning,
  getServerSystemTuning,
  getWindowsUpdatePolicy,
  setDisableAutoReboot,
} from './serverB/stabilityMgr';
import { settingsStore } from './store';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function getResourcePath(filename: string): string {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'resources', filename);
    if (fs.existsSync(unpacked)) return unpacked;
    return path.join(process.resourcesPath, 'app.asar', 'resources', filename);
  }
  return path.join(__dirname, '../../../resources', filename);
}

function loadTrayIcon(status: TunnelStatus, role: AppRole): Electron.NativeImage {
  let file = 'tray-idle.png';
  if (role === 'serverB') {
    file = 'tray-server.png';
  } else if (status.state === 'connected') {
    file = 'tray-connected.png';
  } else if (status.state === 'connecting' || status.state === 'reconnecting') {
    file = 'tray-reconnecting.png';
  } else if (status.state === 'error') {
    file = 'tray-error.png';
  }

  const iconPath = getResourcePath(file);
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  const fallbackPath = getResourcePath('icon.png');
  if (fs.existsSync(fallbackPath)) {
    return nativeImage.createFromPath(fallbackPath).resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function updateTrayUI(): void {
  if (!tray) return;
  const settings = settingsStore.load();
  const status = tunnelManager.getStatus();
  const activeNode = settingsStore.getActiveNode();

  tray.setImage(loadTrayIcon(status, settings.role));

  const stateLabelMap: Record<TunnelStatus['state'], string> = {
    disconnected: '未连接',
    connecting: '连接中...',
    connected: `已连接 (${status.healthyWorkers}/${status.poolSize} 通道 · :${status.localPort})`,
    reconnecting: `自动重连中 (#${status.reconnectCount})`,
    error: '连接异常',
  };

  const tooltip =
    settings.role === 'serverB'
      ? 'SSH Relay Studio — 设备 B（中转端）'
      : `SSH Relay Studio — ${stateLabelMap[status.state]}`;
  tray.setToolTip(tooltip);

  const isRunning =
    status.state === 'connected' ||
    status.state === 'connecting' ||
    status.state === 'reconnecting';

  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: '打开主窗口',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
  ];

  if (settings.role !== 'serverB') {
    menuTemplate.push(
      {
        label: `状态: ${stateLabelMap[status.state]}`,
        enabled: false,
      },
      {
        label: isRunning ? '断开隧道' : `连接隧道${activeNode ? ` (${activeNode.name})` : ''}`,
        enabled: Boolean(activeNode) || isRunning,
        click: async () => {
          if (isRunning) {
            await tunnelManager.stop();
          } else if (activeNode) {
            await tunnelManager.start(activeNode);
          }
        },
      },
      {
        label: '无感平滑热轮换',
        enabled: status.state === 'connected',
        click: async () => {
          await tunnelManager.rotateAllGracefully();
        },
      },
      {
        label: '立即重连',
        enabled: Boolean(activeNode),
        click: async () => {
          if (isRunning) {
            await tunnelManager.reconnectNow();
          } else if (activeNode) {
            await tunnelManager.start(activeNode);
          }
        },
      },
      {
        label: '启动独立代理浏览器',
        enabled: Boolean(activeNode),
        click: () => {
          if (activeNode) {
            launchProxyBrowser(activeNode, settings.browser);
          }
        },
      },
      { type: 'separator' }
    );
  }

  menuTemplate.push({
    label: '彻底退出（停止隧道）',
    click: async () => {
      isQuitting = true;
      await tunnelManager.stop(true);
      app.quit();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow(false);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(startHidden = false): void {
  const iconPath = getResourcePath('icon.png');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 660,
    show: !startHidden,
    title: 'SSH Relay Studio',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#f6f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
  }

  mainWindow.on('close', (e) => {
    const settings = settingsStore.load();
    if (!isQuitting && settings.minimizeToTray && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  try {
    const settings = settingsStore.load();
    const status = tunnelManager.getStatus();
    tray = new Tray(loadTrayIcon(status, settings.role));
    tray.on('double-click', () => showMainWindow());
    tray.on('click', () => showMainWindow());
    updateTrayUI();
  } catch (err) {
    logger.warn('system', `系统托盘初始化失败: ${(err as Error).message}`);
  }
}

function registerIpcHandlers(): void {
  // ===== App & Environment =====
  ipcMain.handle('app:getEnvInfo', async (): Promise<EnvironmentInfo> => {
    const settings = settingsStore.load();
    setCustomOpenSshDir(settings.customOpenSshDir);
    tunnelManager.setCustomHysteriaPath(settings.customHysteriaPath);

    const [isAdmin, sshClientVersion, hysteriaClient] = await Promise.all([
      checkIsAdmin(),
      detectOpenSshVersion('ssh'),
      inspectHysteriaBinary('clientA', settings.customHysteriaPath),
    ]);
    const sshPath = resolveOpenSshBinary('ssh');
    const sshClientAvailable = IS_WINDOWS ? fs.existsSync(sshPath) || sshPath === 'ssh.exe' : true;
    return {
      platform: process.platform,
      isWindows: IS_WINDOWS,
      isAdmin,
      hostname: os.hostname(),
      username: os.userInfo().username,
      appVersion: app.getVersion(),
      userDataDir: app.getPath('userData'),
      sshClientAvailable,
      sshClientPath: sshPath,
      sshClientVersion,
      hysteriaClient,
    };
  });

  ipcMain.handle('app:getSettings', () => settingsStore.load());

  ipcMain.handle('app:updateSettings', (_e, patch: Partial<AppSettings>) => {
    const updated = settingsStore.update(patch);
    setCustomOpenSshDir(updated.customOpenSshDir);
    tunnelManager.setCustomHysteriaPath(updated.customHysteriaPath);
    updateTrayUI();
    return updated;
  });

  ipcMain.handle('app:setRole', (_e, role: AppRole) => {
    const updated = settingsStore.update({ role });
    logger.info(
      'system',
      `切换应用角色 -> ${role === 'clientA' ? '设备 A（使用端）' : role === 'serverB' ? '设备 B（中转端）' : '未选择'}`
    );
    updateTrayUI();
    return updated;
  });

  ipcMain.handle('app:relaunchAsAdmin', (_e, targetRole: 'serverB' | 'clientA' = 'serverB') =>
    relaunchAsAdmin(targetRole)
  );

  ipcMain.handle('app:copyText', (_e, text: string) => {
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle(
    'app:selectFile',
    async (_e, title: string, filters?: Array<{ name: string; extensions: string[] }>) => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title,
        properties: ['openFile'],
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );

  ipcMain.handle('app:selectDirectory', async (_e, title: string) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title,
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    await shell.openExternal(url);
  });

  // ===== Logs =====
  ipcMain.handle('logs:get', () => logger.getAll());
  ipcMain.handle('logs:clear', () => {
    logger.clear();
  });

  // ===== Client A: Tunnel =====
  ipcMain.handle('clientA:getTunnelStatus', () => tunnelManager.getStatus());

  ipcMain.handle('clientA:startTunnel', async (_e, nodeId?: string) => {
    const settings = settingsStore.load();
    setCustomOpenSshDir(settings.customOpenSshDir);
    tunnelManager.setCustomHysteriaPath(settings.customHysteriaPath);
    const targetNode = nodeId
      ? settings.nodes.find((n) => n.id === nodeId)
      : settingsStore.getActiveNode();
    if (!targetNode) {
      return { ok: false, message: '请先添加一个中转节点（设备 B）' };
    }
    if (settings.activeNodeId !== targetNode.id) {
      settingsStore.update({ activeNodeId: targetNode.id });
    }
    return tunnelManager.start(targetNode);
  });

  ipcMain.handle('clientA:stopTunnel', () => tunnelManager.stop());
  ipcMain.handle('clientA:reconnectTunnel', () => tunnelManager.reconnectNow());
  ipcMain.handle('clientA:rotatePool', () => tunnelManager.rotateAllGracefully());
  ipcMain.handle('clientA:killOrphanSsh', () => tunnelManager.killOrphanSshProcesses());

  // ===== Client A: Keys & Security =====
  ipcMain.handle('clientA:getKeyPairInfo', (_e, customPath?: string) => getKeyPairInfo(customPath));
  ipcMain.handle('clientA:generateKeyPair', (_e, forceOverwrite = false) =>
    generateEd25519KeyPair(forceOverwrite)
  );
  ipcMain.handle('clientA:scanHostKeys', (_e, host: string, port: number) =>
    scanHostKeys(host, port)
  );
  ipcMain.handle(
    'clientA:trustHostKeys',
    (_e, host: string, port: number, entries: Array<{ keyType: string; keyData: string }>) =>
      trustHostKeys(host, port, entries)
  );
  ipcMain.handle('clientA:runSecurityVerification', (_e, node: NodeProfile) =>
    runSecurityVerification(node)
  );

  // ===== Client A: Browser, Diagnostics, Engines, AutoStart =====
  ipcMain.handle('clientA:detectBrowsers', () => detectInstalledBrowsers());
  ipcMain.handle(
    'clientA:launchProxyBrowser',
    (_e, node: Pick<NodeProfile, 'mode' | 'localPort' | 'engine'>, prefs: BrowserPrefs) =>
      launchProxyBrowser(node, prefs)
  );
  ipcMain.handle(
    'clientA:runDiagnostics',
    (_e, node: Pick<NodeProfile, 'mode' | 'localPort'>, targetUrl?: string) =>
      runTunnelDiagnostics(node, targetUrl)
  );
  ipcMain.handle('clientA:setAutoStart', (_e, enabled: boolean) => {
    settingsStore.update({ autoStart: enabled });
    return setAutoStartEnabled(enabled);
  });
  ipcMain.handle(
    'engine:downloadHysteria',
    (_e, scope: 'clientA' | 'serverB', customUrl?: string) =>
      downloadHysteriaBinary(scope, customUrl)
  );
  ipcMain.handle(
    'engine:importHysteria',
    (_e, scope: 'clientA' | 'serverB', filePath: string) =>
      importLocalHysteriaBinary(scope, filePath)
  );

  // ===== Server B =====
  ipcMain.handle('serverB:getOverview', async (): Promise<ServerOverview> => {
    const settings = settingsStore.load();
    setCustomOpenSshDir(settings.customOpenSshDir);
    const config = readSshdConfigState();
    const [
      service,
      authorizedKeys,
      firewallRules,
      updatePolicy,
      systemTuning,
      quicServer,
      network,
      detectedPublicIp,
    ] = await Promise.all([
      getOpenSshServiceStatus(),
      getAuthorizedKeysState(
        settings.serverPrefs.useAdminAuthorizedKeys,
        settings.serverPrefs.customAuthorizedKeysPath
      ),
      listSshFirewallRules(),
      getWindowsUpdatePolicy(),
      getServerSystemTuning(),
      quicServerMgr.getStatus(settings.customHysteriaPath),
      inspectNetworkState(config.port),
      detectServerPublicIp(),
    ]);

    return {
      service,
      config,
      authorizedKeys,
      firewallRules,
      updatePolicy,
      systemTuning,
      quicServer,
      listeningPorts: network.listeningPorts,
      activeConnections: network.activeConnections,
      detectedPublicIp,
      localIps: network.localIps,
      hostPublicKey: readHostPublicKey(),
    };
  });

  ipcMain.handle('serverB:installOpenSsh', () => installOpenSshServer());
  ipcMain.handle('serverB:controlSshd', (_e, action: 'start' | 'stop' | 'restart') =>
    controlSshdService(action)
  );
  ipcMain.handle('serverB:configureFailureRecovery', () => configureSshdFailureRecovery());
  ipcMain.handle('serverB:applySshdConfig', (_e, update: SshdConfigUpdate) =>
    applySshdConfigUpdate(update)
  );
  ipcMain.handle('serverB:restoreSshdConfigBackup', () => restoreSshdConfigBackup());

  ipcMain.handle(
    'serverB:addAuthorizedKey',
    (_e, publicKeyText: string, labelComment?: string) => {
      const { useAdminAuthorizedKeys, customAuthorizedKeysPath } =
        settingsStore.load().serverPrefs;
      return addAuthorizedKeyToServer(
        useAdminAuthorizedKeys,
        customAuthorizedKeysPath,
        publicKeyText,
        labelComment
      );
    }
  );

  ipcMain.handle('serverB:removeAuthorizedKey', (_e, keyData: string) => {
    const { useAdminAuthorizedKeys, customAuthorizedKeysPath } = settingsStore.load().serverPrefs;
    return deleteAuthorizedKeyFromServer(
      useAdminAuthorizedKeys,
      customAuthorizedKeysPath,
      keyData
    );
  });

  ipcMain.handle('serverB:tightenKeyPermissions', () => {
    const { useAdminAuthorizedKeys, customAuthorizedKeysPath } = settingsStore.load().serverPrefs;
    const { filePath } = resolveAuthorizedKeysPath(
      useAdminAuthorizedKeys,
      customAuthorizedKeysPath
    );
    return tightenAuthorizedKeysPermissions(filePath);
  });

  ipcMain.handle('serverB:allowFirewallPort', (_e, port: number) => allowFirewallPort(port));
  ipcMain.handle('serverB:disablePort22Firewall', () => disablePort22FirewallRule());
  ipcMain.handle('serverB:setDisableAutoReboot', (_e, disable: boolean) =>
    setDisableAutoReboot(disable)
  );
  ipcMain.handle('serverB:applySystemTuning', () => applyServerSystemTuning());
  ipcMain.handle('serverB:deployQuicServer', (_e, cfg: QuicServerConfigInput) => {
    const settings = settingsStore.load();
    return quicServerMgr.deployAndStart(cfg, settings.customHysteriaPath);
  });
  ipcMain.handle('serverB:stopQuicServer', () => quicServerMgr.stop());
  ipcMain.handle('serverB:configureQuicStartupTask', () => {
    const settings = settingsStore.load();
    return quicServerMgr.configureStartupTask(settings.customHysteriaPath);
  });
}

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    // Handle CLI arguments (--role=serverB, --autostart)
    const roleArg = process.argv.find((a) => a.startsWith('--role='));
    if (roleArg) {
      const requested = roleArg.split('=')[1];
      if (requested === 'serverB' || requested === 'clientA') {
        settingsStore.update({ role: requested });
      }
    }

    const isAutoStartLaunch = process.argv.includes('--autostart');
    const settings = settingsStore.load();
    setCustomOpenSshDir(settings.customOpenSshDir);
    tunnelManager.setCustomHysteriaPath(settings.customHysteriaPath);

    registerIpcHandlers();
    createMainWindow(isAutoStartLaunch && settings.minimizeToTray);
    createTray();

    // Proactively verify or rebuild tunnel on OS wake from sleep/hibernate
    powerMonitor.on('resume', () => {
      tunnelManager.handleSystemResume();
    });

    // Forward live tunnel status & logs to renderer + tray
    tunnelManager.subscribe((status) => {
      updateTrayUI();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clientA:tunnelStatus', status);
      }
    });

    logger.subscribe((entry) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('logs:entry', entry);
      }
    });

    logger.info('system', `SSH Relay Studio v${app.getVersion()} 已启动 (${process.platform})`);

    // Auto-connect active node on Device A if enabled
    if (settings.role === 'clientA' && settings.autoConnectOnLaunch) {
      const activeNode = settingsStore.getActiveNode();
      if (activeNode) {
        logger.info('clientA', `触发启动自动连接节点: ${activeNode.name}`);
        await tunnelManager.start(activeNode);
      }
    }
  });

  app.on('before-quit', async () => {
    isQuitting = true;
    await tunnelManager.stop(true);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
