# R02 · P1B 生产发布记录

## 审定构件

- 应用提交：`f0e89146e27b136bc08dfd0e7e21b9c0b09de76d`
- Web 镜像：`sha256:6932a71e0f3e3701dc8666811f6d1faaaa92120c00be5e17f7ecc59645d7ff8e`
- 生产 Web 启动时间：`2026-09-18T14:56:40.760374577Z`
- DWSIM 镜像：`sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`
- DWSIM 启动时间仍为：`2026-09-18T04:16:21.50725706Z`
- 变更边界：仅使用 Compose `--no-deps --no-build --force-recreate web` 重建 Web；未重启 DWSIM，保留生产 HTTPS、凭据、网络和数据卷。

## 发布前备份

- 回滚目录：`/opt/ecop/.rollback/r02-20260918T145528Z`
- 旧 Web 镜像：`sha256:e155dd4ab269220420de4449c35b9865dea2953d3c49792417ce43d002d4463f`
- 旧 Web 启动时间：`2026-09-18T13:48:19.934631809Z`
- 旧镜像标签：`ecop-web:rollback-r02-20260918T145528Z`
- 部署树归档 SHA-256：`336c8a761ce613078b0c45ad4c64a2d07abdf4e8e88e7bbda78802f0235c271f`
- 数据卷归档 SHA-256：`b6d7ea7b7183f7f636e38182a87e5ec4c69de329f49900312910def6b368ad4a`
- 旧 Web inspect SHA-256：`03c9a3aa058e63d5bb999efd1d8cd6b9ef4c36f5f0e256f8f9217f1f60b3e51a`
- DWSIM inspect SHA-256：`271cbc02a367e13b09b835c45ee612d2d9b9919232f33e5e9b0bff69a689f56a`
- 两个 tar.gz 均已通过 `gzip -t`；哈希均从实际文件读取。

## 生产自检

- 回环入口 `127.0.0.1:18765`：认证、页面、引擎、目录、组分、九次真实计算、非法输入和跨域拒绝全部通过；证据 SHA-256 `75d7a71da7ba60bafefbd9d6652832964e2590c7603720bfba5b1c2dbf39269f`。
- HTTPS 入口通过本机 Nginx、真实 TLS/SNI 与正式域名执行同一套九次真实计算；证据 SHA-256 `c140216675cbd2f85762db6cadaa8ce4d74a031f8c9ef1d6eb9abcb925cbeb78`。
- 回环新增模块 run_id：HeatExchanger `dc1eb8f01afd4965b4b44aa5e337bff2`、Compressor `c63deb96819545f098da6ba56cc04b2a`、Vessel `5e3c7d0c3cb64c78bec11e78cf8bf019`。
- HTTPS 新增模块 run_id：HeatExchanger `49496ed6590e42d79865f9dc8f9d0154`、Compressor `768d4b9f79764a0e84a31916aa000e6b`、Vessel `171f701e717d4d72b409d15bf2100ede`。
- 两个入口均得到换热器两侧压降 `0 kPa`、压缩机功率相对误差 `2.09e-9`、Vessel 汽/液产品 `300/700 kg/h` 且最大压力残差 `0 kPa`。

## 回退步骤

1. 在 `/opt/ecop` 停止并仅移除当前 Web 容器，不停止 DWSIM。
2. 将 `ecop-web:rollback-r02-20260918T145528Z` 重新标记为 `ecop-web:latest`。
3. 如需恢复部署文件，先校验 `SHA256SUMS`，再将 `ecop-deployment-tree.tgz` 解压到 `/opt/ecop`。
4. 仅当数据确认需要回退时，停止 Web 后校验并恢复 `ecop-runs-volume.tgz` 到 `ecop_runs`；正常应用回退不得覆盖新增运行记录。
5. 执行 `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --no-deps --no-build --force-recreate web`。
6. 核验 Web 实际镜像为旧镜像、回环与 HTTPS 自检通过，并再次确认 DWSIM 镜像与启动时间未变化。

## 状态

- P1B-R01 候选总控独立复核：PASS。
- R02 生产 Web 部署与最小自检：PASS。
- 总控线上独立验收前，P2 继续 HOLD。
