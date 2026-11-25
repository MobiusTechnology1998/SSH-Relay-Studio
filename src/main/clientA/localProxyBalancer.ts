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

const HTTP_METHOD_PREFIX_RE = /^(CONNECT|GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)\s/i;
const MAX_HTTP_HEADER_BYTES = 32 * 1024;

function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const trimmed = authority.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    const host = trimmed.slice(1, closeIdx);
    const rest = trimmed.slice(closeIdx + 1);
    const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : defaultPort;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && trimmed.indexOf(':') === lastColon) {
    const host = trimmed.slice(0, lastColon);
    const port = Number.parseInt(trimmed.slice(lastColon + 1), 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  return { host: trimmed, port: defaultPort };
}

function buildSocks5ConnectPacket(host: string, port: number): Buffer {
  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const octets = host.split('.').map((n) => Number.parseInt(n, 10));
    return Buffer.from([
      0x05,
      0x01,
      0x00,
      0x01,
      octets[0],
      octets[1],
      octets[2],
      octets[3],
      (port >> 8) & 0xff,
      port & 0xff,
    ]);
  }
  const hostBuf = Buffer.from(host, 'utf8');
  const len = Math.min(255, hostBuf.length);
  const out = Buffer.alloc(4 + 1 + len + 2);
  out[0] = 0x05;
  out[1] = 0x01;
  out[2] = 0x00;
  out[3] = 0x03; // ATYP = Domain (forces remote DNS resolution on Device B!)
  out[4] = len;
  hostBuf.copy(out, 5, 0, len);
  out[5 + len] = (port >> 8) & 0xff;
  out[6 + len] = port & 0xff;
  return out;
}

/**
 * Pure Node.js L4 TCP stream balancer + Mixed HTTP/SOCKS5 bridge sitting on 127.0.0.1:<localPort>:
 * - Transparently accepts BOTH SOCKS5 and HTTP proxy (CONNECT / GET / POST ...) on the same port
 *   so Electron apps, Node.js, Python, Cursor, VS Code, Chrome, etc. all work seamlessly
 * - Zero protocol parsing overhead for SOCKS5 streams, TCP_NODELAY enabled on both legs
 * - Pauses client socket during upstream dial for lossless transparent failover on dead workers
 * - Least-Connections + RTT-aware dispatch + Make-Before-Break graceful draining
 */
export class LocalProxyBalancer {
  private server: net.Server | null = null;
  private listenPort: number | null = null;
  private mixedHttpBridge = true;
  private backends = new Map<string, BalancerBackendState>();
  private openSockets = new Set<net.Socket>();
  private totalBytesUp = 0;
  private totalBytesDown = 0;
  private onBackendDialError?: (backendId: string, err: Error) => void;

  constructor(options?: { onBackendDialError?: (backendId: string, err: Error) => void }) {
    this.onBackendDialError = options?.onBackendDialError;
  }

