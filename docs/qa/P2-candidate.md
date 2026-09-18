# P2 隔离候选验收记录

## 候选身份与隔离

- 运行代码提交：`26d98cffaa79bbde693d742a79e626225429486b`。
- Web 镜像：`ecop:p2-26d98cf`，镜像 ID `sha256:17aef32f9dd37dd0ed4357e1c551f3e0843b9e67671867346f8b1ca4130a2cc6`。
- Web 容器：`ecop-p2-web`，容器 ID `a16c31b9e634e017db5dbc4cfdae1d432ebc3f90facf1eff6caf540f6314f641`，启动时间 `2026-09-18T15:47:35.090308154Z`，仅监听 `127.0.0.1:18768`。
- DWSIM 容器：`ecop-p2-dwsim`，容器 ID `d05a285955aedec43111f91faf758a4bfc8493e3d0a9c019ed21525d6fcce5bf`，启动时间 `2026-09-18T15:47:33.968731569Z`，仅监听 `127.0.0.1:15904`。
- 独立资源：内部网络 `ecop-p2-net`、数据卷 `ecop_p2_runs`、独立 Basic Auth 密码文件；未连接生产数据卷。
- 验收后生产 Web 仍为镜像 `sha256:6932a71e0f3e3701dc8666811f6d1faaaa92120c00be5e17f7ecc59645d7ff8e`、启动时间 `2026-09-18T14:56:40.760374577Z`；生产 DWSIM 仍为镜像 `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`、启动时间 `2026-09-18T04:16:21.50725706Z`。生产未重启、未部署 P2。

## 验证结果

- 本地单元/故障回放：35 项通过，1 项按设计跳过。覆盖配置回读不一致、组成/流量回读不一致、压力、非有限值、失败不落盘/流程图清理及相分配错误但整体组成不变。
- 直连 MCP：7 个白名单组合全部真实求解并清理 flowsheet。
- Web API：8 个物系工况、5 个拒绝工况、Origin/nonce/未认证防护全部通过。
- 原九工作流：目标汽化、出口温度、泵、Mixer、Splitter、Valve、HeatExchanger、Compressor、Vessel 各 1 个真实回归全部通过。
- 浏览器：真实 Google Chrome 完成 NRTL/Raoult 两次计算、同模块比较和 JSON 下载；1440 px 与 390 px 横向溢出均为 0；console/page error 均为 0；页面为 10 个标签与 10 个表单。

## 固定运行记录

| 用例 | run_id |
|---|---|
| Water / Steam Tables | `d154e944cc7648b19e64e01a55370878` |
| Ethanol / NRTL | `6920c45f22544736b6f84657565e1c66` |
| Ethanol / Raoult | `318041a7f7124bc4ad36ec24794f3dcc` |
| Acetone / NRTL | `477c0dd129af4fd1b7546da39bb7221a` |
| Acetone / Raoult | `42f7f88403734fde9edd12ae0b720c6e` |
| Water–Ethanol / NRTL | `2493792c810b48a38ca390b2040b0788` |
| Water–Ethanol / Raoult | `e15f95a5f59044d4b1c967d8567e3c07` |
| Water–Ethanol / NRTL 扰动 | `ed529b4f0dc643178b4fa31df9c5ab99` |
| 浏览器 NRTL | `335e397b2bce4d75ae6f3f9998fde88c` |
| 浏览器 Raoult | `279d745e2b2e4298a5951f324acd64e0` |

原九流程回归 run_id 记录在 `.local/qa/P2/p2-api.json` 的 `nine_workflow_regression` 数组中。

| 原九工作流 | run_id |
|---|---|
| 目标汽化 | `3b68afd0b9d84ef0acc6909aee57f54f` |
| 出口温度 | `b96dabf386374f4e9b9db4c62cf05a51` |
| 泵升压 | `7d069c0c4b8d4ea7a92f852313c217b3` |
| 两股混合 | `3e98c934f03f4c8a90430abdac07c672` |
| 按比例分流 | `bd186480c4c647a9aa2452cad433da85` |
| 阀门节流 | `80a02e78a678447a8a95027aaeb5a595` |
| 冷热换热 | `52680d5adb3746f5b83d661f9d49e5b0` |
| 蒸汽压缩 | `742ecdae6dd14dbd90dd5360b396e97e` |
| 气液分离 | `e4da84a5d8d240429b64715026314eeb` |

## 证据哈希

| 证据 | SHA-256 |
|---|---|
| `.local/qa/P2/p2-schema.json` | `5fd564263dc41353f048cd8b8245d781b41b416f58b332b31d5489a45b24d5b0` |
| `.local/qa/P2/p2-api.json` | `7f437f9ed3ae549fb2e774f5f8dd4ea016f2adcd5494fcc43d7dc2989083e8d5` |
| `.local/qa/P2/browser/p2-browser-evidence.json` | `171cefce6e51b9772f936ec1e9d31ddc9108c07862fb6ffbfece14daacf8b329` |
| `.local/qa/P2/browser/p2-desktop-1440.png` | `ea8fd3c483bfff4e657b1e6dfa3b289630b0262aad2b444be659fc866e2a37bf` |
| `.local/qa/P2/browser/p2-material-result-1440.png` | `eaa5fee9fcb5b8b3b6642ff0e16207c925ea22de4acae064c0219e1474b5645b` |
| `.local/qa/P2/browser/p2-mobile-390.png` | `5bade0e3ee25a60f454749400af8c5975208b62a16390ca4f5987c71e7d4d6ce` |
| 服务器 `.local/qa/P2/p2-web.log` | `0ef354d2f6a00c3a00794838c209a6a7e554cd6f881a4f37e6fe2ede3c665c87` |
| 服务器 `.local/qa/P2/p2-dwsim.log` | `e13d1ecf17163c2f3ce4f80f4593b38e1ed566a42bb9ea145f9cd1287d2cf1a4` |

## 门禁结论

- P2 候选实现与引擎一致性验收通过，待总控独立复核。
- 一致性/守恒通过不等同物性准确性；Raoult 对水–乙醇仅为理想溶液对照，NRTL 参数来源与有效温区未知。
- 盐、电解质、结垢、工业废水、反应和“全部 1611 组分可用”均继续 HOLD。
- 生产部署与 P3 继续 HOLD。
