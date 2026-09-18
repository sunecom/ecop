# G0 现状冻结与可执行验收基线

- 执行日期：2026-09-18（Asia/Shanghai）
- 阶段结论：分控自检 PASS；等待总控独立复核与 P1A 放行。
- 范围：仅生产只读盘点、既有六工况真实复跑和隔离引擎探测；未修改生产功能，未部署，未重启生产引擎。

## 依据与版本

| 项目 | 值 |
| --- | --- |
| 执行计划 | `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\docs\plans\2026-09-18-ecop-web-expansion-V1.0.md` |
| 计划 SHA-256 | `AA451CA280EBF8A54632B27D0AB20F33D43122E174C3E025B73B5517CE67D7C0` |
| 验收台账 | `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\docs\qa\ECOP-Web-阶段验收台账.md` |
| 台账快照 SHA-256 | `C89CAD58B383EC9C45673528FD32772C924AC85234EEF56208715DAC680816FB` |
| 文档基线 Git | `31fad32830cc2cc3bfed840559695365229f6565` |
| 生产应用功能 Git | `2c8ad85da2da69757d7edc1d3d5fcb84f1112ccb` |
| DWSIM 引擎 | `10.2.8` |
| 配置的引擎摘要 | `ghcr.io/danwbr/dwsim-mcp:10.2.8@sha256:015fd7ecbf219192d6b9d81a9080ba02fd0de7d4b9388506c4ab755159032f36` |
| 运行引擎镜像 ID | `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf` |
| 运行 Web 镜像 ID | `sha256:d3dcf8f407104fad4b4f5c5e94107da2e4dfdfa96a5b5b72468558c9a70b5021` |

应用 Git 提交和 DWSIM 镜像摘要是两个不同的版本轴，验收时不得混用。

## 生产冻结

| 检查项 | 实际值 |
| --- | --- |
| 正式地址 | `https://ecop.aitomoney.online` |
| Web 入口 | 仅 `127.0.0.1:18765 -> 8000` |
| DWSIM 宿主端口 | 无 |
| 生产 DWSIM 启动时间 | `2026-09-18T04:16:21.50725706Z`；隔离探测前后一致 |
| 数据卷 | `ecop_runs -> /data`，可写；其他根文件系统只读 |
| 记录数 | G0 前 26，六次复跑后 32 |
| 记录字节 | G0 后 `301874` |
| 密钥挂载 | 只读；目录 `0700`，文件 `0400`，UID/GID `10001:10001` |
| 当前目录 | 48 个 MCP 工具、44 种单元操作、28 个物性包、1611 条组分、3 个在线工作流 |
| 回滚点 | `.rollback/pre-2c8ad85-20260918-193212.tgz` 及部署前镜像保留 |

关键生产文件 SHA-256：`server.py=71e05f7c...87728`、`cloud_app.py=d5cedfa7...8c5`、`catalog.py=756038f6...c9e`、`index.html=a7c736cb...bb2d`、`ecop-logo.jpg=1e6e1291...1a1d8`、`compose.yaml=7ce82003...be10`。完整值在 `production-readonly.json` 中。

## 六个真实工况

预先冻结容差：质量残差绝对值 `<=1e-6 kg/h`；目标温度 `<=0.02 °C`；目标压力 `<=0.02 kPa`；汽相分率 `<=1e-5`；基准指标相对偏差 `<=1e-6`。全部使用 `Steam Tables (IAPWS-IF97)`，求解前检查 ready，求解结果 ok。

| 用例 | 输入 | 运行 ID | 实际结果 |
| --- | --- | --- | --- |
| EVAP-30 | `1000 kg/h, 25°C, 101.325 kPa(a), 30%` | `142db45b26bf48adba7c564af7a1d666` | `275.284346565 kW; 99.974300000°C; 300.000000000 kg/h vapor; residual 0` |
| EVAP-60 | `1000 kg/h, 25°C, 101.325 kPa(a), 60%` | `f1b7b9de1eb9450e857b96bdeb47c37e` | `463.329408918 kW; 99.974300000°C; 600.000000000 kg/h vapor; residual 0` |
| TEMP-HEAT | `1000 kg/h, 25->60°C, 101.325 kPa(a)` | `2b86d9120b6d4beca28b05c7a2343d3d` | `40.637067457 kW; 59.999999989°C; vapor fraction 0; residual 0` |
| TEMP-COOL | `1000 kg/h, 60->25°C, 101.325 kPa(a)` | `0d096211d89647fbb44acd2d0f27cf42` | `-40.637067448 kW; 25.000000019°C; vapor fraction 0; residual 0` |
| PUMP-500 | `1000 kg/h, 25°C, 101.325->500 kPa(a), 75%` | `d2b5bb66ba804d8596ac8daefb3d5c9c` | `0.148094600 kW shaft; 500 kPa; 74.999988855%; residual 0` |
| PUMP-900 | `1000 kg/h, 25°C, 101.325->900 kPa(a), 75%` | `e4c8028c0b9d4e7c9628d9d126a7fffd` | `0.296681371 kW shaft; 900 kPa; 74.999994481%; residual 0` |

