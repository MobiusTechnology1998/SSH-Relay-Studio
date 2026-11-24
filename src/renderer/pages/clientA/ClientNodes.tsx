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
    compression: false,
    serverAliveInterval: 15,
    serverAliveCountMax: 3,
    forceIpv4: true,
    preferFastCipher: true,
    healthCheckEnabled: true,
    healthCheckIntervalSec: 25,
    poolSize: 3,
    rotationIntervalMin: 0,
    engine: 'openssh',
    autoFallbackToSsh: true,
    quicUdpPort: 53623,
    quicSni: 'www.bing.com',
    quicUpMbps: 50,
    quicDownMbps: 200,
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
      const hasQuic = Boolean(payload.quic);
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
        poolSize: 3,
        forceIpv4: true,
        preferFastCipher: true,
        healthCheckEnabled: true,
        healthCheckIntervalSec: 25,
        engine: hasQuic ? 'hysteria2' : 'openssh',
        autoFallbackToSsh: true,
        quicUdpPort: payload.quic?.udpPort ?? 53623,
        quicAuthToken: payload.quic?.authToken,
        quicCertPinSha256: payload.quic?.certPinSha256,
        quicSni: payload.quic?.sni ?? 'www.bing.com',
        quicObfsPassword: payload.quic?.obfsPassword,
        quicUpMbps: 50,
        quicDownMbps: 200,
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
        hasQuic
          ? `已导入节点「${newNode.name}」，自动启用 QUIC (Hysteria 2) 跨国加速（并已信任 SSH 指纹用于自动容灾回退）！`
          : payload.hostPublicKey
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
            管理一个或多个设备 B 中转端配置，支持 OpenSSH 多隧道连接池与 QUIC (Hysteria 2) 跨国弱网加速引擎
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
                      variant={node.engine === 'hysteria2' ? 'success' : 'neutral'}
                      dot={false}
                      label={
                        node.engine === 'hysteria2'
                          ? `QUIC 加速 :${node.localPort}`
                          : node.mode === 'socks5'
                          ? `SSH SOCKS5 :${node.localPort} · ${node.poolSize ?? 3} 通道`
                          : `SSH 转发 :${node.localPort} → B:${node.remoteProxyPort} · ${node.poolSize ?? 3} 通道`
                      }
                    />
                  </div>
                  <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    {node.engine === 'hysteria2'
                      ? `QUIC UDP ${node.host}:${node.quicUdpPort ?? 53623} (备用 SSH :${node.sshPort})`
                      : `${node.username}@${node.host}:${node.sshPort}`}
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

            <div className="grid-2">
              <div className="field">
                <label className="field-label">传输引擎</label>
                <select
                  className="select"
                  value={editing.engine ?? 'openssh'}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      engine: e.target.value as NodeProfile['engine'],
                    })
                  }
                >
                  <option value="openssh">OpenSSH 多隧道池（零额外组件）</option>
                  <option value="hysteria2">QUIC / Hysteria 2（跨国弱网抗丢包推荐）</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label">本地代理监听端口</label>
                <input
                  className="input mono"
                  type="number"
                  value={editing.localPort}
                  onChange={(e) =>
                    setEditing({ ...editing, localPort: Number(e.target.value) || 1080 })
                  }
                />
                <span className="field-hint">仅监听 127.0.0.1，默认 1080</span>
              </div>
            </div>

            {editing.engine === 'hysteria2' && (
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">设备 B QUIC UDP 端口</label>
                  <input
                    className="input mono"
                    type="number"
                    value={editing.quicUdpPort ?? 53623}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        quicUdpPort: Number(e.target.value) || 53623,
                      })
                    }
                  />
                </div>
                <div className="field">
                  <label className="field-label">QUIC 鉴权密钥 (Auth Token)</label>
                  <input
                    className="input mono"
                    value={editing.quicAuthToken ?? ''}
                    onChange={(e) => setEditing({ ...editing, quicAuthToken: e.target.value })}
                    placeholder="从设备 B 配对码自动导入"
                  />
                </div>
              </div>
            )}

            <details className="advanced-drawer">
              <summary>
                <span>高级弱网与协议参数（已自动设为跨国最优值）</span>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {editing.engine === 'hysteria2'
                    ? `Brutal ${editing.quicUpMbps ?? 50}/${editing.quicDownMbps ?? 200}M · 备选 SSH ${editing.poolSize ?? 3} 通道`
                    : `${editing.mode === 'socks5' ? 'SOCKS5' : '本地转发'} · ${editing.poolSize ?? 3} 通道 · 心跳 ${editing.serverAliveInterval ?? 15}s`}
                </span>
              </summary>
              <div className="advanced-drawer-body">
                {editing.engine === 'hysteria2' && (
                  <div className="callout callout-accent stack-sm" style={{ padding: 12 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>
                      QUIC (Hysteria 2) 进阶参数（配对码已自动填充，通常无需修改）
                    </div>
                    <div className="grid-2">
                      <div className="field">
                        <label className="field-label">TLS 伪装域名 (SNI)</label>
                        <input
                          className="input mono"
                          value={editing.quicSni ?? 'www.bing.com'}
                          onChange={(e) => setEditing({ ...editing, quicSni: e.target.value })}
                          placeholder="www.bing.com"
                        />
                      </div>
                      <div className="field">
                        <label className="field-label">Salamander 混淆密码（可选）</label>
                        <input
                          className="input mono"
                          value={editing.quicObfsPassword ?? ''}
                          onChange={(e) =>
                            setEditing({ ...editing, quicObfsPassword: e.target.value })
                          }
                          placeholder="留空则不启用混淆"
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label className="field-label">服务端证书指纹 pinSHA256（防中间人攻击）</label>
                      <input
                        className="input mono"
                        value={editing.quicCertPinSha256 ?? ''}
                        onChange={(e) =>
                          setEditing({ ...editing, quicCertPinSha256: e.target.value })
                        }
                        placeholder="AA:BB:CC:..."
                      />
                    </div>
                    <div className="grid-2">
                      <div className="field">
                        <label className="field-label">本机上行带宽期望 (Mbps，Brutal)</label>
                        <input
                          className="input mono"
                          type="number"
                          min={5}
                          max={2000}
                          value={editing.quicUpMbps ?? 50}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              quicUpMbps: Math.max(5, Number(e.target.value) || 50),
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <label className="field-label">本机下行带宽期望 (Mbps，Brutal)</label>
                        <input
                          className="input mono"
                          type="number"
                          min={10}
                          max={5000}
                          value={editing.quicDownMbps ?? 200}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              quicDownMbps: Math.max(10, Number(e.target.value) || 200),
                            })
                          }
                        />
                      </div>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={editing.autoFallbackToSsh !== false}
                        onChange={(e) =>
                          setEditing({ ...editing, autoFallbackToSsh: e.target.checked })
                        }
                      />
                      <span>UDP 被屏蔽/握手失败时，自动无缝回退至 OpenSSH 多隧道连接池（强烈推荐）</span>
                    </label>
                  </div>
                )}

                <div className="field">
                  <label className="field-label">SSH 隧道转发模式</label>
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

                <div className="grid-2">
                  <div className="field">
                    <label className="field-label">心跳保活间隔 ServerAliveInterval（秒）</label>
                    <input
                      className="input mono"
                      type="number"
                      min={5}
                      max={300}
                      value={editing.serverAliveInterval ?? 15}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          serverAliveInterval: Math.max(5, Number(e.target.value) || 15),
                        })
                      }
                    />
                    <span className="field-hint">默认 15 秒，搭配 IPQoS=none 与 TCPKeepAlive=yes</span>
                  </div>
                  <div className="field">
                    <label className="field-label">心跳最大重试 ServerAliveCountMax</label>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      max={20}
                      value={editing.serverAliveCountMax ?? 3}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          serverAliveCountMax: Math.max(1, Number(e.target.value) || 3),
                        })
                      }
                    />
                    <span className="field-hint">连续无响应此次数后自动触发重连（默认 3 次）</span>
                  </div>
                </div>

                <div className="grid-2">
                  <div className="field">
                    <label className="field-label">并行隧道连接池数（1-6，推荐 3）</label>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      max={6}
                      value={editing.poolSize ?? 3}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          poolSize: Math.max(1, Math.min(6, Number(e.target.value) || 3)),
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">定时无感轮换周期（分钟，0 为关闭）</label>
                    <input
                      className="input mono"
                      type="number"
                      min={0}
                      max={1440}
                      value={editing.rotationIntervalMin ?? 0}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          rotationIntervalMin: Math.max(
                            0,
                            Math.min(1440, Number(e.target.value) || 0)
                          ),
                        })
                      }
                    />
                  </div>
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editing.preferFastCipher !== false}
                    onChange={(e) =>
                      setEditing({ ...editing, preferFastCipher: e.target.checked })
                    }
                  />
                  <span>优先高速加密套件（AES-128-GCM / ChaCha20，利用 AES-NI 硬件加速）</span>
                </label>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editing.forceIpv4 !== false}
                    onChange={(e) => setEditing({ ...editing, forceIpv4: e.target.checked })}
                  />
                  <span>强制使用 IPv4（AddressFamily=inet，避免跨国链路 IPv6 绕路）</span>
                </label>

                <div className="grid-2">
                  <div className="field" style={{ justifyContent: 'center' }}>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={editing.healthCheckEnabled !== false}
                        onChange={(e) =>
                          setEditing({ ...editing, healthCheckEnabled: e.target.checked })
                        }
                      />
                      <span>启用端到端主动探活</span>
                    </label>
                  </div>
                  {editing.healthCheckEnabled !== false && (
                    <div className="field">
                      <label className="field-label">探活周期（秒，默认 25）</label>
                      <input
                        className="input mono"
                        type="number"
                        min={10}
                        max={120}
                        value={editing.healthCheckIntervalSec ?? 25}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            healthCheckIntervalSec: Math.max(
                              10,
                              Math.min(120, Number(e.target.value) || 25)
                            ),
                          })
                        }
                      />
                    </div>
                  )}
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(editing.compression)}
                    onChange={(e) => setEditing({ ...editing, compression: e.target.checked })}
                  />
                  <span>启用 SSH 压缩（-C，日常浏览 HTTPS 建议保持关闭）</span>
                </label>

                {editing.host.trim() && (
                  <div className="field">
                    <label className="field-label">将执行的 SSH 命令预览</label>
                    <div className="code-block" style={{ fontSize: 11.5 }}>
                      {formatSshCommandPreview(editing)}
                    </div>
                  </div>
                )}
              </div>
            </details>
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
