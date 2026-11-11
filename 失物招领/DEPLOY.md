# 寻物智联部署手册

从项目的 `失物招领` 目录运行以下命令。Ubuntu 22.04 和 24.04 使用 Docker Compose，应用镜像使用 Node.js 22，容器内以 `node` 用户运行。默认只有 Nginx 的端口对宿主机开放。

## 环境切换

| 项目 | 本地开发 | 公网演示 | 校内生产目标配置 |
| --- | --- | --- | --- |
| 运行方式 | Node.js 22 LTS | Ubuntu + Compose | Ubuntu + Compose，或 PM2 + Nginx |
| `NODE_ENV` | `development` | `production` | `production` |
| `BASE_URL` | 留空，按请求来源识别 | `http://服务器IP` 或 `https://已配置的域名` | `https://已获批的校内域名` |
| `SESSION_SECRET` | 可留空，重启后需重新登录 | `deploy.sh` 首次生成，更新时保留 | 每套环境单独生成并妥善保管 |
| `TRUST_PROXY` | `0` | `1`，应用端口仅容器网络可达 | 直连 `0`，单层受控 Nginx `1` |
| `CAS_ENABLED` | `false` | `false`，本地账号登录 | 当前制品用 `false` 完成部署验证。接入学校 CAS 后才切换为 `true` |
| `DB_PATH` | `data/xunwu.db` | `data/xunwu.db` | Compose 使用 `data/` 卷内路径 |
| `IMAGE_STORE` | `db` 或 `file` | `file` | `file` |
| `SEED_DEV_USER` | 默认为 `false`，需要样例才启用 | `false` | `false` |
| `CORS_ORIGIN` | 同源留空 | 同源留空 | 同源留空，跨源时填受信的完整来源 |
| `RATE_LIMIT` | 默认 `20` | 同一 IP 每 15 分钟的登录和注册合计 20 次，发布另计 | 按校园出口流量调整 |
| 地图与 OCR | SVG 无需 key | `MAP_KEY`、`OCR_SECRET_ID`、`OCR_SECRET_KEY` 留空 | 仅在相应服务接入后向后端注入 |

当前压缩包只有本地账号认证。启用 `CAS_ENABLED=true` 会明确拒绝启动。校方完成 service 回调登记、HTTPS 和测试账号准备后，还需接入 CAS 票据校验和会话签发。校内环境可先用表中的本地账号配置验收部署。任何环境均应为 `BASE_URL` 使用浏览器实际访问的协议、主机和端口。

### 本地开发

无 `.env` 时默认可开发启动。

```bash
npm ci
npm start
```

访问 `http://127.0.0.1:3000`。如果从模板复制 `.env`，开发时设置 `NODE_ENV=development`、`TRUST_PROXY=0`，并将 `BASE_URL` 留空。启用 `SEED_DEV_USER=true` 后，新建样例账号的随机密码会在控制台打印一次。修改前端样式类名后运行 `npm run build`。

### Ubuntu 公网演示

将制品解压到 Ubuntu，进入 `失物招领` 目录。服务器需能访问 Docker 软件仓库、Docker 镜像仓库和 npm 注册表，并开放入站 TCP 80。

```bash
bash deploy/deploy.sh
curl -fsS http://localhost/health
```

首次运行会安装依赖、生成权限为 `0600` 的 `.env`，然后构建并启动应用。首次输出应含 `{"status":"ok"}`。脚本可以重复执行并保留现有密钥和数据。Docker 需要提权时脚本会使用 `sudo`，后续手工 Compose 命令也使用同一权限。IP 演示使用 HTTP，使用临时演示账号与虚构联系方式。可在 `.env` 中设置 `BASE_URL=http://实际IP` 固定访问来源。

```bash
docker compose ps
docker compose down
docker compose up -d --wait
curl -fsS http://localhost/health
```

`down` 保留两个命名卷。跨环境切换应使用独立目录和项目名，例如设置 `.env` 中的 `COMPOSE_PROJECT_NAME=xunwu-demo`。删除卷的操作会清空相应实例的数据与图片。

### 域名与 HTTPS

