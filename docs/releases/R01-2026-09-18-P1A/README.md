# R01 — P1A 生产发布归档

## 标识

- 发布日期：`2026-09-18`。
- 生产审计提交：`5effd72dd270736b92ac4ffb8845473f3a9b9c72`。
- 发布记录提交：`924bef390ad2847f00da8a47feb95363cd9ec24a`。
- 生产 Web 镜像：`sha256:e155dd4ab269220420de4449c35b9865dea2953d3c49792417ce43d002d4463f`。
- 生产 DWSIM 镜像：`sha256:ce00bf065a3d5f1160d24934527b45822a22a3020745ff5a4ce1ffb7b796cacf`；发布期间未重启。
- 服务器备份目录：`/opt/ecop/.rollback/p1a-5effd72-20260918T134252Z`。

## 结果

- 总控修订候选复核：`PASS`；`P1A-R01` 关闭。
- 生产上线后 Mixer、Splitter、Valve 三个真实 DWSIM 工况通过，运行 ID 分别为 `5de2605c9ca24db9b00dac5e76ec40d1`、`cc1da828d50149968c8dde24e72572ed`、`2a4bd6be58ec40b8a3cfa8dd7642f0c1`。
- Web 容器健康，生产 HTTPS 与认证配置保留，未认证接口返回 `401`。
- P1B 在总控线上最终验收前保持 `HOLD`。

## 回退

```bash
docker tag ecop-web:rollback-20260918T134252Z ecop-web:latest
cd /opt/ecop/deploy
docker compose up -d --no-deps --no-build --force-recreate web
docker inspect ecop-web-1 --format '{{.Image}} {{.State.Health.Status}}'
docker inspect ecop-dwsim-1 --format '{{.Image}} {{.State.StartedAt}}'
```

普通 Web 回退不恢复数据卷，避免覆盖发布后新增记录。发布详情见 `docs/qa/P1A-release-2026-09-18.md`，哈希勘误见本目录 `ERRATA.md`。

