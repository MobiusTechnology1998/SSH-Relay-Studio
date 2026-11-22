export type AppRole = 'unset' | 'clientA' | 'serverB';

export type TunnelMode = 'socks5' | 'localForward';

export interface NodeProfile {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  username: string;
  mode: TunnelMode;
  localPort: number;
  remoteProxyPort: number; // Used when mode === 'localForward' (e.g. 7890 for Clash/v2rayN on B)
  privateKeyPath: string; // Empty means default ~/.ssh/id_ed25519
  expectedHostKey?: string; // Optional host public key from B pairing token
  notes?: string;
}

export interface BrowserPrefs {
  selectedBrowser: 'edge' | 'chrome' | 'custom';
  customBrowserPath: string;
  userDataDir: string; // Empty means default %LOCALAPPDATA%\SSHRelay-<Browser>
  useHostResolverRules: boolean; // Default false per ssh.md 5.3 & 6
  startUrl: string;
}

export interface AppSettings {
  role: AppRole;
  nodes: NodeProfile[];
  activeNodeId: string | null;
  autoStart: boolean;
  autoConnectOnLaunch: boolean;
  minimizeToTray: boolean;
  browser: BrowserPrefs;
  serverPrefs: {
    targetPort: number;
    useAdminAuthorizedKeys: boolean;
    customAuthorizedKeysPath: string;
  };
}

export type TunnelStatusState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface TunnelStatus {
  state: TunnelStatusState;
  nodeId: string | null;
  nodeName: string | null;
  mode: TunnelMode;
  localPort: number;
  pid: number | null;
  connectedSince: number | null;
  reconnectCount: number;
  lastError: string | null;
  diagnosticHint: string | null;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  source: 'system' | 'clientA' | 'serverB' | 'tunnel';
  message: string;
}

export interface EnvironmentInfo {
  platform: NodeJS.Platform;
  isWindows: boolean;
  isAdmin: boolean;
  hostname: string;
  username: string;
  appVersion: string;
  userDataDir: string;
  sshClientAvailable: boolean;
  sshClientPath: string;
}

export interface KeyPairInfo {
  exists: boolean;
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
  fingerprint: string;
}

export interface HostKeyScanResult {
  success: boolean;
  host: string;
  port: number;
  entries: Array<{
    keyType: string;
    keyData: string;
    fingerprint: string;
    rawLine: string;
  }>;
  alreadyTrusted: boolean;
  error?: string;
}

export interface SecurityCheckResult {
  tcpReachable: boolean;
  tcpDetail: string;
  keyAuthPassed: boolean;
  remoteHostname: string;
  keyAuthDetail: string;
  passwordAuthDisabled: boolean;
  passwordAuthDetail: string;
}

export interface DiagnosticsResult {
  localPortListening: boolean;
  localPortDetail: string;
  exitIp: string | null;
  exitIpDetail: string;
  targetSiteOk: boolean;
  targetSiteStatus: string;
  targetSiteLatencyMs: number | null;
}

export interface DetectedBrowser {
  id: 'edge' | 'chrome';
  name: string;
  path: string;
  exists: boolean;
}

export interface PairingPayload {
  version: 1;
  name: string;
  host: string;
  sshPort: number;
  username: string;
  hostPublicKey?: string;
  createdAt: number;
}

// ===== Device B (Server) Types =====

export interface OpenSshServiceStatus {
  installed: boolean;
  capabilityName: string;
  serviceExists: boolean;
  status: 'Running' | 'Stopped' | 'Unknown' | 'NotInstalled';
  startType: string;
  failureRecoveryConfigured: boolean;
  failureRecoveryDetail: string;
}

export interface SshdConfigState {
  exists: boolean;
  path: string;
  backupExists: boolean;
  port: number;
  pubkeyAuthentication: boolean;
  passwordAuthentication: boolean;
  hasMatchAdminBlock: boolean;
  rawContent: string;
}

export interface AuthorizedKeyEntry {
  id: string;
  keyType: string;
  keyData: string;
  comment: string;
  fingerprint: string;
  rawLine: string;
}

export interface AuthorizedKeysState {
  filePath: string;
  exists: boolean;
  isAdminPath: boolean;
  keys: AuthorizedKeyEntry[];
  permissionsValid: boolean;
  permissionsRaw: string;
}

export interface FirewallRuleInfo {
  name: string;
  displayName: string;
  enabled: boolean;
  action: string;
  localPort: string;
}

export interface WindowsUpdatePolicyState {
  auOptions: number | null;
  noAutoRebootWithLoggedOnUsers: number | null;
  autoRebootDisabled: boolean;
}

export interface ActiveConnectionInfo {
  protocol: string;
  localAddress: string;
  remoteAddress: string;
  remoteIp: string;
  state: string;
  pid: string;
  category: 'ssh' | 'rdp';
}

export interface ServerOverview {
  service: OpenSshServiceStatus;
  config: SshdConfigState;
  authorizedKeys: AuthorizedKeysState;
  firewallRules: FirewallRuleInfo[];
  updatePolicy: WindowsUpdatePolicyState;
  listeningPorts: string[];
  activeConnections: ActiveConnectionInfo[];
  detectedPublicIp: string | null;
  localIps: string[];
  hostPublicKey: string | null;
}

export interface ActionResult<T = void> {
  ok: boolean;
  message: string;
  data?: T;
}
