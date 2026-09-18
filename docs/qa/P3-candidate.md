# P3 隔离候选验收记录

## R01 当前候选（2026-09-19）

- 当前源码提交 `9bc2685decf9e88e990eb72bf2d7b7e259ab040f`，源码包 `.local/qa/P3-R01/p3-r01-source-9bc2685.tar.gz`，SHA-256 `a8366049c4e77ed7884c8d0ab1cda28b2740b655d900b447851f2dfd3d75cf66`。
- 远端目录 `/opt/ecop-candidates/p3-r01-9bc2685`，Compose project 继续使用 `ecop-p3`，候选复测地址为 `http://127.0.0.1:18769`。仅候选 Basic Auth 凭据已轮换，受限文件位于 `/opt/ecop-candidates/p3-r01-9bc2685/deploy/secrets/ecop_password.txt`；文档和证据不保存凭据内容。
- Web 镜像 ID `sha256:cba2cb14d987ba0244f9874cd48edd3d09dfa48137956023df45a20a5b42c886`，健康启动时间 `2026-09-18T19:13:13.44505557Z`。DWSIM 镜像 ID 仍为 `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间仍为 `2026-09-18T18:03:16.903529114Z`，本次切换未重启 DWSIM。
- 切换前后继续复用 `ecop-p3_projects`、`ecop-p3_runs`。切换前数据库计数为项目/版本/记录 `7/15/14`，切换后保持 `7/15/14`；新增一笔 R01 真实计算后为 `8/16/15`。
- 原项目 `prj_1a7a935f7a404a678de2c3800511dd2a` 的 3 个 run 和 3 个导出哈希全部保留；总控项目 `prj_eefbadd0e1db4234beeedc34d82f116a` 与 Chrome 项目 `prj_084c4aeb46b44566a1f95e1ea13b3e2d` 均可重新打开，分别保留 3 条和 2 条记录。
- R01 真实计算项目 `prj_1ac1221972d642a3a05ec87c472790b4`，run `3b8fc459fb13465892f0125d4410a6d2`；输入为 `1000 kg/h`、`25 °C`、`101.325 kPa`、目标汽化 `37%`，DWSIM 10.2.8 返回热负荷 `319.16152778044335 kW`。导出 XML 可解析，SHA-256 `3472a64e9c721f39c558267bbf0eabb209c5491a891e554c03bb45b0f7422fcc`。
- 项目计算只写 SQLite 和受控导出，不再生成 `/data/runs/<run_id>.json`；该 run 的 SQLite 记录数为 1，legacy JSON 不存在。
- 候选运行时迁移夹具首次为 `1 imported / 3 invalid`，第二次为 `4 skipped`；数据库触发器故障按 `IntegrityError` 传播且 `legacy_imports=0`，证明坏记录隔离和数据库故障不掩盖均生效。
- 修复提交全量测试准确口径为 **55 总数 = 54 PASS + 1 SKIP**；故障日志来自受控负例。

## 原候选基线与隔离

- 本地证据根目录：`C:/Users/gao/.codex/worktrees/f815/ECOP企业方案agent/.local/qa/P3`；服务器证据根目录：`/opt/ecop-candidates/p3-bdb319e/.local/qa/P3`。浏览器与桌面子目录已完整镜像到服务器同名子目录。
- 应用镜像代码提交：`bdb319eb9c6d4f6ae568319cdf92533fd9d06674`；配置与 QA 修正提交：`bb5e68d0c1cfe0b2b462b2b5ea0f7f42607e8d29`。
- 候选源码包：本地 `.local/qa/P3/p3-source-bdb319e.tar.gz`，SHA-256 `9de4eef0db318b714179b559d398ba7ae9ccf5fc1b5447a22881827d9a6f4c7e`。精确模型运行包 `.local/qa/P3/p3-models-runtime.tar`，SHA-256 `cbb99699c17a616226cd28b39381b983b83213d43cc4fa56a40dd9482f0af811`。
- 远端目录 `/opt/ecop-candidates/p3-bdb319e`，Compose project `ecop-p3`，仅监听 `127.0.0.1:18769`；候选网络与生产网络分离。
- Web 镜像 ID `sha256:a410dce767af3010bdb8e823c081580fc7eca3a4018a716f7eb0e05560656f80`；迁移幂等复核后的启动时间 `2026-09-18T18:16:13.498936261Z`。
- DWSIM 镜像 ID `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`；启动时间始终为 `2026-09-18T18:03:16.903529114Z`，三次 Web 重建均未重启 DWSIM。
- 独立卷：`ecop-p3_runs`、`ecop-p3_projects`；恢复验证卷 `ecop-p3-projects-restore`。生产未部署 P3、未重启，继续 HOLD。

## 单元、API 与安全验证

- 原候选本地共 52 项测试，51 项通过、1 项真实引擎测试按设计跳过；R01 修复提交现为 55 总数、54 项通过、1 项跳过。`project_ui.js` 通过 `node --check`，两份 P3 QA 脚本通过 `py_compile`，候选 `docker compose config --quiet` 通过。
- API 项目 `prj_1a7a935f7a404a678de2c3800511dd2a` 创建不可变 30% 与 45% 目标汽化版本，真实 DWSIM run 分别为 `b566e77dc77646169b6b70dd708bb969`、`68d1e832d7ff445687124a9da76f9fe2`；泵不兼容对照为 `ad53b30970eb4286921c4ce2880ffa00`。
- 两个兼容蒸发记录比较热负荷从 `275.2843465647 kW` 变为 `369.3068777413 kW`，差值 `94.0225311766 kW`；蒸发与泵比较返回 `409`。
- 3 个导出均可下载、解析为 XML，正文 SHA-256 与数据库及 `X-Content-SHA256` 一致。非法 ID、路径穿越、错误 Origin、错误 nonce 和未认证请求均被拒绝。
- API 原始证据本地路径 `.local/qa/P3/p3-api-evidence.json`，服务器路径 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/p3-api-evidence.json`，SHA-256 `76f1ca2962cdf3d5decc394bcbdaf23810a4bc965eb0f547f8096249b6004dd1`。

