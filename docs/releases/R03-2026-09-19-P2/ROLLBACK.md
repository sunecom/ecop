# R03 回退操作

以下命令仅在另行批准的维护窗口内执行。先确认没有运行中的计算，并保留发布后新增数据；普通代码回退不得恢复旧数据卷。

## 1. 校验备份

```bash
sudo -i
backup=/opt/ecop/.rollback/r03-20260918T170051Z
cd "$backup"
sha256sum -c SHA256SUMS
gzip -t ecop-web-image.tar.gz
tar -tf dwsim-image.tar >/dev/null
```

全部校验通过后方可继续。

## 2. 仅回退 Web（首选）

```bash
sudo -i
docker tag ecop-web:rollback-r03-20260918T170051Z ecop-web:latest
cd /opt/ecop/deploy
docker compose up -d --no-deps --no-build --force-recreate web
docker inspect ecop-web-1 --format '{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}'
docker inspect ecop-dwsim-1 --format '{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}'
```

预期：Web 使用回退镜像；DWSIM 镜像和启动时间不变。随后从生产 loopback 验证认证、`/api/status`、目录和一条既有基线，不直接从公网执行批量计算。

## 3. 回退应用树和 Web

```bash
sudo -i
backup=/opt/ecop/.rollback/r03-20260918T170051Z
cd /opt/ecop
tar -xzf "$backup/ecop-deployment-tree.tgz"
docker tag ecop-web:rollback-r03-20260918T170051Z ecop-web:latest
cd /opt/ecop/deploy
docker compose up -d --no-deps --no-build --force-recreate web
```

这一步恢复发布前应用/配置树，但不恢复数据卷，也不重建固定 DWSIM 镜像。若旧 `compose.yaml` 不含 `/models` 挂载，不得自行重建 DWSIM；需先由总控确认是否移除挂载。

## 4. 镜像归档恢复（仅本地标签缺失时）

```bash
sudo -i
backup=/opt/ecop/.rollback/r03-20260918T170051Z
gzip -dc "$backup/ecop-web-image.tar.gz" | docker load
docker load -i "$backup/dwsim-image.tar"
docker image inspect ecop-web:rollback-r03-20260918T170051Z >/dev/null
```

加载后回到“仅回退 Web”步骤。固定 DWSIM 镜像只有在镜像本身丢失且总控明确批准时才从归档加载和重建。

## 5. 数据灾难恢复（禁止作为普通回退）

`ecop-runs-volume.tgz` 只用于总控批准的数据灾难恢复。执行前必须另行备份当前卷，停止 Web，记录当前数据条目数量和哈希；恢复会丢失发布后新增记录，因此不能随代码回退自动执行。

