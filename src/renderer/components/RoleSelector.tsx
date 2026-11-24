import React from 'react';
import type { AppRole } from '../../shared/types';
import { IconLaptop, IconServer, IconShield } from './Icons';

interface RoleSelectorProps {
  onSelect: (role: Exclude<AppRole, 'unset'>) => void;
}

export const RoleSelector: React.FC<RoleSelectorProps> = ({ onSelect }) => {
  return (
    <div className="role-landing">
      <div className="role-landing-inner">
        <div className="role-landing-head">
          <div
            className="brand-mark"
            style={{ width: 48, height: 48, margin: '0 auto', borderRadius: 13 }}
          >
            <IconShield size={24} />
          </div>
          <h1>SSH Relay Studio</h1>
          <p>请选择当前电脑在 SSH 隧道中转方案中的角色（随时可在左侧栏切换）</p>
        </div>

        <div className="role-cards-grid">
          <button
            type="button"
            className="role-choice-card"
            onClick={() => onSelect('clientA')}
          >
            <div className="role-choice-icon client">
              <IconLaptop size={24} />
            </div>
            <div>
              <h2>我是设备 A（使用端）</h2>
              <p style={{ marginTop: 4 }}>
                日常办公或跨国弱网电脑，通过设备 B 的 QUIC / SSH 加密中转稳定高速访问外网。
              </p>
            </div>
            <ul className="role-feature-list">
              <li>QUIC (Hysteria 2) 跨国弱网加速 + OpenSSH 多隧道池，UDP 受阻自动回退</li>
              <li>2 步极速配对：一键复制本机公钥 + 粘贴配对码自动信任指纹</li>
              <li>端到端主动探活、系统休眠唤醒秒级恢复与无感连接轮换</li>
              <li>一键启动独立全站代理浏览器（Edge / Chrome）与终端代理变量</li>
            </ul>
            <div style={{ marginTop: 'auto', paddingTop: 6 }}>
              <span className="btn btn-primary" style={{ width: '100%' }}>
                进入设备 A（使用端）
              </span>
            </div>
          </button>

          <button
            type="button"
            className="role-choice-card"
            onClick={() => onSelect('serverB')}
          >
            <div className="role-choice-icon server">
              <IconServer size={24} />
            </div>
            <div>
              <h2>我是设备 B（中转端）</h2>
              <p style={{ marginTop: 4 }}>
                具备完整外网权限的 Windows 主机或海外云服务器，提供 QUIC 与 OpenSSH 加密中转。
              </p>
            </div>
            <ul className="role-feature-list">
              <li>首页「一键全自动部署与优化」：装 OpenSSH、加固端口、配自愈与 TCP 调优</li>
              <li>可选内置 QUIC (Hysteria 2) 服务端：自动签发证书与 Salamander 防限速混淆</li>
              <li>设备公钥追加 + 自动 ACL 权限收紧 + 实时来源 IP 反查</li>
              <li>一键生成并复制配对码（含主机指纹与 QUIC 凭证），A 端粘贴即连</li>
            </ul>
            <div style={{ marginTop: 'auto', paddingTop: 6 }}>
              <span
                className="btn"
                style={{
                  width: '100%',
                  background: '#0f766e',
                  borderColor: '#0f766e',
                  color: '#fff',
                }}
              >
                进入设备 B（中转端）
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