  public setMixedHttpBridge(enabled: boolean): void {
    this.mixedHttpBridge = enabled;
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
    clientSocket.setNoDelay(true);
    this.openSockets.add(clientSocket);

    const state = { closed: false };
    clientSocket.once('close', () => {
      state.closed = true;
      this.openSockets.delete(clientSocket);
    });
    clientSocket.on('error', () => {
      state.closed = true;
      clientSocket.destroy();
    });

    if (!this.mixedHttpBridge) {
      clientSocket.pause();
      this.pipeRawToBackend(clientSocket, state, null);
      return;
    }

    // Peek at the initial bytes to decide between raw SOCKS passthrough and HTTP->SOCKS5 bridge
    let headerBuf: Buffer = Buffer.alloc(0);
    clientSocket.setTimeout(15000);

    const cleanupPeek = () => {
      clientSocket.removeListener('data', onPeekData);
      clientSocket.removeListener('timeout', onPeekTimeout);
      clientSocket.setTimeout(0);
    };

    const onPeekTimeout = () => {
      cleanupPeek();
      if (!clientSocket.destroyed) clientSocket.destroy();
    };

    const onPeekData = (chunk: Buffer) => {
      headerBuf = headerBuf.length === 0 ? chunk : Buffer.concat([headerBuf, chunk]);

      // SOCKS5 (0x05) or SOCKS4 (0x04) or non-ASCII byte -> immediate zero-overhead raw pipe
      const firstByte = headerBuf[0];
      if (firstByte === 0x05 || firstByte === 0x04 || firstByte < 0x41 || firstByte > 0x5a) {
        cleanupPeek();
        clientSocket.pause();
        this.pipeRawToBackend(clientSocket, state, headerBuf);
        return;
      }

      // Check once we have enough bytes whether it's an HTTP proxy request
      if (headerBuf.length >= 8) {
        const prefix = headerBuf.subarray(0, 12).toString('ascii');
        if (!HTTP_METHOD_PREFIX_RE.test(prefix)) {
          cleanupPeek();
          clientSocket.pause();
          this.pipeRawToBackend(clientSocket, state, headerBuf);
          return;
        }
      }

      const headerEndIdx = headerBuf.indexOf('\r\n\r\n');
      if (headerEndIdx === -1) {
        if (headerBuf.length > MAX_HTTP_HEADER_BYTES) {
          cleanupPeek();
          clientSocket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n');
        }
        return;
      }

      cleanupPeek();
      clientSocket.pause();

      const headerRaw = headerBuf.subarray(0, headerEndIdx).toString('latin1');
      const trailingBytes = headerBuf.subarray(headerEndIdx + 4);
      this.bridgeHttpOverSocks5(clientSocket, state, headerRaw, trailingBytes);
    };

    clientSocket.on('data', onPeekData);
    clientSocket.once('timeout', onPeekTimeout);
  }

