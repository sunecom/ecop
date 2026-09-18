# P2 R03 生产发布记录（2026-09-19）

## 放行与版本

- 总控独立复核结论为 `PASS`：R01、R02、R03 关闭，并授权一次受控生产发布；P3 在总控线上独立验收前继续 `HOLD`。
- 生产运行时代码提交：`bb414312118773f8cb9ed7b6e35dfd17fb499e61`。
- 发布时文档提交：`4935bfd7c0e3b4a9ef928ee839a865c142ca92dc`。
- 生产 Web 镜像：`sha256:026fa25d1ccce82974588a7482b8e7cb6e7f1b7d57814f92102f42fb2360bdff`，启动时间 `2026-09-18T17:03:57.80636353Z`。
- 生产 DWSIM 镜像保持为 `sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间 `2026-09-18T17:03:56.914245358Z`。
- DWSIM 新增 `/opt/ecop/deploy/models:/models:ro` 只读挂载；固定 DWSIM 镜像未重建。
- 受控模板清单 `deploy/models/manifest.json` 的 SHA-256 为 `153a7b6215eb37a783ce7f74c2230cdfb6f24ae5522dd1c67933aa28bf56d9ae`。
- 精确模板运行包 SHA-256 为 `cbb99699c17a616226cd28b39381b983b83213d43cc4fa56a40dd9482f0af811`。

## 发布过程

- 首次切换在模板哈希门禁处安全终止：Windows `git archive` 将模板 XML 的 LF 转换为 CRLF，归档内模板哈希因此不等于受控清单值。
- 门禁触发后立即恢复原 Web 镜像运行，没有进入候选运行时，也没有覆盖生产数据。
- 随后改用工作树字节级模板归档，逐一校验 7 个模板哈希均与清单一致，再重新创建 DWSIM 和 Web 容器。
- `deploy/smoke_test.py` 的目录断言仍为旧值 9；P2 发布后目录实际为 10。生产最小冒烟改用独立只读脚本完成，本记录同时将正式冒烟脚本断言修正为 10。

## 备份与回退

- 备份目录：`/opt/ecop/.rollback/r03-20260918T170051Z`，文件权限收紧为仅 root 可访问。
- 旧 Web 回退标签：`ecop-web:rollback-r03-20260918T170051Z`；新 Web 标签：`ecop-web:r03-bb41431`。
- 完整校验表 `SHA256SUMS` 的 SHA-256 为 `e2647bbe2e7b85a35f841478c03c8ca358706f62d85baaa0c56d0cc5f8b424ea`。
- `ecop-web-image.tar.gz` 已通过 `gzip -t`；`dwsim-image.tar` 已通过 tar 目录读取。

| 备份文件 | SHA-256 |
| --- | --- |
| `dwsim-image.tar` | `28baffd4b5a8c949c1b9670a879c0d50cfc6d7a771a5ab1e7d13ceabc7289f4b` |
| `ecop-deployment-tree.tgz` | `c21dc4aacb581c230f1515c9eff520fa563c51642f2cec530ac6df3c7e88c961` |
| `ecop-dwsim-container.json` | `271cbc02a367e13b09b835c45ee612d2d9b9919232f33e5e9b0bff69a689f56a` |
| `ecop-dwsim-image.json` | `7c3cd67413d86bcab0c14a74c248eb416db3d5d3c372921ccf9d807ec6f67a11` |
| `ecop-runs-volume.tgz` | `8726b4dd84604dd8bc94daa2584afa523e474b53cbfadc79b0923cf91b8d9538` |
| `ecop-web-container.json` | `5879899f8ddd1afd704dbe669fa9a63427f5048268172b98edc48c553a6d2231` |
| `ecop-web-image.json` | `5d47b3d7e1a989952f7674060b848add1166c0f187ff4ef1462f94c408f35b23` |
| `ecop-web-image.tar.gz` | `64ed4bd9f8d85ecacbd08af623b2fc42adff9e52bf8064526dc407f9080994e5` |
| `manifest.txt` | `888d7ecf6e54a0c52b9e63e9001da5923cff436356605469583f6f98e74dda6f` |
| `production-loopback-minimal-smoke.json` | `e8d70d370f93325fdd01a7de38041be4fdf9fe89a65c2af9c30fb6851a4f2ba3` |

## 生产最小冒烟

- 通过生产主机 loopback、生产 Basic Auth 和生产 Origin 完成认证、状态、目录 10 个工作流及一个 P2 原失败工况回放。
- 运行 ID：`f4298cf8f5d94c23b814be00ea92209f`。
- 工况结果：温度 `98.93984125206543 °C`，实际汽相摩尔率 `0.40000001832516296`，最大逐组分质量相对残差 `5.499574378120542e-08`。
- 冒烟证据：`/opt/ecop/.rollback/r03-20260918T170051Z/production-loopback-minimal-smoke.json`，SHA-256 `e8d70d370f93325fdd01a7de38041be4fdf9fe89a65c2af9c30fb6851a4f2ba3`。

## 门禁结论

- P2 R03 已按总控授权发布，运行镜像、7 个模板、只读挂载、备份和最小冒烟均已复核。
- 本次发布不扩大物系白名单，不把守恒结果表述为物性准确性认证。
- P3 继续 `HOLD`，等待总控线上独立验收，不由执行端自行放行。
