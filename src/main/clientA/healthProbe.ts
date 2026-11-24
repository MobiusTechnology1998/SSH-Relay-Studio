import net from 'net';
import type { TunnelMode } from '../../shared/types';

export interface TunnelHealthProbeResult {
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

/**
 * Probes an OpenSSH dynamic SOCKS5 tunnel (`ssh -D 127.0.0.1:<localPort>`) end-to-end
 * without relying on external internet sites or DNS:
 * 1. Performs a local SOCKS5 NO-AUTH greeting against 127.0.0.1:<localPort>.
 * 2. Sends SOCKS5 CONNECT to Device B's own loopback SSH port (`127.0.0.1:<remoteSshPort>`).
 * 3. Waits for the SOCKS5 reply header (`0x05 <REP>`). Because ssh.exe cannot emit the
 *    CONNECT reply until sshd on Device B responds over the encrypted channel, receiving
 *    REP=0x00 (succeeded) or REP=0x05 (refused on B loopback) mathematically proves
 *    end-to-end tunnel liveness and measures true A<->B tunnel RTT.
 */
export function probeSocks5TunnelHealth(
  localPort: number,
  remoteSshPort: number,
  timeoutMs = 8000
): Promise<TunnelHealthProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let stage: 'greeting' | 'connect' = 'greeting';
    let rttStart = Date.now();
    let recvBuf = Buffer.alloc(0);

    const finish = (ok: boolean, latencyMs: number | null, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs, detail });
    };

    socket.setTimeout(timeoutMs);

    socket.once('timeout', () => {
      finish(false, null, `SOCKS5 端到端探活超时 (${timeoutMs}ms，隧道可能已假死)`);
    });

    socket.once('error', (err) => {
      finish(false, null, `SOCKS5 探活连接异常: ${err.message}`);
    });

    socket.once('close', () => {
      if (!settled) {
        finish(false, null, 'SOCKS5 探活连接在返回响应前关闭');
      }
    });

    socket.on('data', (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);

      if (stage === 'greeting') {
        if (recvBuf.length < 2) return;
        const ver = recvBuf[0];
        const method = recvBuf[1];
        recvBuf = recvBuf.subarray(2);

        if (ver !== 0x05 || method !== 0x00) {
          finish(false, null, `SOCKS5 握手异常 (ver=${ver}, method=${method})`);
          return;
        }

        stage = 'connect';
        rttStart = Date.now();
        const safePort = Math.max(1, Math.min(65535, remoteSshPort));
        const connectReq = Buffer.from([
          0x05, // VER
          0x01, // CMD = CONNECT
          0x00, // RSV
          0x01, // ATYP = IPv4
          127,
          0,
          0,
          1, // 127.0.0.1 on Device B
          (safePort >> 8) & 0xff,
          safePort & 0xff,
        ]);
        socket.write(connectReq);
      }

      if (stage === 'connect' && recvBuf.length >= 4) {
        const ver = recvBuf[0];
        const rep = recvBuf[1];
        const latencyMs = Math.max(1, Date.now() - rttStart);

        if (ver !== 0x05) {
          finish(false, null, `SOCKS5 响应格式异常 (ver=${ver})`);
          return;
        }

        // REP 0x00 (succeeded) or 0x05 (connection refused on B loopback) both confirm
        // Device B sshd processed our channel open and replied over the live tunnel.
        if (rep === 0x00 || rep === 0x05) {
          finish(true, latencyMs, `端到端探活正常 (${latencyMs}ms)`);
        } else {
          finish(false, null, `SOCKS5 远端通道返回错误码 0x${rep.toString(16).padStart(2, '0')}`);
        }
      }
    });

    socket.connect(localPort, '127.0.0.1', () => {
      // Send SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=NO_AUTH(0)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

function probeLocalForwardWithPayload(
  localPort: number,
  payload: Buffer,
  validateReply: (buf: Buffer) => boolean,
  timeoutMs: number
): Promise<TunnelHealthProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let rttStart = Date.now();
    let recvBuf = Buffer.alloc(0);

    const finish = (ok: boolean, latencyMs: number | null, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs, detail });
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      finish(false, null, `本地转发探活超时 (${timeoutMs}ms)`);
    });
    socket.once('error', (err) => {
      finish(false, null, `本地转发探活错误: ${err.message}`);
    });
    socket.once('close', () => {
      if (!settled) {
        finish(false, null, '本地转发上游无响应即断开');
      }
    });

    socket.on('data', (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      if (validateReply(recvBuf)) {
        const latencyMs = Math.max(1, Date.now() - rttStart);
        finish(true, latencyMs, `本地转发探活正常 (${latencyMs}ms)`);
      } else if (recvBuf.length >= 64) {
        finish(false, null, '本地转发上游返回了未识别的协议响应');
      }
    });

    socket.connect(localPort, '127.0.0.1', () => {
      rttStart = Date.now();
      socket.write(payload);
    });
  });
}

/**
 * Probes an OpenSSH local port forward (`ssh -L`) to Device B's upstream proxy (e.g. Clash/v2rayN).
 * First probes HTTP (works for Clash mixed-port and v2rayN HTTP), then falls back to a SOCKS5
 * greeting probe (works if Device B's upstream port is pure SOCKS5).
 */
export async function probeLocalForwardHealth(
  localPort: number,
  timeoutMs = 8000
): Promise<TunnelHealthProbeResult> {
  const httpPayload = Buffer.from(
    'HEAD / HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
    'ascii'
  );
  const httpRes = await probeLocalForwardWithPayload(
    localPort,
    httpPayload,
    (buf) => buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === 'HTTP/',
    Math.min(timeoutMs, 6000)
  );
  if (httpRes.ok) {
    return httpRes;
  }

  // Fallback for pure SOCKS5 upstream ports (e.g. v2rayN 10808)
  const socksRes = await probeLocalForwardWithPayload(
    localPort,
    Buffer.from([0x05, 0x01, 0x00]),
    (buf) => buf.length >= 2 && buf[0] === 0x05,
    Math.min(timeoutMs, 4000)
  );
  return socksRes.ok ? socksRes : httpRes;
}

export function probeTunnelHealth(
  mode: TunnelMode,
  localPort: number,
  remoteSshPort: number,
  timeoutMs = 8000
): Promise<TunnelHealthProbeResult> {
  if (mode === 'localForward') {
    return probeLocalForwardHealth(localPort, timeoutMs);
  }
  return probeSocks5TunnelHealth(localPort, remoteSshPort, timeoutMs);
}
