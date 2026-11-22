import { ChildProcess, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import {
  buildSshTunnelArgs,
  decodeSshOutputChunk,
  diagnoseSshError,
  isNonFatalChannelOpenError,
} from '../../shared/commandBuilders';
import type { ActionResult, NodeProfile, TunnelStatus } from '../../shared/types';
import { logger } from '../logger';
import {
  isLocalPortListening,
  resolveOpenSshBinary,
  IS_WINDOWS,
  execCmd,
} from '../platform/shell';

type StatusListener = (status: TunnelStatus) => void;

const RECONNECT_DELAY_MS = 5000;

class TunnelManager {
  private child: ChildProcess | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private listenPollTimer: NodeJS.Timeout | null = null;
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
  }

  private resolveKeyPath(node: NodeProfile): string {
    if (node.privateKeyPath && node.privateKeyPath.trim()) {
      return node.privateKeyPath.trim();
    }
    return path.join(os.homedir(), '.ssh', 'id_ed25519');
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
      lastError: null,
      diagnosticHint: null,
    });

    this.spawnTunnelProcess(false);
    return { ok: true, message: `正在启动隧道：${node.name}`, data: this.getStatus() };
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
          lastError: null,
          diagnosticHint: null,
        });
      } else if (pollAttempts > 40) {
        // 20 seconds elapsed without opening port
        if (this.listenPollTimer) {
          clearInterval(this.listenPollTimer);
          this.listenPollTimer = null;
        }
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
        });
        return;
      }

      const reason =
        this.stderrBuffer.trim() ||
        `SSH 进程异常退出 (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
      this.handleUnexpectedExit(code ?? 1, reason);
    });
  }

  private handleUnexpectedExit(_code: number, reason: string): void {
    const hint = diagnoseSshError(reason);
    const nextReconnectCount = this.status.reconnectCount + 1;

    // Fatal config/auth errors shouldn't spam infinite reconnects without telling user;
    // still keep watchdog for network drops, but pause on explicit host key / key missing errors
    const isHardAuthFailure =
      reason.toLowerCase().includes('host key verification failed') ||
      reason.toLowerCase().includes('no such file or directory');

    if (isHardAuthFailure) {
      this.desiredRunning = false;
      logger.error('tunnel', `检测到认证/指纹错误，已暂停自动重连: ${reason}`);
      this.emit({
        state: 'error',
        pid: null,
        connectedSince: null,
        lastError: reason,
        diagnosticHint: hint,
      });
      return;
    }

    logger.warn(
      'tunnel',
      `隧道已断开（${reason}），将于 ${RECONNECT_DELAY_MS / 1000} 秒后执行第 ${nextReconnectCount} 次自动重连...`
    );

    this.emit({
      state: 'reconnecting',
      pid: null,
      connectedSince: null,
      reconnectCount: nextReconnectCount,
      lastError: reason,
      diagnosticHint: hint,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.desiredRunning) {
        this.spawnTunnelProcess(true);
      }
    }, RECONNECT_DELAY_MS);
  }

  public async stop(silent = false): Promise<ActionResult<TunnelStatus>> {
    this.desiredRunning = false;
    this.clearTimers();

    const child = this.child;
    this.child = null;

    if (child && child.pid) {
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

    if (!silent) {
      logger.info('tunnel', '已手动断开隧道连接并停止自动守护。');
    }

    this.emit({
      state: 'disconnected',
      pid: null,
      connectedSince: null,
      reconnectCount: 0,
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
