# P1A Mixer / Splitter / Valve 候选验收记录

- 日期：2026-09-18（Asia/Shanghai）
- 前置：G0 总控复核 PASS；复核记录 `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\docs\qa\G0-总控复核-2026-09-18.md`，SHA-256 `791BE286A3CD7E0CACF5823EF3A5F34DC8039A1050B1062C3F553248E11FA684`。
- 状态：分控候选自检 PASS，等待总控独立复核；未部署、未重启或替换生产容器，未进入 P1B。

## 实现边界

| 工作流 | 专用契约 | 引擎映射 | 成功前校核 |
| --- | --- | --- | --- |
| Mixer | 两股纯水流量、温度和绝对压力；压差 `<=0.1 kPa` | `feed_port=0/1`，单出口 | 单液相、出口压力、质量守恒和焓流守恒 |
| Splitter | 纯水入口状态与 1 号出口分流比 `1–99%` | `OperationMode=SplitRatios`，`SR1=fraction` | 两路流量比、温压状态和总质量 |
| Valve | 单液相纯水入口与目标出口绝对压力；降压 `>=10 kPa` | `CalcMode=OutletPressure`，`OutletPressure=Pa` | 出口压力、质量守恒和等焓关系；显示出口相态 |

三者仅开放 Water 与 `Steam Tables (IAPWS-IF97)` 的已验证范围；组分目录的其他物质不会被默认带入计算。

## 隔离候选

| 项目 | 值 |
| --- | --- |
| Web 容器 | `ecop-p1a-web`，镜像 ID `sha256:5d0c7ede1d34c2c02222c21e304bb687b7bca63b89ea657daf43b307b804d299` |
| DWSIM 容器 | `ecop-p1a-dwsim`，运行镜像 ID `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf` |
| DWSIM 固定引用 | `10.2.8@sha256:015fd7ecbf219192d6b9d81a9080ba02fd0de7d4b9388506c4ab755159032f36` |
| 访问方式 | 服务器回环 `http://127.0.0.1:18766`；需 SSH 端口转发；Basic Auth 候选凭据另行交给总控 |
| 网络 | Web 双网络；DWSIM 仅在 `ecop-p1a-net` 内部网络，无宿主端口 |
| 数据 | 独立 `ecop_p1a_runs` volume，不使用生产 `ecop_runs` |
| 生产 DWSIM | `StartedAt=2026-09-18T04:16:21.50725706Z`，P1A 前后未变 |

## 真实工况

预先固定容差：质量残差绝对值 `<=1e-6 kg/h`；能量/焓流相对残差 `<=1e-4`；压力 `<=0.02 kPa`；分流比 `<=1e-6`；状态温度 `<=0.02 °C`。

| 用例 | 输入概要 | 运行 ID | 实际结果 |
| --- | --- | --- | --- |
| MIXER-BASE | `400 kg/h@25°C + 600 kg/h@55°C; 200 kPa(a)` | `9ddae91490184950ae7e620161cd99eb` | `1000 kg/h; 43.000050291°C; 200 kPa; mass 0; enthalpy-rel 4.12274e-11` |
| MIXER-DISTURB | `700 kg/h@20°C + 300 kg/h@80°C; 300 kPa(a)` | `bdb2a355ee1040a697bded5f06ff2f8b` | `1000 kg/h; 38.009743842°C; 300 kPa; mass 0; enthalpy-rel 4.38826e-11` |
| SPLITTER-BASE | `1000 kg/h; 35°C; 250 kPa(a); 30/70%` | `b654454889b344038c14f2923313cba6` | `300/700 kg/h; fraction 0.3/0.7; mass residual 9.99e-14 kg/h` |
| SPLITTER-DISTURB | `1500 kg/h; 60°C; 500 kPa(a); 65/35%` | `f97e572f90524f03b2da5a3ac17afb7c` | `975/525 kg/h; fraction 0.65/0.35; mass residual -9.99e-14 kg/h` |
| VALVE-BASE | `1000 kg/h; 25°C; 500->200 kPa(a)` | `d086ff3b98914feaa6e96ccc10e47c5b` | `25.066430109°C; 300 kPa drop; vapor 0; mass 0; h-rel 8.30484e-10` |
| VALVE-DISTURB | `1800 kg/h; 70°C; 1000->300 kPa(a)` | `1d2874edfc4449febd5d0ed008989404` | `70.136684129°C; 700 kPa drop; vapor 0; mass 0; h-rel 1.73120e-9` |

六个工况的 `check.ready=true`、`solve.ok=true`，要求对象均 `calculated=true`，每个 flowsheet 均在 `finally` 关闭。

## 拒绝与安全

- `MIXER-MISSING`、`MIXER-BOOL`、`MIXER-PRESSURE-MISMATCH`、`SPLITTER-RATIO-ZERO`、`SPLITTER-RATIO-FULL`、`VALVE-NO-DROP`、`VALVE-REVERSE`、`NON-FINITE` 均返回 `400`。
- Python 契约测试直接覆盖 `NaN` 和 `Infinity`；HTTP 测试覆盖非数字输入，不使用非标准 JSON 字面量。
- 错误 Origin 和 nonce 均 `403`；未认证状态接口 `401`。
- 业务路由仍只是固定 `/api/calculate`，未增加任意 MCP 工具代理。

