# trpg-warehouse · B1 最小实现

公开只读的网页版 TRPG 模组库。上传者在受 Access 保护的 `/upload` 提交**主控台单文件 + `.xmind` 单文件 + 文件夹拖拽资源树**，浏览端即时上架；访客点卡片进条目页，并列拿到「思维导图 / 主控台」两个入口，思维导图在**浏览器内直接预览**，主控台原样托管、内部链接自然取到对应文件。

> 本仓库是 **BC · B1** 首次开发产物，按《项目档案_trpg-warehouse_v1.md》§0 / §1 / §3.2 实现。
> **代码已落盘并通过沙盒断言；Cloudflare 部署与真实样本仍需你在本机 / 真机验一次**（见文末）。

---

## 1. 架构（一眼看懂）

```
访客浏览器
  ├─ 首页 / 条目页 / 预览页 / CSS / JS  → Workers Assets 边缘直出（不跑 Worker）
  ├─ GET /api/modules                  → Worker 读 D1（只返回 published，不含资源清单）
  └─ 预览页 fetch .xmind               → R2 自定义域（CORS GET）→ 浏览器解 ZIP → mind-elixir 只读画布
                                          ↑ 完全不经过 Worker、不生成第二份产物

上传者浏览器（/upload，Cloudflare Access 保护）
  ├─ POST /api/upload/prepare   → Worker：zod 枚举校验 / 重名 / 路径安全 / 按主控台实际引用逐项断言
  │                               → 对每个 R2 key 签预签名 PUT，回一次性 HMAC 令牌
  ├─ PUT <R2 S3 端点>           → 浏览器并发直传，大包不经 Worker 请求体
  └─ POST /api/upload/finalize  → Worker：head() 逐个追到真实写入 → upsert D1 → 写后读回校验
                                  上传端重新拉 /api/modules 断言「卡片 +1」才显示成功
```

技术栈：**单 Worker（Workers Free 只允许 1 个）** + Workers Assets 静态壳 + R2（资源）+ D1（索引唯一真值）+ Cloudflare Access（写口）+ aws4fetch（预签名）+ fflate / mind-elixir / @mind-elixir/import-xmind（全在浏览端）。

上架**不消耗任何构建**：资源进 R2、索引进 D1，静态壳只在改代码时重新 deploy。

---

## 2. 目录结构

| 路径 | 作用 |
|---|---|
| `wrangler.toml` | 单 Worker 配置：Assets / D1 / R2 绑定、路由、vars |
| `worker/src/index.ts` | **唯一 Worker**：Access、预签名、上架断言、D1 读写、下载兜底 |
| `worker/src/schema.ts` / `access.ts` / `presign.ts` / `token.ts` / `types.ts` | zod 契约、Access JWT 断言、R2 预签名、prepare→finalize 令牌、绑定类型 |
| `shared/*.js` | **唯一口径出处**：枚举 / slug / 路径剥顶层 / 依赖解析 / xmind 格式判定；Worker、上传端、预览页、测试共用 |
| `shared/*.test.js` | 30 条单元测试（`npm test`） |
| `web/index.html` `web/module.html` `web/mindmap.html` | 首页 / 条目页（仅两入口）/ xmind 预览页 |
| `web/upload/index.html` | `/upload` 三区输入（受 Access 保护） |
| `web/assets/*.js` `web/assets/site.css` | **源码**：改这里 |
| `web/vendor/*` | **生成物**：改完 `web/assets/*.js` 跑 `npm run build` 重出，不直接手改 |
| `migrations/0001_init.sql` | D1 `modules` 表（一条目一行，upsert） |
| `r2-cors.json` | R2 CORS：同时放行浏览域 `GET` 与预签名 `PUT` |
| `scripts/build-web.mjs` `scripts/smoke.mjs` | 前端打包 / B1 离线冒烟（含两代 xmind 合成样本） |
| `docs/项目档案_trpg-warehouse_v1.md` | 项目唯一信息载体（已更新到 B1 轮） |

---

## 3. 先建仓（你来做）

