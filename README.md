# trpg-warehouse · B1 最小实现

公开只读的网页版 TRPG 模组库。上传者在受 Access 保护的 `/upload` 提交**主控台单文件 + `.xmind` 单文件 + 文件夹拖拽资源树**，浏览端即时上架；访客点卡片进条目页，并列拿到「思维导图 / 主控台」两个入口，思维导图在**浏览器内直接预览**，主控台原样托管、内部链接自然取到对应文件。

> 本仓库是 **BC · B1** 首次开发产物，按《项目档案_trpg-warehouse_v1.md》§0 / §1 / §3.2 实现。
> **部署方式是纯点击（GitHub 网页 + Cloudflare Dashboard + Workers Builds），不需要本地命令行**；步骤见 [`docs/部署指引_纯点击.md`](docs/部署指引_纯点击.md)。
> 代码已通过 30 条单测 / 14 项离线冒烟 / TypeScript 类型检查；**Cloudflare 尚未部署，真实样本与真机验收仍待完成**。

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
| `r2-cors.json` | R2 CORS 模板：粘贴到 Dashboard 的 CORS Policy JSON tab，同时放行 `GET` 与 `PUT` |
| `scripts/build-web.mjs` `scripts/smoke.mjs` | 前端打包 / B1 离线冒烟（含两代 xmind 合成样本） |
| `docs/部署指引_纯点击.md` | **部署步骤唯一出处**（网页点选，零命令行） |
| `docs/项目档案_trpg-warehouse_v1.md` | 项目唯一信息载体（已更新到 B1-2 轮） |

---

## 3. 部署（纯点击 · 不需要命令行）

仓库已建立：**https://github.com/Luffy852/trpg_warehouse**（`main`，Public）。

**部署全程在浏览器里完成**：GitHub 网页编辑 + Cloudflare Dashboard / Zero Trust 点选 + Workers Builds 自动构建。**不需要 clone、不需要装 Node、不需要任何 `npm` / `wrangler` / `git` 命令。**

> 📄 **详细步骤只写在 [`docs/部署指引_纯点击.md`](docs/部署指引_纯点击.md)**：值清单、每一步点哪里、粘贴哪段 SQL / JSON、排错表、纯点击验收清单都在那里。本节只给路线图，避免两份说明不一致。

### 3.1 路线图

| 阶段 | 在哪个网页 | 做什么 |
|---|---|---|
| 0 | GitHub | 上传纯点击补丁包（同名替换） |
| 1 | — | 备好「值清单」（6 个配置值 + 3 个 Secret） |
| 2 | Cloudflare Dashboard | 建 D1 `trpg-warehouse-db`、R2 `trpg-warehouse-assets`、R2 公开读域、R2 S3 API token |
| 3 | Zero Trust | 设 team domain + 建 Self-hosted Access 应用（`/upload*`、`/api/upload*` 两条 path） |
| 4 | GitHub | 网页编辑 `wrangler.toml`，一次填 5 个 `REPLACE_*` 值（第 6 个值「站点域名」用在 Access 应用与 CORS） |
| 5 | Workers & Pages | **Create application → GitHub → Save and Deploy**（站点上线） |
| 6 | Worker → Settings | 加 3 个 Secret → Deploy |
| 7 | D1 → Studio | 粘贴建表 SQL → Run all statements |
| 8 | R2 → Settings | 粘贴 CORS JSON（GET + PUT）→ Save |
| 9 | Zero Trust | 校准 Access 应用域名（AUD 不变） |
| 10 | 浏览器 | 按验收清单点一遍 |

### 3.2 三条最容易踩的坑

1. **Project name 必须是 `trpg-warehouse`**（与 `wrangler.toml` 的 `name` 完全一致），否则 Workers Builds 直接报 name mismatch。
2. **真实值必须写进 `wrangler.toml`**：Workers Builds 每次部署以仓库里的 Wrangler 配置为唯一真值，只在 Dashboard 手加的 D1 / R2 绑定与 vars 会被覆盖掉；**3 个 Secret 是例外**，在 Dashboard 加后会保留。
3. **不要用 Worker → Settings → Domains & Routes 的「Enable Cloudflare Access」一键开关**：它会把整个站点（含公开浏览端）一起锁上。本项目只在 Zero Trust 建 Self-hosted 应用，用两条 path 锁写口；Worker 内再验一次 JWT 断言兜底。

### 3.3 Workers Builds 设置

| 字段 | 值 |
|---|---|
| Project name | `trpg-warehouse` |
| Production branch | `main` |
| **Build command** | **留空**（`web/vendor/*` 已随仓库提交，Worker 的 TS 由 wrangler 自动打包） |
| Deploy command | 保持默认 `npx wrangler deploy` |
| Root directory | 留空 |

Workers Builds 会自动 clone 仓库并**自动安装依赖**。Free 计划每月 3,000 构建分钟、1 并发、单次 20 分钟超时；**上架模组不触发构建**，只有 push 代码才会。

之后改代码也一样纯点击：在 GitHub 网页改文件 → Commit → 自动重新部署，不必重做第 2–9 步。

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

> **以上真机项按 [`docs/部署指引_纯点击.md`](docs/部署指引_纯点击.md) 第 10 步在浏览器里逐条点验，不需要命令行。**
> 若你想在开发机上额外跑一遍离线断言（**部署完全不需要这一步**），才用得到 `npm test`（30 条单测）、`npm run smoke`（14 项离线冒烟）、`npm run typecheck`（Worker TypeScript）。

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
