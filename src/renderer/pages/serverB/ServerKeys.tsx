import React, { useState } from 'react';
import type { ServerOverview } from '../../../shared/types';
import { IconKey, IconShield } from '../../components/Icons';
import { StatusBadge } from '../../components/StatusBadge';

interface ServerKeysProps {
  overview: ServerOverview | null;
  onRefresh: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

export const ServerKeys: React.FC<ServerKeysProps> = ({
  overview,
  onRefresh,
  onNotify,
}) => {
  const [newKey, setNewKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const authState = overview?.authorizedKeys;

  const handleAdd = async () => {
    if (!newKey.trim()) {
      onNotify('warn', '请粘贴完整的设备 A 公钥文本');
      return;
    }
    setBusy(true);
    try {
      const res = await window.relayApi.addServerAuthorizedKey(newKey, label || undefined);
      onNotify(res.ok ? 'success' : 'error', res.message);
      if (res.ok) {
        setNewKey('');
        setLabel('');
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (keyData: string) => {
    setBusy(true);
    try {
      const res = await window.relayApi.removeServerAuthorizedKey(keyData);
      onNotify(res.ok ? 'info' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleTightenAcl = async () => {
    setBusy(true);
    try {
      const res = await window.relayApi.tightenServerKeyPermissions();
      onNotify(res.ok ? 'success' : 'error', res.message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">授权公钥与权限管理</h1>
          <p className="page-desc">
            管理 <code className="mono">{authState?.filePath ?? 'C:\\ProgramData\\ssh\\administrators_authorized_keys'}</code>，安全追加多台设备 A 公钥并确保 ACL 合规
          </p>
        </div>
      </div>

      {/* Add Key Card */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconKey size={16} />
              追加新的设备 A 公钥
            </h3>
            <p className="card-subtitle">
              不会覆盖已有设备的公钥；写入时强制使用无 BOM 的 UTF-8 编码并自动执行 icacls 权限收紧
            </p>
          </div>
        </div>

        <div className="field">
          <label className="field-label">设备备注（可选，将作为公钥末尾注释）</label>
          <input
            className="input"
            style={{ maxWidth: 320 }}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如：公司台式机-A"
          />
        </div>

        <div className="field">
          <label className="field-label">设备 A 公钥内容（id_ed25519.pub）</label>
          <textarea
            className="textarea"
            rows={3}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
          />
        </div>

        <div>
          <button className="btn btn-primary" onClick={handleAdd} disabled={busy}>
            {busy ? '正在保存...' : '追加公钥并自动收紧权限'}
          </button>
        </div>
      </div>

      {/* Authorized Key List */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">已授权设备列表 ({authState?.keys.length ?? 0})</h3>
          </div>
        </div>

        {authState && authState.keys.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>设备备注</th>
                  <th>算法</th>
                  <th>SHA256 指纹</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {authState.keys.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ fontWeight: 600 }}>{entry.comment}</td>
                    <td className="mono">{entry.keyType}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {entry.fingerprint}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => handleRemove(entry.keyData)}
                        disabled={busy}
                      >
                        移除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="callout">当前尚未授权任何设备 A 的公钥。</div>
        )}
      </div>

      {/* ACL Compliance Card */}
      <div className="card stack-sm">
        <div className="card-header" style={{ marginBottom: 4 }}>
          <div>
            <h3 className="card-title">
              <IconShield size={16} />
              administrators_authorized_keys 文件 ACL 权限校验
            </h3>
            <p className="card-subtitle">
              Windows OpenSSH 要求该文件仅包含 Administrators 与 SYSTEM 权限且移除继承，否则免密登录必然失败
            </p>
          </div>
          <div className="row-wrap">
            <StatusBadge
              variant={authState?.permissionsValid ? 'success' : 'warn'}
              label={authState?.permissionsValid ? 'ACL 合规' : '需收紧权限'}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={handleTightenAcl}
              disabled={busy || !authState?.exists}
            >
              一键执行 icacls 收紧权限
            </button>
          </div>
        </div>

        <div className="code-block" style={{ fontSize: 11.8 }}>
          {authState?.permissionsRaw || '尚未读取到权限信息'}
        </div>
      </div>
    </div>
  );
};
