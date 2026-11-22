import type { DiagnosticsResult, NodeProfile } from '../../shared/types';
import { logger } from '../logger';
import { execCmd, isLocalPortListening, IS_WINDOWS } from '../platform/shell';

export async function runTunnelDiagnostics(
  node: Pick<NodeProfile, 'mode' | 'localPort'>,
  targetUrl = 'https://chatgpt.com'
): Promise<DiagnosticsResult> {
  const listening = await isLocalPortListening(node.localPort);
  if (!listening) {
    return {
      localPortListening: false,
      localPortDetail: `127.0.0.1:${node.localPort} 未监听，请先启动隧道`,
      exitIp: null,
      exitIpDetail: '隧道未启动，跳过出口 IP 检测',
      targetSiteOk: false,
      targetSiteStatus: '未检测',
      targetSiteLatencyMs: null,
    };
  }

  const curlBin = IS_WINDOWS ? 'curl.exe' : 'curl';
  const proxyArgs =
    node.mode === 'localForward'
      ? ['--proxy', `http://127.0.0.1:${node.localPort}`]
      : ['--socks5-hostname', `127.0.0.1:${node.localPort}`];

  // 1. Check exit IP via api.ipify.org
  const ipRes = await execCmd(
    curlBin,
    ['-sS', '--max-time', '10', ...proxyArgs, 'https://api.ipify.org'],
    { timeoutMs: 12000 }
  );

  let exitIp: string | null = null;
  let exitIpDetail = '';
  if (ipRes.code === 0 && /^[0-9a-fA-F.:]+$/.test(ipRes.stdout.trim())) {
    exitIp = ipRes.stdout.trim();
    exitIpDetail = `出口公网 IP: ${exitIp}（应与设备 B 公网 IP 一致）`;
  } else {
    exitIpDetail = `获取出口 IP 失败: ${ipRes.stderr.trim() || ipRes.stdout.trim() || '连接超时'}`;
  }

  // 2. Check target site reachability (HEAD request)
  const start = Date.now();
  const siteRes = await execCmd(
    curlBin,
    [
      '-sS',
      '-o',
      IS_WINDOWS ? 'NUL' : '/dev/null',
      '-w',
      '%{http_code}',
      '-I',
      '--max-time',
      '12',
      ...proxyArgs,
      targetUrl,
    ],
    { timeoutMs: 15000 }
  );
  const latency = Date.now() - start;
  const statusCode = siteRes.stdout.trim();
  const numericCode = Number.parseInt(statusCode, 10);
  // Per ssh.md 5.5: 200 / 301 / 302 / 403 all prove the tunnel reaches target site successfully
  const targetSiteOk = siteRes.code === 0 && numericCode >= 200 && numericCode < 500;
  const targetSiteStatus = targetSiteOk
    ? `HTTP ${statusCode}（链路已打通）`
    : `访问失败: ${siteRes.stderr.trim() || statusCode || '超时'}`;

  logger.info(
    'clientA',
    `链路诊断完成 -> 本地监听:${listening}, 出口IP:${exitIp ?? '失败'}, 目标站(${targetUrl}):${targetSiteStatus}`
  );

  return {
    localPortListening: true,
    localPortDetail: `127.0.0.1:${node.localPort} 正常监听 (LISTENING)`,
    exitIp,
    exitIpDetail,
    targetSiteOk,
    targetSiteStatus,
    targetSiteLatencyMs: targetSiteOk ? latency : null,
  };
}
