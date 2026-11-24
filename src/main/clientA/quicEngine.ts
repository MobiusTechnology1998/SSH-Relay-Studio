import { ChildProcess, spawn } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  computeReconnectDelayMs,
  decodeSshOutputChunk,
} from '../../shared/commandBuilders';
import {
  buildHysteriaClientYaml,
  diagnoseHysteriaError,
} from '../../shared/hysteriaConfig';
import type { NodeProfile, TunnelStatus } from '../../shared/types';
import { logger } from '../logger';
import { inspectHysteriaBinary } from '../platform/binaryMgr';
import { execCmd, isLocalPortListening, IS_WINDOWS } from '../platform/shell';
import { probeTunnelHealth } from './healthProbe';

export interface QuicEngineCallbacks {
  onStatusUpdate: (patch: Partial<TunnelStatus>) => void;
  onFallbackToSsh: (reason: string) => void;
}

const QUIC_STARTUP_TIMEOUT_MS = 12_000;
const HEALTH_PROBE_TIMEOUT_MS = 7000;
const HEALTH_FAIL_THRESHOLD = 2;

/**
 * Manages the Hysteria 2 QUIC client process on Device A for cross-border weak networks:
 * - Zero TCP-over-TCP head-of-line blocking + Brutal congestion control + native UDP
 * - Active SOCKS5/HTTP liveness probing + OS wake recovery
 * - Automatic seamless fallback to OpenSSH Multi-Tunnel Pool when UDP is blocked
 */
export class QuicTunnelEngine {
  private child: ChildProcess | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private desiredRunning = false;
  private activeNode: NodeProfile | null = null;
  private customBinaryPath = '';
  private sessionEpoch = 0;
  private consecutiveStartupFailures = 0;
  private consecutiveHealthFailures = 0;
  private reconnectCount = 0;
  private healthInFlight = false;
  private lastOutput = '';
  private callbacks: QuicEngineCallbacks;

  constructor(callbacks: QuicEngineCallbacks) {
    this.callbacks = callbacks;
  }

  private get configPath(): string {
    return path.join(app.getPath('userData'), 'quic-client.yaml');
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.healthInFlight = false;
  }

  private async killChild(child: ChildProcess | null): Promise<void> {
    if (!child || !child.pid) return;
    try {
      if (IS_WINDOWS) {
        await execCmd('taskkill', ['/F', '/T', '/PID', String(child.pid)], { timeoutMs: 5000 });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      try {
        child.kill();
      } catch {
        // Ignore
      }
    }
  }

  public async start(node: NodeProfile, customBinaryPath?: string): Promise<{ ok: boolean; message: string }> {
    await this.stop();

    const bin = await inspectHysteriaBinary('clientA', customBinaryPath);
    if (!bin.installed) {
      const msg = '未检测到 Hysteria 2 客户端内核，请先在「代理浏览器与工具」中一键下载或导入本地 hysteria.exe。';
      if (node.autoFallbackToSsh !== false) {
        logger.warn('tunnel', `${msg} 正在自动回退至 OpenSSH 多隧道连接池...`);
        this.callbacks.onFallbackToSsh('本机尚未安装 Hysteria 2 内核');
        return { ok: true, message: '未安装 QUIC 内核，已自动回退至 OpenSSH 多隧道连接池' };
      }
      return { ok: false, message: msg };
    }

    let yaml: string;
    try {
      yaml = buildHysteriaClientYaml(node);
    } catch (err) {
      const msg = (err as Error).message;
      if (node.autoFallbackToSsh !== false) {
        logger.warn('tunnel', `QUIC 配置不完整（${msg}），自动回退至 OpenSSH 多隧道连接池...`);
        this.callbacks.onFallbackToSsh(msg);
        return { ok: true, message: `${msg}，已自动回退至 OpenSSH 多隧道连接池` };
      }
      return { ok: false, message: msg };
    }

    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, yaml, 'utf8');

    this.desiredRunning = true;
    this.activeNode = { ...node };
    this.customBinaryPath = customBinaryPath || '';
    this.consecutiveStartupFailures = 0;
    this.consecutiveHealthFailures = 0;
    this.reconnectCount = 0;
    const epoch = ++this.sessionEpoch;

    this.callbacks.onStatusUpdate({
      state: 'connecting',
      nodeId: node.id,
      nodeName: node.name,
      mode: node.mode,
      activeEngine: 'hysteria2',
      fallbackActive: false,
      localPort: node.localPort,
      pid: null,
      connectedSince: null,
      reconnectCount: 0,
      nextRetryAt: null,
      lastHealthCheckAt: null,
      lastHealthLatencyMs: null,
      poolSize: 1,
      healthyWorkers: 0,
      activeConnections: 0,
      totalBytesUp: 0,
      totalBytesDown: 0,
      workers: [],
      lastError: null,
      diagnosticHint: null,
    });

    this.spawnClient(bin.path, epoch, false);
    return {
      ok: true,
      message: `正在启动 QUIC (Hysteria 2) 弱网加速引擎：${node.name}`,
    };
  }