## 回归与浏览器

- 旧六工况在最终候选上全部通过；关键数值与 G0 一致，质量残差均为 0。
- 真实 Google Chrome 完成 Mixer、Splitter、Valve 页面求解，并用第二个 Mixer 工况验证历史保留、同模块比较与本次 JSON 下载。
- 1440px 和 390px 的页面级水平溢出均为 `0 px`；390px 下六个工作流标签两列展示，活动 Mixer 与表单一致。
- Chrome `console_errors=0`，`page_errors=0`。

## P1A-R01 修复候选

- 总控首次独立复核发现：真实求解结果中的 `NaN` 可绕过 Mixer 焓流阈值比较。修复后，Mixer、Splitter、Valve 对参与计算的引擎原始数值及派生结果均显式执行有限数校验。
- `save_result` 在创建目录和写文件前使用 `allow_nan=False` 完成严格序列化；本地 HTTP 与云端 WSGI 响应共用同一严格 JSON 边界，形成最终防线。
- 故障注入覆盖 `NaN`、`+Infinity`、`-Infinity`：三个新增工作流均不返回成功；完整 `server.calculate` 路径不新增成功记录，并在异常后关闭 flowsheet、释放单引擎锁；云端接口统一返回脱敏 `502`。
- 修复候选 Web 镜像为 `sha256:e155dd4ab269220420de4449c35b9865dea2953d3c49792417ce43d002d4463f`；候选 DWSIM 引擎镜像和启动时间保持不变。
- 修复候选重新执行 6 个 P1A 真实工况、8 个负例、3 个安全负例和原 6 模块回归，均通过。UI 代码未变化；总控首次复核已独立完成真实 Chrome 求解、改参失效和 390px 无横向溢出验证。

## 复跑命令

```powershell
python deploy/run_p1a_qa.py --base http://127.0.0.1:18766 --origin http://127.0.0.1:18766 --user ecop --password-file <候选密码文件> --output <输出JSON>
python deploy/smoke_test.py --base http://127.0.0.1:18766 --origin http://127.0.0.1:18766 --password-file <候选密码文件>
$env:ECOP_P1A_PASSWORD = (Get-Content -Raw <候选密码文件>).Trim()
$env:PYTHONPATH = <Playwright运行时目录>
python deploy/browser_p1a_qa.py --base http://127.0.0.1:18766 --user ecop --password-env ECOP_P1A_PASSWORD --chrome <Chrome路径> --output-dir <输出目录>
```

## 证据哈希

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `...\.local\qa\P1A\p1a-candidate-runs-final.json` | 11117 | `973FA638BF9F835D988D7193F1468053C1C8AF3A158CAC2B7BCB78FC4693EED2` |
| `...\.local\qa\P1A\p1a-regression-final.json` | 7174 | `0C3DB3493EA4B858104C0D75919F694D94C21D3D5930A57E50E986CC7F73712D` |
| `...\.local\qa\P1A\browser\p1a-browser-evidence.json` | 4111 | `CEE6DBB50CC1691075A3DA88293C3660D7F9F064DB19868BC30D3E6EA2D48D71` |
| `...\.local\qa\P1A\browser\p1a-desktop-1440.png` | 1262308 | `7F1A0D6659392AE635AA7F13154FC39E955527F7360BCCB6E54312430EFEEE01` |
| `...\.local\qa\P1A\browser\p1a-mixer-result-1440.png` | 1310987 | `6B0A5D426CAFD939B86078C300A37CF0D7DE6D774DA35DAD0EC9C6AB0BB2C552` |
| `...\.local\qa\P1A\browser\p1a-mobile-390.png` | 56371 | `D84E9100702F18B4BAD621410B0E59AEF7B389419D9B7B82CA779D507DB7AAE6` |
| `...\.local\qa\P1A\rework\p1a-rework-runs.json` | 11117 | `0DE11C3692505A0AF4360007FCC17400374FD5A81B5503AC6ED6295C41CEC16C` |
| `...\.local\qa\P1A\rework\p1a-rework-regression.json` | 7174 | `064EBCA409E6D02ED3B0109D4C1A45DCCFEC51D87F0CF945E0B8B6169189F71A` |
| `...\.local\qa\P1A\rework\p1a-rework-unit-tests.txt` | 6686 | `8A2A269FB9C31278FEB9940ED212ED6E663ECEBD08D89EA42951AF9B01DEB4FC` |
| `...\.local\qa\P1A\rework\p1a-r01-controller-replay.json` | 472 | `87BB05300CCB98827A4A86273B0631443313F48E7CB9AE0AB89687A62268D52A` |

## HOLD 与回退

- 总控首次独立候选复核：`REWORK`；`P1A-R01` 修复候选待复核。
- 正式站部署：`HOLD`；本轮不将候选结果写入生产卷。
- P1B 压缩机、换热器、气液分离器：`HOLD`。
- 候选回退只需删除 `ecop-p1a-web`、`ecop-p1a-dwsim`、`ecop-p1a-net` 和独立候选数据卷；不操作生产 Compose。
