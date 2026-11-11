# 寻物智联 - 智能失物招领平台（全栈版）

在原纯前端页面基础上，新增了后端服务与数据库。所有访问者注册的用户信息、发布的失物/招领信息均存入 SQLite 数据库，支持多用户共享。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | HTML + Tailwind CSS（本地构建）+ 原生 JavaScript（fetch 调用 API） |
| 后端 | Node.js + Express |
| 数据库 | SQLite（better-sqlite3），数据库文件：`data/xunwu.db` |
| 安全 | 密码 bcrypt 哈希存储（不存明文）、HttpOnly 会话 Cookie（有效期 24 小时）、管理员接口权限校验 |

## 目录结构

```
失物招领/
├── server.js          # 后端服务与 REST API
├── db.js              # 数据库连接、建表、种子数据
├── package.json       # 项目依赖
├── data/
│   └── xunwu.db       # SQLite 数据库文件（运行后自动生成）
├── public/
│   ├── index.html     # 首页（hero + 数据统计 + 最新失物/招领预览）
│   ├── login.html     # 登录 / 注册页
│   ├── lost.html      # 失物列表页（关键词搜索 + 分类筛选）
│   ├── found.html     # 招领列表页（关键词搜索 + 分类筛选）
│   ├── recognize.html # 智能识别页（上传图片 AI 匹配）
│   ├── publish.html   # 发布信息页（失物/招领 + 可选图片上传）
│   ├── profile.html   # 个人中心页（头像 / 个性签名 / 我的发布）
│   ├── admin.html     # 管理后台页面（/admin 访问，统计卡 + 用户/物品表格 + 详情弹窗）
│   ├── css/style.css  # 公共样式（玻璃拟态、卡片、动画、装饰）
│   ├── js/common.js   # 公共脚本（登录鉴权、导航高亮、物品卡片、详情弹窗）
│   └── images/        # 物品图片 item-1~12.jpg + 拼贴版画装饰图 corner-art-*.png
│   ├── admin.html     # 管理后台页面（/admin 访问，统计卡 + 用户/物品表格 + 详情弹窗）
│   └── images/        # 12 张物品图片（item-1.jpg ~ item-12.jpg，与种子数据一一对应）
└── Untitled-1.html    # 原始纯前端页面（保留备份，勿用！请访问 http://localhost:3000）
```

## 启动方法

1. 安装 Node.js 22 LTS 后安装依赖（仅需一次）：
   ```powershell
   npm ci
   ```
2. 启动服务：
   ```powershell
   npm start
   ```
3. 浏览器访问：
   - 用户端：`http://localhost:3000`
   - 管理后台：`http://localhost:3000/admin`
   - 同一局域网（同一 Wi-Fi）的其他设备：`http://<你的IP>:3000`（启动时会打印）

默认数据库为空。通过登录页注册后，可以运行 `node scripts/promote-admin.js <用户名>` 授予管理员权限。
需要本地样例数据时，在开发环境设置 `SEED_DEV_USER=true`。新建样例账号的随机密码会在首次创建时打印。

公网演示、HTTPS、PM2 和备份恢复见 [DEPLOY.md](DEPLOY.md)。

> 注意：请通过网址访问，不要双击打开桌面上的 `Untitled-1.html`（那是旧版纯前端，数据不会写入服务器数据库）。

## 数据库表结构

**users（用户表）**

| 字段 | 说明 |
| --- | --- |
| id | 用户ID（主键自增） |
| username | 用户名（唯一） |
| password_hash | 密码的 bcrypt 哈希 |
| phone | 手机号（唯一） |
| avatar | 头像（文件路径或 base64） |
| signature | 个性签名 |
| role | `user`（普通用户）/ `admin`（管理员） |
| created_at | 注册时间（毫秒时间戳） |

**items（物品表）**

| 字段 | 说明 |
| --- | --- |
| id | 物品ID（主键自增） |
| type | `lost`（寻物）/ `found`（招领） |
| title / category / color | 名称 / 分类 / 颜色 |
| location / date | 地点 / 日期 |
| image / description | 图片 / 详细描述 |
| contact / reward | 联系方式 / 酬谢 |
| features | 特征标签（JSON 数组） |
| publisher | 发布者用户名 |
| status | `active`（在架）/ `removed`（已撤销）/ `resolved`（已找回或已认领） |

