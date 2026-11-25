import { contextBridge, ipcRenderer } from 'electron';
import type {
  ActionResult,
  AppRole,
  AppSettings,
  AuthorizedKeysState,
  BinaryStatusInfo,
  BrowserPrefs,
  DetectedBrowser,
  DetectedDesktopApp,
  DiagnosticsResult,
  EnvironmentInfo,
  HostKeyScanResult,
  KeyPairInfo,
  LogEntry,
  NodeProfile,
  ProxiedAppProfile,
  QuicServerConfigInput,
  QuicServerStatus,
  SecurityCheckResult,
  ServerOverview,
  ServerSystemTuningState,
  SshdConfigState,
  TunnelStatus,
  WindowsUpdatePolicyState,
} from '../shared/types';
import type { SshdConfigUpdate } from '../shared/sshConfigParser';

export interface RelayApi {
  // Environment & App
  getEnvInfo: () => Promise<EnvironmentInfo>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  setRole: (role: AppRole) => Promise<AppSettings>;
  relaunchAsAdmin: (targetRole?: 'serverB' | 'clientA') => Promise<ActionResult>;
  copyText: (text: string) => Promise<boolean>;
  selectFile: (title: string, filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
  selectDirectory: (title: string) => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;

  // Logs
  getLogs: () => Promise<LogEntry[]>;
  clearLogs: () => Promise<void>;
  onLogEntry: (cb: (entry: LogEntry) => void) => () => void;

  // Client A: Tunnel
  getTunnelStatus: () => Promise<TunnelStatus>;
  startTunnel: (nodeId?: string) => Promise<ActionResult<TunnelStatus>>;
  stopTunnel: () => Promise<ActionResult<TunnelStatus>>;
  reconnectTunnel: () => Promise<ActionResult<TunnelStatus>>;
  rotateTunnelPool: () => Promise<ActionResult<TunnelStatus>>;
  killOrphanSsh: () => Promise<ActionResult>;
  onTunnelStatus: (cb: (status: TunnelStatus) => void) => () => void;

  // Client A: Keys, Host Trust & Security
  getKeyPairInfo: (customPath?: string) => Promise<KeyPairInfo>;
  generateKeyPair: (forceOverwrite?: boolean) => Promise<ActionResult<KeyPairInfo>>;
  isHostKeyTrusted: (host: string, port: number) => Promise<boolean>;
  scanHostKeys: (host: string, port: number) => Promise<HostKeyScanResult>;
  trustHostKeys: (
    host: string,
    port: number,
    entries: Array<{ keyType: string; keyData: string }>
  ) => Promise<ActionResult>;
  runSecurityVerification: (node: NodeProfile) => Promise<SecurityCheckResult>;

  // Client A: Browser, Per-App Launcher, Diagnostics, Engines & AutoStart
  detectBrowsers: () => Promise<DetectedBrowser[]>;
  launchProxyBrowser: (
    node: Pick<NodeProfile, 'mode' | 'localPort' | 'engine'>,
    prefs: BrowserPrefs
  ) => Promise<ActionResult>;
  detectDesktopApps: () => Promise<DetectedDesktopApp[]>;
  launchProxiedApp: (
    appProfile: ProxiedAppProfile,
    node: Pick<NodeProfile, 'mode' | 'localPort' | 'engine'>
  ) => Promise<ActionResult>;
  runDiagnostics: (
    node: Pick<NodeProfile, 'mode' | 'localPort'>,
    targetUrl?: string
  ) => Promise<DiagnosticsResult>;
  setAutoStart: (enabled: boolean) => Promise<ActionResult>;
  downloadHysteriaBinary: (scope: 'clientA' | 'serverB', customUrl?: string) => Promise<ActionResult<BinaryStatusInfo>>;
  importHysteriaBinary: (scope: 'clientA' | 'serverB', filePath: string) => Promise<ActionResult<BinaryStatusInfo>>;

  // Server B: Overview, Service, Config, Keys, Firewall, Stability & QUIC
  getServerOverview: (forceRefresh?: boolean) => Promise<ServerOverview>;
  installOpenSshServer: () => Promise<ActionResult>;
  controlSshdService: (action: 'start' | 'stop' | 'restart') => Promise<ActionResult>;
  configureSshdFailureRecovery: () => Promise<ActionResult>;
  applySshdConfig: (update: SshdConfigUpdate) => Promise<ActionResult<SshdConfigState>>;
  restoreSshdConfigBackup: () => Promise<ActionResult<SshdConfigState>>;
  addServerAuthorizedKey: (
    publicKeyText: string,
    labelComment?: string
  ) => Promise<ActionResult<AuthorizedKeysState>>;
  removeServerAuthorizedKey: (keyData: string) => Promise<ActionResult<AuthorizedKeysState>>;
  tightenServerKeyPermissions: () => Promise<ActionResult<{ valid: boolean; raw: string }>>;
  allowFirewallPort: (port: number) => Promise<ActionResult>;
  disablePort22FirewallRule: () => Promise<ActionResult>;
  setDisableAutoReboot: (disable: boolean) => Promise<ActionResult<WindowsUpdatePolicyState>>;
  applyServerSystemTuning: () => Promise<ActionResult<ServerSystemTuningState>>;
  deployQuicServer: (cfg: QuicServerConfigInput) => Promise<ActionResult<QuicServerStatus>>;
  stopQuicServer: () => Promise<ActionResult>;
  configureQuicStartupTask: () => Promise<ActionResult<QuicServerStatus>>;
}

const api: RelayApi = {
  getEnvInfo: () => ipcRenderer.invoke('app:getEnvInfo'),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  updateSettings: (patch) => ipcRenderer.invoke('app:updateSettings', patch),
  setRole: (role) => ipcRenderer.invoke('app:setRole', role),
  relaunchAsAdmin: (targetRole) => ipcRenderer.invoke('app:relaunchAsAdmin', targetRole),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text),
  selectFile: (title, filters) => ipcRenderer.invoke('app:selectFile', title, filters),
  selectDirectory: (title) => ipcRenderer.invoke('app:selectDirectory', title),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onLogEntry: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: LogEntry) => cb(entry);
    ipcRenderer.on('logs:entry', handler);
    return () => ipcRenderer.removeListener('logs:entry', handler);
  },

  getTunnelStatus: () => ipcRenderer.invoke('clientA:getTunnelStatus'),
  startTunnel: (nodeId) => ipcRenderer.invoke('clientA:startTunnel', nodeId),
  stopTunnel: () => ipcRenderer.invoke('clientA:stopTunnel'),
  reconnectTunnel: () => ipcRenderer.invoke('clientA:reconnectTunnel'),
  rotateTunnelPool: () => ipcRenderer.invoke('clientA:rotatePool'),
  killOrphanSsh: () => ipcRenderer.invoke('clientA:killOrphanSsh'),
  onTunnelStatus: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, status: TunnelStatus) => cb(status);
    ipcRenderer.on('clientA:tunnelStatus', handler);
    return () => ipcRenderer.removeListener('clientA:tunnelStatus', handler);
  },

  getKeyPairInfo: (customPath) => ipcRenderer.invoke('clientA:getKeyPairInfo', customPath),
  generateKeyPair: (forceOverwrite) => ipcRenderer.invoke('clientA:generateKeyPair', forceOverwrite),
  isHostKeyTrusted: (host, port) => ipcRenderer.invoke('clientA:isHostKeyTrusted', host, port),
  scanHostKeys: (host, port) => ipcRenderer.invoke('clientA:scanHostKeys', host, port),
  trustHostKeys: (host, port, entries) =>
    ipcRenderer.invoke('clientA:trustHostKeys', host, port, entries),
  runSecurityVerification: (node) => ipcRenderer.invoke('clientA:runSecurityVerification', node),

  detectBrowsers: () => ipcRenderer.invoke('clientA:detectBrowsers'),
  launchProxyBrowser: (node, prefs) => ipcRenderer.invoke('clientA:launchProxyBrowser', node, prefs),
  detectDesktopApps: () => ipcRenderer.invoke('clientA:detectDesktopApps'),
  launchProxiedApp: (appProfile, node) =>
    ipcRenderer.invoke('clientA:launchProxiedApp', appProfile, node),
  runDiagnostics: (node, targetUrl) => ipcRenderer.invoke('clientA:runDiagnostics', node, targetUrl),
  setAutoStart: (enabled) => ipcRenderer.invoke('clientA:setAutoStart', enabled),
  downloadHysteriaBinary: (scope, customUrl) =>
    ipcRenderer.invoke('engine:downloadHysteria', scope, customUrl),
  importHysteriaBinary: (scope, filePath) =>
    ipcRenderer.invoke('engine:importHysteria', scope, filePath),

  getServerOverview: (forceRefresh = false) =>
    ipcRenderer.invoke('serverB:getOverview', forceRefresh),
  installOpenSshServer: () => ipcRenderer.invoke('serverB:installOpenSsh'),
  controlSshdService: (action) => ipcRenderer.invoke('serverB:controlSshd', action),
  configureSshdFailureRecovery: () => ipcRenderer.invoke('serverB:configureFailureRecovery'),
  applySshdConfig: (update) => ipcRenderer.invoke('serverB:applySshdConfig', update),
  restoreSshdConfigBackup: () => ipcRenderer.invoke('serverB:restoreSshdConfigBackup'),
  addServerAuthorizedKey: (publicKeyText, labelComment) =>
    ipcRenderer.invoke('serverB:addAuthorizedKey', publicKeyText, labelComment),
  removeServerAuthorizedKey: (keyData) =>
    ipcRenderer.invoke('serverB:removeAuthorizedKey', keyData),
  tightenServerKeyPermissions: () => ipcRenderer.invoke('serverB:tightenKeyPermissions'),
  allowFirewallPort: (port) => ipcRenderer.invoke('serverB:allowFirewallPort', port),
  disablePort22FirewallRule: () => ipcRenderer.invoke('serverB:disablePort22Firewall'),
  setDisableAutoReboot: (disable) => ipcRenderer.invoke('serverB:setDisableAutoReboot', disable),
  applyServerSystemTuning: () => ipcRenderer.invoke('serverB:applySystemTuning'),
  deployQuicServer: (cfg) => ipcRenderer.invoke('serverB:deployQuicServer', cfg),
  stopQuicServer: () => ipcRenderer.invoke('serverB:stopQuicServer'),
  configureQuicStartupTask: () => ipcRenderer.invoke('serverB:configureQuicStartupTask'),
};

contextBridge.exposeInMainWorld('relayApi', api);
