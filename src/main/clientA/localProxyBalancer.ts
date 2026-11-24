import net from 'net';

export interface BalancerBackendConfig {
  id: string;
  port: number;
  healthy: boolean;
  latencyMs: number | null;
  draining?: boolean;
}

export interface BalancerBackendState extends BalancerBackendConfig {
  draining: boolean;
  activeConnections: number;
  totalAssigned: number;
  recentDialFailures: number;
}

export interface BalancerStats {
  listening: boolean;
  listenPort: number | null;
  activeConnections: number;
  totalBytesUp: number;
  totalBytesDown: number;
  perBackendActive: Record<string, number>;
}

/**
 * Finds an available ephemeral TCP port on 127.0.0.1.
 */
export function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close(() => reject(new Error('无法分配本地空闲端口')));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Computes dispatch score for a backend worker (lower is better):
 * combines Least-Connections with EWMA tunnel RTT and dial failure penalty
 * so cross-border packet-loss spikes automatically shift traffic to healthier tunnels.
 */
export function scoreBackend(b: Pick<BalancerBackendState, 'activeConnections' | 'latencyMs' | 'recentDialFailures'>): number {
  const latencyScore = b.latencyMs !== null && Number.isFinite(b.latencyMs)
    ? Math.min(Math.max(b.latencyMs, 1), 5000)
    : 150;
  return b.activeConnections * 100 + latencyScore + b.recentDialFailures * 600;
}

/**
 * Pure Node.js L4 TCP stream balancer that sits on 127.0.0.1:<localPort>
 * in front of N parallel SSH tunnels (works transparently for both SOCKS5 -D and HTTP/local -L):
 * - Zero protocol parsing overhead, TCP_NODELAY enabled on both legs
 * - Pauses client socket during upstream dial for lossless transparent failover on dead workers
 * - Least-Connections + RTT-aware dispatch
 * - Supports Make-Before-Break graceful draining
 */
export class LocalProxyBalancer {
  private server: net.Server | null = null;
  private listenPort: number | null = null;
  private backends = new Map<string, BalancerBackendState>();
  private openSockets = new Set<net.Socket>();
  private totalBytesUp = 0;
  private totalBytesDown = 0;
  private onBackendDialError?: (backendId: string, err: Error) => void;

  constructor(options?: { onBackendDialError?: (backendId: string, err: Error) => void }) {
    this.onBackendDialError = options?.onBackendDialError;
  }

