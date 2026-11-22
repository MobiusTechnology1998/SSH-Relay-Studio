import os from 'os';
import type { ActiveConnectionInfo } from '../../shared/types';
import { execCmd, IS_WINDOWS } from '../platform/shell';

function extractIpFromEndpoint(endpoint: string): string {
  // Handle IPv6 [::ffff:1.2.3.4]:54321 or IPv4 1.2.3.4:54321
  if (endpoint.startsWith('[')) {
    const endIdx = endpoint.indexOf(']');
    return endIdx > 0 ? endpoint.slice(1, endIdx) : endpoint;
  }
  const lastColon = endpoint.lastIndexOf(':');
  return lastColon > 0 ? endpoint.slice(0, lastColon) : endpoint;
}

function extractPortFromEndpoint(endpoint: string): number | null {
  const lastColon = endpoint.lastIndexOf(':');
  if (lastColon === -1) return null;
  const p = Number.parseInt(endpoint.slice(lastColon + 1), 10);
  return Number.isNaN(p) ? null : p;
}

export async function inspectNetworkState(sshPort: number): Promise<{
  listeningPorts: string[];
  activeConnections: ActiveConnectionInfo[];
  localIps: string[];
}> {
  const localIps: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const addr of entries) {
      if (!addr.internal && addr.family === 'IPv4') {
        localIps.push(addr.address);
      }
    }
  }

  if (!IS_WINDOWS) {
    return {
      listeningPorts: [],
      activeConnections: [],
      localIps,
    };
  }

  const res = await execCmd('netstat.exe', ['-ano', '-p', 'TCP'], { timeoutMs: 8000 });
  const listeningPorts = new Set<string>();
  const activeConnections: ActiveConnectionInfo[] = [];

  if (res.code === 0) {
    const lines = res.stdout.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('TCP')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;

      const [, localAddr, remoteAddr, state, pid] = parts;
      const localPort = extractPortFromEndpoint(localAddr);
      if (localPort === null) continue;

      if (state === 'LISTENING' && (localPort === sshPort || localPort === 22)) {
        listeningPorts.add(localAddr);
      }

      if (state === 'ESTABLISHED') {
        if (localPort === sshPort || localPort === 22) {
          activeConnections.push({
            protocol: 'TCP',
            localAddress: localAddr,
            remoteAddress: remoteAddr,
            remoteIp: extractIpFromEndpoint(remoteAddr),
            state,
            pid,
            category: 'ssh',
          });
        } else if (localPort === 3389) {
          activeConnections.push({
            protocol: 'TCP',
            localAddress: localAddr,
            remoteAddress: remoteAddr,
            remoteIp: extractIpFromEndpoint(remoteAddr),
            state,
            pid,
            category: 'rdp',
          });
        }
      }
    }
  }

  return {
    listeningPorts: Array.from(listeningPorts),
    activeConnections,
    localIps,
  };
}

export async function detectServerPublicIp(): Promise<string | null> {
  const curlBin = IS_WINDOWS ? 'curl.exe' : 'curl';
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
  for (const url of urls) {
    const res = await execCmd(curlBin, ['-sS', '--max-time', '5', url], { timeoutMs: 6500 });
    const candidate = res.stdout.trim();
    if (res.code === 0 && /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
