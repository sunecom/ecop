# P4 生产发布归档

## 发布结论

总控已对 P4 生产线上验收作出正式 PASS 结论。生产发布目录为 `/opt/ecop-releases/p4-8b8e18f`，运行源码为 `8b8e18f`；本归档提交不改变该已验证运行源码。

## 运行身份

- Web Image ID：`sha256:7c43fd6b5e696fdeca3a9929358113e77db27eef73db2c1dc5ca552ceb5c3c47`
- DWSIM 仓库摘要：`ghcr.io/danwbr/dwsim-mcp@sha256:015fd7ecbf219192d6b9d81a9080ba02fd0de7d4b9388506c4ab755159032f36`
- DWSIM 运行 Image ID：`sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`
- 部署前备份：`/opt/ecop-backups/p4-pre-20260919T020432Z`，总控复核全部校验通过。
- 部署后备份：`/opt/ecop-backups/p4-post-20260921T001500Z`，总控复核全部校验通过。

## 部署事件与修复

首次发布时，发布目录的统一 `root` 所有权错误覆盖了两份 secret 文件的读取者，使 Web 进程读取 `/run/secrets/mcp_token` 失败并重启。未输出、复制或修改任何密钥内容。

修复操作仅恢复已验证权限：secret 目录 `700`、两个 secret 文件 `400`、文件所有者 `10001:10001`；随后强制重建服务。复核时 Web 与 DWSIM 容器均为 `0` 次重启，Web 健康状态为 `healthy`。该短暂启动失败已纳入总控生产复核；后续线上验收在恢复后执行。

## 总控证据引用

总控结构化证据位于其主工作区 `.local/qa/P4-controller/`：

- `production-checkpoint.json`：报告 SHA-256 前缀 `817a5ae9`。
- `production-project.json`：报告 SHA-256 前缀 `eb2b8bb7`。
- `production-browser/controller-production-browser.json`：报告 SHA-256 前缀 `77f02b1e`。

本工作区未持有上述文件的完整副本，因此不补写或猜测其完整哈希。总控已独立验证正式 HTTPS 真实联算、项目/版本/复制/比较、DWXML、Chrome `1440/390`、备份、容器/权限、P3 历史项目与旧导出保持。

总控浏览器项目为 `prj_25eca70a12a840e197d3814a0454d68d`，运行记录为 `cd34e39d…` 与 `d5bf1889…`；下载 DWXML 哈希前缀为 `f04677e3`。P3 历史项目 `prj_e0d548…` 及两份旧导出哈希前缀 `20160a…`、`740d3e…` 仍匹配。前缀保留为总控已报告信息，完整值以其结构化证据为准。

## 边界

P4 仅覆盖固定纯水预热—蒸发—汽液分离模板。多效蒸发、MVR、板式机械设计、工业盐料液和 P5 范围均不纳入本发布归档。
