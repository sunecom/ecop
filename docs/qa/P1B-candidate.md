# P1B 隔离候选验收

## 候选构件

- Web 镜像：`sha256:454e0196b6f89f19dd77a484e24988bfc66676de16a56d9ed9be6d4dbcbb4bbf`
- Web：`ecop-p1b-web`，仅监听 `127.0.0.1:18767`，启动时间 `2026-09-18T14:31:11.331077032Z`
- 引擎：`ecop-p1b-dwsim`，仅监听 `127.0.0.1:15903`，启动时间 `2026-09-18T13:59:18.094794008Z`
- 独立资源：`ecop-p1b-net`、`ecop_p1b_runs`
- 状态：候选验收通过，待总控独立复核；禁止生产部署，禁止进入 P2。

## API 验收

| 用例 | run_id | 关键结果 | 闭合 |
| --- | --- | --- | --- |
| HX-BASE | `0c1f2301e49e42b6ba2de7f17afebfba` | 热侧 50.000°C；冷侧 45.035°C；34.879 kW | 两侧质量残差 0；热平衡相对误差 `4.07e-10` |
| HX-DISTURB | `005d641c1dba4db1bed6665f4c4419a6` | 热侧 60.000°C；冷侧 65.131°C；52.393 kW | 两侧质量残差 0；热平衡相对误差 `4.32e-10` |
| COMPRESSOR-BASE | `577779c0616041ee99bc57f29c5f6d46` | 500 kPa；348.663°C；81.808 kW | 质量残差 0；功率相对误差 `2.09e-9`；汽相 1 |
| COMPRESSOR-DISTURB | `896a45cf4d904571869abceb3ab43333` | 900 kPa；431.128°C；80.943 kW | 质量残差 0；功率相对误差 `2.64e-10`；汽相 1 |
| VESSEL-BASE | `6c401e70ccfa4a888d9688de512daa00` | 300 kg/h 汽相；700 kg/h 液相 | 质量残差约 `1.0e-13` kg/h；焓流相对误差 0 |
| VESSEL-DISTURB | `e8a853d5337848baa2f18caaaafdfdfe` | 1040 kg/h 汽相；560 kg/h 液相 | 质量残差约 `1.0e-13` kg/h；焓流相对误差 `2.58e-16` |

六个拒绝用例均返回 400，包括压缩机液相入口；错误 Origin、错误 nonce 分别返回 403，未认证访问返回 401。既有六类工作流回归通过。

## 浏览器验收

- 真实 Google Chrome；九个 tab 和九个 form。
- 新增三类设备均从真实表单完成求解；换热器基准/扰动记录可比较，最新记录可下载。
- 1440px 与 390px 横向溢出均为 0；控制台错误 0，页面错误 0。
- 浏览器证据 SHA-256：`354E089A06419DAF82A6D3D01E47CC24DF18EC0F65C3DA98E6C5150198FF52D9`。

## 证据索引

- API：`.local/qa/P1B/p1b-candidate-qa.json`，SHA-256 `BC54F956DA52579369283BFE015690047C0ADC3CBF5AD3B1565412E742C695D6`
- 回归：`.local/qa/P1B/p1b-regression.json`，SHA-256 `23EABF72B8F65E3199764B24ED0F721A7D0278A187D4CB49A7F731193E2A8762`
- 日志：`.local/qa/P1B/p1b-web.log`、`.local/qa/P1B/p1b-dwsim.log`
- 截图：`.local/qa/P1B/browser/p1b-desktop-1440.png`、`.local/qa/P1B/browser/p1b-mobile-390.png`

## 正式站未变化证明

- Web 镜像仍为 `sha256:e155dd4ab269220420de4449c35b9865dea2953d3c49792417ce43d002d4463f`，启动时间仍为 `2026-09-18T13:48:19.934631809Z`。
- DWSIM 镜像仍为 `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间仍为 `2026-09-18T04:16:21.50725706Z`。
