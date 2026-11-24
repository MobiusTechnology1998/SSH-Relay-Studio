# SSH Relay Studio

面向 Windows **设备 A（使用端）** 与 **设备 B（中转端）** 的独立桌面管理工具，将手动 OpenSSH 隧道部署、安全加固、防锁死端口迁移、密钥免密与后台守护全部图形化与自动化。

## 核心特性

### 设备 B（中转端 · 运维、加固与 QUIC 加速工作台）
- **一键环境部署**：自动检测/安装 Windows 内置 `OpenSSH.Server`、启动 `sshd` 并设为开机自启，自动检测旧版 OpenSSH（< 9.0）并支持新版 Win32-OpenSSH 路径。
- **防锁死部署向导**：
  1. 安装并启动 OpenSSH Server
  2. 追加设备 A 公钥至 `C:\ProgramData\ssh\administrators_authorized_keys`（不覆盖已有设备），无 BOM UTF-8 写入并自动执行 `icacls` 收紧权限（使用语言无关 SID，兼容中英文 Windows）
  3. 放行高位端口防火墙 → 自动备份 `sshd_config.bak` → 在 `Match Group administrators` 块之前安全写入端口、禁用密码、双向保活与高并发性能参数（`UseDNS no`、`Compression no`、`MaxSessions 64`、`MaxStartups 30:50:100`）→ 自动运行 `sshd.exe -t` 语法校验（失败自动回滚）→ 重启 `sshd`
  4. 确认 A 端新端口联通后，精准禁用旧 22 端口防火墙规则（不误删高位端口规则）
  5. 一键配置 `sshd` 崩溃 5 秒自动拉起（`sc.exe failure`）、禁止 Windows 自动更新强制重启、禁止电源休眠/网卡节能，以及跨国弱网 Windows TCP 协议栈调优（`CUBIC`/`CTCP` 拥塞控制、`AutoTuning`、`Timestamps`、禁用 `ECN`）
- **跨国弱网终极引擎（QUIC / Hysteria 2 服务端）**：一键下载或离线导入 `hysteria.exe`，纯内置生成 ECDSA P-256 自签名 TLS 1.3 证书与 SHA-256 指纹、自动配置 Salamander UDP 混淆、放行 UDP 防火墙规则与 Windows 开机自启崩溃自愈计划任务。
- **设备 A 来源 IP 反查**：自动解析当前 RDP (`:3389`) 与 SSH 连接来源 IP，一键复制 `x.x.x.x/32` 用于配置云安全组。
- **配对码导出**：一键生成 `SSHR1:...` 配对码（附带公网 IP、高位端口、用户名、B 端主机公钥，以及已部署的 QUIC UDP 端口/鉴权密钥/TLS 指纹），供 A 端一键导入并自动信任。

### 设备 A（使用端 · 双引擎弱网加速与代理启动器）
- **多隧道并行连接池与本地调度器**：默认并行维持多条 SSH 隧道（1–6 通道可配），前置轻量本地 L4 TCP 调度器按「最少连接 + 低延迟」分发流量，显著缓解跨国弱网单 TCP 队头阻塞；支持单通道故障无感切换与先建后拆（Make-Before-Break）平滑热轮换。
- **QUIC (Hysteria 2) 跨国弱网引擎 + 自动容灾回退**：基于 UDP QUIC + Brutal 拥塞控制 + 原生 UDP 转发，高丢包跨国链路提速数倍；当所处网络屏蔽 UDP 时自动无缝回退至 OpenSSH 多隧道连接池。
- **主动假死探活与休眠自愈**：端到端探活自动识别并重建假死隧道、监听系统休眠唤醒（`powerMonitor`）秒级恢复、1s 起步指数退避重连 + TCP 预检，彻底告别 `start_tunnel.vbs` 与 `stop_tunnel.bat`。
- **双转发模式 & 独立全站代理浏览器**：支持 SOCKS5 动态隧道与本地端口转发（`ssh -L`）；OpenSSH 模式下默认禁用浏览器 QUIC（`--disable-quic`）消除 HTTP/3 超时回退延迟，Hysteria 2 模式下自动保留原生 QUIC；内置出口 IP 与目标站连通性诊断。

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
