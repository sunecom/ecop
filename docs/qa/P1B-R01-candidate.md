# P1B-R01 隔离候选验收

## 修复范围

- 根因：初版 P1B 将换热器和 Vessel 压力写入展示结果，但未把全部声明压力纳入成功条件。
- HeatExchanger：热/冷入口读回、两侧出口分别对照声明压力，同时校核声明的两侧零压降；统一绝对容差 `0.02 kPa`。
- Vessel：预热前入口、真实两相进料、汽相出口、液相出口全部对照指定分离压力；统一绝对容差 `0.02 kPa`。
- 证据字段：换热器输出两侧压降；Vessel 输出两相进料、汽相产品、液相产品压力及最大压力残差。

## 故障回放

- Vessel 输入声明 `280 kPa`，预热前入口保持 `280 kPa`，将两相进料、汽相出口、液相出口回放为 `180 kPa`，现返回 `RuntimeError`，不再生成成功结果。
- HeatExchanger 入口保持 `300 kPa`，将热侧出口回放为 `280 kPa`、冷侧出口回放为 `290 kPa`，现返回 `RuntimeError`。
- HTTP 端到端测试确认压力故障返回受控 `502`，响应不泄露内部错误，不写成功 JSON，`finally` 调用 `dwsim_flowsheet_close`。

## 修订候选

- Web 镜像：`sha256:6932a71e0f3e3701dc8666811f6d1faaaa92120c00be5e17f7ecc59645d7ff8e`
- Web：`ecop-p1b-web`，仅监听 `127.0.0.1:18767`，启动时间 `2026-09-18T14:48:48.892045241Z`
- 引擎：继续使用隔离的 `ecop-p1b-dwsim` 与 `ecop-p1b-net`；未重启正式引擎。
- 状态：R01 自测通过，保留修订候选供总控独立浏览器与故障复核；生产部署和 P2 继续 HOLD。

## 验收结果

- 镜像内 Python 3.12：`26 tests OK (1 skipped)`。
- schema 探针、六个真实正向工况、六个业务拒绝、Origin/nonce/认证边界全部通过。
- 换热器两组工况的热/冷侧压降均为 `0 kPa`。
- Vessel 两组工况的两相进料与两个产品压力最大残差均为 `0 kPa`。
- 既有六类工作流真实回归通过。

| 用例 | run_id |
| --- | --- |
| HX-BASE | `6aa764fc83b947fc936317d4c8d9467a` |
| HX-DISTURB | `e0caa55c248c41099ed8e93dc100c12b` |
| COMPRESSOR-BASE | `173c3420edb449aaa5cf336bec4a5b7f` |
| COMPRESSOR-DISTURB | `9094f476e26b408c8e40a556a701d2e9` |
| VESSEL-BASE | `1e5136fd31364133879cb46e44f2428c` |
| VESSEL-DISTURB | `050508c58970469bbed730d15494058b` |

## 证据索引

- API：`.local/qa/P1B-R01/p1b-r01-candidate-qa.json`，SHA-256 `0ED701206D88F72B8949083AA48A3F7C6296EE1F808F9F2D21B1A87C53A2CEFD`
- schema：`.local/qa/P1B-R01/p1b-r01-schema-probe.json`，SHA-256 `3AA953702F3D12863253158A4C07666997467783919B996F6AE1249815679817`
- 回归：`.local/qa/P1B-R01/p1b-r01-regression.json`，SHA-256 `70F896387698309E57A7CF138AEC4513202EBC18F901FDEA1005941C29E065B4`
- 单测：`.local/qa/P1B-R01/p1b-r01-unit-tests.log`，SHA-256 `ED1E3B68390D7D2ABD1C9ECC986213AFE2631665D3B54E47B9F76D0C462262F3`

## 正式站未变化

- Web 镜像仍为 `sha256:e155dd4ab269220420de4449c35b9865dea2953d3c49792417ce43d002d4463f`，启动时间仍为 `2026-09-18T13:48:19.934631809Z`。
- DWSIM 镜像仍为 `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间仍为 `2026-09-18T04:16:21.50725706Z`。
