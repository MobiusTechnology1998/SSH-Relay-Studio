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
                日常办公或受限网络电脑，需要通过设备 B 的加密 SSH 隧道安全访问外网。
              </p>
            </div>
            <ul className="role-feature-list">
              <li>内置 SSH 进程守护，断线 5 秒自动重连与系统托盘常驻</li>
              <li>一键生成 ed25519 密钥、导入 B 端配对码与指纹信任</li>
              <li>一键启动全站代理隔离浏览器（Edge / Chrome）</li>
              <li>支持标准 SOCKS5 (-D) 与上游代理转发 (-L) 双模式</li>
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
                具备完整外网权限的 Windows 主机或海外云服务器，提供 OpenSSH 加密中转服务。
              </p>
            </div>
            <ul className="role-feature-list">
              <li>一键安装启动 OpenSSH Server 并配置崩溃 5 秒自愈</li>
              <li>防锁死端口迁移向导：自动校验 sshd_config 并备份回滚</li>
              <li>公钥追加管理 + 自动 icacls 权限收紧（管理员专属路径）</li>
              <li>禁止 Windows 更新自动重启 + 实时来源 IP 反查与配对码导出</li>
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
