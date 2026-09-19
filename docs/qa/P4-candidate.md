# P4 候选验收包：预热—蒸发—汽液分离固定模板

## 候选身份与边界

- 代码：`8b8e18f`（固定串联流程与同 flowsheet 预热泡点 2 °C 守卫）；关联实现提交：`7d1d5b7`、`aa12848`。
- 候选：`/opt/ecop-candidates/p4-4cf8d0a`，Compose 项目 `ecop-p4`，仅监听 `127.0.0.1:18770`，使用独立 runs/projects 卷和密钥。
- Web Image ID：`sha256:bb15afb97ba5a88bc523354808f78f62bc66a6cc033c0d1a538ddbf8f146e12e`。
- DWSIM 仓库摘要：`ghcr.io/danwbr/dwsim-mcp@sha256:015fd7ecbf219192d6b9d81a9080ba02fd0de7d4b9388506c4ab755159032f36`；运行镜像 ID：`sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`。
- 此验收包不代表生产发布；未变更 P3 生产环境，未启动 P5。

## 实现契约

P4 仅运行纯水 Steam Tables 的固定实际 DWSIM 流程：`FEED → H-01 → PREHEATED → EV-01 → TWO-PHASE → V-01 → VAPOR + LIQUID`。H-01、EV-01、V-01 均在同一 flowsheet 中联算；不拼接独立 JSON。

在最终求解前，H-01 会在同一 flowsheet 中临时运行“目标预热温度 + 2 °C”的相态守卫。守卫温度必须由引擎达到且保持单液相，之后才恢复用户目标并取得最终串联结果。响应和持久化记录只包含有限的总体/有效相字段，不使用缺失相组分。

验收容差：每段及全流程质量残差 `≤ max(1e-6 kg/h, flow × 1e-8)`；预热/蒸发压力 `≤ 0.02 kPa`；预热温度 `≤ 0.02 °C`；目标汽相分率 `≤ 1e-6`；V-01 能量相对残差 `≤ 1e-4`；汽相产品汽相率 `≥ 0.999999`，液相产品汽相率 `≤ 1e-6`。失败在记录或 DWXML 导出之前终止。

## 真实 DWSIM 证据

| 工况 | 输入 | 关键输出 | 结果 |
|---|---|---|---|
| 基准 | 1000 kg/h、25 °C、101.325 kPa、预热 70 °C、汽化 30% | H-01 `52.262773758974845 kW`；EV-01 `223.0215728057343 kW`；汽/液 `300.0000000000003/699.9999999999998 kg/h`；全流程质量 `-9.992007221626409e-14 kg/h`；V-01 能量相对 `1.8671997674829376e-16` | 通过 |
| 扰动 | 1250 kg/h、30 °C、101.325 kPa、预热 75 °C、汽化 45% | H-01 `65.34390597099994 kW`；EV-01 `389.0312119708727 kW`；汽/液 `562.5000000000001/687.4999999999999 kg/h`；质量 `0 kg/h`；V-01 能量相对 `2.282559394128648e-16` | 通过 |
| 相态拒绝 | 1000 kg/h、25 °C、101.325 kPa、预热 99 °C、汽化 30% | 泡点守卫触发；API 受控返回 `502`，无成功记录 | 通过 |

基准守卫物流为 `345.15 K`、汽相分率 `0`。候选本地证据位于 `.local/qa/P4/remote/`，远端副本位于 `/opt/ecop-candidates/p4-4cf8d0a/.local/qa/P4/`：

- `p4-baseline-8b8e18f.json`：SHA-256 `640a58ec2756727faab135da1d65ac1c5763f9ed95fb273efe5e55c64d31ec07`
- `p4-perturb-8b8e18f.json`：SHA-256 `ce8f548691b4bbbb77d20e1d27185b51bffe5d5119cfa8ecaba7bca516f69847`
- `p4-preheat-reject-8b8e18f.json`：SHA-256 `7d32b5c4a4b5233e636a82bb680f26fa3100402ae41f7e268cc7ca1bd896a6ed`

## 项目、导出与浏览器

真实 Chrome 候选验收创建项目 `prj_4d8db6a13da84596bbdc78a9d925017a`，基准版本记录为 `b38ceb9f581d4f1f8a11f326412f898b`，45% 汽化的不可变新版本记录为 `ee1c88e8876c4a60be54cb6e83383360`。比较结果为 EV-01 热负荷 `223.0215728057343 → 317.0441039823075 kW`，差值 `94.02253117657318 kW`（`42.1585%`）；复制后项目包含两条工况。

DWXML 下载文件为 `ECOP-ee1c88e8876c4a60be54cb6e83383360.dwxml`，`218981` bytes，SHA-256 `7b37188addd23fa0685445478fec6e067531e033ab0f3d3257f1ffa0b296c56b`。Chrome 在 `1440 px` 和 `390 px` 下横向溢出均为 `0`，P4 标签在移动宽度可见，控制台和页面错误均为 `0`。

- 浏览器证据：`.local/qa/P4/browser/p4-browser-evidence.json` 与远端同名文件，SHA-256 `24c490247a2a9794a7cd4e494abdb9756f462ced8c86aa3e4cd21374c7164cf8`
- 截图：`.local/qa/P4/browser/p4-desktop-1440.png`、`.local/qa/P4/browser/p4-mobile-390.png`

## 回归

`python -m unittest discover -s deploy -p 'test_*.py' -v`：`59` 通过、`1` 项条件跳过。覆盖 P4 判别测试、基础/高级/物系工作流、项目不可变版本/比较/受控导出映射、失败导出清理、云适配和非有限值保护。