## 持久化、迁移与恢复

- Web 强制重建后，同一项目、3 个 run 和 3 个导出哈希全部保留；DWSIM 启动时间未变化。证据本地 `.local/qa/P3/p3-persistence-evidence.json`，服务器 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/p3-persistence-evidence.json`，SHA-256 `79fe87a1c7bf5e714b5af671ebc21d61d860af7c0169a3065e5314c6d86d1856`。
- 干净数据库夹具首次迁移 `1 imported`，二次初始化 `1 skipped`，计数不增加；实际候选再次重建前后数据库计数一致，DWSIM 未重启。证据本地 `.local/qa/P3/p3-migration-idempotency-evidence.json`，服务器 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/p3-migration-idempotency-evidence.json`，SHA-256 `de7cdb280a4ab2f5781011e5865d4a3620636e85739aff08bbdd399e80dc8bbb`。
- SQLite 在线备份包含 3 个项目、7 个版本、7 条记录，数据库 SHA-256 `0eeff2eeca82fbafa4fa35f743ea11f1f8828d1ca0443388e3cf9b3a2ab17952`。证据本地 `.local/qa/P3/p3-backup-evidence.json`，服务器 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/p3-backup-evidence.json`，文件 SHA-256 `35f24fa87b9199e08d7d05ad3c07f5e102fb7f11fcd63f07361d94b500843f5e`。
- 在全新恢复卷中重新打开备份后，同一项目、3 个 run 和 3 个导出哈希全部一致。证据本地 `.local/qa/P3/p3-restore-evidence.json`，服务器 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/p3-restore-evidence.json`，SHA-256 `746cb12bf5545f84eca57823c5b1ac73d9eb12fd2513d7ee13d0348367056359`。

## 浏览器验收

- 真实 Google Chrome 经 SSH loopback 隧道访问隔离候选，完成创建项目、保存 30% 版本、真实计算、改为 45% 新版本、再次计算、兼容比较、下载 `.dwxml`、刷新后持久化和 390 px 检查。
- 浏览器项目 `prj_fcbb252713f149d1aaddab4f6809ebff`，run 为 `0903959935924d3a99aab007cd91f425` 与 `5949d4da26df4d698383945a53a4813e`。刷新后仍有 2 条记录；1440 px 与 390 px 横向溢出均为 0；console error 与 page error 均为 0。
- 下载文件 `.local/qa/P3/browser/ECOP-5949d4da26df4d698383945a53a4813e.dwxml`，SHA-256 `b1042b7d502b2d9aa70256742ba6b50c59002c79f5e9ba952d4ddca46692a105`。
- 浏览器原始证据 `.local/qa/P3/browser/p3-browser-evidence.json`，服务器镜像 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/browser/p3-browser-evidence.json`，SHA-256 `ccc55bafacf3eec6d1d98ce98847b7a7c453d0c6cd6752041daaa2137d7582f9`。

## Windows DWSIM 对照与 UI 阻塞

- 正式 Windows portable DWSIM 10.2.8 桌面程序 `D:/AiToMoney/tools/DWSIM-10.2.8/DWSIM.UI.Desktop.Avalonia.exe`，文件版本 `10.2.8.0`，SHA-256 `bfafafafd9cd1ef1bc2213d582b346b52bebc8f3dcf3c938498bbb42f23774fc`。
- 桌面程序已用候选导出作为命令行文件参数可见启动；窗口标题为 `DWSIM - ECOP 目标汽化计算 (...p3-browser-export.dwxml)`，证明正式 UI 能识别并打开该文件。
- 补充 Automation 对照通过：45% 模型重算后温度 `99.9743000005 °C`、汽相摩尔率 `0.45`、热负荷 `369.3068777413 kW`；目标改为 55% 后汽相摩尔率 `0.5500000000`、热负荷 `431.9885651923 kW`。证据 `.local/qa/P3/desktop/p3-windows-automation-evidence.json`，SHA-256 `65f23439e2d4a838594a54591e24d86558af824e34a013583ce54eeb2b177112`。
- **桌面 UI 硬门槛未通过。** Codex Computer Use 运行时无法导入文档要求的 `@oai/sky`，返回 `Module not found: @oai/sky`；当前 unified-computer-use 配置只启用 `browser` surface，本机 `@oai/sky` 目录也缺少 JS 入口。基于安全约束，没有改用 PowerShell UIAutomation、SendKeys 或后台 Automation 冒充 UI 操作。
- 阻塞证据 `.local/qa/P3/desktop/p3-desktop-ui-blocker-evidence.json`，服务器镜像 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/desktop/p3-desktop-ui-blocker-evidence.json`，SHA-256 `a8e9d3a8a122cdafd27c95c0c2573206c2b8384f7966a0875a696b9ee9d31766`。在 Computer Use 恢复前，“UI 中点击重算、改参、再次重算、检查和另存”保持 BLOCKED。