## API 列表

| 方法 | 路径 | 说明 | 是否需登录 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 注册，body：`{username, password, phone}` | 否 |
| POST | `/api/auth/login` | 登录（用户名或手机号），设置会话 Cookie | 否 |
| GET | `/api/auth/me` | 获取当前登录用户信息 | 是 |
| PUT | `/api/auth/profile` | 修改头像/签名，body：`{avatar?, signature?}` | 是 |
| POST | `/api/auth/logout` | 退出登录 | 否 |
| GET | `/api/items` | 物品列表，支持 `?type=lost|found`、`?publisher=xxx` | 否 |
| GET | `/api/items/stats` | 统计信息（总数/找回数/找回率） | 否 |
| POST | `/api/items/match` | 智能匹配，body：`{type, color, category}` | 否 |
| GET | `/api/items/:id` | 物品详情 | 否 |
| POST | `/api/items` | 发布物品（publisher 以登录用户为准） | 是 |
| PATCH | `/api/items/:id/status` | 更新启事状态：撤销/恢复/标记已找回（寻物）或已认领（招领），需本人或管理员 | 是 |
| GET | `/api/admin/stats` | 后台统计（需管理员会话） | 管理员 |
| GET | `/api/admin/users` | 后台用户列表（需管理员会话） | 管理员 |
| GET | `/api/admin/items` | 后台物品列表（需管理员会话） | 管理员 |

浏览器登录后会在同源请求中自动携带会话 Cookie。

## 多页架构

网站已从单页切换升级为「导航栏多页」结构，每个功能有独立网址，未登录访问任意页面会自动跳转到登录页，登录后返回原页面：

| 页面 | 网址 | 说明 |
| --- | --- | --- |
| 首页 | `/` | hero 主视觉 + 平台统计 + 最新失物/招领预览 |
| 登录/注册 | `/login` | 登录与注册切换，成功后按来源页跳转 |
| 失物列表 | `/lost` | 关键词 + 分类筛选，支持 `?q=` 直达搜索结果 |
| 招领列表 | `/found` | 同上 |
| 智能识别 | `/recognize` | 上传图片 → 模拟识别 → 数据库智能匹配 |
| 发布信息 | `/publish` | 发布失物/招领，支持上传真实物品图 |
| 个人中心 | `/profile` | 头像上传、个性签名、账号信息、我的发布 |
| 管理后台 | `/admin` | 管理员专用 |

公共导航栏 6 个入口 + 用户区下拉菜单在所有页面保持一致，自动高亮当前所在页面；移动端折叠为汉堡菜单。

## 本次视觉升级说明

- 用户端与管理后台统一艺术化：玻璃拟态卡片、渐变标题、漂浮光斑背景、按钮扫光特效、精致详情弹窗。
- 12 条种子物品的图片已替换为符合描述的 AI 生成实拍图（`public/images/item-1.jpg ~ item-12.jpg`）。
- 用户端与后台均可点击任意一条启事查看详情（图片、分类、颜色、地点、日期、描述、联系方式、发布者）。
- 后台点击用户行可查看用户详情（角色、注册时间、发布记录），并可跳转到对应物品详情。

## 拼贴版画边角装饰

前端边角插画采用「拼贴版画」风格（蓝橙黄绿撞色纸块 + 撕纸毛边 + 波点/斜条纹），贴合艺术学院应用背景，已在全部页面嵌入：

| 装饰图 | 用途 |
| --- | --- |
| `corner-art-h.png` | 横版长条：首页 hero、失物/招领列表页头、个人中心页头 |
| `corner-art-v.png` | 竖版：登录页右下角、智能识别/发布页右上角、后台右下角 |
| `corner-art-empty.png` | 方版：失物/招领列表的空状态插画 |

装饰以「白色画框 + 轻微旋转 + 阴影」的贴画样式呈现，不遮挡操作区域（pointer-events 关闭，移动端自动隐藏）。

## 备注

- 想让外网（非同一局域网）用户访问，需要将服务部署到云服务器（如阿里云/腾讯云，配合 PM2 常驻运行），或将数据库替换为云服务（如 Supabase）。
- 生产环境部署时，通过 `SESSION_SECRET` 配置随机密钥。Compose 的应用端口为 3000，公网端口由 Nginx 提供。