  public async start(listenPort: number): Promise<void> {
    if (this.server) {
      await this.stop();
    }

    this.totalBytesUp = 0;
    this.totalBytesDown = 0;

    return new Promise((resolve, reject) => {
      const srv = net.createServer((clientSocket) => {
        this.handleClientConnection(clientSocket);
      });

      srv.once('error', (err) => {
        reject(err);
      });

      srv.listen(listenPort, '127.0.0.1', () => {
        this.server = srv;
        this.listenPort = listenPort;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.listenPort = null;

    for (const sock of this.openSockets) {
      try {
        sock.destroy();
      } catch {
        // Ignore already destroyed
      }
    }
    this.openSockets.clear();
    this.backends.clear();

    if (!srv) return;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  public upsertBackend(cfg: BalancerBackendConfig): void {
    const existing = this.backends.get(cfg.id);
    if (existing) {
      existing.port = cfg.port;
      existing.healthy = cfg.healthy;
      existing.draining = Boolean(cfg.draining);
      if (cfg.latencyMs !== null) {
        // Smooth RTT with EWMA (70% old, 30% new) to prevent jittery flapping
        existing.latencyMs =
          existing.latencyMs === null
            ? cfg.latencyMs
            : Math.round(existing.latencyMs * 0.7 + cfg.latencyMs * 0.3);
      }
      if (cfg.healthy) {
        existing.recentDialFailures = 0;
      }
    } else {
      this.backends.set(cfg.id, {
        id: cfg.id,
        port: cfg.port,
        healthy: cfg.healthy,
        latencyMs: cfg.latencyMs,
        draining: Boolean(cfg.draining),
        activeConnections: 0,
        totalAssigned: 0,
        recentDialFailures: 0,
      });
    }
  }

  public removeBackend(id: string): void {
    this.backends.delete(id);
  }

  public getBackendActiveConnections(id: string): number {
    return this.backends.get(id)?.activeConnections ?? 0;
  }

  public selectBackend(excludeIds?: Set<string>): BalancerBackendState | null {
    let best: BalancerBackendState | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const b of this.backends.values()) {
      if (!b.healthy || b.draining) continue;
      if (excludeIds && excludeIds.has(b.id)) continue;

      const s = scoreBackend(b);
      if (
        best === null ||
        s < bestScore ||
        (s === bestScore && b.totalAssigned < best.totalAssigned)
      ) {
        best = b;
        bestScore = s;
      }
    }

    return best;
  }

  public getStats(): BalancerStats {
    let activeConnections = 0;
    const perBackendActive: Record<string, number> = {};
    for (const b of this.backends.values()) {
      activeConnections += b.activeConnections;
      perBackendActive[b.id] = b.activeConnections;
    }
    return {
      listening: Boolean(this.server),
      listenPort: this.listenPort,
      activeConnections,
      totalBytesUp: this.totalBytesUp,
      totalBytesDown: this.totalBytesDown,
      perBackendActive,
    };
  }

  private handleClientConnection(clientSocket: net.Socket): void {
    // Pause client stream until upstream dial succeeds so failover retry loses zero bytes
    clientSocket.pause();
    clientSocket.setNoDelay(true);
    this.openSockets.add(clientSocket);

    let clientClosed = false;
    clientSocket.once('close', () => {
      clientClosed = true;
      this.openSockets.delete(clientSocket);
    });
    clientSocket.on('error', () => {
      clientClosed = true;
      clientSocket.destroy();
    });

    const tried = new Set<string>();

    const tryNextBackend = () => {
      if (clientClosed || clientSocket.destroyed) return;

      const backend = this.selectBackend(tried);
      if (!backend) {
        clientSocket.destroy();
        return;
      }
      tried.add(backend.id);

      const upstream = new net.Socket();
      upstream.setNoDelay(true);
      upstream.setTimeout(4000);
      this.openSockets.add(upstream);

      let connected = false;
      let accounted = false;

      const releaseAccounting = () => {
        if (accounted) {
          accounted = false;
          backend.activeConnections = Math.max(0, backend.activeConnections - 1);
        }
        this.openSockets.delete(upstream);
      };

      upstream.once('connect', () => {
        if (clientClosed || clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        connected = true;
        upstream.setTimeout(0); // Idle timeout is managed by end-to-end protocols / browser
        backend.recentDialFailures = 0;
        backend.activeConnections += 1;
        backend.totalAssigned += 1;
        accounted = true;

        clientSocket.on('data', (chunk: Buffer) => {
          this.totalBytesUp += chunk.length;
        });
        upstream.on('data', (chunk: Buffer) => {
          this.totalBytesDown += chunk.length;
        });

        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
        clientSocket.resume();
      });

      upstream.once('timeout', () => {
        if (!connected) {
          upstream.destroy(new Error('本地隧道 worker 连接超时'));
        }
      });

      upstream.on('error', (err) => {
        releaseAccounting();
        if (!connected) {
          backend.recentDialFailures += 1;
          this.onBackendDialError?.(backend.id, err);
          // Transparent lossless failover to next healthy backend!
          tryNextBackend();
        } else if (!clientSocket.destroyed) {
          clientSocket.destroy();
        }
      });

      upstream.once('close', () => {
        releaseAccounting();
        if (connected && !clientSocket.destroyed) {
          clientSocket.end();
        }
      });

      clientSocket.once('close', () => {
        if (!upstream.destroyed) {
          upstream.destroy();
        }
      });

      upstream.connect(backend.port, '127.0.0.1');
    };

    tryNextBackend();
  }
}
