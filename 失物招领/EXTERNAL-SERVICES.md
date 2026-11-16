# 外部服务启用与上线合规手册

本文件覆盖 **4 类必须由人工在第三方控制台完成** 的操作：真实底图（腾讯位置服务）、文字识别（腾讯云 OCR）、域名 A 记录、备案与主体合规。代码与配置侧已经就绪，缺的只是账号、密钥与解析授权。

> 安全红线：任何真实密钥只写入服务器上的 `.env`（`deploy.sh` 已 `chmod 600`，`.env` 已在 `.gitignore` 中）。**不要**写进仓库、截图、聊天记录或前端 JS。

## 0. 总览

| 项 | 控制台 | 产出 | 验证命令 |
|---|---|---|---|
| 1 真实底图 | <https://lbs.qq.com/dev/console/application/mine> | `MAP_KEY` + 标定文件 | `curl -s http://127.0.0.1/api/map/config` |
| 2 OCR | <https://console.cloud.tencent.com/cam/capi> | `OCR_SECRET_ID` / `OCR_SECRET_KEY` | 登录后 `POST /api/ocr` |
| 3 域名 | 域名持有人的云解析 DNS | A 记录 → 服务器公网 IP | `nslookup <域名>` |
| 4 备案合规 | <https://beian.aliyun.com> | 人工确认结论 | 见第 4 节清单 |

配置改完后统一执行（在 `失物招领` 目录）：

```bash
docker compose up -d          # 环境变量变更需要重建容器
curl -s http://127.0.0.1/health
```

---

## 1. 腾讯位置服务：启用真实底图

代码侧已实现：`GET /api/map/config` 从后端下发 `sdkUrl` 与 key，前端只做 `https` + `map.qq.com` 白名单校验；未配置时一律降级自绘 SVG。

### 1.1 申请 key

1. 打开 <https://lbs.qq.com/dev/console/application/mine>，用微信或 QQ 登录，完成实名认证。
2. 「应用管理 → 创建应用」，名称填项目名（如 `xunwu-zhilian`），类型选「交通出行 / 校园服务」均可。
3. 在该应用下「添加 key」，启用 **WebServiceAPI** 与 **JavaScript API GL** 两项能力。
4. 复制生成的 key（形如 `ABCDE-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`）。

### 1.2 配置白名单

在 key 的「设置」里填写 **域名白名单**：

- **正式域名上线后**：填 `example.org/*`（把 `example.org` 换成实际域名，`www` 子域另加一条）。
- **当前 IP 演示阶段**：填服务器公网 IP。若控制台拒绝纯 IP，说明该校验只接受域名——此时应尽快完成第 3 节域名切换，期间不要把 key 贴到任何公开页面。

白名单是防止 key 被盗用的唯一手段，**不要留空上线**。

### 1.3 采集校区 GCJ-02 标定

腾讯地图使用 GCJ-02 坐标系，**不要用手机 GPS 原始 WGS-84 值**，否则整体偏移几百米。

1. 打开坐标拾取器 <https://lbs.qq.com/getPoint/>。
2. 搜索并定位到校区，逐个点击关键点位（图书馆、教学楼、食堂、宿舍区），左侧会显示 `经度,纬度`，这就是 GCJ-02 值。
3. 把 `deploy/campus-calibration.example.json` 复制为 `data/campus-calibration.json`（`data/` 已在 `.gitignore` 中，不会入库），按下面格式填写：

```json
{
  "campus": "实际校区名",
  "center": { "lng": 114.3621, "lat": 30.5412 },
  "zoom": 16,
  "zones": [
    { "name": "图书馆", "lng": 114.3621, "lat": 30.5412 },
    { "name": "教学楼", "lng": 114.3655, "lat": 30.5401 }
  ]
}
```

`center` 是地图初始中心；`zones` 供前端分区使用。服务端优先读 `.env` 的 `MAP_CENTER_LNG/LAT`，未配置时回退到本文件的 `center`，再回退到 `zones` 第一个有效点；文件缺失、JSON 损坏或坐标越界都会安全关闭真实地图。

### 1.4 写入配置并重启

编辑 `.env`：

```dotenv
MAP_KEY=上一步申请到的 key
# 有两种方式，二选一：
# A) 直接写中心点（优先级最高）
MAP_CENTER_LNG=114.3621
MAP_CENTER_LAT=30.5412
MAP_ZOOM=16
# B) 留空上面三项，改用标定文件（默认路径即可）
CAMPUS_CALIBRATION=data/campus-calibration.json
```

