# ECOP 云端受控演示 V0.1

AiToMoney 为客户 ECOP 提供的纯水蒸发计算技术验证。域名 `ecop.aitomoney.online`，仓库 `https://github.com/sunecom/ecop.git`。

## 部署边界

本地 `本地演示/server.py` 入口保留；云端通过 `cloud_app.py` 和 Gunicorn 服务。Web 只有一个 worker，四个线程；进程内锁串行调用一个 DWSIM 引擎。**不要直接增加 worker 或复制 Web 容器共享引擎**。此版本无多租户、任务队列、持久化账户体系，也不是板式蒸发器选型、多效或 MVR 工程设计系统。

所有页面及业务 API 使用 Basic Auth；应用内仅 `/healthz` 返回无敏感内容的存活状态，生产 Nginx 可选择不公开该路径。计算 POST 另验证同源 Origin 和页面 nonce。MCP token 不传至浏览器，MCP 不映射宿主端口、无公网路由。Web 同时接入普通 `edge` 网络和隔离的 `engine` 网络，宿主端口仅监听 `127.0.0.1:18765`；DWSIM 只接入 `engine`。两个容器将 `HOME` 指向可写的 `/tmp`；DWSIM 以 UID/GID 10001 读取只读 secret，并在 token 为空时拒绝启动。所有登录账户共享同一演示空间。

## 固定引擎

官方镜像 `ghcr.io/danwbr/dwsim-mcp:10.2.8`，2026-09-18 从 GHCR Registry API 核验的 OCI index digest：

`sha256:015fd7ecbf219192d6b9d81a9080ba02fd0de7d4b9388506c4ab755159032f36`

amd64 manifest digest 为 `sha256:f194c706c6bde5d290768703b5f402de66e37a31c589a8be0fe39f97f86c1f72`。镜像配置核验启动路径 `/opt/dwsim-mcp/dwsim-mcp`，参数 `--http --host 0.0.0.0 --port 5901`。Compose 加载 secret 并追加官方 `--token`。上游镜像使用 Ubuntu 24.04 的 .NET runtime-deps 和 fontconfig；不要求宿主机也是 Ubuntu。

镜像来自官方版本发布，不将其未经证明标成与本机源码提交完全相同；结果记录使用镜像摘要。参考：[官方 Docker 文档](https://github.com/DanWBR/dwsim10/tree/0cd6a30ce1b5eb976cdd94495d102a9691b067f5/packaging/docker)。本机源码 pin 为 `0cd6a30ce1b5eb976cdd94495d102a9691b067f5`。DWSIM 归原作者，适用其 GPL-3.0-or-later 许可；AiToMoney 标识不覆盖第三方权利。

## 启动

工作目录 `/opt/ecop`，仅上传版本库精选文件，不上传 SDK、研究报告、原始 DWSIM 源码、日志或运行记录。

1. 准备 Docker Engine 和 Compose v2。现有服务器软件无需全局重启。
2. 将 `deploy/.env.example` 复制为 `deploy/.env`，确认 HTTPS 域名及空闲本机端口。
3. 管理员通过安全渠道准备 `deploy/secrets/ecop_password.txt`（至少16字符随机密码）与 `deploy/secrets/mcp_token.txt`（随机 token）。不提交到 Git；目录0700、文件所有者10001:10001且权限0400，供容器用户读取，禁止其他用户读取。不要把密码写入命令日志或聊天记录。
4. `docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet`
5. `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build`
6. `docker compose --env-file deploy/.env -f deploy/compose.yaml ps`
7. 将现有 Nginx/Caddy 增加该域名站点，反代到 `127.0.0.1:18765`、保留 Host、请求超时至少240秒、请求体限制4KB；申请并启用 HTTPS。`Caddyfile.example` 只是站点片段，不覆盖已有配置。

健康检查 `/healthz` 只证明 Web 存活；通过认证的 `/api/status` 才验证 MCP。首次引擎初始化可能暂时返回503，刷新后再试。

停止仅本项目：`docker compose --env-file deploy/.env -f deploy/compose.yaml stop`。更新前备份 `ecop_runs` volume 和部署配置，保留旧发布目录和镜像以便回滚。不要执行 `down -v`，否则会删除运行记录。运行记录位于独立 volume，无公开读取端点；需按业务留存期限清理和备份。

## 验证

本地：`python deploy/test_cloud_adapter.py --real-engine` 使用现有本机 MCP，验证认证、同源、无效输入、错误信息隐藏和真实计算；不加参数只进行模拟单元检查。Windows 检查不等于 Linux 验证。

目标服务器必须实际验证：未登录返回401；登录页面200；MCP在线；1000kg/h、25°C、101.325kPa、汽化30%得汽化水量300kg/h、出口约99.9743°C、热负荷约275.28435kW；2000kg/h得600kg/h与550.56869kW；错误输入拒绝；MCP无宿主端口。每次换镜像必须重复基准算例。

在目标服务器执行 `python3 deploy/smoke_test.py` 验证回环入口；再执行 `python3 deploy/smoke_test.py --base https://ecop.aitomoney.online` 验证正式 HTTPS 入口。两次均使用相同的认证、同源、nonce、非法输入和真实计算断言，脚本不会打印密码或认证头。

## 已知限制与后续

- 本机 pin 的组分参数会覆盖总流量，已先设置组分后重新设置总流量并读回验证。真实结果与物料衡算校验保留。
- 目前单引擎串行、无任务队列。取消、超时和失败后的引擎彻底隔离尚待实现；扩展时应每任务独立进程/容器并设置总耗时。
- Basic Auth 用于受控演示，不是客户正式账号体系。需补充权限、审计、队列、资源配额和工程校核工作流后再产品化。
- 数据 volume 会增长；应监控磁盘并建立保留策略。日志已限制轮转，但运行记录尚无自动清理。
- Python基础镜像已固定版本系列，尚未锁定不可变digest；上线正式版本前应锁定并建立安全更新流程。
- 不访问或修改服务器其他站点，不自动注册开机之外的计划任务。Docker仅本项目容器采用unless-stopped重启策略。
