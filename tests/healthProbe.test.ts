import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  probeLocalForwardHealth,
  probeQuicTunnelHealth,
  probeSocks5TunnelHealth,
} from '../src/main/clientA/healthProbe';

const servers: net.Server[] = [];

function startMockServer(onSocket: (socket: net.Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(onSocket);
    servers.push(srv);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to bind ephemeral port'));
      }
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop();
    if (!srv) continue;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('healthProbe', () => {
  it('succeeds when SOCKS5 tunnel replies REP=0x00 for Device B loopback sshPort', async () => {
    const port = await startMockServer((socket) => {
      let step = 0;
      socket.on('data', (chunk) => {
        if (step === 0 && chunk[0] === 0x05) {
          step = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        } else if (step === 1 && chunk[0] === 0x05 && chunk[1] === 0x01) {
          step = 2;
          // Standard IPv4 SOCKS5 reply with REP=0x00 (Succeeded)
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]));
        }
      });
    });

    const res = await probeSocks5TunnelHealth(port, 53622, 2000);
    expect(res.ok).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(1);
  });

  it('treats REP=0x05 (refused on B loopback) as healthy since Device B sshd replied over tunnel', async () => {
    const port = await startMockServer((socket) => {
      let step = 0;
      socket.on('data', () => {
        if (step === 0) {
          step = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        } else if (step === 1) {
          step = 2;
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
      });
    });

    const res = await probeSocks5TunnelHealth(port, 53622, 2000);
    expect(res.ok).toBe(true);
  });

  it('detects frozen/zombie SOCKS5 tunnel that completes local greeting but stalls on remote CONNECT', async () => {
    const port = await startMockServer((socket) => {
      let greeted = false;
      socket.on('data', () => {
        if (!greeted) {
          greeted = true;
          socket.write(Buffer.from([0x05, 0x00]));
          // Intentionally never reply to CONNECT -> simulates blackholed SSH TCP session
        }
      });
    });

    const res = await probeSocks5TunnelHealth(port, 53622, 250);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('超时');
  });

  it('probes localForward HTTP proxy (Clash/v2rayN) successfully', async () => {
    const port = await startMockServer((socket) => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      });
    });

    const res = await probeLocalForwardHealth(port, 2000);
    expect(res.ok).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(1);
  });

  it('falls back to SOCKS5 greeting probe for pure SOCKS5 localForward upstreams', async () => {
    const port = await startMockServer((socket) => {
      socket.once('data', (chunk) => {
        if (chunk[0] === 0x05) {
          socket.write(Buffer.from([0x05, 0x00]));
        } else {
          socket.destroy();
        }
      });
    });

    const res = await probeLocalForwardHealth(port, 2000);
    expect(res.ok).toBe(true);
  });

  it('measures genuine end-to-end RTT through fastOpen QUIC SOCKS5 instead of 0ms local CONNECT reply', async () => {
    const port = await startMockServer((socket) => {
      let step = 0;
      socket.on('data', (chunk) => {
        if (step === 0) {
          step = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        } else if (step === 1) {
          step = 2;
          // Simulate Hysteria 2 fastOpen: immediate 0ms local CONNECT success reply
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        } else if (step === 2 && chunk.toString('ascii').includes('SSH-2.0-')) {
          step = 3;
          // Simulate cross-border QUIC round-trip to Device B sshd banner (~45ms)
          setTimeout(() => {
            socket.write('SSH-2.0-OpenSSH_for_Windows_9.5\r\n');
          }, 45);
        }
      });
    });

    const res = await probeQuicTunnelHealth('socks5', port, 53622, 2000);
    expect(res.ok).toBe(true);
    expect(res.latencyMs).not.toBeNull();
    expect(res.latencyMs!).toBeGreaterThanOrEqual(35);
  });

  it('rejects dead fastOpen QUIC SOCKS5 session that closes immediately with 0 remote bytes', async () => {
    const port = await startMockServer((socket) => {
      let step = 0;
      socket.on('data', () => {
        if (step === 0) {
          step = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        } else if (step === 1) {
          step = 2;
          // Local fastOpen CONNECT ACK
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        } else if (step === 2) {
          // Simulate dead QUIC session: local proxy closes immediately without any remote banner
          socket.end();
        }
      });
    });

    const res = await probeQuicTunnelHealth('socks5', port, 53622, 2000);
    expect(res.ok).toBe(false);
    expect(res.latencyMs).toBeNull();
    expect(res.detail).toContain('未返回响应');
  });

  it('rejects dead fastOpen QUIC HTTP CONNECT session that closes immediately with 0 remote bytes', async () => {
    const port = await startMockServer((socket) => {
      let step = 0;
      socket.on('data', () => {
        if (step === 0) {
          step = 1;
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        } else if (step === 1) {
          socket.end();
        }
      });
    });

    const res = await probeQuicTunnelHealth('localForward', port, 53622, 2000);
    expect(res.ok).toBe(false);
    expect(res.latencyMs).toBeNull();
    expect(res.detail).toContain('未返回响应');
  });
});