  private pipeRawToBackend(
    clientSocket: net.Socket,
    clientState: { closed: boolean },
    initialChunk: Buffer | null
  ): void {
    const tried = new Set<string>();

    const tryNextBackend = () => {
      if (clientState.closed || clientSocket.destroyed) return;

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
        if (clientState.closed || clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        connected = true;
        upstream.setTimeout(0);
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

        if (initialChunk && initialChunk.length > 0) {
          this.totalBytesUp += initialChunk.length;
          upstream.write(initialChunk);
        }

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

  private bridgeHttpOverSocks5(
    clientSocket: net.Socket,
    clientState: { closed: boolean },
    headerRaw: string,
    trailingBytes: Buffer
  ): void {
    const lines = headerRaw.split('\r\n');
    const requestLine = lines[0] || '';
    const reqMatch = requestLine.match(/^([A-Z]+)\s+(\S+)\s+(HTTP\/\d\.\d)$/i);
    if (!reqMatch) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const method = reqMatch[1].toUpperCase();
    const target = reqMatch[2];
    const httpVersion = reqMatch[3];
    const isConnect = method === 'CONNECT';

    let targetHost = '';
    let targetPort = isConnect ? 443 : 80;
    let rewrittenHeaderBuf: Buffer | null = null;

    if (isConnect) {
      const parsed = parseHostPort(target, 443);
      if (!parsed) {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      targetHost = parsed.host;
      targetPort = parsed.port;
    } else {
      let originPath = target;
      let parsedHost: { host: string; port: number } | null = null;
      if (/^https?:\/\//i.test(target)) {
        try {
          const u = new URL(target);
          parsedHost = {
            host: u.hostname,
            port: u.port ? Number.parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80,
          };
          originPath = `${u.pathname || '/'}${u.search || ''}`;
        } catch {
          clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
      } else {
        const hostHeader = lines.find((l) => /^host\s*:/i.test(l));
        if (hostHeader) {
          parsedHost = parseHostPort(hostHeader.slice(hostHeader.indexOf(':') + 1), 80);
        }
      }
      if (!parsedHost) {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      targetHost = parsedHost.host;
      targetPort = parsedHost.port;

      const filteredHeaders = lines
        .slice(1)
        .filter((l) => !/^proxy-connection\s*:/i.test(l) && !/^proxy-authorization\s*:/i.test(l));
      rewrittenHeaderBuf = Buffer.from(
        [`${method} ${originPath} ${httpVersion}`, ...filteredHeaders, '', ''].join('\r\n'),
        'latin1'
      );
    }

    const tried = new Set<string>();

    const tryNextBackend = () => {
      if (clientState.closed || clientSocket.destroyed) return;

      const backend = this.selectBackend(tried);
      if (!backend) {
        if (!clientSocket.destroyed) {
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        }
        return;
      }
      tried.add(backend.id);

      const upstream = new net.Socket();
      upstream.setNoDelay(true);
      upstream.setTimeout(10000);
      this.openSockets.add(upstream);

      let tcpConnected = false;
      let bridged = false;
      let accounted = false;
      let handshakeStage: 'greeting' | 'connect' = 'greeting';
      let hsBuf: Buffer = Buffer.alloc(0);

      const releaseAccounting = () => {
        if (accounted) {
          accounted = false;
          backend.activeConnections = Math.max(0, backend.activeConnections - 1);
        }
        this.openSockets.delete(upstream);
      };

      const onHandshakeData = (chunk: Buffer) => {
        hsBuf = hsBuf.length === 0 ? chunk : Buffer.concat([hsBuf, chunk]);

        if (handshakeStage === 'greeting') {
          if (hsBuf.length < 2) return;
          const ver = hsBuf[0];
          const authMethod = hsBuf[1];
          hsBuf = hsBuf.subarray(2);
          if (ver !== 0x05 || authMethod !== 0x00) {
            upstream.destroy(new Error('SOCKS5 后端握手失败'));
            return;
          }
          handshakeStage = 'connect';
          upstream.write(buildSocks5ConnectPacket(targetHost, targetPort));
        }

        if (handshakeStage === 'connect') {
          if (hsBuf.length < 4) return;
          const ver = hsBuf[0];
          const rep = hsBuf[1];
          const atyp = hsBuf[3];
          if (ver !== 0x05) {
            upstream.destroy(new Error('SOCKS5 后端响应无效'));
            return;
          }

          let needed = 10;
          if (atyp === 0x01) {
            needed = 10;
          } else if (atyp === 0x04) {
            needed = 22;
          } else if (atyp === 0x03) {
            if (hsBuf.length < 5) return;
            needed = 4 + 1 + hsBuf[4] + 2;
          }
          if (hsBuf.length < needed) return;

          const extraDownstream = hsBuf.subarray(needed);
          upstream.removeListener('data', onHandshakeData);

          if (rep !== 0x00) {
            upstream.destroy();
            if (!clientSocket.destroyed) {
              clientSocket.end(
                'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
              );
            }
            return;
          }

          bridged = true;
          upstream.setTimeout(0);

          if (isConnect) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          } else if (rewrittenHeaderBuf) {
            this.totalBytesUp += rewrittenHeaderBuf.length;
            upstream.write(rewrittenHeaderBuf);
          }

          if (trailingBytes.length > 0) {
            this.totalBytesUp += trailingBytes.length;
            upstream.write(trailingBytes);
          }

          if (extraDownstream.length > 0) {
            this.totalBytesDown += extraDownstream.length;
            clientSocket.write(extraDownstream);
          }

          clientSocket.on('data', (c: Buffer) => {
            this.totalBytesUp += c.length;
          });
          upstream.on('data', (c: Buffer) => {
            this.totalBytesDown += c.length;
          });

          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
          clientSocket.resume();
        }
      };

      upstream.once('connect', () => {
        if (clientState.closed || clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        tcpConnected = true;
        backend.recentDialFailures = 0;
        backend.activeConnections += 1;
        backend.totalAssigned += 1;
        accounted = true;

        upstream.on('data', onHandshakeData);
        upstream.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      upstream.once('timeout', () => {
        if (!bridged) {
          upstream.destroy(new Error('HTTP->SOCKS5 代理隧道握手超时'));
        }
      });

      upstream.on('error', (err) => {
        releaseAccounting();
        if (!tcpConnected) {
          backend.recentDialFailures += 1;
          this.onBackendDialError?.(backend.id, err);
          tryNextBackend();
        } else if (!bridged && !clientSocket.destroyed) {
          clientSocket.end(
            'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          );
        } else if (!clientSocket.destroyed) {
          clientSocket.destroy();
        }
      });

      upstream.once('close', () => {
        releaseAccounting();
        if (bridged && !clientSocket.destroyed) {
          clientSocket.end();
        } else if (tcpConnected && !bridged && !clientSocket.destroyed) {
          clientSocket.end(
            'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          );
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
