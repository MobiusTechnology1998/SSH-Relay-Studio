import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findFreeLocalPort,
  LocalProxyBalancer,
  scoreBackend,
} from '../src/main/clientA/localProxyBalancer';

const servers: net.Server[] = [];
const balancers: LocalProxyBalancer[] = [];

function startEchoServer(tag: string): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        socket.write(`${tag}:${chunk.toString('utf8')}`);
      });
    });
    servers.push(srv);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        resolve({ server: srv, port: addr.port });
      } else {
        reject(new Error('Failed to bind echo server'));
      }
    });
  });
}

function sendAndReceive(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(payload);
    });
    sock.setTimeout(3000);
    let data = '';
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
      sock.end();
    });
    sock.once('end', () => resolve(data));
    sock.once('timeout', () => {
      sock.destroy();
      reject(new Error('Timeout'));
    });
    sock.once('error', reject);
  });
}

afterEach(async () => {
  while (balancers.length > 0) {
    const b = balancers.pop();
    if (b) await b.stop();
  }
  while (servers.length > 0) {
    const s = servers.pop();
    if (!s) continue;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('LocalProxyBalancer', () => {
  it('scores backends by least connections, lowest RTT, and failure penalty', () => {
    const fastIdle = scoreBackend({ activeConnections: 0, latencyMs: 60, recentDialFailures: 0 });
    const slowIdle = scoreBackend({ activeConnections: 0, latencyMs: 280, recentDialFailures: 0 });
    const busyFast = scoreBackend({ activeConnections: 3, latencyMs: 60, recentDialFailures: 0 });
    const degraded = scoreBackend({ activeConnections: 0, latencyMs: 60, recentDialFailures: 1 });

    expect(fastIdle).toBeLessThan(slowIdle);
    expect(slowIdle).toBeLessThan(busyFast);
    expect(fastIdle).toBeLessThan(degraded);
  });

  it('distributes concurrent TCP streams across healthy backends and tracks bytes accurately', async () => {
    const b1 = await startEchoServer('B1');
    const b2 = await startEchoServer('B2');
    const listenPort = await findFreeLocalPort();

    const balancer = new LocalProxyBalancer();
    balancers.push(balancer);
    await balancer.start(listenPort);

    balancer.upsertBackend({ id: 'w1', port: b1.port, healthy: true, latencyMs: 100 });
    balancer.upsertBackend({ id: 'w2', port: b2.port, healthy: true, latencyMs: 100 });

    const r1 = await sendAndReceive(listenPort, 'hello');
    const r2 = await sendAndReceive(listenPort, 'world');

    // Equal score tie-breaks by totalAssigned, so requests alternate cleanly across B1 and B2
    expect(new Set([r1, r2])).toEqual(new Set(['B1:hello', 'B2:world']));

    // Give sockets a tick to complete close events
    await new Promise((r) => setTimeout(r, 30));
    const stats = balancer.getStats();
    expect(stats.activeConnections).toBe(0);
    expect(stats.totalBytesUp).toBe(10); // 'hello' + 'world'
    expect(stats.totalBytesDown).toBe(16); // 'B1:hello' + 'B2:world'
  });

  it('losslessly fails over to a healthy backend if the chosen worker refuses connection', async () => {
    const deadPort = await findFreeLocalPort(); // Nothing listening here -> ECONNREFUSED
    const healthy = await startEchoServer('OK');
    const listenPort = await findFreeLocalPort();

    const failedIds: string[] = [];
    const balancer = new LocalProxyBalancer({
      onBackendDialError: (id) => failedIds.push(id),
    });
    balancers.push(balancer);
    await balancer.start(listenPort);

    // Dead worker has artificially lower latency so balancer tries it FIRST
    balancer.upsertBackend({ id: 'dead', port: deadPort, healthy: true, latencyMs: 10 });
    balancer.upsertBackend({ id: 'alive', port: healthy.port, healthy: true, latencyMs: 120 });

    const reply = await sendAndReceive(listenPort, 'ping');
    expect(reply).toBe('OK:ping');
    expect(failedIds).toContain('dead');
  });

  it('skips draining backends for new connections during Make-Before-Break rotation', async () => {
    const oldSrv = await startEchoServer('OLD');
    const newSrv = await startEchoServer('NEW');
    const listenPort = await findFreeLocalPort();

    const balancer = new LocalProxyBalancer();
    balancers.push(balancer);
    await balancer.start(listenPort);

    balancer.upsertBackend({ id: 'old', port: oldSrv.port, healthy: true, latencyMs: 50, draining: true });
    balancer.upsertBackend({ id: 'new', port: newSrv.port, healthy: true, latencyMs: 150, draining: false });

    const r1 = await sendAndReceive(listenPort, 'req1');
    const r2 = await sendAndReceive(listenPort, 'req2');
    expect(r1).toBe('NEW:req1');
    expect(r2).toBe('NEW:req2');
  });
});
