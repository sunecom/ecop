# P3 项目、历史版本与桌面导出 schema 证据

## 持久化边界

- 项目数据使用 SQLite，数据库位于专用持久化卷 `/projects/projects.sqlite3`；DWSIM 导出位于 `/projects/exports`。Web 与 DWSIM 只共享 `/projects`。普通即时计算仍可写入独立 `/data/runs`，项目版本计算不写 legacy JSON，只由 SQLite 保存记录。
- `project-init` 是一次性 root 初始化服务，仅挂载 `projects` 卷，网络为空，`read_only=true`、`no-new-privileges=true`、先 `cap_drop: ALL`，再只加 `CHOWN`、`DAC_OVERRIDE`、`FOWNER` 以初始化 Docker 新卷权限。Web 与 DWSIM 仍为 `cap_drop: ALL`，没有扩大权限。
- Web 以 UID/GID `10001:10001` 使用 `/projects`；DWSIM 同样以 `10001:10001` 运行。DWSIM 模板目录 `/models` 保持只读。

## 数据模型

| 表 | 稳定 ID / 主键 | 作用 |
|---|---|---|
| `projects` | `prj_<32 hex>` | 认证主体的项目容器；`legacy_key` 仅用于旧记录迁移幂等定位 |
| `cases` | `case_<32 hex>` | 项目内工况名称与创建时间 |
| `case_versions` | `cv_<32 hex>` | 不可变输入快照、版本号、父版本 ID |
| `calculation_records` | 32 位十六进制 `run_id` | 不可变计算结果、引擎身份与时间 |
| `exports` | `exp_<32 hex>` | 受控导出相对路径、SHA-256、字节数和时间 |
| `legacy_imports` | `source_key` | 旧 `/data/runs/*.json` 的源路径加内容哈希，记录导入或非法状态 |

- `case_versions` 和 `calculation_records` 均有数据库触发器拒绝 `UPDATE` 与 `DELETE`；修改参数只能生成新版本，历史结果不能覆盖。
- 版本号在同一工况内唯一；父版本 ID 显式保存。项目、工况、版本、导出均使用服务端生成的不透明稳定 ID。
- Basic Auth 用户名通过 `SHA-256` 映射为 `usr_...` 所有者 ID；数据库不直接保存用户名。
- 输入和结果按严格 JSON 保存，拒绝非有限浮点数；请求体、项目名和 JSON 大小均有限制。

## API 契约

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` / `POST` | `/api/projects` | 列出或新建当前认证主体项目；列表响应含本次启动迁移统计 |
| `GET` | `/api/projects/<prj_id>` | 返回项目、工况、版本、记录和导出元数据 |
| `POST` | `/api/projects/<prj_id>/cases` | 以当前输入创建工况版本 1 |
| `POST` | `/api/cases/<case_id>/versions` | 以父版本和新输入生成不可变新版本 |
| `POST` | `/api/case-versions/<cv_id>/copy` | 将版本复制到新工况，生成新稳定 ID |
| `POST` | `/api/case-versions/<cv_id>/calculate` | 用真实 DWSIM 求解并保存受控 `.dwxml` |
| `GET` | `/api/compare?run_a=...&run_b=...` | 只比较签名兼容的记录 |
| `GET` | `/api/exports/<exp_id>` | 由导出 ID 下载 XML，不接受路径 |

- 所有业务接口均要求 Basic Auth；写操作还要求精确 Origin 和页面 nonce。未认证返回 `401`，Origin/nonce 错误返回 `403`。
- 浏览器只接收导出 ID。下载响应为 `application/xml`、文件名后缀 `.dwxml`，并返回 `X-Content-SHA256`；API、前端和错误响应均不暴露服务器绝对路径。
- 比较签名至少包括模块、设备类型、unit tag、指标、单位、物性包、物系、组成基准与组成；不兼容比较返回 `409`。

## DWSIM 导出事务

- 项目计算先由服务端生成受控导出路径，再调用真实 DWSIM 工作流。
- DWSIM 在关闭 flowsheet 前保存 `.dwxml`；服务端随后校验文件存在、大小和 SHA-256，再一次性写入计算记录和导出映射。
- 求解、保存或入库任一步失败都会删除部分导出，不留下可下载的半成品；项目入库失败也不会留下可被下次迁移误认成成功结果的 legacy JSON。
- 浏览器不提供任意路径、任意文件上传或用户指定服务器文件名入口。

## 迁移、重启与恢复

- 启动时扫描 `/data/runs/*.json`。`source_key` 由解析后的绝对路径和文件 SHA-256 组成；同一文件二次初始化只计入 `skipped`。
- R01 对每条 legacy 记录逐字段验证：顶层、`module`、`inputs`、`results`、`comparison` 必须为对象，模块标识与输入模块一致，run ID、设备类型、物性包、引擎、提交、比较指标/单位/有限数值均必填且有界。坏记录记为 `invalid` 后继续扫描，不再因嵌套类型错误阻断启动。
- 只有数据验证错误会转为 `invalid`；SQLite 数据库异常继续向上抛出，避免把存储故障伪装成坏数据。候选运行时夹具首次 `imported=1, invalid=3`，二次 `skipped=4`；注入数据库触发器故障得到 `IntegrityError` 且没有 `legacy_imports` 记录。
- 干净数据库夹具实测首次为 `imported=1, skipped=0, invalid=0`，第二次为 `imported=0, skipped=1, invalid=0`；两次后项目、工况、版本、记录和 `legacy_imports` 均各 1 条。
- 实际候选 Web 重建前后数据库计数完全一致；启动响应均为 `imported=0, skipped=7, invalid=0`。候选自身的旧式 JSON 记录会被扫描登记，但已存在的 `run_id` 不会重复生成计算记录。
- SQLite 使用在线备份 API 生成一致性副本；恢复验证在全新卷 `ecop-p3-projects-restore` 中打开备份，并逐一核对项目、3 个 run 与 3 个导出 SHA-256。

原始迁移证据位于本地 `.local/qa/P3/p3-migration-idempotency-evidence.json`，远端同名文件位于 `/opt/ecop-candidates/p3-bdb319e/.local/qa/P3/`，SHA-256 为 `de7cdb280a4ab2f5781011e5865d4a3620636e85739aff08bbdd399e80dc8bbb`。