## 证据哈希

| 证据 | SHA-256 |
|---|---|
| `.local/qa/P3/p3-api-evidence.json` | `76f1ca2962cdf3d5decc394bcbdaf23810a4bc965eb0f547f8096249b6004dd1` |
| `.local/qa/P3/p3-persistence-evidence.json` | `79fe87a1c7bf5e714b5af671ebc21d61d860af7c0169a3065e5314c6d86d1856` |
| `.local/qa/P3/p3-migration-idempotency-evidence.json` | `de7cdb280a4ab2f5781011e5865d4a3620636e85739aff08bbdd399e80dc8bbb` |
| `.local/qa/P3/p3-backup-evidence.json` | `35f24fa87b9199e08d7d05ad3c07f5e102fb7f11fcd63f07361d94b500843f5e` |
| `.local/qa/P3/p3-restore-evidence.json` | `746cb12bf5545f84eca57823c5b1ac73d9eb12fd2513d7ee13d0348367056359` |
| `.local/qa/P3/browser/p3-browser-evidence.json` | `ccc55bafacf3eec6d1d98ce98847b7a7c453d0c6cd6752041daaa2137d7582f9` |
| `.local/qa/P3/browser/p3-project-desktop-1440.png` | `bec8cca0ce4bb9556221192a7ef50edc8e93166a40e36740607fcea0c0b0f1d9` |
| `.local/qa/P3/browser/p3-project-mobile-390.png` | `55b8b7db7e4a27d32f506878c064f1143a68a1ce24a69796fb58c0125fbd75b1` |
| `.local/qa/P3/desktop/p3-windows-automation-evidence.json` | `65f23439e2d4a838594a54591e24d86558af824e34a013583ce54eeb2b177112` |
| `.local/qa/P3/desktop/p3-desktop-ui-blocker-evidence.json` | `a8e9d3a8a122cdafd27c95c0c2573206c2b8384f7966a0875a696b9ee9d31766` |
| `.local/qa/P3-R01/pre-switch-state.json` | `fbc8e3c28ae1f2516a512c92b1cfabc6ed06490b54a4b91f51151fcf4e7ae984` |
| `.local/qa/P3-R01/post-switch-state.json` | `a2d4489912e5a9d194288b515c1e722038f35b6837c92704356114d11e55b4c1` |
| `.local/qa/P3-R01/final-state.json` | `37f12f0b4c88c017ae1126e814ada580f0d8deb58dc816a20ce2cc688df85917` |
| `.local/qa/P3-R01/p3-r01-existing-persistence.json` | `589cab33daaec991d71b66b50f77461917458b66ec1116e99956036389896aa4` |
| `.local/qa/P3-R01/p3-r01-smoke-evidence.json` | `3fecc8152a168beaea23eff1df5ea9f4b79767eab757b850ceda1e51673b960e` |
| `.local/qa/P3-R01/p3-r01-migration-evidence.json` | `27c019931d8cb60d7d1fe71bbc59c47ce7b5582a6fe910e2688bd54399632362` |
| `.local/qa/P3-R01/p3-r01-retained-projects.json` | `f488b8d26e427bc9ddf43e49f8f58d011fa23677007f9c97be70907fb81597e0` |

## 门禁结论

- 项目保存、不可变版本、真实计算、受控 DWSIM 导出、比较保护、迁移坏记录隔离、迁移幂等、数据库故障传播、Web 重建持久化、在线备份/全新卷恢复和浏览器响应式流程均通过 R01 当前候选自检。
- 桌面 Automation 只能作为补充一致性证据；因 Computer Use 运行时缺包，真实桌面 UI 的重算、UI 改参和另存尚未完成。
- P3 候选整体状态为 **HOLD / DESKTOP UI BLOCKED**。不申请生产发布，不把本记录当作总控独立 PASS。