  private spawnClient(binPath: string, epoch: number, isReconnect: boolean): void {
    const node = this.activeNode;
    if (!node || !this.desiredRunning || epoch !== this.sessionEpoch) return;

    this.clearTimers();
    this.lastOutput = '';
    let connectedLogged = false;

    logger.info(
      'tunnel',
      `[QUIC${isReconnect ? '·重连' : ''}] 启动 Hysteria 2 客户端 -> ${node.host}:${node.quicUdpPort ?? 53623} (Brutal ${node.quicUpMbps ?? 50}/${node.quicDownMbps ?? 200} Mbps)`
    );

    let child: ChildProcess;
    try {
      child = spawn(binPath, ['client', '-c', this.configPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = `无法启动 Hysteria 2 进程: ${(err as Error).message}`;
      this.handleFailure(epoch, msg);
      return;
    }

    this.child = child;
    this.callbacks.onStatusUpdate({
      state: isReconnect ? 'reconnecting' : 'connecting',
      pid: child.pid ?? null,
      nextRetryAt: null,
    });

    const handleOutput = (chunk: Buffer, isStderr: boolean) => {
      const text = decodeSshOutputChunk(chunk);
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (lower.includes('connected to server')) {
          connectedLogged = true;
          logger.success('tunnel', `[QUIC] ${line}`);
        } else if (isStderr || lower.includes('error') || lower.includes('failed')) {
          this.lastOutput = line;
          logger.warn('tunnel', `[QUIC] ${line}`);
        } else {
          logger.info('tunnel', `[QUIC] ${line}`);
        }
      }
    };

    child.stdout?.on('data', (c: Buffer) => handleOutput(c, false));
    child.stderr?.on('data', (c: Buffer) => handleOutput(c, true));

    const startedAt = Date.now();
    this.pollTimer = setInterval(async () => {
      if (!this.desiredRunning || epoch !== this.sessionEpoch || this.child !== child) {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        return;
      }

      const listening = await isLocalPortListening(node.localPort);
      if (!this.desiredRunning || epoch !== this.sessionEpoch || this.child !== child) return;

      if (listening && (connectedLogged || Date.now() - startedAt >= 1500)) {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.consecutiveStartupFailures = 0;
        this.consecutiveHealthFailures = 0;

        logger.success(
          'tunnel',
          `QUIC (Hysteria 2) 加速隧道已就绪！本地监听 127.0.0.1:${node.localPort} (原生支持 TCP+UDP)`
        );
        this.callbacks.onStatusUpdate({
          state: 'connected',
          activeEngine: 'hysteria2',
          fallbackActive: false,
          pid: child.pid ?? null,
          connectedSince: Date.now(),
          healthyWorkers: 1,
          poolSize: 1,
          nextRetryAt: null,
          lastError: null,
          diagnosticHint: null,
          workers: [
            {
              id: 'quic-primary',
              slotIndex: 0,
              internalPort: node.localPort,
              pid: child.pid ?? null,
              state: 'healthy',
              latencyMs: null,
              activeConnections: 0,
              reconnectCount: this.reconnectCount,
            },
          ],
        });

        this.startHealthLoop(child, node, epoch);
      } else if (Date.now() - startedAt > QUIC_STARTUP_TIMEOUT_MS) {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.lastOutput = 'QUIC/UDP 握手超过 12 秒未就绪（可能 UDP 端口未放行或被当前网络屏蔽）';
        logger.warn('tunnel', `[QUIC] ${this.lastOutput}`);
        await this.killChild(child);
      }
    }, 400);

    child.once('error', (err) => {
      if (this.child !== child || epoch !== this.sessionEpoch) return;
      this.handleFailure(epoch, err.message);
    });

    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimers();

      if (!this.desiredRunning || epoch !== this.sessionEpoch) {
        return;
      }

      const reason = this.lastOutput || `Hysteria 2 客户端退出 (code=${code ?? 'null'})`;
      this.handleFailure(epoch, reason);
    });
  }

  private startHealthLoop(child: ChildProcess, node: NodeProfile, epoch: number): void {
    if (node.healthCheckEnabled === false) return;
    const intervalSec =
      typeof node.healthCheckIntervalSec === 'number' &&
      node.healthCheckIntervalSec >= 10 &&
      node.healthCheckIntervalSec <= 120
        ? Math.round(node.healthCheckIntervalSec)
        : 25;

    const runProbe = async () => {
      if (!this.desiredRunning || epoch !== this.sessionEpoch || this.child !== child || this.healthInFlight) {
        return;
      }
      this.healthInFlight = true;
      try {
        // Probe local proxy listening + lightweight E2E tunnel check
        const res = await probeTunnelHealth(
          node.mode,
          node.localPort,
          node.sshPort,
          HEALTH_PROBE_TIMEOUT_MS
        );
        if (!this.desiredRunning || epoch !== this.sessionEpoch || this.child !== child) return;

        if (res.ok) {
          this.consecutiveHealthFailures = 0;
          this.callbacks.onStatusUpdate({
            lastHealthCheckAt: Date.now(),
            lastHealthLatencyMs: res.latencyMs,
            workers: [
              {
                id: 'quic-primary',
                slotIndex: 0,
                internalPort: node.localPort,
                pid: child.pid ?? null,
                state: 'healthy',
                latencyMs: res.latencyMs,
                activeConnections: 0,
                reconnectCount: this.reconnectCount,
              },
            ],
          });
        } else {
          // If loopback is blocked by Hysteria ACL, verify local port is at least alive before killing
          const stillListening = await isLocalPortListening(node.localPort);
          if (!stillListening) {
            this.consecutiveHealthFailures += 1;
          } else if (res.detail.includes('超时')) {
            this.consecutiveHealthFailures += 1;
          }

          if (this.consecutiveHealthFailures >= HEALTH_FAIL_THRESHOLD) {
            logger.warn('tunnel', '[QUIC] 连续探活超时，判定 QUIC 通道异常，主动重建...');
            this.lastOutput = 'QUIC 通道连续探活超时';
            await this.killChild(child);
          }
        }
      } finally {
        this.healthInFlight = false;
      }
    };

    setTimeout(() => {
      void runProbe();
    }, 3000);

    this.healthTimer = setInterval(() => {
      void runProbe();
    }, intervalSec * 1000);
  }

  private handleFailure(epoch: number, reason: string): void {
    const node = this.activeNode;
    if (!node || !this.desiredRunning || epoch !== this.sessionEpoch) return;

    this.consecutiveStartupFailures += 1;
    this.reconnectCount += 1;
    const hint = diagnoseHysteriaError(reason);

    // Auto-fallback to OpenSSH Multi-Tunnel Pool if UDP/QUIC is blocked or unreachable
    if (node.autoFallbackToSsh !== false && this.consecutiveStartupFailures >= 2) {
      logger.warn(
        'tunnel',
        `[QUIC] 连续 ${this.consecutiveStartupFailures} 次连接失败（${reason}），触发跨网容灾：自动无缝回退至 OpenSSH 多隧道连接池！`
      );
      this.desiredRunning = false;
      this.sessionEpoch += 1;
      this.clearTimers();
      this.callbacks.onFallbackToSsh(reason);
      return;
    }

    const delayMs = computeReconnectDelayMs(this.reconnectCount);
    logger.warn(
      'tunnel',
      `[QUIC] 连接断开（${reason}），${(delayMs / 1000).toFixed(1)} 秒后第 ${this.reconnectCount} 次重连...`
    );

    this.callbacks.onStatusUpdate({
      state: 'reconnecting',
      pid: null,
      connectedSince: null,
      healthyWorkers: 0,
      reconnectCount: this.reconnectCount,
      nextRetryAt: Date.now() + delayMs,
      lastError: reason,
      diagnosticHint: hint,
      workers: [],
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.desiredRunning || epoch !== this.sessionEpoch) return;
      const bin = await inspectHysteriaBinary('clientA', this.customBinaryPath);
      if (!bin.installed) {
        this.callbacks.onFallbackToSsh('Hysteria 2 二进制缺失');
        return;
      }
      this.spawnClient(bin.path, epoch, true);
    }, delayMs);
  }

  public handleSystemResume(): void {
    if (!this.desiredRunning || !this.activeNode) return;
    const epoch = this.sessionEpoch;
    logger.info('tunnel', '[QUIC] 检测到系统休眠唤醒，正在快速重启 QUIC 通道以刷新 NAT 映射...');
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(async () => {
      this.resumeTimer = null;
      if (!this.desiredRunning || epoch !== this.sessionEpoch) return;
      const child = this.child;
      this.reconnectCount = 0;
      this.consecutiveStartupFailures = 0;
      if (child) {
        await this.killChild(child);
      } else {
        const bin = await inspectHysteriaBinary('clientA', this.customBinaryPath);
        if (bin.installed) {
          this.spawnClient(bin.path, epoch, true);
        }
      }
    }, 1500);
  }

  public async stop(): Promise<void> {
    this.sessionEpoch += 1;
    this.desiredRunning = false;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    await this.killChild(child);
  }
}