```bash
cd trpg-warehouse
git init
git add .
git commit -m "B1: 首个可部署实现（单 Worker + R2 + D1 + xmind 浏览器预览）"
git remote add origin https://github.com/<你的用户名>/trpg-warehouse.git
git branch -M main
git push -u origin main
```

建好后把 **仓库地址 / `main`** 回填到 `docs/项目档案_trpg-warehouse_v1.md` §0.2 首行；之后新对话只传这一份档案即可。

另开一个窗口装依赖：`npm install`（Node 20+）。

---

## 4. Cloudflare 一次性配置（按顺序）

### 4.1 建 D1 与 R2

```bash
npx wrangler login
npx wrangler d1 create trpg-warehouse-db          # 记下 database_id
npx wrangler r2 bucket create trpg-warehouse-assets
```

把 `database_id` 填进 `wrangler.toml` 的 `REPLACE_WITH_D1_DATABASE_ID`，再初始化表：

```bash
npm run d1:init          # 远程
npm run d1:init:local    # 本地 wrangler dev 用
```

### 4.2 R2 自定义域 + CORS

1. Cloudflare Dashboard → R2 → `trpg-warehouse-assets` → Settings → **Connect custom domain**，绑一个公开读域名（如 `assets.your-domain.com`；**别用 `r2.dev` 开发域**）。
2. 把 `r2-cors.json` 里的 `AllowedOrigins` 换成你的站点域名（本地开发再补 `http://localhost:8787`）。
3. `npm run r2:cors` 应用策略。预览页 `fetch` 需要 `GET`，浏览器直传需要 `PUT`，两者缺一不可。
4. 把域名填进 `wrangler.toml` 的 `R2_PUBLIC_BASE_URL`（不带末尾斜杠），`R2_ACCOUNT_ID` 换成账户 ID。

### 4.3 R2 S3 API 凭据 + 3 个 secret

