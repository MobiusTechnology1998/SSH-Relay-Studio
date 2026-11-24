import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { buildHysteriaServerYaml } from '../../shared/hysteriaConfig';
import type {
  ActionResult,
  QuicServerConfigInput,
  QuicServerStatus,
} from '../../shared/types';
import { logger } from '../logger';
import { inspectHysteriaBinary } from '../platform/binaryMgr';
import { generateSelfSignedTlsCert } from '../platform/selfSignedCert';
import { execCmd, IS_WINDOWS, runPowerShell } from '../platform/shell';
import { allowUdpFirewallPort } from './firewallMgr';

interface PersistedQuicServerState {
  udpPort: number;
  sni: string;
  authToken: string;
  obfsPassword: string;
  certPinSha256: string;
  maxUpMbps: number;
  maxDownMbps: number;
}

const TASK_NAME = 'SSHRelayStudio-QUIC';

class QuicServerManager {
  private child: ChildProcess | null = null;
  private lastError: string | null = null;

  private get workDir(): string {
    if (IS_WINDOWS) {
      return 'C:\\ProgramData\\SSHRelayStudio\\quic';
    }
    return path.join(app.getPath('userData'), 'quic-server');
  }

  private get statePath(): string {
    return path.join(this.workDir, 'state.json');
  }

  private get certPath(): string {
    return path.join(this.workDir, 'server.crt');
  }

  private get keyPath(): string {
    return path.join(this.workDir, 'server.key');
  }

  private get yamlPath(): string {
    return path.join(this.workDir, 'server.yaml');
  }