## 拒绝和认证证据

| 类型 | 用例 | 结果 |
| --- | --- | --- |
| 非法输入 | EMPTY、BOOL-FLOW、TEMP-NO-DELTA、PUMP-NO-RISE、UNSUPPORTED、PHASE-BOUND-PUMP | 均 `400`，返回明确 `error`，未报成功 |
| 请求边界 | WRONG-ORIGIN、WRONG-NONCE | 均 `403` |
| 方法白名单 | 已认证 `GET /api/calculate` | `404` |
| 密码 | WRONG-PASSWORD | `401` |
| 未认证业务路由 | `/`、logo、status、catalog、compounds、calculate | 均 `401` |

`PHASE-BOUND-PUMP` 使用 `81°C` 并在应用允许范围检查处被拒绝；由于当前泵模块允许范围内不能稳定到达纯水气相入口，运行时相态护栏在现有契约下不可达。本轮不将“范围拒绝”冒充为“已实触发运行时相态拒绝”。

## P1A 隔离引擎探测

临时容器 `ecop-g0-dwsim` 使用与生产相同的运行镜像 ID，仅绑定 `127.0.0.1:15902`，用户 `10001`，只读根文件系统，`cap-drop ALL`，`no-new-privileges`，内存 `4g`，PID `256`。探测后容器与服务器临时文件已删除，生产 DWSIM 启动时间未变。

| 单元 | 实际 schema/属性 | 最小实算 | 物理断言 |
| --- | --- | --- | --- |
| Mixer | 连接 `feed_port=0/1`、`product_port=0`；可设属性含 `PressureCalculation` | `0.1 kg/s @ 300K,200kPa + 0.2 kg/s @ 330K,150kPa` | 出口 `0.3 kg/s, 320.005155293K, 150kPa`；质量残差 `0`；焓流相对残差 `1.22831e-7` |
| Splitter | `OperationMode=SplitRatios`；两出口时设 `SR1=0.3`，引擎自动补足第二路 | `0.3 kg/s @ 310K,200kPa` | 出口 `0.09/0.21 kg/s`，分流比 `0.3/0.7`，质量残差 `0` |
| Valve | `CalcMode=OutletPressure`；`OutletPressure=200000 Pa` | `0.25 kg/s @ 300K,500kPa -> 200kPa` | 出口 `300.066064632K,200kPa`；质量残差 `0`；等焓相对残差 `3.59181e-9` |

Mixer 、Splitter 、Valve 在本文中的状态仅为“引擎已实算、网页待接入”，不是“生产已上线”。其专用输入契约、错误边界、网页表单、记录与比较属于 P1A。

## 原始证据

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\.local\qa\G0\production-readonly.json` | 66164 | `BA84D0566B1AACF08C79986EEEB5C764083BE59635F1227727B3894D480CF7F3` |
| `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\.local\qa\G0\g0-production-runs.json` | 16908 | `D8F1DF97D1F0BE22F01165BDA9A29AD071D191FCD1F2188D58365FA3EE62B822` |
| `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\.local\qa\G0\g0-p1a-discovery.json` | 14128 | `9D50D5E47BE41553A603B66B1674BE8DC2D578BC6575905BBE0FF8A648A9BFC0` |
| `D:\codex\workspace\项目分类\FDE项目\ECOP企业方案agent\.local\qa\G0\g0-p1a-probe.json` | 49018 | `31E99537506000130C59934DA517E4E797188FF92DC32A014AB15A4DD203837B` |

证据不包含 Basic Auth 密码、MCP token 或 Authorization header。

## 复测命令

```powershell
python -m py_compile deploy\run_g0_qa.py deploy\probe_p1a_schema.py
python -m json.tool deploy\qa_cases\baseline.json > $null
python -c "import csv; rows=list(csv.DictReader(open(r'docs/qa/capability-matrix.csv',encoding='utf-8'))); assert len(rows)==44"
```

公网六工况重跑会新增 6 条生产记录，总控复核建议仅独立重跑 1 个蒸发和 1 个泵工况：

```powershell
$env:ECOP_G0_PASSWORD='<current-password>'
python deploy\run_g0_qa.py --password-env ECOP_G0_PASSWORD --output '<evidence-path>'
Remove-Item Env:ECOP_G0_PASSWORD
```

完整 P1A 探针只允许明确的本机隔离端点 `http://127.0.0.1:15902/mcp`，不会连接正式引擎：

```bash
python3 deploy/probe_p1a_schema.py \
  --url http://127.0.0.1:15902/mcp \
  --token-file /path/to/isolated-token \
  --output /tmp/g0-p1a-probe.json
```

## HOLD 与停止点

- 总控独立复核状态：`PENDING`。
- Mixer、Splitter、Valve 生产接口与页面：`HOLD-P1A`。
- 其他 38 种未实算单元：仅证明引擎库存存在，不声称可用。
- 纯水范围外的混合物、电解质、工业废水、盐溶液与结垢料液：`HOLD`。
- 本分控在 G0 交付后停止功能开发，等待总控复核通过后才进入 P1A。
