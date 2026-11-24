import { ChildProcess, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import {
  buildSshTunnelArgs,
  computeReconnectDelayMs,
  decodeSshOutputChunk,
  diagnoseSshError,
  isHardSshAuthFailure,
  isNonFatalChannelOpenError,
} from '../../shared/commandBuilders';
import type {
  ActionResult,
  NodeProfile,
  TunnelStatus,
  TunnelWorkerSummary,
} from '../../shared/types';
import { logger } from '../logger';
import {
  execCmd,
  isLocalPortListening,
  IS_WINDOWS,
  resolveOpenSshBinary,
  testTcpConnection,
} from '../platform/shell';
import { probeTunnelHealth } from './healthProbe';
import { findFreeLocalPort, LocalProxyBalancer } from './localProxyBalancer';
import { QuicTunnelEngine } from './quicEngine';

type StatusListener = (status: TunnelStatus) => void;

const STABLE_RESET_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 8000;
const HEALTH_FAIL_THRESHOLD = 2;
const WORKER_STAGGER_MS = 350;
const DRAIN_MAX_WAIT_MS = 30_000;

interface PoolWorker {
  id: string;
  slotIndex: number;
  internalPort: number;
  child: ChildProcess | null;
  state: TunnelWorkerSummary['state'];
  latencyMs: number | null;
  reconnectCount: number;
  nextRetryAt: number | null;
  consecutiveHealthFailures: number;
  healthCheckInFlight: boolean;
  stderrBuffer: string;
  isRotationCandidate: boolean;
  replacingWorkerId: string | null;
  listenPollTimer: NodeJS.Timeout | null;
  healthCheckTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  stableResetTimer: NodeJS.Timeout | null;
  drainTimer: NodeJS.Timeout | null;
}

class TunnelManager {
  private balancer: LocalProxyBalancer;
  private quicEngine: QuicTunnelEngine;
  private customHysteriaPath = '';
  private workers = new Map<string, PoolWorker>();
  private staggerTimers: NodeJS.Timeout[] = [];
  private metricsTimer: NodeJS.Timeout | null = null;
  private rotationTimer: NodeJS.Timeout | null = null;
  private resumeProbeTimer: NodeJS.Timeout | null = null;
  private desiredRunning = false;
  private runningQuicMode = false;
  private activeNode: NodeProfile | null = null;
  private sessionEpoch = 0;
  private workerSeq = 0;
  private rotationCursor = 0;
  private listeners = new Set<StatusListener>();
  private lastMetricsFingerprint = '';

  private status: TunnelStatus = {
    state: 'disconnected',
    nodeId: null,
    nodeName: null,
    mode: 'socks5',
    activeEngine: 'openssh',
    fallbackActive: false,
    localPort: 1080,
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
  };

  constructor() {
    this.balancer = new LocalProxyBalancer({
      onBackendDialError: (backendId, err) => {
        const w = this.workers.get(backendId);
        if (!w || w.state !== 'healthy') return;
        logger.warn(
          'tunnel',
          `通道 #${w.slotIndex + 1} 本地拨号失败（${err.message}），已自动无感切换至其他健康通道并触发探活`
        );
        void this.probeWorkerNow(w, this.sessionEpoch);
      },
    });

    this.quicEngine = new QuicTunnelEngine({
      onStatusUpdate: (patch) => {
        if (!this.runningQuicMode) return;
        this.emit(patch);
      },
      onFallbackToSsh: (reason) => {
        const node = this.activeNode;
        if (!node || !this.runningQuicMode) return;
        logger.warn(
          'tunnel',
          `QUIC 引擎不可用（${reason}），正在自动无缝切换至 OpenSSH 多隧道连接池...`
        );
        this.runningQuicMode = false;
        void this.startOpenSshPool(node, true);
      },
    });
  }

  public setCustomHysteriaPath(binPath?: string): void {
    this.customHysteriaPath = (binPath || '').trim();
  }

  public getStatus(): TunnelStatus {
    return {
      ...this.status,
      workers: this.status.workers.map((w) => ({ ...w })),
    };
  }

  public subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(patch: Partial<TunnelStatus>): void {
    this.status = { ...this.status, ...patch };
    const snapshot = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore window closed errors
      }
    }
  }

  private resolvePoolSize(node: NodeProfile): number {
    const raw = node.poolSize;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(1, Math.min(6, Math.round(raw)));
    }
    return 3;
  }

  private resolveKeyPath(node: NodeProfile): string {
    if (node.privateKeyPath && node.privateKeyPath.trim()) {
      return node.privateKeyPath.trim();
    }
    return path.join(os.homedir(), '.ssh', 'id_ed25519');
  }

  private clearWorkerTimers(w: PoolWorker): void {
    if (w.listenPollTimer) {
      clearInterval(w.listenPollTimer);
      w.listenPollTimer = null;
    }
    if (w.healthCheckTimer) {
      clearInterval(w.healthCheckTimer);
      w.healthCheckTimer = null;
    }
    if (w.reconnectTimer) {
      clearTimeout(w.reconnectTimer);
      w.reconnectTimer = null;
    }
    if (w.stableResetTimer) {
      clearTimeout(w.stableResetTimer);
      w.stableResetTimer = null;
    }
    if (w.drainTimer) {
      clearInterval(w.drainTimer);
      w.drainTimer = null;
    }
    w.healthCheckInFlight = false;
  }

  private clearGlobalTimers(): void {
    for (const t of this.staggerTimers) {
      clearTimeout(t);
    }
    this.staggerTimers = [];

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    if (this.resumeProbeTimer) {
      clearTimeout(this.resumeProbeTimer);
      this.resumeProbeTimer = null;
    }
  }

  private async killChildProcess(child: ChildProcess | null): Promise<void> {
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
        // Ignore already exited
      }
    }
  }

  private syncAggregateStatus(extra?: Partial<TunnelStatus>): void {
    const node = this.activeNode;
    const stats = this.balancer.getStats();
    const workerList: TunnelWorkerSummary[] = Array.from(this.workers.values())
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((w) => ({
        id: w.id,
        slotIndex: w.slotIndex,
        internalPort: w.internalPort,
        pid: w.child?.pid ?? null,
        state: w.state,
        latencyMs: w.latencyMs,
        activeConnections: stats.perBackendActive[w.id] ?? 0,
        reconnectCount: w.reconnectCount,
      }));

    const healthyList = workerList.filter((w) => w.state === 'healthy');
    const healthyCount = healthyList.length;
    const primaryHealthy = healthyList[0] ?? workerList.find((w) => w.pid !== null) ?? null;

    const latencies = healthyList
      .map((w) => w.latencyMs)
      .filter((ms): ms is number => ms !== null);
    const bestLatencyMs = latencies.length > 0 ? Math.min(...latencies) : null;

    const retryTimes = Array.from(this.workers.values())
      .map((w) => w.nextRetryAt)
      .filter((t): t is number => t !== null);
    const soonestRetryAt = retryTimes.length > 0 ? Math.min(...retryTimes) : null;

    const totalReconnects = workerList.reduce((sum, w) => sum + w.reconnectCount, 0);

    let nextState = this.status.state;
    if (extra?.state) {
      nextState = extra.state;
    } else if (!this.desiredRunning) {
      nextState = this.status.state === 'error' ? 'error' : 'disconnected';
    } else if (healthyCount > 0) {
      nextState = 'connected';
    } else if (workerList.some((w) => w.state === 'reconnecting')) {
      nextState = 'reconnecting';
    } else {
      nextState = 'connecting';
    }

    const connectedSince =
      nextState === 'connected' ? (this.status.connectedSince ?? Date.now()) : null;

    this.emit({
      state: nextState,
      pid: primaryHealthy?.pid ?? null,
      connectedSince,
      reconnectCount: totalReconnects,
      nextRetryAt: nextState === 'reconnecting' ? soonestRetryAt : null,
      lastHealthLatencyMs: bestLatencyMs,
      poolSize: node ? this.resolvePoolSize(node) : 1,
      healthyWorkers: healthyCount,
      activeConnections: stats.activeConnections,
      totalBytesUp: stats.totalBytesUp,
      totalBytesDown: stats.totalBytesDown,
      workers: workerList,
      ...(nextState === 'connected' ? { lastError: null, diagnosticHint: null } : {}),
      ...extra,
    });
  }

  public async start(node: NodeProfile): Promise<ActionResult<TunnelStatus>> {
    if (!node.host.trim()) {
      return { ok: false, message: '节点主机地址不能为空' };
    }

    // Stop any previous pool or QUIC engine cleanly
    if (this.desiredRunning || this.runningQuicMode || this.workers.size > 0) {
      await this.stop(true);
    }

    // Check if local port is already occupied by another process
    const portBusy = await isLocalPortListening(node.localPort);
    if (portBusy) {
      const msg = `本地端口 127.0.0.1:${node.localPort} 已被其他进程占用，请更换端口或先清理旧进程。`;
      logger.warn('tunnel', msg);
      this.emit({
        state: 'error',
        nodeId: node.id,
        nodeName: node.name,
        mode: node.mode,
        activeEngine: node.engine === 'hysteria2' ? 'hysteria2' : 'openssh',
        fallbackActive: false,
        localPort: node.localPort,
        pid: null,
        connectedSince: null,
        nextRetryAt: null,
        lastHealthCheckAt: null,
        lastHealthLatencyMs: null,
        poolSize: this.resolvePoolSize(node),
        healthyWorkers: 0,
        activeConnections: 0,
        totalBytesUp: 0,
        totalBytesDown: 0,
        workers: [],
        lastError: msg,
        diagnosticHint: '可点击「清理残留 ssh.exe」按钮，或在节点配置中修改本地端口（如 1081）。',
      });
      return { ok: false, message: msg, data: this.getStatus() };
    }

    this.activeNode = { ...node };

    if (node.engine === 'hysteria2') {
      this.runningQuicMode = true;
      this.desiredRunning = true;
      const res = await this.quicEngine.start(node, this.customHysteriaPath);
      if (!res.ok) {
        this.runningQuicMode = false;
        this.desiredRunning = false;
        this.emit({
          state: 'error',
          activeEngine: 'hysteria2',
          fallbackActive: false,
          lastError: res.message,
          diagnosticHint: '可在「代理浏览器与工具」下载或导入 hysteria.exe，或将节点引擎切回 OpenSSH 多隧道。',
        });
      }
      return { ok: res.ok, message: res.message, data: this.getStatus() };
    }

    return this.startOpenSshPool(node, false);
  }

  private async startOpenSshPool(
    node: NodeProfile,
    isFallback: boolean
  ): Promise<ActionResult<TunnelStatus>> {
    this.runningQuicMode = false;

    try {
      await this.balancer.start(node.localPort);
    } catch (err) {
      const msg = `本地代理调度器无法监听 127.0.0.1:${node.localPort}: ${(err as Error).message}`;
      logger.error('tunnel', msg);
      this.emit({
        state: 'error',
        nodeId: node.id,
        nodeName: node.name,
        mode: node.mode,
        activeEngine: 'openssh',
        fallbackActive: isFallback,
        localPort: node.localPort,
        lastError: msg,
        diagnosticHint: '请确认本地端口未被占用，或更换本地代理端口（如 1081）。',
      });
      return { ok: false, message: msg, data: this.getStatus() };
    }

    const poolSize = this.resolvePoolSize(node);
    const epoch = ++this.sessionEpoch;
    this.desiredRunning = true;
    this.activeNode = { ...node };
    this.rotationCursor = 0;
    this.lastMetricsFingerprint = '';

    this.emit({
      state: 'connecting',
      nodeId: node.id,
      nodeName: node.name,
      mode: node.mode,
      activeEngine: 'openssh',
      fallbackActive: isFallback,
      localPort: node.localPort,
      pid: null,
      connectedSince: null,
      reconnectCount: 0,
      nextRetryAt: null,
      lastHealthCheckAt: null,
      lastHealthLatencyMs: null,
      poolSize,
      healthyWorkers: 0,
      activeConnections: 0,
      totalBytesUp: 0,
      totalBytesDown: 0,
      workers: [],
      lastError: null,
      diagnosticHint: null,
    });

    logger.info(
      'tunnel',
      `${isFallback ? '[QUIC 回退] ' : ''}启动多隧道连接池 (${poolSize} 条并行通道) -> 本地入口 127.0.0.1:${node.localPort} (${node.mode === 'socks5' ? 'SOCKS5' : 'HTTP/本地转发'})`
    );

    // Stagger worker startup to avoid hitting Device B MaxStartups burst limits
    for (let slot = 0; slot < poolSize; slot++) {
      const timer = setTimeout(() => {
        if (!this.desiredRunning || epoch !== this.sessionEpoch) return;
        void this.launchWorkerForSlot(slot, epoch, false, null);
      }, slot * WORKER_STAGGER_MS);
      this.staggerTimers.push(timer);
    }

    // Periodically push active connection & throughput telemetry to UI
    this.metricsTimer = setInterval(() => {
      if (!this.desiredRunning || epoch !== this.sessionEpoch) return;
      const stats = this.balancer.getStats();
      const fp = `${stats.activeConnections}:${stats.totalBytesUp}:${stats.totalBytesDown}`;
      if (fp !== this.lastMetricsFingerprint) {
        this.lastMetricsFingerprint = fp;
        this.syncAggregateStatus();
      }
    }, 1500);

    // Optional periodic Make-Before-Break smooth worker rotation
    const rotMin =
      typeof node.rotationIntervalMin === 'number' &&
      Number.isFinite(node.rotationIntervalMin) &&
      node.rotationIntervalMin >= 10
        ? Math.round(node.rotationIntervalMin)
        : 0;
    if (rotMin > 0) {
      const stepMs = Math.max(60_000, Math.round((rotMin * 60_000) / poolSize));
      logger.info(
        'tunnel',
        `已启用连接池定时平滑轮换：每 ${rotMin} 分钟完成全池无感换线（单通道轮换间隔 ${Math.round(stepMs / 60_000)} 分钟）`
      );
      this.rotationTimer = setInterval(() => {
        if (!this.desiredRunning || epoch !== this.sessionEpoch) return;
        const targetSlot = this.rotationCursor % poolSize;
        this.rotationCursor += 1;
        void this.rotateSlotGracefully(targetSlot, epoch);
      }, stepMs);
    }

    return {
      ok: true,
      message: `正在启动 ${poolSize} 通道并行隧道：${node.name}`,
      data: this.getStatus(),
    };
  }

  private async launchWorkerForSlot(
    slotIndex: number,
    epoch: number,
    isReconnect: boolean,
    replacingWorkerId: string | null,
    priorReconnectCount = 0
  ): Promise<void> {
    const node = this.activeNode;
    if (!node || !this.desiredRunning || epoch !== this.sessionEpoch) return;

    let internalPort: number;
    try {
      internalPort = await findFreeLocalPort();
    } catch (err) {
      logger.error('tunnel', `通道 #${slotIndex + 1} 分配本地内部端口失败: ${(err as Error).message}`);
      return;
    }

    if (!this.desiredRunning || epoch !== this.sessionEpoch) return;

    const workerId = `w-${slotIndex + 1}-${++this.workerSeq}`;
    const worker: PoolWorker = {
      id: workerId,
      slotIndex,
      internalPort,
      child: null,
      state: isReconnect ? 'reconnecting' : 'starting',
      latencyMs: null,
      reconnectCount: priorReconnectCount,
      nextRetryAt: null,
      consecutiveHealthFailures: 0,
      healthCheckInFlight: false,
      stderrBuffer: '',
      isRotationCandidate: Boolean(replacingWorkerId),
      replacingWorkerId,
      listenPollTimer: null,
      healthCheckTimer: null,
      reconnectTimer: null,
      stableResetTimer: null,
      drainTimer: null,
    };

    this.workers.set(workerId, worker);
    this.spawnWorkerProcess(worker, epoch, isReconnect);
  }

  private spawnWorkerProcess(worker: PoolWorker, epoch: number, isReconnect: boolean): void {
    const node = this.activeNode;
    if (!node || !this.desiredRunning || epoch !== this.sessionEpoch) return;

    this.clearWorkerTimers(worker);
    worker.stderrBuffer = '';
    worker.nextRetryAt = null;
    worker.state = isReconnect ? 'reconnecting' : 'starting';

    const sshBin = resolveOpenSshBinary('ssh');
    const keyPath = this.resolveKeyPath(node);
    const workerNode: NodeProfile = { ...node, localPort: worker.internalPort };
    const args = buildSshTunnelArgs(workerNode, keyPath);

    logger.info(
      'tunnel',
      `[通道 #${worker.slotIndex + 1}${worker.isRotationCandidate ? '·热轮换' : isReconnect ? '·重连' : ''}] 启动内部隧道 127.0.0.1:${worker.internalPort}`
    );

    let child: ChildProcess;
    try {
      child = spawn(sshBin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = `无法启动 ssh 进程: ${(err as Error).message}`;
      logger.error('tunnel', msg);
      void this.abortPoolWithFatalError(
        msg,
        '请确认 Windows 已内置 OpenSSH Client（C:\\Windows\\System32\\OpenSSH\\ssh.exe）。'
      );
      return;
    }

    worker.child = child;
    this.syncAggregateStatus();

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = decodeSshOutputChunk(chunk).trim();
      if (text) logger.info('tunnel', `[通道 #${worker.slotIndex + 1}] ${text}`);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = decodeSshOutputChunk(chunk);
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (isNonFatalChannelOpenError(line)) {
          const lower = line.toLowerCase();
          const isDnsMiss =
            line.includes('不知道这样的主机') ||
            lower.includes('no such host is known') ||
            lower.includes('name or service not known');
          logger.info(
            'tunnel',
            isDnsMiss
              ? `[通道 #${worker.slotIndex + 1}] ${line}（单条目标域名解析失败，不影响隧道）`
              : `[通道 #${worker.slotIndex + 1}] ${line}（单条子通道失败，不影响隧道）`
          );
          continue;
        }

        const existingLines = worker.stderrBuffer
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        existingLines.push(line);
        worker.stderrBuffer = existingLines.slice(-8).join('\n');
        logger.warn('tunnel', `[通道 #${worker.slotIndex + 1}] ${line}`);
      }
    });

    // Poll internal worker port until ready
    let pollAttempts = 0;
    worker.listenPollTimer = setInterval(async () => {
      if (!this.desiredRunning || epoch !== this.sessionEpoch || worker.child !== child) {
        if (worker.listenPollTimer) {
          clearInterval(worker.listenPollTimer);
          worker.listenPollTimer = null;
        }
        return;
      }

      pollAttempts += 1;
      const listening = await isLocalPortListening(worker.internalPort);
      if (!this.desiredRunning || epoch !== this.sessionEpoch || worker.child !== child) {
        return;
      }

      if (listening) {
        if (worker.listenPollTimer) {
          clearInterval(worker.listenPollTimer);
          worker.listenPollTimer = null;
        }

        // Mark healthy and register in LocalProxyBalancer immediately
        worker.state = 'healthy';
        worker.consecutiveHealthFailures = 0;
        this.balancer.upsertBackend({
          id: worker.id,
          port: worker.internalPort,
          healthy: true,
          latencyMs: worker.latencyMs,
          draining: false,
        });

        // If this worker was a Make-Before-Break rotation replacement, now gracefully drain the old worker
        if (worker.replacingWorkerId) {
          const oldId = worker.replacingWorkerId;
          worker.replacingWorkerId = null;
          worker.isRotationCandidate = false;
          this.beginDrainingWorker(oldId, epoch);
        }

        logger.success(
          'tunnel',
          `[通道 #${worker.slotIndex + 1}] 已就绪并加入调度池 (内部端口 :${worker.internalPort}, PID=${child.pid ?? '-'})`
        );

        this.syncAggregateStatus();
        this.startWorkerHealthLoop(worker, child, epoch);

        // Reset backoff counter after stable 60s
        worker.stableResetTimer = setTimeout(() => {
          worker.stableResetTimer = null;
          if (
            this.desiredRunning &&
            epoch === this.sessionEpoch &&
            worker.child === child &&
            worker.state === 'healthy'
          ) {
            if (worker.reconnectCount > 0) {
              worker.reconnectCount = 0;
              this.syncAggregateStatus();
            }
          }
        }, STABLE_RESET_MS);
      } else if (pollAttempts > 40) {
        if (worker.listenPollTimer) {
          clearInterval(worker.listenPollTimer);
          worker.listenPollTimer = null;
        }
        logger.warn(
          'tunnel',
          `[通道 #${worker.slotIndex + 1}] SSH 握手超过 20 秒未监听端口，主动中止并重连...`
        );
        if (!worker.stderrBuffer.trim()) {
          worker.stderrBuffer = 'Connection timed out (SSH 握手超时未监听内部端口)';
        }
        await this.killChildProcess(child);
      }
    }, 500);

    child.once('error', (err) => {
      if (worker.child !== child || epoch !== this.sessionEpoch) return;
      logger.error('tunnel', `[通道 #${worker.slotIndex + 1}] ssh 进程启动失败: ${err.message}`);
      this.handleWorkerUnexpectedExit(worker, epoch, err.message);
    });

    child.once('exit', (code, signal) => {
      if (worker.child !== child) return;
      worker.child = null;
      this.clearWorkerTimers(worker);
      this.balancer.removeBackend(worker.id);

      if (!this.desiredRunning || epoch !== this.sessionEpoch || worker.state === 'draining') {
        worker.state = 'stopped';
        this.workers.delete(worker.id);
        if (this.desiredRunning && epoch === this.sessionEpoch) {
          this.syncAggregateStatus();
        }
        return;
      }

      const reason =
        worker.stderrBuffer.trim() ||
        `SSH 进程异常退出 (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
      this.handleWorkerUnexpectedExit(worker, epoch, reason);
    });
  }

  private startWorkerHealthLoop(worker: PoolWorker, child: ChildProcess, epoch: number): void {
    const node = this.activeNode;
    if (!node || node.healthCheckEnabled === false) return;

    const rawSec = node.healthCheckIntervalSec;
    const intervalSec =
      typeof rawSec === 'number' && Number.isFinite(rawSec) && rawSec >= 10 && rawSec <= 120
        ? Math.round(rawSec)
        : 25;

    // Initial probe staggered slightly so UI gets RTT without spiking all workers simultaneously
    const initialDelayMs = 2000 + worker.slotIndex * 600;
    const initTimer = setTimeout(() => {
      if (this.desiredRunning && epoch === this.sessionEpoch && worker.child === child) {
        void this.probeWorkerNow(worker, epoch);
      }
    }, initialDelayMs);
    this.staggerTimers.push(initTimer);

    worker.healthCheckTimer = setInterval(() => {
      if (this.desiredRunning && epoch === this.sessionEpoch && worker.child === child) {
        void this.probeWorkerNow(worker, epoch);
      }
    }, intervalSec * 1000);
  }

  private async probeWorkerNow(worker: PoolWorker, epoch: number): Promise<boolean> {
    const node = this.activeNode;
    const child = worker.child;
    if (
      !node ||
      !child ||
      !this.desiredRunning ||
      epoch !== this.sessionEpoch ||
      worker.state !== 'healthy' ||
      worker.healthCheckInFlight
    ) {
      return true;
    }

    worker.healthCheckInFlight = true;
    try {
      const res = await probeTunnelHealth(
        node.mode,
        worker.internalPort,
        node.sshPort,
        HEALTH_PROBE_TIMEOUT_MS
      );
      if (
        !this.desiredRunning ||
        epoch !== this.sessionEpoch ||
        worker.child !== child ||
        worker.state !== 'healthy'
      ) {
        return true;
      }

      if (res.ok) {
        worker.consecutiveHealthFailures = 0;
        worker.latencyMs = res.latencyMs;
        this.balancer.upsertBackend({
          id: worker.id,
          port: worker.internalPort,
          healthy: true,
          latencyMs: res.latencyMs,
          draining: false,
        });
        this.syncAggregateStatus({ lastHealthCheckAt: Date.now() });
        return true;
      }

      worker.consecutiveHealthFailures += 1;
      logger.warn(
        'tunnel',
        `[通道 #${worker.slotIndex + 1}] 端到端探活失败 (${worker.consecutiveHealthFailures}/${HEALTH_FAIL_THRESHOLD}): ${res.detail}`
      );
      if (worker.consecutiveHealthFailures >= HEALTH_FAIL_THRESHOLD) {
        logger.warn(
          'tunnel',
          `[通道 #${worker.slotIndex + 1}] 判定假死，已从调度池摘除并重建（其余健康通道不受影响）`
        );
        this.balancer.removeBackend(worker.id);
        worker.stderrBuffer = '端到端健康探活连续失败（隧道假死）';
        await this.killChildProcess(child);
      }
      return false;
    } finally {
      worker.healthCheckInFlight = false;
    }
  }

  private handleWorkerUnexpectedExit(worker: PoolWorker, epoch: number, reason: string): void {
    if (!this.desiredRunning || epoch !== this.sessionEpoch) return;

    // If this was a rotation candidate that failed to come up, leave the original healthy worker untouched!
    if (worker.isRotationCandidate && worker.replacingWorkerId) {
      logger.warn(
        'tunnel',
        `[通道 #${worker.slotIndex + 1}·热轮换] 新替补通道建立失败（${reason}），保留原健康通道继续服务`
      );
      this.workers.delete(worker.id);
      this.syncAggregateStatus();
      return;
    }

    if (isHardSshAuthFailure(reason)) {
      const hint = diagnoseSshError(reason);
      void this.abortPoolWithFatalError(reason, hint);
      return;
    }

    this.scheduleWorkerReconnect(worker, epoch, reason);
  }

  private scheduleWorkerReconnect(worker: PoolWorker, epoch: number, reason: string): void {
    if (!this.desiredRunning || epoch !== this.sessionEpoch) return;

    worker.reconnectCount += 1;
    const delayMs = computeReconnectDelayMs(worker.reconnectCount);
    worker.state = 'reconnecting';
    worker.latencyMs = null;
    worker.nextRetryAt = Date.now() + delayMs;

    const hint = diagnoseSshError(reason);
    logger.warn(
      'tunnel',
      `[通道 #${worker.slotIndex + 1}] 已断开（${reason}），${(delayMs / 1000).toFixed(1)} 秒后执行第 ${worker.reconnectCount} 次自动重连...`
    );

    const hasOtherHealthy = Array.from(this.workers.values()).some((w) => w.state === 'healthy');
    this.syncAggregateStatus(
      hasOtherHealthy ? {} : { lastError: reason, diagnosticHint: hint }
    );

    worker.reconnectTimer = setTimeout(async () => {
      worker.reconnectTimer = null;
      if (!this.desiredRunning || epoch !== this.sessionEpoch || !this.activeNode) return;

      // On retry >= 2, run lightweight TCP pre-check before spawning ssh.exe
      if (worker.reconnectCount >= 2) {
        const probe = await testTcpConnection(this.activeNode.host, this.activeNode.sshPort, 4000);
        if (!this.desiredRunning || epoch !== this.sessionEpoch || !this.activeNode) return;
        if (!probe.reachable) {
          this.scheduleWorkerReconnect(worker, epoch, `网络预检不可达: ${probe.detail}`);
          return;
        }
      }

      // Allocate a fresh internal port on reconnect to avoid Windows TIME_WAIT / lingering socket clash
      try {
        worker.internalPort = await findFreeLocalPort();
      } catch {
        // Keep existing port as fallback
      }
      if (!this.desiredRunning || epoch !== this.sessionEpoch) return;
      this.spawnWorkerProcess(worker, epoch, true);
    }, delayMs);
  }

  private beginDrainingWorker(workerId: string, epoch: number): void {
    const oldW = this.workers.get(workerId);
    if (!oldW) return;

    oldW.state = 'draining';
    this.clearWorkerTimers(oldW);
    this.balancer.upsertBackend({
      id: oldW.id,
      port: oldW.internalPort,
      healthy: true,
      latencyMs: oldW.latencyMs,
      draining: true,
    });
    this.syncAggregateStatus();

    const startedDrainAt = Date.now();
    const finishDrain = async () => {
      if (oldW.drainTimer) {
        clearInterval(oldW.drainTimer);
        oldW.drainTimer = null;
      }
      this.balancer.removeBackend(oldW.id);
      const child = oldW.child;
      oldW.child = null;
      oldW.state = 'stopped';
      this.workers.delete(oldW.id);
      await this.killChildProcess(child);
      if (this.desiredRunning && epoch === this.sessionEpoch) {
        logger.info('tunnel', `[通道 #${oldW.slotIndex + 1}] 旧连接已优雅排空并下线`);
        this.syncAggregateStatus();
      }
    };

    if (this.balancer.getBackendActiveConnections(oldW.id) === 0) {
      void finishDrain();
      return;
    }

    oldW.drainTimer = setInterval(() => {
      const active = this.balancer.getBackendActiveConnections(oldW.id);
      if (active === 0 || Date.now() - startedDrainAt >= DRAIN_MAX_WAIT_MS) {
        void finishDrain();
      }
    }, 1000);
  }

  private async rotateSlotGracefully(slotIndex: number, epoch: number): Promise<void> {
    if (!this.desiredRunning || epoch !== this.sessionEpoch) return;

    // Find current active healthy worker for this slot (skip if already rotating or reconnecting)
    const slotWorkers = Array.from(this.workers.values()).filter((w) => w.slotIndex === slotIndex);
    if (slotWorkers.some((w) => w.isRotationCandidate || w.state === 'draining')) {
      return;
    }
    const current = slotWorkers.find((w) => w.state === 'healthy');
    if (!current) return;

    logger.info('tunnel', `[通道 #${slotIndex + 1}] 开始 Make-Before-Break 无感热轮换...`);
    await this.launchWorkerForSlot(slotIndex, epoch, false, current.id, 0);
  }

  /**
   * Smoothly replaces all healthy workers one-by-one (Make-Before-Break) without dropping active traffic.
   */
  public async rotateAllGracefully(): Promise<ActionResult<TunnelStatus>> {
    if (!this.desiredRunning || !this.activeNode) {
      return { ok: false, message: '当前隧道未运行，无法执行平滑轮换' };
    }
    if (this.runningQuicMode) {
      logger.info('tunnel', 'QUIC 模式不支持多槽位轮换，改为快速重建 QUIC 会话...');
      return this.reconnectNow();
    }
    const epoch = this.sessionEpoch;
    const poolSize = this.resolvePoolSize(this.activeNode);
    logger.info('tunnel', `开始全池平滑热轮换 (${poolSize} 条通道，先建后拆，业务不断流)...`);

    for (let slot = 0; slot < poolSize; slot++) {
      const timer = setTimeout(() => {
        if (this.desiredRunning && epoch === this.sessionEpoch) {
          void this.rotateSlotGracefully(slot, epoch);
        }
      }, slot * 1200);
      this.staggerTimers.push(timer);
    }

    return {
      ok: true,
      message: '已触发全池无感平滑热轮换（先建立新通道，再优雅排空旧通道）',
      data: this.getStatus(),
    };
  }

  private async abortPoolWithFatalError(reason: string, hint: string | null): Promise<void> {
    this.sessionEpoch += 1;
    this.desiredRunning = false;
    this.runningQuicMode = false;
    this.clearGlobalTimers();

    const toKill: Promise<void>[] = [];
    for (const w of this.workers.values()) {
      this.clearWorkerTimers(w);
      const child = w.child;
      w.child = null;
      w.state = 'stopped';
      toKill.push(this.killChildProcess(child));
    }
    this.workers.clear();
    await Promise.all(toKill);
    await this.balancer.stop();

    logger.error('tunnel', `检测到认证/指纹/配置错误，已暂停连接池自动重连: ${reason}`);
    this.emit({
      state: 'error',
      pid: null,
      connectedSince: null,
      nextRetryAt: null,
      lastHealthLatencyMs: null,
      healthyWorkers: 0,
      activeConnections: 0,
      workers: [],
      lastError: reason,
      diagnosticHint: hint,
    });
  }

  /**
   * Called when OS wakes from sleep/hibernate (Electron powerMonitor 'resume').
   * Proactively verifies all healthy workers and immediately wakes up any workers waiting on backoff.
   */
  public handleSystemResume(): void {
    if (!this.desiredRunning || !this.activeNode) return;
    if (this.runningQuicMode) {
      this.quicEngine.handleSystemResume();
      return;
    }

    const epoch = this.sessionEpoch;
    logger.info('tunnel', '检测到系统休眠唤醒，正在快速校验所有连接池通道...');

    if (this.resumeProbeTimer) {
      clearTimeout(this.resumeProbeTimer);
    }

    this.resumeProbeTimer = setTimeout(async () => {
      this.resumeProbeTimer = null;
      if (!this.desiredRunning || epoch !== this.sessionEpoch) return;

      for (const w of Array.from(this.workers.values())) {
        if (w.reconnectTimer) {
          clearTimeout(w.reconnectTimer);
          w.reconnectTimer = null;
          w.reconnectCount = 0;
          w.nextRetryAt = null;
          this.spawnWorkerProcess(w, epoch, true);
        } else if (w.state === 'healthy' && w.child) {
          const ok = await this.probeWorkerNow(w, epoch);
          if (!ok && w.child && w.state === 'healthy') {
            // Wake probe failed once: rebuild immediately instead of waiting for 2nd interval
            logger.warn(
              'tunnel',
              `[通道 #${w.slotIndex + 1}] 休眠唤醒后已失效，立即重建...`
            );
            this.balancer.removeBackend(w.id);
            w.reconnectCount = 0;
            w.stderrBuffer = '系统休眠唤醒后连接失效';
            await this.killChildProcess(w.child);
          }
        }
      }
    }, 1500);
  }

  public async stop(silent = false): Promise<ActionResult<TunnelStatus>> {
    this.sessionEpoch += 1;
    this.desiredRunning = false;
    this.runningQuicMode = false;
    this.clearGlobalTimers();

    await this.quicEngine.stop();

    const toKill: Promise<void>[] = [];
    for (const w of this.workers.values()) {
      this.clearWorkerTimers(w);
      const child = w.child;
      w.child = null;
      w.state = 'stopped';
      toKill.push(this.killChildProcess(child));
    }
    this.workers.clear();

    await Promise.all(toKill);
    await this.balancer.stop();

    if (!silent) {
      logger.info('tunnel', '已手动断开隧道连接并停止所有后台守护进程。');
    }

    this.emit({
      state: 'disconnected',
      fallbackActive: false,
      pid: null,
      connectedSince: null,
      reconnectCount: 0,
      nextRetryAt: null,
      lastHealthCheckAt: null,
      lastHealthLatencyMs: null,
      healthyWorkers: 0,
      activeConnections: 0,
      totalBytesUp: 0,
      totalBytesDown: 0,
      workers: [],
      lastError: null,
      diagnosticHint: null,
    });

    return { ok: true, message: '隧道已断开', data: this.getStatus() };
  }

  public async reconnectNow(): Promise<ActionResult<TunnelStatus>> {
    if (!this.activeNode) {
      return { ok: false, message: '当前没有可重连的活动节点' };
    }
    const target = this.activeNode;
    logger.info('tunnel', '收到手动「立即重连」指令，正在重建隧道...');
    await this.stop(true);
    return this.start(target);
  }

  /**
   * Cleans up any orphaned ssh.exe / hysteria.exe processes.
   */
  public async killOrphanSshProcesses(): Promise<ActionResult> {
    await this.stop(true);
    if (!IS_WINDOWS) {
      return { ok: true, message: '已停止当前应用托管的所有隧道进程。' };
    }
    const r1 = await execCmd('taskkill', ['/F', '/IM', 'ssh.exe'], { timeoutMs: 5000 });
    const r2 = await execCmd('taskkill', ['/F', '/IM', 'hysteria.exe'], { timeoutMs: 5000 });
    if (r1.code === 0 || r2.code === 0) {
      logger.success('tunnel', '已强制清理本机残留的 ssh.exe / hysteria.exe 进程。');
      return { ok: true, message: '已清理所有残留的隧道进程' };
    }
    return {
      ok: true,
      message: '未发现残留的 ssh.exe / hysteria.exe 进程（或已全部结束）',
    };
  }
}

export const tunnelManager = new TunnelManager();