先让域名 A 记录指向服务器，并确认 80 和 443 入站可访问。域名实名认证、备案、云服务器购买和校方审批由账号持有人办理。备案未完成时按获准的 IP 演示方案验收。

1. 在 HTTP 模式启动站点，在项目目录使用 Certbot 签发证书。将命令中的域名替换成实际值。

   ```bash
   sudo apt-get install -y certbot
   sudo certbot certonly --webroot -w "$PWD/deploy/acme" -d example.org
   ```

2. 编辑 `.env`，填入以下值，再运行 `bash deploy/deploy.sh`。

   ```dotenv
   COMPOSE_FILE=docker-compose.yml:deploy/compose.https.yml
   TLS_DOMAIN=example.org
   TLS_CERT_DIR=/etc/letsencrypt
   BASE_URL=https://example.org
   ```

3. 验证 HTTPS `/health` 返回 200，域名 HTTP 会跳转到 HTTPS，登录 Cookie 带 `Secure`、`HttpOnly`、`SameSite=Lax`。IP 或 localhost 的 HTTP 健康探针仍可用。用 `sudo certbot renew --dry-run` 验证续签，续签成功后执行 `docker compose exec -T nginx nginx -s reload` 让 Nginx 读取新证书。保留 Certbot 的完整证书目录，因为 `live` 中的证书是符号链接。

### PM2 备选

预装 Node.js 22 LTS、npm、PM2 和系统 Nginx。复制 `.env.example` 为 `.env`，通过 `openssl rand -hex 32` 生成并写入 `SESSION_SECRET`，按环境表配置其余字段，设置 `chmod 600 .env`。

```bash
npm ci --omit=dev
pm2 start ecosystem.config.js
pm2 save
pm2 startup
curl -fsS http://127.0.0.1:3000/health
```

按 `pm2 startup` 输出执行开机自启命令。系统 Nginx 的上游指向 `http://127.0.0.1:3000`，配置 8 MiB 请求上限，并用 `$remote_addr`、`$scheme`、`$http_host` 覆盖转发头。Compose 的 `proxy.conf` 使用 Docker DNS，系统 Nginx 使用本机地址。

## 管理员与端到端验收

注册三套独立账号，分别用作发布者、认领者和管理员。演示注册可在手机号栏使用 `TEST-PUB1`、`TEST-CLAIM1`、`TEST-OPS1`。用下列命令将自己的已注册运维账号提升为管理员。

```bash
docker compose exec -T app node scripts/promote-admin.js <运维用户名>
# 本地或 PM2
node scripts/promote-admin.js <运维用户名>
```

1. 发布者登录，选择招领，填写联系方式、地图选点，并添加至少一题防冒领问题。可附一张 5 MiB 以内的 JPEG、PNG、GIF 或 WebP。
2. 用另一个浏览器配置文件或无痕窗口登录认领者。在招领列表打开详情，确认联系方式打码、答题选项可见。
3. 答错确认未解锁，答对确认显示完整联系方式。
4. 在热力图确认此启事出现在选中的 SVG 区域。带实测标定的区域同时有经纬度。
5. 用管理员账号访问 `/admin`，在物品管理中将该启事标记为已认领。刷新热力图确认已结案点消失。
6. 执行 `docker compose down` 和 `docker compose up -d --wait`，再次核对启事状态和附件。

## 旧库迁移与坐标接口

启动会给旧库追加 `lng REAL`、`lat REAL` 并保留 `map_x`、`map_y`。发布接口 `POST /api/items` 接受成对的 `lng`/`lat`（GCJ-02）以及 `mapX`/`mapY`（1000×700 SVG）。可以提交两组，或提交一组并由已有的地点或标定信息补另一组。经纬度缺测时允许为空。公开热力图只提供三位小数的经纬度和绘图需要的字段。发布者和管理员可读取保存值。

由 A、B 实测后，把标定表保存到 `data/campus-calibration.json`，区域名应与 `public/js/campus-map.js` 的 `CAMPUS_ZONES` 一致。JSON 结构为 `{"图书馆":{"lng":数值,"lat":数值}}`。Compose 下可将实测文件导入数据卷。

```bash
docker compose cp ./campus-calibration.json app:/app/data/campus-calibration.json
docker compose exec -T app node scripts/migrate-coords.js
docker compose restart app
```

