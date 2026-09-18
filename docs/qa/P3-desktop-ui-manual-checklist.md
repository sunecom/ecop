# P3 DWSIM 桌面 UI 人工验收操作单

> 用途：在 Computer Use 运行时恢复或用户在场时补齐 P3 桌面 UI 硬门槛。此操作单不代表已经验收，也不得用 Automation、脚本或 API 结果替代可见桌面操作证据。

## 1. 验收对象与准备

- DWSIM：`D:\AiToMoney\tools\DWSIM-10.2.8\DWSIM.UI.Desktop.Avalonia.exe`；文件版本 `10.2.8.0`；SHA-256 `bfafafafd9cd1ef1bc2213d582b346b52bebc8f3dcf3c938498bbb42f23774fc`。
- 打开此已验导出：`C:\Users\gao\.codex\worktrees\f815\ECOP企业方案agent\.local\qa\P3\desktop\p3-browser-export.dwxml`；SHA-256 `b1042b7d502b2d9aa70256742ba6b50c59002c79f5e9ba952d4ddca46692a105`。
- 验收前先核对上述两个 SHA-256；不一致立即停止并记录，不得继续使用未知文件。
- 新建证据目录：`C:\Users\gao\.codex\worktrees\f815\ECOP企业方案agent\.local\qa\P3\desktop\manual`。原始 `.dwxml` 只读使用，禁止覆盖。

## 2. 可见 UI 操作

1. 用上述 DWSIM 桌面程序打开 `p3-browser-export.dwxml`，截取完整窗口；标题应含 `DWSIM - ECOP 目标汽化计算`，流程图应显示 `FEED → EV-01 → PRODUCT`。
2. 在 UI 中点击求解/重算按钮，等待 `EV-01`、`FEED`、`PRODUCT` 均显示已计算且无求解错误。读取并记录基准值：`FEED=1000 kg/h、25 °C、101.325 kPa`；`EV-01` 模式为 `OutletVaporFraction`、目标值 `0.45`；`PRODUCT` 温度 `99.9743 °C`、压力 `101.325 kPa`、汽相摩尔分率 `0.45`；热负荷 `369.3069 kW`。
3. 仅在 `EV-01` 属性编辑器中把目标汽化分率从 `0.45` 改为 `0.55`；不得修改 FEED、物性包、计算模式或连接关系。修改后先截取能同时辨认对象标签、字段名和 `0.55` 的画面。
4. 再次点击求解/重算，等待全部对象恢复已计算且无错误。读取并记录：`PRODUCT` 温度 `99.9743 °C`、压力 `101.325 kPa`、汽相摩尔分率 `0.55`；热负荷 `431.9886 kW`。热负荷应比基准增加约 `62.6817 kW`。
5. 使用 UI 的“另存为”保存到证据目录，文件名采用 `P3-UI-55pct-YYYYMMDD-HHMM.dwxml`；不得覆盖原文件。关闭后从 DWSIM UI 重新打开该另存文件，确认目标值仍为 `0.55`，重算结果仍满足第 4 步容差。

## 3. 判定容差

| 项目 | 基准期望 | 改参期望 | 允许偏差 |
|---|---:|---:|---:|
| FEED 质量流量 | `1000 kg/h` | 不变 | `±0.001 kg/h` |
| FEED 温度 / 压力 | `25 °C` / `101.325 kPa` | 不变 | `±0.01 °C` / `±0.001 kPa` |
| PRODUCT 温度 / 压力 | `99.9743 °C` / `101.325 kPa` | 同左 | `±0.01 °C` / `±0.001 kPa` |
| 目标与出口汽相摩尔分率 | `0.45` | `0.55` | 绝对偏差 `≤1×10⁻⁶` |
| EV-01 热负荷 | `369.3069 kW` | `431.9886 kW` | `±0.01 kW` |

任一对象未显示已计算、出现求解错误、数值超差、另存失败或重新打开后结果不一致，均判定 **FAIL**；不得调整容差后重判。

## 4. 必须留存的证据

- `01-open.png`：完整 DWSIM 窗口、文件标题和流程图；`02-baseline-recalculated.png`：基准重算后的目标、出口分率与热负荷；`03-target-055.png`：可见 UI 中 `EV-01` 目标改为 `0.55`；`04-changed-recalculated.png`：改参重算后的出口分率、热负荷和已计算状态；`05-reopened-save-as.png`：另存文件重新打开后的文件标题与复算结果。
- 另存 `.dwxml`、五张原始截图、DWSIM 可执行文件和输入文件分别计算 SHA-256；记录测试人、开始/结束时间、DWSIM 文件版本、所有读数、求解错误列表（应为空）及最终 `PASS/FAIL`。
- 将记录写入同目录 `P3-desktop-ui-manual-evidence.json`，不得只在聊天中口头确认。只有上述证据齐全且全部满足容差，才可关闭 `DESKTOP UI BLOCKED`；仍需总控独立判定，不自动放行生产或 P4。