标定文件必须能被容器读到：`docker-compose.yml` 已把 `database` 卷挂到 `/app/data`，因此把标定文件放到**数据卷**里，或改用 `.env` 直接写中心点。**推荐直接用方式 A**，最省事。

### 1.5 自检

```bash
curl -s http://127.0.0.1/api/map/config
```

- 成功：`{"enabled":true,"sdkUrl":"https://map.qq.com/api/gljs?...&key=...","center":{"lng":114.36,"lat":30.54},"zoom":16}`
- 失败原因会写在 `reason` 里：`map-key-not-configured`（没填 key）、`campus-calibration-not-configured`（没标定）、`sdk-host-not-allowed`（SDK 地址不是 map.qq.com）。

浏览器打开热力图页，应显示腾讯底图而非自绘 SVG；打开开发者工具确认没有 CSP 拦截报错。

### 1.6 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面仍是 SVG 示意图 | `/api/map/config` 返回 `enabled:false` | 看 `reason` 字段逐项补 |
| 控制台报 `Invalid Key` | 白名单没加当前访问域名/IP | 回 1.2 补白名单 |
| 地图整体偏移数百米 | 用了 WGS-84 而非 GCJ-02 | 用坐标拾取器重新取值 |
| CSP 拦截脚本 | 未重启容器，`mapCspSources()` 仍是旧值 | `docker compose up -d` |

---

## 2. 腾讯云 OCR：启用文字识别

代码侧已实现：`POST /api/ocr` 由后端签名调用腾讯云 `GeneralBasicOCR`，密钥不出后端；未配置时返回友好提示，不报 5xx。

### 2.1 申请密钥（推荐子用户）

1. 打开 <https://console.cloud.tencent.com/cam/capi>，用主账号登录。
2. **推荐**：「用户 → 新建用户 → 自定义创建」，只勾选「编程访问」，在权限里只授予 **QcloudOCRFullAccess**（最小权限）。不要用主账号密钥。
3. 创建完成后复制 `SecretId` 与 `SecretKey`（SecretKey 只显示一次）。

### 2.2 写入配置并重启

```dotenv
OCR_SECRET_ID=AKIDxxxxxxxxxxxxxxxxxxxx
OCR_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OCR_REGION=ap-guangzhou
```

```bash
docker compose up -d
```

### 2.3 自检

OCR 接口要求登录（防止匿名刷调用）。用浏览器登录站点，在发布页上传一张含文字的图片，点「识别图中文字，填入描述草稿」：

- 成功：描述框出现识别文字，手机号/证件号/长编号已被替换为 `[手机号已隐藏]` 等占位。
- 未配置：提示「文字识别服务暂时不可用，请手动填写描述」（这是 `ocr-not-configured` 降级，不是故障）。

也可用命令行自检（需先取到登录 Cookie）：

```bash
curl -s -X POST http://127.0.0.1/api/ocr \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <登录后的 Cookie>' \
  -d '{"image":"data:image/png;base64,<图片 base64>"}'
```

### 2.4 计费与配额

腾讯云 OCR 每月有免费额度，超出按次计费。建议在控制台设置 **用量告警**，避免被刷。OCR 接口本身已有登录校验与限流（`ocrLimit = 10`）。

---

## 3. 域名接入与 A 记录：切换到服务器

> **⚠️ 2026-11-16 实机纠错**：早前"同接入商换服务器只需改 A 记录、无需接入备案"的判断**错误**。域名 `yellowcranefind.cn` 虽已在阿里云备案、A 记录也已指向本服务器，但因**备案信息在他人账号、未接入本服务器账号**，阿里云在网络层拦截 80/443：域名访问返回 `HTTP 403 Server: Beaver` 的「Non-compliance ICP Filing」页，而 IP 直连 `/health` 正常。**必须先完成「接入备案」**，否则配 HTTPS 也无效（TLS 握手同样被 reset）。官方依据：help.aliyun.com 知识库 36993、ECS「在其他服务商已备案的域名如何接入阿里云」。

### 3.0 接入备案（阻塞项，须备案主体在其阿里云账号操作）

域名已备案但备案信息不在当前服务器账号下 → 阿里云拦截访问。必须由**备案主体**在其阿里云账号提交「接入备案」：

