# P2 组分、物性包与相率 schema 证据

## 固定探测环境

- 引擎：`ecop-p2-dwsim`，仅监听服务器回环 `127.0.0.1:15904`。
- 引擎镜像 ID：`sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`。
- 引擎启动时间：`2026-09-18T16:36:22.502331536Z`。
- 直连探测脚本：`deploy/probe_p2_schema.py`；仅接受 `http://127.0.0.1:15904/mcp`。
- 原始证据：`.local/qa/P2/p2-schema-r01.json`，SHA-256 `c392c633039a38fbc2b6542f05ff1dbedddf93e85984cfcc7ecdbb9359711b75`。

## 库存与配置回读

- 实际库存为 1611 个组分、28 个物性包、48 个 MCP 工具。
- P2 白名单组分 `Water`、`Ethanol`、`Acetone` 均在真实库存；白名单物性包 `Steam Tables (IAPWS-IF97)`、`NRTL`、`Raoult's Law` 均在真实库存。
- 每个白名单组合加载独立只读空白模板；运行前通过 `dwsim_flowsheet_get_xml` 核对精确组分集合、唯一物性包、空白流程以及 PT 闪蒸内外循环 `1e-8` 设置。模板清单见 `deploy/models/manifest.json`。
- 进料组成以 `mass_fraction` 写入；设置组成后再次设置总质量流量，并回读组分集合、质量分数、质量分数和及总流量。

## 汽相比例基准

- P2 输入字段为 `vapor_molar_percent`；Heater `OutletVaporFraction` 和流股相 `fraction` 均按**摩尔相率**解释，不称质量汽化率。
- DWSIM 官方源码对相流量的计算是“总体摩尔流量 × 相摩尔分率”，再乘相平均分子量得到相质量流量；见 [DWSIM 官方 PropertyPackage 源码](https://github.com/DanWBR/dwsim/blob/windows/DWSIM.Thermodynamics/PropertyPackages/GraysonStreed.vb)。
- P2 使用总体质量/摩尔组成反推受控组分分子量，再由总摩尔流量、摩尔相率和各相摩尔组成重建汽液相质量流量；同时校核分组分质量和摩尔闭合。页面另外显示汽相质量率，避免与目标摩尔相率混用。
- 相重构总量与每个组分分别按各自进料流量执行 `1e-6` 相对容差，并保留质量/摩尔绝对残差与相对残差。50/50 水–乙醇 NRTL 工况最大逐组分质量相对残差为 `9.3655e-8`；原复核工况为 `5.4996e-8`。故障回放覆盖“整体组成不变但相分配错误”，必须被拒绝。

## 七组直连求解

所有工况均为 `1000 kg/h`、入口 `25 °C`、`101.325 kPa(a)`、目标汽相摩尔率 `50 mol%`。纯物质在给定压力下的两相平衡温度不因 5–95 mol% 的相率规格改变；这里的 50 mol% 用于同时检验两相返回和相率闭合，不能把混合物结果笼统称为沸点。

| 物系 | 物性包 | 温度 °C | 汽相摩尔率 | 汽相质量率 | 说明 |
|---|---|---:|---:|---:|---|
| Water | Steam Tables | 99.974300 | 0.500000 | 0.500000 | 纯物质常压两相温度 |
| Ethanol | NRTL | 78.655512 | 0.500000 | 0.500000 | 纯物质常压两相温度 |
| Ethanol | Raoult | 78.655512 | 0.500000 | 0.500000 | 纯物质理想对照 |
| Acetone | NRTL | 56.139572 | 0.500000 | 0.500000 | 纯物质常压两相温度 |
| Acetone | Raoult | 56.139572 | 0.500000 | 0.500000 | 纯物质理想对照 |
| Water/Ethanol 50/50 mass% | NRTL | 86.130179 | 0.500000 | 0.592830 | 混合物指定摩尔汽相率闪蒸温度 |
| Water/Ethanol 50/50 mass% | Raoult | 93.986779 | 0.500000 | 0.542223 | 理想溶液对照温度 |

NRTL 与 Raoult 相差 `7.856600 °C`，只证明物性包选择确实作用于模型，**不构成准确性验证**。

## 总控复核工况

- Water/Ethanol `60/40 mass%`、NRTL、`800 kg/h`、入口 `30 °C`、`150 kPa(a)`、目标汽相率 `40 mol%`。
- 修复前实际汽相率 `0.399989856997353`，目标误差 `-1.0143e-5`；模型内 PT 闪蒸内外循环设置均为 `1e-4`。
- 受控模板设置为 `1e-8` 后，实际汽相率 `0.400000018325163`，目标误差 `+1.8325e-8`；温度 `98.939841 °C`，热负荷 `217.186422 kW`。
- 最大逐组分质量和摩尔相对残差均为 `5.4996e-8`，低于逐组分 `1e-6` 门槛；没有放宽汽相目标或相衡算门槛。

## 外部参考层级

- Water：NIST 常压沸点 `373.17 K`；候选相差 `-0.045700 °C`。[NIST Water](https://webbook.nist.gov/cgi/cbook.cgi?ID=C7732185&Mask=4)
- Ethanol：NIST 常压沸点 `351.5 K`；候选相差 `+0.305512 °C`。[NIST Ethanol](https://webbook.nist.gov/cgi/cbook.cgi?ID=C64175&Mask=4)
- Acetone：NIST 常压沸点 `329.3 K`；候选相差 `-0.010428 °C`。[NIST Acetone](https://webbook.nist.gov/cgi/cbook.cgi?ID=C67641&Mask=4)
- 这些比较属于外部量级筛查，不设置未经来源支持的 `0.6 °C` 硬容差，也不是物性包精度认证。
- 水–乙醇已使用官方 Windows portable 10.2.8 运行时和本机 pin `0cd6a30` 源码构建的 Automation 驱动完成同模型重新求解，一致性结果相同；Automation DLL 不是 portable 自带文件。这仍不是实验数据验证或 P3 桌面 UI 验收。MCP 未暴露 NRTL 二元参数来源和有效温区，因此明确记录为未知，不因收敛而推断适用。
