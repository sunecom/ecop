# P1B 真实 schema 探测

## 隔离边界

- 探测端点固定为 `http://127.0.0.1:15903/mcp`，脚本拒绝非回环、非 HTTP、非 `15903` 端口。
- 候选引擎容器为 `ecop-p1b-dwsim`，镜像 ID `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间 `2026-09-18T13:59:18.094794008Z`。
- 正式站 Web 和 DWSIM 未重启、未部署；P1B Web 使用独立容器、网络和数据卷。

## 探测结论

- `HeatExchanger`：指定热侧出口温度时使用 `CalculationMode=CalcTempColdOut` 与 `HotSideOutletTemperature`（K），两侧压降当前固定为零。当前业务边界仅允许纯水双侧单液相，拒绝温度次序无效或发生相变的工况。
- `Compressor`：使用 `CalcMode=OutletPressure`、`POut`（Pa）和 `AdiabaticEfficiency`（百分数）。求解后必须确认入口和出口汽相分数均接近 1；液相入口返回业务拒绝。
- `Vessel`：直接给 MaterialStream 设置汽相分数不能形成可复现两相进料。候选先由 `Heater` 的 `OutletVaporFraction` 生成真实两相物流，再连接 `Vessel`；产品端口 0 为汽相、端口 1 为液相。

## 可重复证据

- 探针：`deploy/probe_p1b_schema.py`
- 原始证据：`.local/qa/P1B/p1b-schema-probe.json`
- SHA-256：`F3CD5ACBFB6F90EA06F793A35399E7A7297056F0C72A58BDD4E99E261542C1A0`
- 三设备基准探测均报告 `flowsheet_check.ready=true`、`solve.ok=true`，并在 `finally` 中关闭流程图。