Dashboard → R2 → **Manage R2 API tokens** → 建一个 **Object Read & Write** 范围的 token，拿到 Access Key ID / Secret Access Key，然后：

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put UPLOAD_TOKEN_SECRET     # 随机长字符串，如 openssl rand -hex 32
```

### 4.4 Cloudflare Access 保护写口

Zero Trust → Access → Applications → **Self-hosted**：
- 应用域名填你的 Worker 域名，路径包含 **`/upload*`** 与 **`/api/upload*`**（用一条应用加两条 path 规则，或两条应用）
- 策略：Allow + 你的邮箱 / 指定身份
- 记下 **Team domain**（`xxx.cloudflareaccess.com`）与 **Application AUD**，填进 `wrangler.toml` 的 `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`

Worker 内还会再验一次 Access JWT 断言，防止绕过 route 直连 `workers.dev`。**隐藏路径 ≠ 鉴权**，这两层都要有。

### 4.5 部署

```bash
npm run build        # 首次可跳过：vendor 产物已随仓库提交
npm run deploy
```

本地调试：`npm run dev`（先跑 `npm run d1:init:local`）。

---

## 5. 上架一条目（三区输入）

1. 打开 `/upload`（会先过 Access）。
2. 填元数据：`slug` 必须英文小写短横线（纯中文标题请手动填，如 `frozen-malice`）；`system` / `kind` 人工语义判定；`status=draft` 不进浏览端。
3. ① 选主控台 HTML 单文件、② 选 `.xmind` 单文件 —— 两者**原始文件名**（含中文）原样平铺到 `modules/<slug>/` 根，并写入 D1 `consoleFile` / `mindmapFile`。
4. ③ 把资源文件夹拖进第三区（或点选文件夹）：按 `webkitRelativePath` **剥掉所选顶层文件夹名**，其余整树原样保留。例：

   ```
   本地：资源包/assets/maps/深层/地图 01.png
   R2：  modules/frozen-malice/assets/maps/深层/地图 01.png   ← 不挂「资源包/」这一层
   ```
5. 点「校验并上架」。会依次发生：
   - 本地预检：枚举 / 路径安全 / 重名 / 按主控台**实际引用**逐项求包含
   - Worker 权威复检（不预设必备文件名清单，原文单文件 / 多文件都行）
   - 浏览器并发直传 R2（不手动设 `Content-Type`，避免签名不匹配）
   - `head()` 追到真实写入 → upsert D1 → 写后读回
   - **重新拉 `/api/modules` 断言卡片数 +1**，通过才显示「上架成功」

重名（两单文件同名 / 单文件命中拖拽树 / 树内自身重名）、缺任一被引用文件、非法枚举 → **拒上架并回执，索引不变**。

---

## 6. 验收对照（档案 §6.2）

| 编号 | B1 状态 |
|---|---|
| V-01 上架可见 / 卡片 +1 | 代码已实现（finalize + 上传端行为断言）；**真机待验** |
| V-02 条目页仅两入口、主控台内链接可达 | 已实现（条目页只渲染两个入口，资源不在浏览端列举）；**完整主控台待到手** |
| V-03 缺依赖拒绝 | ✅ 沙盒已验（含「删一个文件断言真的会红」） |
| V-04 draft 隔离 | 已实现（SQL `WHERE status='published'` + 上传端断言）；**真机待验** |
| V-05 枚举校验 | ✅ 沙盒已验（zod + shared 契约） |
| V-06 访问控制 | 已实现（Access 应用 + Worker JWT 复验）；**真机待验 403** |
| V-07 纯点击无搜索框 | ✅ 页面无搜索框、无文本输入交互 |
| V-08 性能 | 已实现（无构建、首屏一次列表 API、Worker bundle 480 KB < 3 MB）；**限额真机待验** |
| V-09 资源包不推送 | ✅ 列表接口不返回资源清单，条目页不列举 |
| V-10 目录格局保持 | ✅ 沙盒已验（≥2 层子目录、剥顶层、中文 / 特殊字符 key） |
| V-11 两入口文件名 / 重名拒 | ✅ 沙盒已验 |
| V-12 xmind 浏览器预览 | ✅ 两代格式合成样本解析出图 + 占位 XML / 损坏文件可见兜底；**真实样本与浏览器渲染待验** |
| V-13 不养副本 / 不占 Worker | ✅ 解析全在访客浏览器，预览库在静态壳 |

跑一遍本地断言：

```bash
npm test           # 30 条单测
npm run smoke      # 14 项离线冒烟（含 XMind 2020+ 与 XMind 8 合成样本）
npm run typecheck  # Worker TypeScript
npx wrangler deploy --dry-run   # 可选：看构建产物
```

---

## 7. 已知限制（不夸大）

- **浏览器内预览是「结构可读预览」**：节点树、标题、折叠、缩放 / 平移 / 多 sheet 切换可靠；主题色、标记、关系线、外框、概要、嵌入图片等可能简化，不等同 XMind 客户端 100% 还原。
- **加密（密码保护）/ 损坏 / 过新版本 `.xmind`** 解析必失败，预览页给可见错误 + 「下载原文件」兜底，不留白屏。
- **元宝侧收不到 `.xmind`**：B1 用合成样本验了两代格式解析与失败兜底；渲染保真度须你用本地真实样本验。你的浏览器上传不受此限。
- **完整主控台与真实资源树未到手**：`relativePath` 剥顶层是否与主控台内实际引用写法一致、根相对 `/...` 路径、中文路径编码，均待真机验。Worker 与上传端会把检出的根相对路径单独回执提示，不擅自改整体路由口径。
- 不做中文搜索 / 全文检索 / 搜索输入框；条目多了只能靠分类点击找。
- 浏览端不做登录 / 评论 / 用户系统；`draft → published` 发布流程细化留到后续阶段。
- 单次上架依赖 D1 写入成功；上传端已用「卡片 +1」行为断言兜住「回执成功但没上架」。

---

## 8. 边界与版权

中文译文为**非官方粉丝翻译，禁止商用**；原译者声明与第三方物料声明在公开站原样保留。站点与代码仓库全部公开，不因版权设浏览访问限制；唯一写口 `/upload` 由 Cloudflare Access 保护。

明确不做：中文搜索、登录评论、浏览端列资源包清单、摊平 / 重命名拖拽树、上传时重写 HTML 引用、生成第二份预览产物、在 Worker 里解析 xmind、可编辑预览、构建期静态生成分类页、重绘主控台内部版式。