1. 备案主体登录**域名备案所在的阿里云账号**（原备案账号），进入 ICP 代备案管理系统。
2. 选择「**接入备案** / 新增接入其他服务」，填入域名 `yellowcranefind.cn`。
3. 选择/绑定本服务器（若服务器在另一账号，需服务器账号生成**备案服务码**并授权给备案账号）。
4. 按指引上传资料提交，等待**管局审核**（通常数个工作日至两周）。
5. 审核通过后拦截自动解除，域名恢复访问，**原备案号不变、不影响原接入商**——接入备案无需原服务商配合或取消。

> 域名持有人≠服务器账号持有人时，按官方 FAQ：登录域名所在账号做接入备案；或在原服务商通过「变更备案」修改主体信息后再接入。切勿在接入成功前取消原接入，否则备案号可能被注销。

### 3.1 可直接转发给域名持有人的操作说明

> 麻烦在阿里云「云解析 DNS」里，把下面两条记录的值改成 `60.205.178.60`，TTL 建议先设为 600 秒：
>
> | 记录类型 | 主机记录 | 记录值 |
> |---|---|---|
> | A | `@` | `60.205.178.60` |
> | A | `www` | `60.205.178.60` |
>
> 如果原来指向的是别的 IP（笔记本），直接改值即可，不要新增重复记录。改完 10 分钟内生效。
>
> **2026-11-16 实测**：主域 `@` 已生效指向 `60.205.178.60`，但 `www` 子域查不到（NXDOMAIN），请务必补上 `www` 这条 A 记录。另外，仅改 A 记录还不能让域名打开——还需按 3.0 完成「接入备案」解除阿里云拦截。

### 3.2 验证解析生效

```bash
nslookup <你的域名>
dig +short <你的域名>          # Linux / macOS
```

返回 `60.205.178.60` 即生效。也可用 <https://tool.chinaz.com/dns> 查全国多节点。

### 3.3 启用 HTTPS

**前置条件**：3.0 接入备案已通过（域名访问不再返回 403）+ 3.1 的 `www` 记录已补。否则 webroot 校验流量会被拦截，签证书会失败。

解析生效且 80 端口可访问后，在 `失物招领` 目录签发证书（服务器已有 `deploy/acme` webroot）：

```bash
sudo apt-get install -y certbot    # 非 Ubuntu 用对应包管理器
sudo certbot certonly --webroot -w "$PWD/deploy/acme" -d <你的域名>
```

然后在 `.env` 追加：

```dotenv
COMPOSE_FILE=docker-compose.yml:deploy/compose.https.yml
TLS_DOMAIN=<你的域名>
TLS_CERT_DIR=/etc/letsencrypt
BASE_URL=https://<你的域名>
```

```bash
docker compose up -d
curl -sI https://<你的域名>/health
```

成功后 `config.cookieSecure` 会随 `BASE_URL` 自动切为 `true`，会话 Cookie 只走 HTTPS。

### 3.4 顺序建议

**先部署好服务器再切域名**。当前服务器已跑通，建议顺序：① 通知持有人改 A 记录 → ② 验证解析 → ③ 签证书 → ④ 改 `.env` 重启。若先切域名而 HTTPS 未就绪，站点会有一段时间只能走 HTTP 或打不开。

---

## 4. 备案与主体合规（人工确认）

以下 5 项无法由代码判断，需要项目负责人与域名持有人逐项确认：

1. **主体一致性**：ICP 备案主体与域名持有人是否同一主体？若不同，需确认持有人已获主体授权使用该域名。
2. **接入商**：备案接入商是否为阿里云？是则换服务器只需改 A 记录（已确认）；若为其他接入商，需办理接入备案。
3. **网站名称与内容**：备案填报的网站名称、服务内容需与实际用途（校园失物招领、非经营性）一致，不得用于商业推广。
4. **公安联网备案**：网站上线后通常需在 30 日内到 <https://beian.mps.gov.cn> 办理公安备案，具体以属地要求为准。
5. **校方审批**：若以学校名义对外提供服务，需确认校方对外服务与信息安全审批要求。

> 注意：本节结论需人工核验，不能以「同接入商免备案」推断出「主体合规也没问题」——两者是不同维度。

---

## 5. 验收命令汇总

```bash
# 站点存活
curl -s http://127.0.0.1/health

# 真实地图是否启用（看 enabled / reason）
curl -s http://127.0.0.1/api/map/config

# 容器与卷
docker compose ps
docker volume ls | grep xunwu

# 接口契约（本机，零依赖）
node scripts/check-backend-integration.js     # 38 项

# 端到端（会写测试账号并结案，勿在正式库跑）
node scripts/check-e2e-flow.js http://127.0.0.1
```
