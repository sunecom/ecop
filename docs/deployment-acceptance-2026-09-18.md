# ECOP 云端受控演示部署验收记录

- 验收日期：2026-09-18（Asia/Shanghai）
- 正式地址：https://ecop.aitomoney.online
- 应用部署版本：`946efeb8a9517ccb20580449a3a501534c36d2d7`
- DWSIM 镜像：`ghcr.io/danwbr/dwsim-mcp:10.2.8@sha256:015fd7ecbf219192d6b9d81a9080ba02fd0de7d4b9388506c4ab755159032f36`
- 验收范围：纯水加热汽化技术验证；不包含板式蒸发器选型、多效蒸发或 MVR 设计。

## 部署修复

1. Web 同时接入普通 `edge` 网络和内部 `engine` 网络，恢复 `127.0.0.1:18765` 回环端口访问；DWSIM 仍只接入内部网络。
2. DWSIM 以 UID/GID 10001 运行，可读取 `10001:10001/0400` 的 MCP token；启动脚本在 token 为空时直接退出，禁止无认证启动。
3. Web 与 DWSIM 的 `HOME` 均设为 `/tmp`，Gunicorn 控制目录可在只读根文件系统下正常创建。

## 验收结果

| 检查项 | 结果 |
| --- | --- |
| Compose 配置 | `docker compose config --quiet` 通过 |
| 容器状态 | `ecop-web-1` healthy；`ecop-dwsim-1` running |
| DWSIM 初始化 | 10.2.8 正常启动，动态注册 48 个工具 |
| 回环入口 | `python3 deploy/smoke_test.py` 全部通过 |
| 公网 HTTPS | `python3 deploy/smoke_test.py --base https://ecop.aitomoney.online` 全部通过 |
| 认证 | `/`、`/api/status`、`/api/calculate` 未认证均返回 401；认证页面返回 200 |
| 请求防护 | 非法输入返回 400；错误 Origin 或 nonce 返回 403 |
| 端口隔离 | Web 仅发布 `127.0.0.1:18765`；DWSIM 无宿主端口 |
| Secret 权限 | `deploy/secrets` 为 0700；两个 secret 为 10001:10001/0400；未输出密钥内容 |
| 持久化 | 强制重建 Web 前后运行记录均为 4 条，命名卷数据保持不变 |
| 健康检查 | 回环 `/healthz` 返回 200；公网由 Nginx 按配置隐藏并返回 404 |
| Nginx | `nginx -t` 通过并已提供有效 HTTPS；未修改其他站点 |

## 基准算例

| 进料流量 | 入口条件 | 汽化比例 | 出口温度 | 热负荷 | 蒸汽量 | 质量残差 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1000 kg/h | 25°C，101.325 kPa(a) | 30% | 99.974300°C | 275.2843466 kW | 300.0000000 kg/h | 0.0 kg/h |
| 2000 kg/h | 25°C，101.325 kPa(a) | 30% | 99.974300°C | 550.5686931 kW | 600.0000000 kg/h | 0.0 kg/h |

结果随流量线性翻倍，物料衡算残差为零。结果记录中的 `commit` 字段标识固定 DWSIM 镜像摘要，不将其与本机源码 pin 混淆。

## 版本对应

服务器上的 `deploy/compose.yaml` 与 `deploy/smoke_test.py` 来自应用部署版本 `946efeb8a9517ccb20580449a3a501534c36d2d7`。本验收记录作为后续文档提交加入 `main`；功能文件在该文档提交中未再变化。
