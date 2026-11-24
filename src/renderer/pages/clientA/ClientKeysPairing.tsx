import React, { useEffect, useState } from 'react';
import type {
  HostKeyScanResult,
  KeyPairInfo,
  NodeProfile,
  SecurityCheckResult,
} from '../../../shared/types';
import { IconCheck, IconCopy, IconKey, IconShield } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientKeysPairingProps {
  activeNode: NodeProfile | null;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

export const ClientKeysPairing: React.FC<ClientKeysPairingProps> = ({
  activeNode,
  onNotify,
}) => {
  const [keyInfo, setKeyInfo] = useState<KeyPairInfo | null>(null);
  const [hostTrusted, setHostTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanResult, setScanResult] = useState<HostKeyScanResult | null>(null);
  const [trustModalOpen, setTrustModalOpen] = useState(false);
  const [secResult, setSecResult] = useState<SecurityCheckResult | null>(null);

  const loadKeyInfo = async () => {
    const info = await window.relayApi.getKeyPairInfo(activeNode?.privateKeyPath);
    setKeyInfo(info);
  };

  const loadHostTrust = async () => {
    if (!activeNode?.host.trim()) {
      setHostTrusted(false);
      return;
    }
    const trusted = await window.relayApi.isHostKeyTrusted(activeNode.host, activeNode.sshPort);
    setHostTrusted(trusted);
  };

  useEffect(() => {
    loadKeyInfo();
  }, [activeNode?.privateKeyPath]);

  useEffect(() => {
    loadHostTrust();
  }, [activeNode?.host, activeNode?.sshPort]);

  const handleGenerateKey = async (force = false) => {
    setBusy(true);
    try {
      const res = await window.relayApi.generateKeyPair(force);
      if (res.data) setKeyInfo(res.data);
      onNotify(res.ok ? 'success' : 'error', res.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCopyPubKey = async () => {
    if (!keyInfo?.publicKey) return;
    await window.relayApi.copyText(keyInfo.publicKey);
    onNotify('success', '已复制设备 A 公钥，请粘贴到设备 B 首页第 1 步（或「设备公钥与连接」）');
  };

  const handleScanHostKey = async () => {
    if (!activeNode) {
      onNotify('warn', '请先在「节点管理」中选择或新建一个设备 B 节点');
      return;
    }
    setBusy(true);
    try {
      const res = await window.relayApi.scanHostKeys(activeNode.host, activeNode.sshPort);
      setScanResult(res);
      if (res.success && res.alreadyTrusted) {
        setHostTrusted(true);
      }
      if (!res.success) {
        onNotify('error', res.error || '扫描主机指纹失败');
      } else {
        setTrustModalOpen(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmTrust = async () => {
    if (!scanResult || !scanResult.entries.length) return;
    const res = await window.relayApi.trustHostKeys(
      scanResult.host,
      scanResult.port,
      scanResult.entries.map((e) => ({ keyType: e.keyType, keyData: e.keyData }))
    );
    setTrustModalOpen(false);
    if (res.ok) {
      setHostTrusted(true);
      setScanResult({ ...scanResult, alreadyTrusted: true });
    }
    onNotify(res.ok ? 'success' : 'error', res.message);
  };

  const handleRunSecurityCheck = async () => {
    if (!activeNode) {
      onNotify('warn', '请先配置活动节点');
      return;
    }
    setBusy(true);
    try {
      const res = await window.relayApi.runSecurityVerification(activeNode);
      setSecResult(res);
      if (res.tcpReachable && res.keyAuthPassed && res.passwordAuthDisabled) {
        onNotify('success', '全部安全加固检查通过！可以放心启动长期守护隧道。');
      } else {
        onNotify('warn', '部分安全检查未通过，请查看下方详细结果。');
      }
    } finally {
      setBusy(false);
    }
  };

  const scpFallbackCmd = activeNode
    ? `scp "$env:USERPROFILE\\.ssh\\id_ed25519.pub" ${activeNode.username}@${activeNode.host}:C:/ProgramData/ssh/administrators_authorized_keys`
    : 'scp "$env:USERPROFILE\\.ssh\\id_ed25519.pub" Administrator@<设备B的IP>:C:/ProgramData/ssh/administrators_authorized_keys';

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">密钥与免密配对</h1>
          <p className="page-desc">
            三步完成免密授权、主机指纹信任（解决 BatchMode 静默拒连）与安全加固验证
          </p>
        </div>
      </div>

      {/* Step 1: Ed25519 Keypair */}
      <div className="step-item">
        <div className={`step-num ${keyInfo?.exists ? 'done' : 'active'}`}>
          {keyInfo?.exists ? <IconCheck size={14} /> : '1'}
        </div>
        <div className="step-body">
          <div className="step-title">
            <IconKey size={16} />
            生成并复制设备 A 公钥（ed25519 无密码短语）
            <StatusBadge
              variant={keyInfo?.exists ? 'success' : 'warn'}
              label={keyInfo?.exists ? '密钥已就绪' : '尚未生成'}
            />
          </div>
          <p className="step-desc">
            自动生成空密码短语的 ed25519 密钥对以支持后台断线全自动重连。复制下方公钥粘贴到设备 B 首页第 1 步（或「设备公钥与连接」）中，B 端会自动追加并执行 ACL 权限收紧。
          </p>

          {keyInfo?.exists ? (
            <div className="stack-sm">
              <div className="row-wrap" style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                <span>私钥路径：<code className="mono">{keyInfo.privateKeyPath}</code></span>
                <span>指纹：<code className="mono">{keyInfo.fingerprint}</code></span>
              </div>
              <div className="code-block" style={{ fontSize: 11.8 }}>
                {keyInfo.publicKey}
              </div>
              <div className="row-wrap">
                <button className="btn btn-primary" onClick={handleCopyPubKey}>
                  <IconCopy size={15} />
                  复制公钥文本（推荐粘贴到设备 B 应用）
                </button>
                <button
                  className="btn"
                  onClick={() => handleGenerateKey(true)}
                  disabled={busy}
                >
                  重新生成密钥
                </button>
              </div>
              <details style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
                <summary style={{ cursor: 'pointer' }}>
                  备选：若设备 B 暂未安装本软件，查看传统 scp 首次上传命令
                </summary>
                <div className="code-block" style={{ marginTop: 8, fontSize: 11.5 }}>
                  {scpFallbackCmd}
                </div>
              </details>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => handleGenerateKey(false)}
              disabled={busy}
            >
              一键生成 ed25519 密钥对
            </button>
          )}
        </div>
      </div>

      {/* Step 2: Host Key Fingerprint Trust */}
      <div className="step-item">
        <div className={`step-num ${hostTrusted ? 'done' : 'active'}`}>
          {hostTrusted ? <IconCheck size={14} /> : '2'}
        </div>
        <div className="step-body">
          <div className="step-title">
            信任设备 B 主机指纹（避免更换高位端口后静默拒连）
            {activeNode && (
              <StatusBadge
                variant={hostTrusted ? 'success' : 'warn'}
                label={
                  hostTrusted
                    ? `已信任 ${activeNode.host}:${activeNode.sshPort}`
                    : `待信任 ${activeNode.host}:${activeNode.sshPort}`
                }
              />
            )}
          </div>
          <p className="step-desc">
            OpenSSH 将新端口（如 53622）视为首次连接的主机；若未将主机指纹写入{' '}
            <code className="mono">known_hosts</code>，后台守护进程（<code className="mono">BatchMode=yes</code>）会直接拒连。若你使用了设备 B 的配对码导入，则已自动完成信任。
          </p>
          <div className="row-wrap">
            {hostTrusted ? (
              <>
                <button className="btn" disabled>
                  ✓ 主机指纹已信任
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleScanHostKey}
                  disabled={busy || !activeNode}
                >
                  重新扫描更新
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleScanHostKey}
                disabled={busy || !activeNode}
              >
                {busy ? '扫描中...' : '扫描并信任设备 B 主机指纹'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Step 3: Security Hardening Check */}
      <div className="step-item">
        <div
          className={`step-num ${
            secResult?.keyAuthPassed && secResult?.passwordAuthDisabled ? 'done' : 'active'
          }`}
        >
          3
        </div>
        <div className="step-body">
          <div className="step-title">
            <IconShield size={16} />
            一键验证免密生效与密码登录已关闭
          </div>
          <p className="step-desc">
            自动执行两项核心校验：① 验证当前高位端口免密登录成功并读取设备 B 主机名；② 禁用公钥测试确认设备 B 彻底拒绝密码认证（返回 Permission denied (publickey)）。
          </p>

          <button
            className="btn btn-primary"
            onClick={handleRunSecurityCheck}
            disabled={busy || !activeNode}
          >
            {busy ? '正在检测...' : '运行双项安全校验'}
          </button>

          {secResult && (
            <div className="stack-sm" style={{ marginTop: 14 }}>
              <div
                className={`callout ${
                  secResult.tcpReachable ? 'callout-success' : 'callout-danger'
                }`}
              >
                <strong>1. TCP 端口可达性：</strong>
                {secResult.tcpDetail}
              </div>
              <div
                className={`callout ${
                  secResult.keyAuthPassed ? 'callout-success' : 'callout-danger'
                }`}
              >
                <strong>2. 公钥免密登录测试：</strong>
                {secResult.keyAuthDetail}
              </div>
              <div
                className={`callout ${
                  secResult.passwordAuthDisabled ? 'callout-success' : 'callout-warn'
                }`}
              >
                <strong>3. 关闭密码登录核验：</strong>
                {secResult.passwordAuthDetail}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Host Fingerprint Confirmation Modal */}
      <Modal
        open={trustModalOpen}
        title="确认并信任设备 B 主机指纹"
        subtitle={
          scanResult
            ? `目标主机：${scanResult.host}:${scanResult.port}（${
                scanResult.alreadyTrusted ? '已在 known_hosts 中' : '首次信任'
              }）`
            : ''
        }
        onClose={() => setTrustModalOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setTrustModalOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={handleConfirmTrust}>
              确认写入 known_hosts
            </button>
          </>
        }
      >
        {scanResult?.entries.map((entry, idx) => (
          <div key={idx} className="metric-tile">
            <div className="metric-label">{entry.keyType}</div>
            <div className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all', marginTop: 3 }}>
              {entry.fingerprint}
            </div>
          </div>
        ))}
      </Modal>
    </div>
  );
};
