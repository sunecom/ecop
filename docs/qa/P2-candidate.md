# P2 隔离候选验收记录（总控复核后候选）

## 候选身份与隔离

- 候选来源为当前工作树内容包，SHA-256 `74f1dae1547a58004a935e40c8b61f15e2d388db2562ec54c23032078a0f49df`；本记录不把未提交工作树冒充 Git 提交。
- Web 镜像：`ecop:p2-r01-74f1dae1547a`，镜像 ID `sha256:026fa25d1ccce82974588a7482b8e7cb6e7f1b7d57814f92102f42fb2360bdff`。
- Web 容器：`ecop-p2-web`，容器 ID `77de82a3f9204b032c5635b2fbf4b939c261ad096a22937c60ed0ed8c5ab5604`，启动时间 `2026-09-18T16:36:24.261855603Z`，仅监听 `127.0.0.1:18768`。
- DWSIM 容器：`ecop-p2-dwsim`，容器 ID `eb39781cdf3a01cf2d9326b44e5772f0fdfdccf07d4dd68aa05271c60e122bde`，镜像 ID `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间 `2026-09-18T16:36:22.502331536Z`，仅监听 `127.0.0.1:15904`。
- 独立资源：内部网络 `ecop-p2-net`、数据卷 `ecop_p2_runs`、只读受控模板挂载和独立 Basic Auth 密码文件；未连接生产数据卷。
- 验收后生产 Web 仍为镜像 `sha256:6932a71e0f3e3701dc8666811f6d1faaaa92120c00be5e17f7ecc59645d7ff8e`、启动时间 `2026-09-18T14:56:40.760374577Z`；生产 DWSIM 仍为镜像 `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`、启动时间 `2026-09-18T04:16:21.50725706Z`。生产未重启、未部署 P2。

## R01/R03 根因与处理

- 原失败工况：Water–Ethanol/NRTL，`800 kg/h`、入口 `30 °C`、`150 kPa(a)`、乙醇 `40 mass%`、目标汽相率 `40 mol%`。
- 首版模型保存值显示 `PTFlash_External_Loop_Tolerance=1e-4`、`PTFlash_Internal_Loop_Tolerance=1e-4`。DWSIM 10.2.8 `NestedLoops_v2.Flash_PV_1`读取这两个设置，并以外循环残差小于 `etol` 作为停止条件；Heater 的 `OutletVaporFraction` 模式委托 `PressureVaporFraction` 闪蒸。
- 首版结果实际汽相摩尔率 `0.39998985699735295`，与目标相差 `-1.0143002647067245e-5`；400–3200 kg/h 的密集测试呈相同相对偏差。该现象只能说明相对偏差稳定，不能单独证明舍入根因。
- 修复没有放宽应用验收阈值。7 个白名单物系/物性包组合改为加载只读空白模板，模板固定 PT 闪蒸内外循环容差为 `1e-8`；运行前从引擎回读 XML，逐次核验空白流程、精确组分集合、精确物性包和两项闪蒸设置。
- 汽相目标绝对容差继续为 `1e-5`。相重构总量及每个组分分别按各自进料流量执行 `1e-6` 相对容差，并同时记录质量、摩尔绝对残差和相对残差；不再以总流量的 `2e-5` 统一遮蔽小组分误差。
- 修复后原失败工况：温度 `98.9398412521 °C`、实际汽相摩尔率 `0.400000018325163`、目标误差 `+1.8325163e-8`、热负荷 `217.1864217401 kW`。最大逐组分质量/摩尔相对残差均为 `5.4995744e-8`；乙醇质量绝对残差 `1.7598638e-5 kg/h`，对应容差 `3.2e-4 kg/h`。
- 受控模板清单：`deploy/models/manifest.json`，SHA-256 `153a7b6215eb37a783ce7f74c2230cdfb6f24ae5522dd1c67933aa28bf56d9ae`。生成器为 `deploy/build_material_templates.py`。

## R02 Windows 发行版同模型对照

- 输入模型：`.local/qa/P2/p2-r01-tight.dwxml`，SHA-256 `4774bf2ad14b66a799d7e92f9b05cc80afb4871ca968eac5f8fb43b48bf80f67`。
- 运行时使用已校验官方 Windows portable DWSIM 10.2.8 发行目录 `D:/AiToMoney/tools/DWSIM-10.2.8`。桌面可执行文件版本 `10.2.8.0`、产品提交 `986bda33b525c7665fb5d2c7dd6fb0e067b2959c`，SHA-256 `bfafafafd9cd1ef1bc2213d582b346b52bebc8f3dcf3c938498bbb42f23774fc`。
- Automation 驱动 DLL 是本机 pin `0cd6a30ce1b5eb976cdd94495d102a9691b067f5` 源码构建，并非 portable 发行包自带文件。驱动通过 `Automation3.LoadFlowsheet` 加载模型，明确调用 `CalculateFlowsheet4` 重新求解，再以 `SaveFlowsheet(..., false)` 保存新 XML。`Solved=true`，错误列表为空。
- Windows 重算结果：温度 `98.9398412521 °C`、汽相摩尔率 `0.400000018325163`、汽相质量率 `0.487715795344353`、热负荷 `217.1864089483 kW`；与输入模型保存值三项差值均为 0。
- 原始证据：`.local/qa/P2/desktop-crosscheck/p2-r01-desktop-evidence.json`，SHA-256 `ee122bea68b5a6129a6ecc8d31f820517211f52d75976e1504b6b108f82d1520`。
- 该结果仅是官方 Windows 发行版 Automation 路径的同模型一致性对照，不称实验精度认证，也不替代 P3 日后桌面实际打开和导出文件验收。

## 验证结果

- 本地单元/故障回放：共 36 项，35 项通过、1 项按设计跳过。新增模板精度篡改拒绝测试；覆盖配置/组成/流量回读、压力、非有限值、失败不落盘、流程图清理及相分配错误拒绝。
- 直连 MCP：7 个白名单组合加原失败工况共 8 个真实求解，全部清理 flowsheet。
- Web API：9 个物系工况、5 个拒绝工况、Origin/nonce/未认证防护全部通过。
- 原九工作流：目标汽化、出口温度、泵、Mixer、Splitter、Valve、HeatExchanger、Compressor、Vessel 各 1 个真实回归全部通过。
- 浏览器：真实 Google Chrome 完成 NRTL/Raoult 两次计算、同模块比较和 JSON 下载；1440 px 与 390 px 横向溢出均为 0；console/page error 均为 0；页面为 10 个标签与 10 个表单。

## 固定运行记录

| 用例 | run_id |
|---|---|
| Water / Steam Tables | `49f1059ebb28410590797ef44cc584bd` |
| Ethanol / NRTL | `5fdcaa8728c943298f7d609a3573c5ef` |
| Ethanol / Raoult | `e7bdafb0f9bb41c4ad4477c298085539` |
| Acetone / NRTL | `a7ea57a23059485b993925da962acc83` |
| Acetone / Raoult | `7194da89a9724de0aa49a5057c1e74f5` |
| Water–Ethanol / NRTL | `6a48f3174dd2422e9eb122e75f2539f8` |
| Water–Ethanol / Raoult | `c7db8e14ee134a84a20c00fc6db3c458` |
| Water–Ethanol / NRTL 扰动 | `9d19b8b0f92746d38767bfa521250f03` |
| Water–Ethanol / NRTL 150 kPa 复核 | `36fa104f37f040af94d99c6be6ce514d` |
| 浏览器 NRTL | `9aa1288a36f648bba3b40c1586fdb68f` |
| 浏览器 Raoult | `dcbec46d8ee547959c269aeb39eced28` |

原九流程回归 run_id 位于 `.local/qa/P2/p2-api-r01.json` 的 `nine_workflow_regression` 数组。

## 证据哈希

| 证据 | SHA-256 |
|---|---|
| `.local/qa/P2/p2-schema-r01.json` | `c392c633039a38fbc2b6542f05ff1dbedddf93e85984cfcc7ecdbb9359711b75` |
| `.local/qa/P2/p2-api-r01.json` | `afd3a22e9983bff9139a681b4b7c809ff848f45195ce320b0b0dd65ec1d4d9db` |
| `.local/qa/P2/browser-r01/p2-browser-evidence.json` | `98cbd95367b8d6a426511291e46e47b32f83ff29505dae1f9d28f33d313b2046` |
| `.local/qa/P2/browser-r01/p2-desktop-1440.png` | `7282d7dd3245e2a310722aae052cbda1b5403a9860c549bc4ab8f5f10155b13f` |
| `.local/qa/P2/browser-r01/p2-material-result-1440.png` | `82cd5ff00958f1aebd4b6654059b61a673ef7927f824db9c01a874959bd43c17` |
| `.local/qa/P2/browser-r01/p2-mobile-390.png` | `3166099aee89efc8250d3d1da4dc8a4f628d2d68dcb88869821026ddd1cb520f` |
| `.local/qa/P2/desktop-crosscheck/p2-r01-desktop-evidence.json` | `ee122bea68b5a6129a6ecc8d31f820517211f52d75976e1504b6b108f82d1520` |
| `.local/qa/P2/p2-r01-web.log` | `834a9836b6864522b9a9213a79c8fda387737cd0683a04af3d73d40a8130de7c` |
| `.local/qa/P2/p2-r01-dwsim.log` | `1cc7fb573482b225436cc10636573c0598d22b1be047d2e9c5caaa022fc0dd71` |

## 门禁结论

- 总控复核指出的 R01、R02、R03 已形成新候选和可复核证据；仍待总控独立复核，不自行批准。
- 一致性/守恒通过不等同物性准确性；Raoult 对水–乙醇仅为理想溶液对照，NRTL 参数来源与有效温区仍未知。
- 盐、电解质、结垢、工业废水、反应和“全部 1611 组分可用”继续 HOLD。
- 生产部署与 P3 继续 HOLD。
