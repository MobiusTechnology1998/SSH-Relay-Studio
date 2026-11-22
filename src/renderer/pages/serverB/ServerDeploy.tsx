import React, { useState } from 'react';
import type { ServerOverview } from '../../../shared/types';
import { IconCheck } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ServerDeployProps {
  overview: ServerOverview | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

export const ServerDeploy: React.FC<ServerDeployProps> = ({
  overview,
  onRefresh,
  onNotify,
}) => {
  const [busyStep, setBusyStep] = useState<number | null>(null);
  const [pubKeyInput, setPubKeyInput] = useState('');
  const [pubKeyLabel, setPubKeyLabel] = useState('Device-A');
  const [targetPort, setTargetPort] = useState<number>(
    overview?.config.port && overview.config.port !== 22 ? overview.config.port : 53622
  );
  const [verifiedOnA, setVerifiedOnA] = useState(false);

  const step1Done = Boolean(
    overview?.service.installed && overview.service.status === 'Running'
  );
  const step2Done = Boolean(
    overview &&
      overview.authorizedKeys.keys.length > 0 &&
      overview.authorizedKeys.permissionsValid
  );
  const step3Done = Boolean(
    overview &&
      overview.config.port !== 22 &&
      overview.config.pubkeyAuthentication &&
      !overview.config.passwordAuthentication
  );
  const port22StillEnabled = Boolean(
    overview?.firewallRules.some(
      (r) =>
        r.enabled &&
        (r.localPort.split(',').includes('22') || r.displayName === 'OpenSSH Server (sshd)')
    )
  );
  const step4Done = step3Done && !port22StillEnabled;
  const step5Done = Boolean(
    overview?.service.failureRecoveryConfigured && overview?.updatePolicy.autoRebootDisabled
  );

  const handleInstallSsh = async () => {
    setBusyStep(1);
    try {
      const res = await window.relayApi.installOpenSshServer();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusyStep(null);
    }
  };

  const handleAddKey = async () => {
    if (!pubKeyInput.trim()) {
      onNotify('warn', '请先粘贴从设备 A 复制的 ssh-ed25519 公钥文本');
      return;
    }
    setBusyStep(2);
    try {
      const res = await window.relayApi.addServerAuthorizedKey(pubKeyInput, pubKeyLabel);
      onNotify(res.ok ? 'success' : 'error', res.message);
      if (res.ok) setPubKeyInput('');
      await onRefresh();
    } finally {
      setBusyStep(null);
    }
  };

  const handleApplyHardening = async () => {
    if (!step2Done) {
      onNotify(
        'error',
        '防锁死拦截：请先完成第 2 步（至少授权 1 个设备 A 公钥且权限合规），再关闭密码登录！'
      );
      return;
    }
    setBusyStep(3);
    try {
      // 1. Allow new port in Windows Firewall FIRST so we never lock ourselves out
      const fwRes = await window.relayApi.allowFirewallPort(targetPort);
      if (!fwRes.ok) {
        onNotify('error', fwRes.message);
        return;
      }

      // 2. Update sshd_config with sshd -t syntax check & automatic rollback
      const cfgRes = await window.relayApi.applySshdConfig({
        port: targetPort,
        pubkeyAuthentication: true,
        passwordAuthentication: false,
        tcpKeepAlive: true,
        clientAliveInterval: 30,
        clientAliveCountMax: 3,
      });
      if (!cfgRes.ok) {
        onNotify('error', cfgRes.message);
        return;
      }

      // 3. Restart sshd service
      const restartRes = await window.relayApi.controlSshdService('restart');
      onNotify(
        restartRes.ok ? 'success' : 'error',
        restartRes.ok
          ? `已完成高位端口 TCP ${targetPort} 加固、放行防火墙并重启 sshd！请在云控制台安全组放行 TCP ${targetPort} 后到设备 A 验证。`
          : restartRes.message
      );
      await onRefresh();
    } finally {
      setBusyStep(null);
    }
  };

  const handleCleanupPort22 = async () => {
    setBusyStep(4);
    try {
      const res = await window.relayApi.disablePort22FirewallRule();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusyStep(null);
    }
  };

  const handleApplyStability = async () => {
    setBusyStep(5);
    try {
      const r1 = await window.relayApi.configureSshdFailureRecovery();
      const r2 = await window.relayApi.setDisableAutoReboot(true);
      if (r1.ok && r2.ok) {
        onNotify('success', '已完成 sshd 崩溃 5 秒自愈与禁止 Windows 自动重启配置！');
      } else {
        onNotify('error', `${r1.ok ? '' : r1.message} ${r2.ok ? '' : r2.message}`.trim());
      }
      await onRefresh();
    } finally {
      setBusyStep(null);
    }
  };

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">一键部署与防锁死向导</h1>
          <p className="page-desc">
            严格按照安全顺序执行：安装服务 → 授权公钥与 icacls → 放行新端口并禁密码 → A 端验证后再清理 22 端口 → 长期自愈加固
          </p>
        </div>
      </div>

      {/* Step 1 */}
      <div className="step-item">
        <div className={`step-num ${step1Done ? 'done' : 'active'}`}>
          {step1Done ? <IconCheck size={14} /> : '1'}
        </div>
        <div className="step-body">
          <div className="step-title">
            安装并启动 Windows 内置 OpenSSH Server
            <StatusBadge
              variant={step1Done ? 'success' : 'warn'}
              label={step1Done ? '已运行' : '待部署'}
            />
          </div>
          <p className="step-desc">
            自动查找并安装系统内置的 <code className="mono">OpenSSH.Server</code> 可选功能，启动{' '}
            <code className="mono">sshd</code> 服务并设为开机自动启动。
          </p>
          <button
            className="btn btn-primary"
            onClick={handleInstallSsh}
            disabled={busyStep !== null}
          >
            {busyStep === 1 ? '正在安装并启动（可能需要 1~2 分钟）...' : '一键安装并启动 OpenSSH Server'}
          </button>
        </div>
      </div>

      {/* Step 2 */}
      <div className="step-item">
        <div className={`step-num ${step2Done ? 'done' : 'active'}`}>
          {step2Done ? <IconCheck size={14} /> : '2'}
        </div>
        <div className="step-body">
          <div className="step-title">
            授权设备 A 公钥并自动收紧 icacls 权限
            <StatusBadge
              variant={step2Done ? 'success' : 'warn'}
              label={
                step2Done
                  ? `已授权 ${overview?.authorizedKeys.keys.length} 台且权限合规`
                  : '待授权公钥'
              }
            />
          </div>
          <p className="step-desc">
            将设备 A 生成的公钥粘贴到下方，程序会<strong>安全追加</strong>到{' '}
            <code className="mono">C:\ProgramData\ssh\administrators_authorized_keys</code>（不覆盖已有设备），并自动执行{' '}
            <code className="mono">icacls</code> 仅保留 Administrators 与 SYSTEM 权限。
          </p>
          <div className="stack-sm">
            <input
              className="input"
              style={{ maxWidth: 280 }}
              value={pubKeyLabel}
              onChange={(e) => setPubKeyLabel(e.target.value)}
              placeholder="设备备注名（如 Office-PC）"
            />
            <textarea
              className="textarea"
              rows={2}
              value={pubKeyInput}
              onChange={(e) => setPubKeyInput(e.target.value)}
              placeholder="在此粘贴设备 A 复制的 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... 公钥"
            />
            <div className="row-wrap">
              <button
                className="btn btn-primary"
                onClick={handleAddKey}
                disabled={busyStep !== null}
              >
                {busyStep === 2 ? '写入并收紧权限中...' : '追加公钥并自动执行 icacls'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Step 3 */}
      <div className="step-item">
        <div className={`step-num ${step3Done ? 'done' : 'active'}`}>
          {step3Done ? <IconCheck size={14} /> : '3'}
        </div>
        <div className="step-body">
          <div className="step-title">
            切换高位端口、关闭密码登录并放行防火墙（防锁死保护）
            <StatusBadge
              variant={step3Done ? 'success' : 'neutral'}
              label={step3Done ? `当前 TCP ${overview?.config.port}` : '待加固'}
            />
          </div>
          <p className="step-desc">
            本步骤自动执行：① 放行新端口 Windows 防火墙；② 备份并修改 <code className="mono">sshd_config</code>（保留末尾 Match Group administrators）；③ 运行{' '}
            <code className="mono">sshd.exe -t</code> 语法校验（失败自动回滚）；④ 重启 sshd。
          </p>

          <div className="row-wrap" style={{ marginBottom: 10 }}>
            <label className="field-label">目标高位端口：</label>
            <input
              className="input mono"
              type="number"
              style={{ width: 130 }}
              value={targetPort}
              onChange={(e) => setTargetPort(Number(e.target.value) || 53622)}
            />
            <button
              className="btn btn-primary"
              onClick={handleApplyHardening}
              disabled={busyStep !== null || !step2Done}
            >
              {busyStep === 3 ? '正在加固并校验...' : `一键加固至端口 ${targetPort} 并重启 sshd`}
            </button>
          </div>

          <div className="callout callout-accent">
            <strong>云平台安全组提醒（外部控制台）：</strong>
            请登录云服务器控制台 → 安全组 → 入方向规则，新增放行协议 <strong>TCP</strong>、端口{' '}
            <strong className="mono">{targetPort}</strong>、来源 IP 填 <strong className="mono">0.0.0.0/0</strong>（已禁用密码登录，可安全兼容设备 A 的动态 IP）。
          </div>
        </div>
      </div>

      {/* Step 4 */}
      <div className="step-item">
        <div className={`step-num ${step4Done ? 'done' : 'active'}`}>
          {step4Done ? <IconCheck size={14} /> : '4'}
        </div>
        <div className="step-body">
          <div className="step-title">
            A 端新端口验证通过后，精准清理旧 22 端口规则
            <StatusBadge
              variant={step4Done ? 'success' : 'neutral'}
              label={step4Done ? '已禁用 22 端口' : '待清理'}
            />
          </div>
          <p className="step-desc">
            务必先在设备 A 使用新端口 <code className="mono">{targetPort}</code> 完成指纹信任和免密登录校验后，再禁用旧 22 端口防火墙规则（精准禁用，绝不误删新端口规则），并同步删除云安全组中的 22 端口规则。
          </p>
          <div className="stack-sm">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={verifiedOnA}
                onChange={(e) => setVerifiedOnA(e.target.checked)}
              />
              <span>我已在设备 A 确认新端口免密登录成功，且保留了云控制台/RDP 管理通道</span>
            </label>
            <div>
              <button
                className="btn"
                onClick={handleCleanupPort22}
                disabled={busyStep !== null || !verifiedOnA}
              >
                {busyStep === 4 ? '处理中...' : '精准禁用本机旧 22 端口防火墙规则'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Step 5 */}
      <div className="step-item">
        <div className={`step-num ${step5Done ? 'done' : 'active'}`}>
          {step5Done ? <IconCheck size={14} /> : '5'}
        </div>
        <div className="step-body">
          <div className="step-title">
            长期稳定加固：sshd 崩溃 5 秒自愈 & 禁止自动更新重启
            <StatusBadge
              variant={step5Done ? 'success' : 'neutral'}
              label={step5Done ? '已完成' : '推荐开启'}
            />
          </div>
          <p className="step-desc">
            配置 <code className="mono">sc.exe failure sshd</code> 故障 5000ms 自动重启，并写入 Windows Update 策略（
            <code className="mono">AUOptions=2</code>、<code className="mono">NoAutoRebootWithLoggedOnUsers=1</code>）防止半夜自动更新重启打断隧道。
          </p>
          <button
            className="btn btn-primary"
            onClick={handleApplyStability}
            disabled={busyStep !== null}
          >
            {busyStep === 5 ? '正在应用策略...' : '一键应用长期稳定策略'}
          </button>
        </div>
      </div>
    </div>
  );
};
