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
import type { ActionResult, NodeProfile, TunnelStatus } from '../../shared/types';
import { logger } from '../logger';
import {
  execCmd,
  isLocalPortListening,
  IS_WINDOWS,
  resolveOpenSshBinary,
  testTcpConnection,
} from '../platform/shell';
import { probeTunnelHealth } from './healthProbe';

type StatusListener = (status: TunnelStatus) => void;

const STABLE_RESET_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 8000;
const HEALTH_FAIL_THRESHOLD = 2;

class TunnelManager {
  private child: ChildProcess | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private listenPollTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private stableResetTimer: NodeJS.Timeout | null = null;
  private resumeProbeTimer: NodeJS.Timeout | null = null;
  private healthCheckInFlight = false;
  private consecutiveHealthFailures = 0;
  private desiredRunning = false;
  private activeNode: NodeProfile | null = null;
  private listeners = new Set<StatusListener>();
  private stderrBuffer = '';

  private status: TunnelStatus = {
    state: 'disconnected',
    nodeId: null,
    nodeName: null,
    mode: 'socks5',
    localPort: 1080,
    pid: null,
    connectedSince: null,
    reconnectCount: 0,
    nextRetryAt: null,
    lastHealthCheckAt: null,
    lastHealthLatencyMs: null,
    lastError: null,
    diagnosticHint: null,
  };

