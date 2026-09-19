# P4 设计冻结：预热—蒸发—汽液分离固定组合模板

## 目标与边界

P4 仅提供纯水在**同一实际 DWSIM flowsheet**中的固定串联系统：`FEED → H-01 预热器 → PREHEATED → EV-01 蒸发器 → TWO-PHASE → V-01 分离器 → VAPOR + LIQUID`。三个设备必须由同一次 `dwsim_solve_run` 联算并返回同一 flowsheet ID 的对象和中间物流结果；不得把三个独立求解的 JSON 结果拼成流程结论。

备选方案中，“复用三个单设备 API 后在服务端拼接”因无共同物料流和总体平衡而拒绝；“由用户上传任意 flowsheet”因自由度、路径和权限边界不可控而延后。采用固定拓扑、服务端生成对象名和受控 DWXML 导出的方案。

不覆盖多效蒸发、MVR 闭路、板片机械选型、工业盐料液、结垢、传热面积计算或工程设计能力。

## 拓扑、自由度与输入契约

| 对象 | 类型 | 固定契约 / 自由度 |
|---|---|---|
| `FEED` | Material Stream | 纯水；`flow_kg_h`、`feed_temperature_C`、`pressure_kPa` |
| `H-01` | Heater | `CalcMode=OutletTemperature`；`preheat_temperature_C`；零压降、效率 100% |
| `PREHEATED` | Material Stream | 仅中间物流，必须单液相 |
| `EV-01` | Heater | `CalcMode=OutletVaporFraction`；`vapor_percent`；零压降、效率 100% |
| `TWO-PHASE` | Material Stream | 仅中间物流，目标汽相摩尔分率必须达到 |
| `V-01` | Vessel | 无新增规格；一个进料、气/液两个产品端口 |
| `VAPOR` / `LIQUID` | Material Stream | 仅结果流；分别必须为纯汽相 / 纯液相 |

输入均使用 SI 显式换算：`kg/h → kg/s`、`°C → K`、`kPa → Pa`、百分数 → 0–1 分率。初版范围为：`flow_kg_h 10–100000`，`feed_temperature_C 5–80`，`pressure_kPa 60–1000`，`preheat_temperature_C` 必须高于进料至少 `2 °C` 且低于同压力泡点至少 `2 °C`，`vapor_percent 5–80`。物性包固定为引擎库存中的 Steam Tables，组分固定 Water=1；请求不得包含自由 flowsheet、物性包、设备属性或服务器路径。

## 输出契约、验收容差与拒绝策略

结果必须显示各单元状态和 `FEED`、`PREHEATED`、`TWO-PHASE`、`VAPOR`、`LIQUID` 的流量、温度、压力、汽相分率、比焓；同时输出 H-01 与 EV-01 热负荷、V-01 两相分流及三段质量/能量残差。比较指标固定为 EV-01 热负荷或汽相产品流量，并包含模块、拓扑版本、物性包和单位签名。

运行前声明容差：每个串联段及全流程质量残差 `≤ max(1e-6 kg/h, flow×1e-8)`；预热与蒸发压力偏差 `≤0.02 kPa`；预热出口温度偏差 `≤0.02 °C`；蒸发目标汽相分率绝对偏差 `≤1e-6`；V-01 分离能量相对残差 `≤1e-4`；`VAPOR` 汽相分率 `≥0.999999`、`LIQUID` 汽相分率 `≤1e-6`。基准、扰动、输入范围/相态拒绝和引擎不收敛/求解失败均须在候选运行前留证；失败不得生成项目记录或 DWXML。

P4 复用 P3 的项目、复制、不可变版本、比较、受控导出和桌面交接机制，但仅在 P4 隔离候选（独立 Web/DWSIM、端口、runs/projects 卷）中开发和验收。生产、P4 以外的范围及 P5 均不变更。
