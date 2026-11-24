import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { parseOpenSshVersion } from '../../shared/hysteriaConfig';
import type { OpenSshVersionInfo } from '../../shared/types';

export const IS_WINDOWS = process.platform === 'win32';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function execCmd(
  file: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options?.timeoutMs ?? 30000,
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          return;
        }
        const exitCode =
          typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
            ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1)
            : 1;
        resolve({
          code: exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || err.message || ''),
        });
      }
    );
  });
}

/**
 * Runs a PowerShell script safely using UTF-16LE Base64 -EncodedCommand and forces UTF-8 console output.
 * Prevents quoting/escaping bugs and GBK garbled output on Chinese Windows systems.
 */
export async function runPowerShell(
  script: string,
  timeoutMs = 30000
): Promise<ExecResult> {
  if (!IS_WINDOWS) {
    return {
      code: 1,
      stdout: '',
      stderr: '当前运行环境不是 Windows，无法执行 PowerShell 系统管理命令。',
    };
  }

  const wrapped = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    script,
  ].join('\n');

  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return execCmd(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeoutMs }
  );
}

let customOpenSshDir = '';

export function setCustomOpenSshDir(dir?: string): void {
  customOpenSshDir = (dir || '').trim();
}

/**
 * Resolves the OpenSSH binary path on Windows with smart priority:
 * 1. User-configured custom Win32-OpenSSH directory (e.g. portable v9.8+)
 * 2. Official Microsoft Win32-OpenSSH MSI install (`C:\Program Files\OpenSSH\<name>.exe`)
 * 3. Built-in Windows OpenSSH (`C:\Windows\System32\OpenSSH\<name>.exe`)
 */
export function resolveOpenSshBinary(name: 'ssh' | 'ssh-keygen' | 'ssh-keyscan' | 'scp' | 'sshd'): string {
  const exeName = IS_WINDOWS ? `${name}.exe` : name;

  if (customOpenSshDir) {
    const customCandidate = path.join(customOpenSshDir, exeName);
    if (fs.existsSync(customCandidate)) {
      return customCandidate;
    }
  }

  if (!IS_WINDOWS) {
    return name;
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const modernWin32Candidate = path.join(programFiles, 'OpenSSH', exeName);
  if (fs.existsSync(modernWin32Candidate)) {
    return modernWin32Candidate;
  }

  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const builtinCandidate = path.join(sysRoot, 'System32', 'OpenSSH', exeName);
  if (fs.existsSync(builtinCandidate)) {
    return builtinCandidate;
  }

  return exeName;
}

/**
 * Queries OpenSSH binary version (`ssh -V` / `sshd -V`, which prints to stderr).
 */
export async function detectOpenSshVersion(
  binary: 'ssh' | 'sshd' = 'ssh'
): Promise<OpenSshVersionInfo> {
  const binPath = resolveOpenSshBinary(binary);
  const res = await execCmd(binPath, ['-V'], { timeoutMs: 5000 });
  const combined = `${res.stderr}\n${res.stdout}`.trim();
  return parseOpenSshVersion(combined);
}

/**
 * Computes an OpenSSH-compatible SHA256 fingerprint from the base64 key blob.
 */
export function sha256FingerprintFromBase64(base64KeyData: string): string {
  try {
    const raw = Buffer.from(base64KeyData, 'base64');
    const digest = crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
    return `SHA256:${digest}`;
  } catch {
    return 'SHA256:unknown';
  }
}

/**
 * Tests TCP reachability to host:port using Node.js net.Socket.
 */
export function testTcpConnection(
  host: string,
  port: number,
  timeoutMs = 5000
): Promise<{ reachable: boolean; latencyMs: number | null; detail: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable,
        latencyMs: reachable ? Date.now() - start : null,
        detail,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, `TCP 连通成功 (${Date.now() - start}ms)`));
    socket.once('timeout', () => finish(false, `连接超时 (${timeoutMs}ms)`));
    socket.once('error', (err) => finish(false, `TCP 连接失败: ${err.message}`));
    socket.connect(port, host);
  });
}

/**
 * Checks whether a local port on 127.0.0.1 is currently listening.
 */
export async function isLocalPortListening(port: number): Promise<boolean> {
  const res = await testTcpConnection('127.0.0.1', port, 1200);
  return res.reachable;
}
