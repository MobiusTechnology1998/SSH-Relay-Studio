export type AppRole = 'unset' | 'clientA' | 'serverB';

export type TunnelMode = 'socks5' | 'localForward';

export type TunnelEngineType = 'openssh' | 'hysteria2';

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
  compression?: boolean; // Default false (HTTPS/TLS does not benefit from SSH -C)
  serverAliveInterval?: number; // Default 15 seconds
  serverAliveCountMax?: number; // Default 3
  forceIpv4?: boolean; // Default true: avoid slow/broken IPv6 fallback on cross-border routes
  preferFastCipher?: boolean; // Default true: prioritize AES-GCM / ChaCha20 hardware-accelerated ciphers
  healthCheckEnabled?: boolean; // Default true: active end-to-end tunnel liveness probe
  healthCheckIntervalSec?: number; // Default 25 seconds
  poolSize?: number; // Default 3 (1-6): parallel SSH tunnels behind local balancer to mitigate TCP HOL blocking
  rotationIntervalMin?: number; // Default 0 (disabled): periodic Make-Before-Break worker rotation in minutes
  // Step 3: Pluggable Transport Engine (QUIC / Hysteria 2 for cross-border high-loss weak networks)
  engine?: TunnelEngineType; // Default 'openssh'
  autoFallbackToSsh?: boolean; // Default true: if UDP/QUIC is blocked, fall back seamlessly to OpenSSH pool
  quicUdpPort?: number; // Default 53623
  quicAuthToken?: string;
  quicCertPinSha256?: string;
  quicSni?: string; // Default 'www.bing.com'
  quicObfsPassword?: string; // Optional Salamander obfuscation password
  quicUpMbps?: number; // Default 50 (client upload Mbps for Brutal congestion control)
  quicDownMbps?: number; // Default 200 (client download Mbps for Brutal congestion control)
  notes?: string;
}

export interface BrowserPrefs {
  selectedBrowser: 'edge' | 'chrome' | 'custom';
  customBrowserPath: string;
  userDataDir: string; // Empty means default %LOCALAPPDATA%\Edge or Chrome
  useHostResolverRules: boolean; // Default false per ssh.md 5.3 & 6
  disableQuic?: boolean; // Default true in OpenSSH SOCKS5 mode to avoid HTTP/3 UDP fallback latency
  startUrl: string;
}

export interface AppSettings {
  role: AppRole;
  nodes: NodeProfile[];
  activeNodeId: string | null;
  autoStart: boolean;
  autoConnectOnLaunch: boolean;
  minimizeToTray: boolean;
  customOpenSshDir?: string; // Optional path to newer Win32-OpenSSH directory (v9.8+)
  customHysteriaPath?: string; // Optional path to hysteria.exe binary
  browser: BrowserPrefs;
  serverPrefs: {
    targetPort: number;
    useAdminAuthorizedKeys: boolean;
    customAuthorizedKeysPath: string;
    quicUdpPort?: number;
    quicSni?: string;
    quicMaxUpMbps?: number;
    quicMaxDownMbps?: number;
    quicEnableObfs?: boolean;
  };
}

export type TunnelStatusState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface TunnelWorkerSummary {
  id: string;
  slotIndex: number;
  internalPort: number;
  pid: number | null;
  state: 'starting' | 'healthy' | 'reconnecting' | 'draining' | 'stopped';
  latencyMs: number | null;
  activeConnections: number;
  reconnectCount: number;
}

export interface TunnelStatus {
  state: TunnelStatusState;
  nodeId: string | null;
  nodeName: string | null;
  mode: TunnelMode;
  activeEngine: TunnelEngineType;
  fallbackActive: boolean;
  localPort: number;
  pid: number | null;
  connectedSince: number | null;
  reconnectCount: number;
  nextRetryAt: number | null;
  lastHealthCheckAt: number | null;
  lastHealthLatencyMs: number | null;
  poolSize: number;
  healthyWorkers: number;
  activeConnections: number;
  totalBytesUp: number;
  totalBytesDown: number;
  workers: TunnelWorkerSummary[];
  runningConfigHash?: string | null;
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

export interface OpenSshVersionInfo {
  raw: string;
  version: string | null;
  major: number | null;
  minor: number | null;
  isLegacy: boolean; // True when OpenSSH < 9.0 (e.g. Win10/Server 2019 built-in 7.7/8.1)
}

export interface BinaryStatusInfo {
  installed: boolean;
  path: string;
  version: string | null;
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
  sshClientVersion: OpenSshVersionInfo;
  hysteriaClient: BinaryStatusInfo;
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

export interface QuicPairingInfo {
  udpPort: number;
  authToken: string;
  certPinSha256: string;
  sni: string;
  obfsPassword?: string;
}

export interface PairingPayload {
  version: 1;
  name: string;
  host: string;
  sshPort: number;
  username: string;
  hostPublicKey?: string;
  quic?: QuicPairingInfo;
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
  sshdVersion?: OpenSshVersionInfo;
}

export interface QuicServerConfigInput {
  udpPort: number;
  sni: string;
  maxUpMbps: number;
  maxDownMbps: number;
  enableObfs: boolean;
}

export interface QuicServerStatus {
  binaryInstalled: boolean;
  binaryPath: string;
  binaryVersion: string | null;
  configured: boolean;
  running: boolean;
  pid: number | null;
  udpPort: number;
  sni: string;
  authToken: string;
  obfsPassword: string;
  certPinSha256: string;
  maxUpMbps: number;
  maxDownMbps: number;
  startupTaskConfigured: boolean;
  lastError: string | null;
}

export interface SshdConfigState {
  exists: boolean;
  path: string;
  backupExists: boolean;
  port: number;
  pubkeyAuthentication: boolean;
  passwordAuthentication: boolean;
  tcpKeepAlive: boolean;
  clientAliveInterval: number;
  clientAliveCountMax: number;
  useDns: boolean;
  compression: string;
  maxSessions: number;
  maxStartups: string;
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

export interface ServerSystemTuningState {
  sleepDisabled: boolean;
  standbyTimeoutAcSec: number | null;
  tcpAutoTuning: string;
  tcpCongestionProvider: string;
  tcpEcnCapability: string;
  tcpTimestamps: string;
  tuned: boolean;
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
  systemTuning: ServerSystemTuningState;
  quicServer: QuicServerStatus;
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
