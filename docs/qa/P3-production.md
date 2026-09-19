# P3 生产部署记录

## 发布身份

- 发布源码提交：`9bc2685decf9e88e990eb72bf2d7b7e259ab040f`；候选源码包 SHA-256：`a8366049c4e77ed7884c8d0ab1cda28b2740b655d900b447851f2dfd3d75cf66`。
- 生产发布目录：`/opt/ecop-releases/p3-9bc2685decf9e88e`；保留旧生产目录 `/opt/ecop`，旧 Web 镜像已固定为回滚标签 `ecop:pre-p3-026fa25d1ccce82974588a7482b8e7cb6e7f1b7d57814f92102f42fb2360bdff`。
- Web 镜像：`sha256:cba2cb14d987ba0244f9874cd48edd3d09dfa48137956023df45a20a5b42c886`，健康启动时间 `2026-09-19T00:43:55.372977897Z`。
- DWSIM 镜像：`sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`，启动时间 `2026-09-19T00:39:39.944687478Z`。
- 仅部署 P3 已验候选及生产既有域名/secret 配置；未混入 P4。文档不记录任何密码或令牌。

## 备份与迁移

- 部署前备份：`/opt/ecop-backups/p3-pre-20260919T003748Z`；切换瞬间运行记录归档：`/opt/ecop-backups/p3-cutover-20260919T003935Z/ecop_runs-at-cutover.tar.gz`，SHA-256 `8b083dfb60b5cb775134ade2e61f7c4815431c9fe052d0a56c7f95c5a1af92c9`。
- 发布后在线 SQLite 备份与导出归档：`/opt/ecop-backups/p3-post-20260919T005207Z`；数据库 `projects.sqlite3` SHA-256 `3d7349aaf318932fcf50d9cdd527a4af6d8840e0ceab406f71a49f96f9347ed3`，导出归档 SHA-256 `0c535efb3d4380e296130e17c8dcc63875c9ddc0d82f0fa5676d5087cdbb883d`，SQLite `integrity_check=ok`。
- 生产启动迁移导入 85 条旧记录，5 条旧 JSON 因 `module` 不是 R01 所要求的对象格式而记为 `invalid`；这 5 个原始 JSON 未删除，仍保留在 `ecop_runs`，但不会出现在 SQLite 项目历史中。此历史兼容性缺口已单独记录，等待总控判定，不通过改写原始文件掩盖。
- Web 重建后，9 条刚执行的普通计算 JSON 以 `imported=9, skipped=90, invalid=0` 迁移；生产 SQLite 当前完整性为 `ok`，计数为 4 项目、97 工况、99 版本、98 记录、4 导出、99 条迁移索引。

## 线上验收

- 回环 API 与正式 `https://ecop.aitomoney.online` API 均通过认证、页面、引擎、目录、组分检索、9 笔真实计算、非法输入和跨域拒绝，共 8 类检查；证据 SHA-256 分别为 `3f929cb71f2a1abe61da920f7ca783ee7e2ecceda444d18dca3d261e4d7058f5` 和 `47b8112d2ac31ab8521656afd6e4696aedc555579cc442e4470e37c03dcb7378`。
- P3 项目回归创建 30%/45% 两个不可变版本：run `a9403217f2a5447c84b4ca4157436dcb` 与 `d39918cf12d94493a1e3545eff315325`；热负荷为 `275.28434656470915 → 369.3068777412824 kW`，差值 `94.02253117657324 kW`。两份导出 XML 可解析，SHA-256 分别为 `f81407b37752dca045f925f8bea54c7a06f587bc12fb7ab0903b2886daa89a88`、`a942dd8a42d98d6787beee409a4c0fb605a3316220ec6bf0fca40965f499dcd1`。
- 仅重建 Web 后，上述项目、2 条 run 和 2 份导出哈希全部仍可读取；证据 SHA-256 `7102ea2810cc63ee288070db161cf0283c796a48098cd93180e9c0adad00b890`。
- 真实 Chrome 通过正式 HTTPS 入口完成项目创建、30%/45% 计算、比较、DWXML 下载、刷新后的持久化与 1440px/390px 布局检查。run 为 `c029fab920094275983cb9edee1f4338`、`d28583dd17534e5c8daae3963329cb2e`；下载 SHA-256 `50cb9c46c2c842e25d469a5f968bb352f4181082b92fa07a00a70070eadb46c9`；两种视口横向溢出均为 0，console/page error 均为 0。
- 上述 4 条项目计算 run 已逐项核对不存在 `/data/runs/<run_id>.json`，确认项目计算只写 SQLite 与受控导出；证据 SHA-256 `287d66602fa6d0bc5ba5f3fd74bb563405be2c55d292e91e2d1e537c34dffb3c`。

## 证据与状态

- 远端证据根目录：`/opt/ecop-releases/p3-9bc2685decf9e88e/.local/qa/P3-production`；本地镜像：`.local/qa/P3-production/remote`。
- 部署状态包 SHA-256：`fbc47bfa6691b826a221aa03346a1205bbda0a820b2d648d33f198fc5af9b210`；其中包含容器启动信息、卷文件计数、数据库计数、备份路径和各验收证据哈希。部署日志为 `production-web-deployment.log`，SHA-256 `f2926413be67b47f0c7e55675b841132e105f9ba26e26756f9411fdc1bdbaefc`。
- 生产服务正在健康运行；P4 继续 HOLD。P3 线上验收结论由总控独立复核后确认。
