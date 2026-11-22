# SSH Relay Studio

面向 Windows **设备 A（使用端）** 与 **设备 B（中转端）** 的独立桌面管理工具，将手动 OpenSSH 隧道部署、安全加固、防锁死端口迁移、密钥免密与后台守护全部图形化与自动化。

## 核心特性

### 设备 B（中转端 · 运维与加固工作台）
- **一键环境部署**：自动检测/安装 Windows 内置 `OpenSSH.Server`、启动 `sshd` 并设为开机自启。
- **防锁死部署向导**：
  1. 安装并启动 OpenSSH Server
  2. 追加设备 A 公钥至 `C:\ProgramData\ssh\administrators_authorized_keys`（不覆盖已有设备），无 BOM UTF-8 写入并自动执行 `icacls` 收紧权限（使用语言无关 SID，兼容中英文 Windows）
  3. 放行高位端口防火墙 → 自动备份 `sshd_config.bak` → 在 `Match Group administrators` 块之前安全写入端口/禁用密码配置 → 自动运行 `sshd.exe -t` 语法校验（失败自动回滚）→ 重启 `sshd`
  4. 确认 A 端新端口联通后，精准禁用旧 22 端口防火墙规则（不误删高位端口规则）
  5. 一键配置 `sshd` 崩溃 5 秒自动拉起（`sc.exe failure`）+ 禁止 Windows 自动更新强制重启（`AUOptions=2`、`NoAutoRebootWithLoggedOnUsers=1`）
- **设备 A 来源 IP 反查**：自动解析当前 RDP (`:3389`) 与 SSH 连接来源 IP，一键复制 `x.x.x.x/32` 用于配置云安全组。
- **配对码导出**：一键生成 `SSHR1:...` 配对码（附带公网 IP、高位端口、用户名与 B 端主机公钥），供 A 端一键导入并自动信任主机指纹。

### 设备 A（使用端 · 日常连接与代理启动器）
- **内置进程守护与系统托盘**：直接托管 `ssh.exe`（保活 `ServerAliveInterval=30` × 3、断线 5 秒自动重连、一键立即重连、退出彻底清理子进程），彻底告别 `start_tunnel.vbs` 与 `stop_tunnel.bat`。
- **双隧道模式**：支持标准 SOCKS5 动态加密隧道（`ssh -D`），以及当 B 端本身依赖 Clash/v2rayN 时的本地端口转发模式（`ssh -L`）。
- **免密配对与指纹信任**：一键生成无密码短语 `ed25519` 密钥对、扫码/粘贴 B 端配对码、弹窗确认写入 `known_hosts`（消除 `BatchMode=yes` 首次连接拒连问题），并内置“免密成功 + 密码登录已拒”双项安全校验。
- **独立全站代理浏览器 & 链路自检**：自动扫描 Edge / Chrome 启动独立用户数据目录代理窗口（默认无顶部警告横幅）；一键复制 PowerShell / CMD / Bash 代理变量；内置本地监听、出口 IP 与目标站连通性诊断。

## 本地开发与 Windows 打包

```bash
# 安装依赖
npm install

# 类型检查与单元测试
npm run typecheck
npm test

# 构建主进程与前端资源
npm run build

# 打包 Windows x64 便携免安装压缩包（可在 Linux/Windows 执行）
npm run package:win-zip

# 在 Windows 上打包单文件便携版或 NSIS 安装程序
npm run package:win-portable
npm run package:win-nsis
```