使用非 Compose 环境时，将文件放到 `data/`，执行 `node scripts/migrate-coords.js`，再重启应用。迁移优先使用已有 SVG 点，其次按地点文字找区域，取最近的 SVG 区域中心对应的实测经纬度。重复执行只填充仍缺经纬度的记录。迁移输出 `migrated` 与 `remaining`，缺测区域保留原点。当前制品未附学校实测值。

导入旧数据库后，先备份，再预览并清理旧演示账号和种子联系方式。

```bash
docker compose exec -T app node scripts/clean-demo.js
docker compose exec -T app node scripts/clean-demo.js --apply
```

## 备份、恢复和回滚

```bash
# 默认保存最近 7 份，支持设置 BACKUP_DIR 和 BACKUP_KEEP
bash scripts/backup-db.sh
bash scripts/restore-db.sh backups/<备份文件>.db
```

备份使用 SQLite Online Backup API，包含尚未 checkpoint 的 WAL 数据。恢复会停止应用、校验备份完整性，再替换数据库并重启。恢复失败时应用保持停止，确认旧库或选用其他备份后再执行 `docker compose up -d --wait`。本地与 PM2 使用 `bash scripts/backup-db.sh --local` 和 `bash scripts/restore-db.sh --local <备份>`，本地恢复前先手动停止服务。备份文件包含用户数据，应单独存放并限制读取权限。

文件存储模式下，SQLite 备份保存图片路径。定期另外备份上传卷。需要同一时点的灾备时，暂停发布或安排停机窗口，取得两份快照后再恢复写入。

```bash
# 容器运行时导出图片。建议与同批 SQLite 快照一起保存。
umask 077
docker compose exec -T app tar -C /app/public/uploads -czf - . > uploads.tar.gz
# 停止应用后，从可信备份恢复到上传卷。
docker compose stop app
docker compose run --rm --no-deps -T app tar -C /app/public/uploads -xzf - < uploads.tar.gz
docker compose up -d --wait
```

升级前备份数据库和图片，记录当前制品版本并保留镜像，例如设置独立的 `APP_IMAGE=xunwu-zhilian:版本标识`。回滚时恢复旧版本的文件和配置，用同一 Compose 项目名启动。若升级改写了旧版无法读取的数据，先按上面的流程恢复同版本快照。

## 常见故障

| 现象 | 排查 |
| --- | --- |
| 80 或 443 被占用 | 用 `sudo ss -ltnp` 查找占用进程。演示可改 `HTTP_PORT`，同时更新 `BASE_URL` 中的端口。证书验证通常使用公网 80。 |
| Nginx 502 或启动超时 | 看 `docker compose ps` 和 `docker compose logs --tail=100 app nginx`。核对密钥、数据卷权限、证书目录和端口。 |
| SQLite WAL 锁 | 保持单个应用实例，数据库放本地磁盘卷。用备份脚本获取快照。停应用后再恢复，运行中不要删除 WAL 文件。 |
| 热力图有 SVG 点但没有经纬度 | 检查标定文件是否位于数据卷内、名称是否匹配，再执行迁移并重启。SVG 路线无需地图 key；接入地图服务后再核对 key 的授权和有效期。 |
| CAS 回跳循环 | 演示先确认 `CAS_ENABLED=false`。真实接入时核对登记的 service 回调、`BASE_URL`、HTTPS 与 Nginx 转发协议。 |
| 浏览器登录后仍为匿名 | 检查站点实际访问地址、`BASE_URL` 和 Cookie。HTTPS 配置生成 Secure Cookie，需通过 HTTPS 地址访问。 |

原始 ZIP 没有 Git 元数据。以实际团队仓库的干净基线为准，通过 PR 合入 `feat/deploy`，B 使用 `feat/map`。合入前运行 `git status --short`，并检查 `git ls-files`、`git grep` 和公开仓库历史，确保环境文件、证书、数据库、上传内容与真实个人信息没有进入版本控制。

Docker 安装步骤参考 [Docker Engine 官方 Ubuntu 指南](https://docs.docker.com/engine/install/ubuntu/)。