  private loadPersistedState(): PersistedQuicServerState | null {
    try {
      if (!fs.existsSync(this.statePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<PersistedQuicServerState>;
      if (!parsed.authToken || !parsed.certPinSha256) return null;
      return {
        udpPort: parsed.udpPort ?? 53623,
        sni: parsed.sni || 'www.bing.com',
        authToken: parsed.authToken,
        obfsPassword: parsed.obfsPassword || '',
        certPinSha256: parsed.certPinSha256,
        maxUpMbps: parsed.maxUpMbps ?? 200,
        maxDownMbps: parsed.maxDownMbps ?? 200,
      };
    } catch {
      return null;
    }
  }

  private savePersistedState(state: PersistedQuicServerState): void {
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  private async isStartupTaskConfigured(): Promise<boolean> {
    if (!IS_WINDOWS) return false;
    const res = await runPowerShell(
      `if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`,
      8000
    );
    return res.stdout.trim().includes('YES');
  }

  private async isExternalServerProcessRunning(): Promise<number | null> {
    if (this.child && this.child.pid && this.child.exitCode === null) {
      return this.child.pid;
    }
    if (!IS_WINDOWS) return null;
    const res = await runPowerShell(
      `$p = Get-CimInstance Win32_Process -Filter "Name='hysteria.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server*' } | Select-Object -First 1; if ($p) { $p.ProcessId }`,
      8000
    );
    const pid = Number.parseInt(res.stdout.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  public async getStatus(customBinaryPath?: string): Promise<QuicServerStatus> {
    const [bin, externalPid, startupTaskConfigured] = await Promise.all([
      inspectHysteriaBinary('serverB', customBinaryPath),
      this.isExternalServerProcessRunning(),
      this.isStartupTaskConfigured(),
    ]);

    const saved = this.loadPersistedState();
    const configured = Boolean(saved && fs.existsSync(this.yamlPath) && fs.existsSync(this.certPath));

    return {
      binaryInstalled: bin.installed,
      binaryPath: bin.path,
      binaryVersion: bin.version,
      configured,
      running: externalPid !== null,
      pid: externalPid,
      udpPort: saved?.udpPort ?? 53623,
      sni: saved?.sni ?? 'www.bing.com',
      authToken: saved?.authToken ?? '',
      obfsPassword: saved?.obfsPassword ?? '',
      certPinSha256: saved?.certPinSha256 ?? '',
      maxUpMbps: saved?.maxUpMbps ?? 200,
      maxDownMbps: saved?.maxDownMbps ?? 200,
      startupTaskConfigured,
      lastError: this.lastError,
    };
  }

  public async deployAndStart(
    cfg: QuicServerConfigInput,
    customBinaryPath?: string
  ): Promise<ActionResult<QuicServerStatus>> {
    const bin = await inspectHysteriaBinary('serverB', customBinaryPath);
    if (!bin.installed) {
      return {
        ok: false,
        message: '尚未安装 Hysteria 2 引擎，请先点击「一键下载 Hysteria 2」或「导入本地文件」。',
      };
    }

    if (!Number.isInteger(cfg.udpPort) || cfg.udpPort < 1 || cfg.udpPort > 65535) {
      return { ok: false, message: `无效 UDP 端口: ${cfg.udpPort}` };
    }

    await this.stop();
    this.lastError = null;

    fs.mkdirSync(this.workDir, { recursive: true });
    const existing = this.loadPersistedState();
    const cleanSni = (cfg.sni || 'www.bing.com').trim();

    let certPinSha256 = existing?.certPinSha256 || '';
    const needNewCert =
      !fs.existsSync(this.certPath) ||
      !fs.existsSync(this.keyPath) ||
      !certPinSha256 ||
      existing?.sni !== cleanSni;

    if (needNewCert) {
      const generated = generateSelfSignedTlsCert(cleanSni);
      fs.writeFileSync(this.certPath, generated.certPem, 'utf8');
      fs.writeFileSync(this.keyPath, generated.keyPem, { encoding: 'utf8', mode: 0o600 });
      certPinSha256 = generated.pinSha256;
      logger.info('serverB', `已生成 QUIC 自签名 TLS 1.3 证书 (SNI=${cleanSni}, SHA256=${certPinSha256})`);
    }

    const authToken =
      existing?.authToken || crypto.randomBytes(24).toString('base64url');
    const obfsPassword = cfg.enableObfs
      ? existing?.obfsPassword || crypto.randomBytes(16).toString('base64url')
      : '';

    const yaml = buildHysteriaServerYaml({
      udpPort: cfg.udpPort,
      certPath: this.certPath,
      keyPath: this.keyPath,
      authToken,
      obfsPassword,
      maxUpMbps: cfg.maxUpMbps,
      maxDownMbps: cfg.maxDownMbps,
    });
    fs.writeFileSync(this.yamlPath, yaml, 'utf8');

    const persisted: PersistedQuicServerState = {
      udpPort: cfg.udpPort,
      sni: cleanSni,
      authToken,
      obfsPassword,
      certPinSha256,
      maxUpMbps: cfg.maxUpMbps,
      maxDownMbps: cfg.maxDownMbps,
    };
    this.savePersistedState(persisted);

    if (IS_WINDOWS) {
      const fwRes = await allowUdpFirewallPort(cfg.udpPort);
      if (!fwRes.ok) {
        logger.warn('serverB', `放行 UDP 防火墙失败（继续尝试启动服务）: ${fwRes.message}`);
      }
    }

    // Spawn hysteria server
    try {
      const child = spawn(bin.path, ['server', '-c', this.yamlPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      let startupErr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim();
        if (line) logger.info('serverB', `[QUIC] ${line}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim();
        if (line) {
          startupErr = line;
          logger.warn('serverB', `[QUIC] ${line}`);
        }
      });

      child.once('exit', (code) => {
        if (this.child === child) {
          this.child = null;
          if (code !== 0 && code !== null) {
            this.lastError = startupErr || `Hysteria 2 服务端退出 (code=${code})`;
            logger.error('serverB', `QUIC 服务端异常退出: ${this.lastError}`);
          }
        }
      });

      // Wait briefly to confirm process didn't immediately crash on bind/config error
      await new Promise((r) => setTimeout(r, 1200));
      if (!this.child || this.child.exitCode !== null) {
        const msg = `Hysteria 2 服务端启动失败: ${startupErr || this.lastError || '进程提前退出'}`;
        this.lastError = msg;
        return { ok: false, message: msg, data: await this.getStatus(customBinaryPath) };
      }

      logger.success(
        'serverB',
        `QUIC (Hysteria 2) 服务端已启动！监听 UDP :${cfg.udpPort}（请在云安全组放行 UDP ${cfg.udpPort}）`
      );
      return {
        ok: true,
        message: `QUIC 服务端已启动（UDP :${cfg.udpPort}），已自动生成证书指纹并写入防火墙。请在云安全组放行 UDP ${cfg.udpPort} 后重新导出配对码！`,
        data: await this.getStatus(customBinaryPath),
      };
    } catch (err) {
      const msg = `启动 Hysteria 2 服务端失败: ${(err as Error).message}`;
      this.lastError = msg;
      logger.error('serverB', msg);
      return { ok: false, message: msg, data: await this.getStatus(customBinaryPath) };
    }
  }

  public async stop(): Promise<ActionResult> {
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
          // Ignore
        }
      }
    }

    // Also stop any background scheduled-task instance on Windows
    if (IS_WINDOWS) {
      await runPowerShell(
        `Get-CimInstance Win32_Process -Filter "Name='hysteria.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        8000
      );
    }

    logger.info('serverB', '已停止 QUIC (Hysteria 2) 服务端');
    return { ok: true, message: 'QUIC 服务端已停止' };
  }

  /**
   * Registers a Windows Scheduled Task running as SYSTEM on boot with automatic restart-on-failure
   * so the Hysteria 2 QUIC relay survives Device B reboots just like sshd.
   */
  public async configureStartupTask(customBinaryPath?: string): Promise<ActionResult<QuicServerStatus>> {
    if (!IS_WINDOWS) {
      return { ok: false, message: '仅支持在 Windows 设备 B 上注册开机自启计划任务' };
    }
    const bin = await inspectHysteriaBinary('serverB', customBinaryPath);
    if (!bin.installed || !fs.existsSync(this.yamlPath)) {
      return { ok: false, message: '请先部署并启动 QUIC 服务端，再配置开机自启任务' };
    }

    const psScript = `
      $ErrorActionPreference = 'Stop'
      $action = New-ScheduledTaskAction -Execute '${bin.path.replace(/'/g, "''")}' -Argument 'server -c "${this.yamlPath.replace(/'/g, "''")}"'
      $trigger = New-ScheduledTaskTrigger -AtStartup
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
      Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    `;

    const res = await runPowerShell(psScript, 15000);
    if (res.code !== 0) {
      const msg = `注册 QUIC 开机自启任务失败: ${res.stderr.trim() || res.stdout.trim()}`;
      logger.error('serverB', msg);
      return { ok: false, message: msg };
    }

    logger.success('serverB', `已注册 Windows 开机自启与崩溃自愈任务 (${TASK_NAME})`);
    return {
      ok: true,
      message: `已配置 QUIC 服务端开机自启与异常重启自愈（计划任务: ${TASK_NAME}）`,
      data: await this.getStatus(customBinaryPath),
    };
  }
}

export const quicServerMgr = new QuicServerManager();
