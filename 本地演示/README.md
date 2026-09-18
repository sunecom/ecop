# AiToMoney · ECOP 本地计算演示 V0.1

访问地址：<http://127.0.0.1:18765/>。页面可修改纯水流量、入口温度、绝对压力及目标汽化比例，运行真实 DWSIM 计算，并下载本次 JSON。

这是 AiToMoney 为客户 ECOP 制作的技术验证页面，不是 DWSIM 官方浏览器版。当前验证纯水加热汽化的物性及热量计算，尚未实现板片选型、盐溶液浓缩、多效蒸发或 MVR 系统设计。流程图是示意图，不能拖拽编辑。

## 启动

在本文件所在目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\启动演示.ps1
```

脚本复用本项目已运行的服务；端口被其他程序占用时会报错，不会终止其他程序。服务后台运行，仅监听本机，不设置开机自启。此命令的执行策略仅作用于该进程。

## 安装与结构

- 官方源码：项目目录下 `调研/DWSIM源码解读/source/dwsim10`。
- 上游仓库：https://github.com/DanWBR/dwsim10 。固定提交：`0cd6a30ce1b5eb976cdd94495d102a9691b067f5`，声明版本 10.2.8。
- 本地 `.local/dotnet` 安装 .NET SDK 10.0.100，未替换系统 SDK。
- 已从源码编译 `tools/DWSIM.MCPServer` Release 配置，0 错误；未构建桌面图形客户端。
- `index.html`：AiToMoney 页面；`server.py`：本地 HTTP 服务及受限 MCP 调用；`runs`：计算输入、输出和原始返回。
- Web：127.0.0.1:18765；MCP：localhost:15901/mcp。访问令牌保存在 `.local/mcp-token.txt`，不会发给浏览器。
- 日志位于 `.local/setup`，包括构建及服务日志。Python 使用本机 Codex 配套运行时，移动项目到其他机器时需调整启动脚本中的 Python 路径。

## 模型与验证

调用官方 MCP 建立独立流程，添加 Water 与 IAPWS-IF97 蒸汽表物性包，连接进料、Heater、产品物流，按目标汽化比例求解。热负荷由引擎计算的混合相焓差与质量流量得到；汽化量由引擎返回的汽相比例得到。纯水下摩尔汽相分率与质量汽相分率一致。

已验证 1000 kg/h、25°C、101.325 kPa(a)、30% 汽化：出口 99.974°C，汽化量 300 kg/h，剩余液体 700 kg/h，热负荷 275.284 kW，物料衡算残差 0 kg/h。流量翻倍后热负荷与汽化量翻倍；非法输入被拒绝。验证记录见 `verification.json`。浏览器端也已实际运行并核对上述结果。

上游当前 MCP 组分参数实现会覆盖总质量流量；本演示在组分设置后单独设置总流量，并回读校验。上游源码未为此修改。早期发现问题时的记录如含 `invalid_for_use` 标记，仅保留为调试证据，不可作为计算结果采用。

© 2026 AiToMoney：自建演示页面及说明。DWSIM 属于其原作者及贡献者，使用及再分发须遵循上游仓库许可证；AiToMoney 标识不改变上游软件的版权归属。
