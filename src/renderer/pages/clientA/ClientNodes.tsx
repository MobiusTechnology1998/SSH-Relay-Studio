import React, { useState } from 'react';
import { formatSshCommandPreview } from '../../../shared/commandBuilders';
import { decodePairingToken } from '../../../shared/pairingCodec';
import type { AppSettings, NodeProfile } from '../../../shared/types';
import { Modal } from '../../components/Modal';
import { StatusBadge } from '../../components/StatusBadge';

interface ClientNodesProps {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'warn' | 'info', msg: string) => void;
}

function createEmptyNode(): NodeProfile {
  return {
    id: `node-${Date.now()}`,
    name: '设备 B 中转节点',
    host: '',
    sshPort: 53622,
    username: 'Administrator',
    mode: 'socks5',
    localPort: 1080,
    remoteProxyPort: 7890,
    privateKeyPath: '',
    notes: '',
  };
}

export const ClientNodes: React.FC<ClientNodesProps> = ({
  settings,
  onUpdateSettings,
  onNotify,
}) => {
  const [editing, setEditing] = useState<NodeProfile | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pairingInput, setPairingInput] = useState('');

  const handleSaveNode = async () => {
    if (!editing) return;
    if (!editing.host.trim()) {
      onNotify('error', '请填写设备 B 的 IP 或域名');
      return;
    }
    if (editing.sshPort < 1 || editing.sshPort > 65535) {
      onNotify('error', 'SSH 端口必须在 1-65535 之间');
      return;
    }
    if (editing.localPort < 1024 || editing.localPort > 65535) {
      onNotify('error', '本地代理端口建议设置在 1024-65535 之间');
      return;
    }

    const exists = settings.nodes.some((n) => n.id === editing.id);
    const nextNodes = exists
      ? settings.nodes.map((n) => (n.id === editing.id ? editing : n))
      : [...settings.nodes, editing];

    await onUpdateSettings({
      nodes: nextNodes,
      activeNodeId: settings.activeNodeId ?? editing.id,
    });
    setEditing(null);
    onNotify('success', `节点「${editing.name}」已保存`);
  };

  const handleDeleteNode = async (id: string) => {
    const nextNodes = settings.nodes.filter((n) => n.id !== id);
    const nextActive =
      settings.activeNodeId === id ? (nextNodes[0]?.id ?? null) : settings.activeNodeId;
    await onUpdateSettings({ nodes: nextNodes, activeNodeId: nextActive });
    onNotify('info', '已删除该节点');
  };

  const handleImportPairing = async () => {
    try {
      const payload = decodePairingToken(pairingInput);
      const newNode: NodeProfile = {
        id: `node-${Date.now()}`,
        name: payload.name,
        host: payload.host,
        sshPort: payload.sshPort,
        username: payload.username,
        mode: 'socks5',
        localPort: 1080,
        remoteProxyPort: 7890,
        privateKeyPath: '',
        expectedHostKey: payload.hostPublicKey,
      };

      // If pairing code embeds Device B's host public key, trust it automatically into known_hosts!
      if (payload.hostPublicKey) {
        const parts = payload.hostPublicKey.trim().split(/\s+/);
        if (parts.length >= 2) {
          await window.relayApi.trustHostKeys(payload.host, payload.sshPort, [
            { keyType: parts[0], keyData: parts[1] },
          ]);
        }
      }

      const nextNodes = [...settings.nodes, newNode];
      await onUpdateSettings({
        nodes: nextNodes,
        activeNodeId: newNode.id,
      });
      setImportOpen(false);
      setPairingInput('');
      onNotify(
        'success',
        payload.hostPublicKey
          ? `已导入节点「${newNode.name}」并自动写入主机指纹信任！`
          : `已导入节点「${newNode.name}」`
      );
    } catch (err) {
      onNotify('error', (err as Error).message);
    }
  };

  const handlePickKeyFile = async () => {
    if (!editing) return;
    const picked = await window.relayApi.selectFile('选择 SSH 私钥文件');
    if (picked) {
      setEditing({ ...editing, privateKeyPath: picked });
    }
  };

  return (
    <div className="stack-md">
      <div className="page-header">
        <div>
          <h1 className="page-title">中转节点管理</h1>
          <p className="page-desc">
            管理一个或多个设备 B 中转端配置，支持标准 SOCKS5 动态隧道与 B 端上游代理转发模式
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setImportOpen(true)}>
            导入设备 B 配对码
          </button>
          <button className="btn btn-primary" onClick={() => setEditing(createEmptyNode())}>
            + 新建节点
          </button>
        </div>
      </div>

      {settings.nodes.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '42px 24px' }}>
          <h3 style={{ margin: '0 0 8px' }}>尚未添加中转节点</h3>
          <p className="card-subtitle" style={{ marginBottom: 18 }}>
            可在设备 B 的仪表盘点击「生成配对码」后粘贴导入，或点击下方手动填写设备 B 的 IP 和高位端口。
          </p>
          <div className="row-wrap" style={{ justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
              粘贴设备 B 配对码导入
            </button>
            <button className="btn" onClick={() => setEditing(createEmptyNode())}>
              手动创建节点
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-sm">
          {settings.nodes.map((node) => {
            const isSelected = settings.activeNodeId === node.id;
            return (
              <div key={node.id} className={`node-card ${isSelected ? 'selected' : ''}`}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-wrap" style={{ gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: 15 }}>{node.name}</strong>
                    {isSelected && <StatusBadge variant="accent" label="当前使用" />}
                    <StatusBadge
                      variant="neutral"
                      dot={false}
                      label={
                        node.mode === 'socks5'
                          ? `SOCKS5 :${node.localPort}`
                          : `端口转发 :${node.localPort} → B:${node.remoteProxyPort}`
                      }
                    />
                  </div>
                  <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    {node.username}@{node.host}:{node.sshPort}
                  </div>
                </div>
                <div className="row-wrap">
                  {!isSelected && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => onUpdateSettings({ activeNodeId: node.id })}
                    >
                      设为活动
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => setEditing({ ...node })}>
                    编辑
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => handleDeleteNode(node.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Node Edit Modal */}
      <Modal
        open={Boolean(editing)}
        title={editing && settings.nodes.some((n) => n.id === editing.id) ? '编辑中转节点' : '新建中转节点'}
        subtitle="所有参数均会自动校验空格与格式，避免手工编写脚本出错"
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={handleSaveNode}>
              保存节点
            </button>
          </>
        }
      >
        {editing && (
          <>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">节点名称</label>
                <input
                  className="input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如：新加坡中转服务器"
                />
              </div>
              <div className="field">
                <label className="field-label">设备 B 用户名</label>
                <input
                  className="input mono"
                  value={editing.username}
                  onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                  placeholder="Administrator"
                />
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label className="field-label">设备 B IP 或域名</label>
                <input
                  className="input mono"
                  value={editing.host}
                  onChange={(e) => setEditing({ ...editing, host: e.target.value })}
                  placeholder="203.0.113.10"
                />
              </div>
              <div className="field">
                <label className="field-label">SSH 高位端口</label>
                <input
                  className="input mono"
                  type="number"
                  value={editing.sshPort}
                  onChange={(e) =>
                    setEditing({ ...editing, sshPort: Number(e.target.value) || 22 })
                  }
                />
              </div>
            </div>

            <div className="field">
              <label className="field-label">隧道转发模式</label>
              <select
                className="select"
                value={editing.mode}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    mode: e.target.value as NodeProfile['mode'],
                    localPort: e.target.value === 'localForward' ? 7890 : 1080,
                  })
                }
              >
                <option value="socks5">
                  标准 SOCKS5 动态加密隧道（ssh -D，推荐：设备 B 可直连外网）
                </option>
                <option value="localForward">
                  本地端口转发（ssh -L，适用于设备 B 依赖 Clash/v2rayN 才能出网）
                </option>
              </select>
            </div>

            <div className="grid-2">
              <div className="field">
                <label className="field-label">设备 A 本地监听端口</label>
                <input
                  className="input mono"
                  type="number"
                  value={editing.localPort}
                  onChange={(e) =>
                    setEditing({ ...editing, localPort: Number(e.target.value) || 1080 })
                  }
                />
                <span className="field-hint">仅监听 127.0.0.1，不对外暴露</span>
              </div>
              {editing.mode === 'localForward' && (
                <div className="field">
                  <label className="field-label">设备 B 本地代理端口</label>
                  <input
                    className="input mono"
                    type="number"
                    value={editing.remoteProxyPort}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        remoteProxyPort: Number(e.target.value) || 7890,
                      })
                    }
                  />
                  <span className="field-hint">如 Clash 默认 7890 / v2rayN 10809</span>
                </div>
              )}
            </div>

            <div className="field">
              <label className="field-label">自定义私钥路径（留空则使用默认 ~/.ssh/id_ed25519）</label>
              <div className="row-wrap" style={{ flexWrap: 'nowrap' }}>
                <input
                  className="input mono"
                  value={editing.privateKeyPath}
                  onChange={(e) => setEditing({ ...editing, privateKeyPath: e.target.value })}
                  placeholder="默认 ~/.ssh/id_ed25519"
                />
                <button className="btn" type="button" onClick={handlePickKeyFile}>
                  浏览
                </button>
              </div>
            </div>

            {editing.host.trim() && (
              <div className="field">
                <label className="field-label">将执行的 SSH 命令预览</label>
                <div className="code-block" style={{ fontSize: 11.5 }}>
                  {formatSshCommandPreview(editing)}
                </div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Pairing Code Import Modal */}
      <Modal
        open={importOpen}
        title="导入设备 B 配对码"
        subtitle="粘贴从设备 B 控制台导出的 SSHR1:... 配对码，将自动填充主机、端口、用户名及主机公钥指纹"
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={handleImportPairing}>
              解析并导入节点
            </button>
          </>
        }
      >
        <textarea
          className="textarea"
          rows={4}
          value={pairingInput}
          onChange={(e) => setPairingInput(e.target.value)}
          placeholder="SSHR1:eyJ2ZXJzaW9uIjoxLC..."
        />
      </Modal>
    </div>
  );
};