  public getStatus(): TunnelStatus {
    return { ...this.status };
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

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.listenPollTimer) {
      clearInterval(this.listenPollTimer);
      this.listenPollTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer);
      this.stableResetTimer = null;
    }
    if (this.resumeProbeTimer) {
      clearTimeout(this.resumeProbeTimer);
      this.resumeProbeTimer = null;
    }
    this.healthCheckInFlight = false;
    this.consecutiveHealthFailures = 0;
  }

  private resolveKeyPath(node: NodeProfile): string {
    if (node.privateKeyPath && node.privateKeyPath.trim()) {
      return node.privateKeyPath.trim();
    }
    return path.join(os.homedir(), '.ssh', 'id_ed25519');
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

  public async start(node: NodeProfile): Promise<ActionResult<TunnelStatus>> {
    if (!node.host.trim()) {
      return { ok: false, message: '节点主机地址不能为空' };
    }

    // Stop any previous tunnel cleanly
    if (this.desiredRunning || this.child) {
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
        localPort: node.localPort,
        pid: null,
        connectedSince: null,
        nextRetryAt: null,
        lastHealthCheckAt: null,
        lastHealthLatencyMs: null,
        lastError: msg,
        diagnosticHint: '可点击「清理残留 ssh.exe」按钮，或在节点配置中修改本地端口（如 1081）。',
      });
      return { ok: false, message: msg, data: this.getStatus() };
    }

    this.desiredRunning = true;
    this.activeNode = { ...node };
    this.emit({
      state: 'connecting',
      nodeId: node.id,
      nodeName: node.name,
      mode: node.mode,
      localPort: node.localPort,
      pid: null,
      connectedSince: null,
      reconnectCount: 0,
      nextRetryAt: null,
      lastHealthCheckAt: null,
      lastHealthLatencyMs: null,
      lastError: null,
      diagnosticHint: null,
    });

    this.spawnTunnelProcess(false);
    return { ok: true, message: `正在启动隧道：${node.name}`, data: this.getStatus() };
  }

  private startHealthCheckLoop(child: ChildProcess, node: NodeProfile): void {
    if (node.healthCheckEnabled === false) return;

    const rawSec = node.healthCheckIntervalSec;
    const intervalSec =
      typeof rawSec === 'number' && Number.isFinite(rawSec) && rawSec >= 10 && rawSec <= 120
        ? Math.round(rawSec)
        : 25;

    this.consecutiveHealthFailures = 0;

    // Run a quick initial probe after 3s so UI displays real A<->B tunnel RTT promptly
    const runProbe = async () => {
      if (!this.desiredRunning || this.child !== child || this.healthCheckInFlight) {
        return;
      }
      this.healthCheckInFlight = true;
      try {
        const res = await probeTunnelHealth(
          node.mode,
          node.localPort,
          node.sshPort,
          HEALTH_PROBE_TIMEOUT_MS
        );
        if (!this.desiredRunning || this.child !== child) return;

        if (res.ok) {
          this.consecutiveHealthFailures = 0;
          this.emit({
            lastHealthCheckAt: Date.now(),
            lastHealthLatencyMs: res.latencyMs,
          });
        } else {
          this.consecutiveHealthFailures += 1;
          logger.warn(
            'tunnel',
            `端到端探活失败 (${this.consecutiveHealthFailures}/${HEALTH_FAIL_THRESHOLD}): ${res.detail}`
          );
          if (this.consecutiveHealthFailures >= HEALTH_FAIL_THRESHOLD) {
            logger.warn(
              'tunnel',
              `连续 ${HEALTH_FAIL_THRESHOLD} 次探活超时，判定隧道已假死，主动终止并触发快速重连...`
            );
            this.stderrBuffer = '端到端健康探活连续失败（隧道假死）';
            await this.killChildProcess(child);
          }
        }
      } finally {
        this.healthCheckInFlight = false;
      }
    };

    setTimeout(() => {
      void runProbe();
    }, 3000);

    this.healthCheckTimer = setInterval(() => {
      void runProbe();
    }, intervalSec * 1000);
  }

  private spawnTunnelProcess(isReconnect: boolean): void {
    const node = this.activeNode;
    if (!node || !this.desiredRunning) return;

    this.clearTimers();
    this.stderrBuffer = '';

    const sshBin = resolveOpenSshBinary('ssh');
    const keyPath = this.resolveKeyPath(node);
    const args = buildSshTunnelArgs(node, keyPath);

    logger.info(
      'tunnel',
      `${isReconnect ? '[自动重连] ' : ''}启动 SSH 隧道: ${sshBin} ${args.join(' ')}`
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
      this.emit({
        state: 'error',
        pid: null,
        connectedSince: null,
        nextRetryAt: null,
        lastError: msg,
        diagnosticHint: '请确认 Windows 已内置 OpenSSH Client（C:\\Windows\\System32\\OpenSSH\\ssh.exe）。',
      });
      this.desiredRunning = false;
      return;
    }

    this.child = child;
    this.emit({
      state: isReconnect ? 'reconnecting' : 'connecting',
      pid: child.pid ?? null,
      nextRetryAt: null,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = decodeSshOutputChunk(chunk).trim();
      if (text) logger.info('tunnel', text);
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
              ? `${line}（单条请求目标域名解析失败，不影响主隧道）`
              : `${line}（单条子通道失败，不影响主隧道）`
          );
          continue;
        }

        const existingLines = this.stderrBuffer
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        existingLines.push(line);
        this.stderrBuffer = existingLines.slice(-8).join('\n');
        logger.warn('tunnel', line);
      }
    });

    // Poll local listening port to accurately transition to 'connected'
    let pollAttempts = 0;
    this.listenPollTimer = setInterval(async () => {
      if (!this.desiredRunning || this.child !== child) {
        if (this.listenPollTimer) {
          clearInterval(this.listenPollTimer);
          this.listenPollTimer = null;
        }
        return;
      }
      pollAttempts += 1;
      const listening = await isLocalPortListening(node.localPort);
      if (listening) {
        if (this.listenPollTimer) {
          clearInterval(this.listenPollTimer);
          this.listenPollTimer = null;
        }
        logger.success(
          'tunnel',
          `隧道已就绪！本地监听 127.0.0.1:${node.localPort} (${node.mode === 'socks5' ? 'SOCKS5' : 'HTTP/本地转发'})`
        );
        this.emit({
          state: 'connected',
          pid: child.pid ?? null,
          connectedSince: Date.now(),
          nextRetryAt: null,
          lastError: null,
          diagnosticHint: null,
        });

        // Start active end-to-end health probe to detect frozen/zombie tunnels
        this.startHealthCheckLoop(child, node);

        // Reset backoff counter after stable operation so future blips recover in ~1s
        this.stableResetTimer = setTimeout(() => {
          this.stableResetTimer = null;
          if (this.desiredRunning && this.child === child && this.status.state === 'connected') {
            if (this.status.reconnectCount > 0) {
              this.emit({ reconnectCount: 0 });
            }
          }
        }, STABLE_RESET_MS);
      } else if (pollAttempts > 40) {
        // 20 seconds elapsed without opening port: kill hung ssh.exe to trigger backoff reconnect
        if (this.listenPollTimer) {
          clearInterval(this.listenPollTimer);
          this.listenPollTimer = null;
        }
        logger.warn('tunnel', 'SSH 握手超过 20 秒未打开本地监听端口，主动中止并尝试重连...');
        if (!this.stderrBuffer.trim()) {
          this.stderrBuffer = 'Connection timed out (SSH 握手超时未监听本地端口)';
        }
        await this.killChildProcess(child);
      }
    }, 500);

    child.once('error', (err) => {
      if (this.child !== child) return;
      logger.error('tunnel', `ssh 进程启动失败: ${err.message}`);
      this.handleUnexpectedExit(-1, err.message);
    });

    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimers();

      if (!this.desiredRunning) {
        logger.info('tunnel', '隧道进程已停止。');
        this.emit({
          state: 'disconnected',
          pid: null,
          connectedSince: null,
          nextRetryAt: null,
          lastHealthLatencyMs: null,
        });
        return;
      }

      const reason =
        this.stderrBuffer.trim() ||
        `SSH 进程异常退出 (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
      this.handleUnexpectedExit(code ?? 1, reason);
    });
  }

  private scheduleReconnect(reason: string): void {
    const nextReconnectCount = this.status.reconnectCount + 1;
    const delayMs = computeReconnectDelayMs(nextReconnectCount);
    const nextRetryAt = Date.now() + delayMs;
    const hint = diagnoseSshError(reason);

    logger.warn(
      'tunnel',
      `隧道已断开（${reason}），将于 ${(delayMs / 1000).toFixed(1)} 秒后执行第 ${nextReconnectCount} 次自动重连...`
    );

    this.emit({
      state: 'reconnecting',
      pid: null,
      connectedSince: null,
      reconnectCount: nextReconnectCount,
      nextRetryAt,
      lastHealthLatencyMs: null,
      lastError: reason,
      diagnosticHint: hint,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.desiredRunning || !this.activeNode) return;

      // On subsequent retries (attempt >= 2), run a lightweight TCP pre-check first
      // to avoid spawning ssh.exe repeatedly while the machine is completely offline.
      if (nextReconnectCount >= 2) {
        const probe = await testTcpConnection(this.activeNode.host, this.activeNode.sshPort, 4000);
        if (!this.desiredRunning || !this.activeNode) return;
        if (!probe.reachable) {
          this.scheduleReconnect(`网络预检不可达: ${probe.detail}`);
          return;
        }
      }

      this.spawnTunnelProcess(true);
    }, delayMs);
  }

  private handleUnexpectedExit(_code: number, reason: string): void {
    const hint = diagnoseSshError(reason);

    if (isHardSshAuthFailure(reason)) {
      this.desiredRunning = false;
      logger.error('tunnel', `检测到认证/指纹/配置错误，已暂停自动重连: ${reason}`);
      this.emit({
        state: 'error',
        pid: null,
        connectedSince: null,
        nextRetryAt: null,
        lastHealthLatencyMs: null,
        lastError: reason,
        diagnosticHint: hint,
      });
      return;
    }

    this.scheduleReconnect(reason);
  }

  /**
   * Called when OS wakes from sleep/hibernate (Electron powerMonitor 'resume').
   * Proactively tests or immediately rebuilds the tunnel instead of waiting 45s+ for keepalive timeout.
   */
  public handleSystemResume(): void {
    if (!this.desiredRunning || !this.activeNode) return;

    if (this.reconnectTimer) {
      logger.info('tunnel', '检测到系统休眠唤醒，取消退避等待并立即尝试重连...');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.emit({ reconnectCount: 0, nextRetryAt: null });
      this.resumeProbeTimer = setTimeout(() => {
        this.resumeProbeTimer = null;
        if (this.desiredRunning) {
          this.spawnTunnelProcess(true);
        }
      }, 1500);
      return;
    }

    if (this.child && this.status.state === 'connected') {
      const targetChild = this.child;
      const targetNode = this.activeNode;
      logger.info('tunnel', '检测到系统休眠唤醒，正在快速校验隧道连通性...');
      if (this.resumeProbeTimer) {
        clearTimeout(this.resumeProbeTimer);
      }
      // Wait 1.5s for Wi-Fi / NIC to re-associate after wake, then verify end-to-end liveness
      this.resumeProbeTimer = setTimeout(async () => {
        this.resumeProbeTimer = null;
        if (!this.desiredRunning || this.child !== targetChild) return;
        const probe = await probeTunnelHealth(
          targetNode.mode,
          targetNode.localPort,
          targetNode.sshPort,
          5000
        );
        if (!this.desiredRunning || this.child !== targetChild) return;
        if (probe.ok) {
          logger.success('tunnel', `休眠唤醒校验通过，隧道依然畅通 (${probe.latencyMs}ms)`);
          this.emit({
            lastHealthCheckAt: Date.now(),
            lastHealthLatencyMs: probe.latencyMs,
          });
        } else {
          logger.warn('tunnel', `休眠唤醒后隧道已失效（${probe.detail}），立即重建连接...`);
          this.emit({ reconnectCount: 0 });
          this.stderrBuffer = '系统休眠唤醒后连接失效';
          await this.killChildProcess(targetChild);
        }
      }, 1500);
    }
  }

  public async stop(silent = false): Promise<ActionResult<TunnelStatus>> {
    this.desiredRunning = false;
    this.clearTimers();

    const child = this.child;
    this.child = null;

    await this.killChildProcess(child);

    if (!silent) {
      logger.info('tunnel', '已手动断开隧道连接并停止自动守护。');
    }

    this.emit({
      state: 'disconnected',
      pid: null,
      connectedSince: null,
      reconnectCount: 0,
      nextRetryAt: null,
      lastHealthCheckAt: null,
      lastHealthLatencyMs: null,
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
   * Cleans up any orphaned ssh.exe processes (useful if user previously ran start_tunnel.vbs).
   */
  public async killOrphanSshProcesses(): Promise<ActionResult> {
    await this.stop(true);
    if (!IS_WINDOWS) {
      return { ok: true, message: '已停止当前应用托管的隧道进程。' };
    }
    const res = await execCmd('taskkill', ['/F', '/IM', 'ssh.exe'], { timeoutMs: 5000 });
    if (res.code === 0) {
      logger.success('tunnel', '已强制清理本机残留的 ssh.exe 进程。');
      return { ok: true, message: '已清理所有残留的 ssh.exe 进程' };
    }
    return {
      ok: true,
      message: '未发现残留的 ssh.exe 进程（或已全部结束）',
    };
  }
}

export const tunnelManager = new TunnelManager();
