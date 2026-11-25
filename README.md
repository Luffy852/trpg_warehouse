# trpg-warehouse · B1 最小实现

公开只读的网页版 TRPG 模组库。上传者在受 Access 保护的 `/upload` 提交**主控台单文件 + `.xmind` 单文件 + 文件夹拖拽资源树**，浏览端即时上架；访客点卡片进条目页，并列拿到「思维导图 / 主控台」两个入口，思维导图在**浏览器内直接预览**，主控台原样托管、内部链接自然取到对应文件。

> **当前参考档案版本：v7**（`docs/项目档案_trpg-warehouse_v7.md`）。`docs/` 内会累积多份历史档案（v1–v6），属正常，不要删除；S1 完成后由用户手动归档。
> 本仓库是 **BC · B1** 首次开发产物，按《项目档案_trpg-warehouse_v7.md》§0 / §1 / §3.2 实现；W1 期间已落盘包①–④ 修正（见部署指引「W1 收官记录」），W2-a 期间新增**缩放修正 B 方案增量包**（`web/assets/mindmap-app.js` 步进 `1 → 0.1` + 状态行文案，`web/vendor/mindmap.js` 重出），**W2-b 期间新增「模组更新」显式更新开关增量包**（10 个文件：`shared/update-mode.js` 唯一口径 + 上传页勾选项 + Worker prepare/finalize 双侧权威校验 + D-01 行为断言分叉 + `web/vendor/upload.js` 重出；真机 4 项回执全过）。
> **部署方式是纯点击（GitHub 网页 + Cloudflare Dashboard + Workers Builds），不需要本地命令行**；步骤见 [`docs/部署指引_纯点击.md`](docs/部署指引_纯点击.md)。
> **成本控制（B1-3）**：R2 没有原生硬性账单上限，项目用「写口体积/容量闸门（含预留量）+ CDN 缓存/WAF + 账单告警 + **一键熔断**」兜底；原则是 **fail-closed（宁停不烧钱）**，且成本机制本身零定时/高频遍历。第三方建议的逐条核实与取舍见部署指引**附录 A**与 8.8 节，第 8 步是必做项。
> 代码已通过 **71 条单测 / 42 项离线冒烟 = 113 条断言**（W2-b 收官终态；先红 → 绿 → 回退红 → 还原绿 → 构建后复跑绿 → 干净 clone 只解压增量包复现全绿）。`npm run typecheck` 在沙盒依赖不全时仅剩既有 `jose` TS7016，**A/B 对照错误集合完全一致 → 零新增类型错误**，Workers Builds 用 `bun install` 装齐后应全绿。**Cloudflare 部署与第 10 步 1–16 项真机验收已全部通过**（`warehouse.finewinginnovation.cn` / `warehouseasset.finewinginnovation.cn`）；

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
                                  上传端重新拉 /api/modules 做行为断言才显示成功：
                                  created「卡片 +1」/ updated「卡片数不变、内容已更新」
```

技术栈：**单 Worker（Workers Free 只允许 1 个）** + Workers Assets 静态壳 + R2（资源）+ D1（索引唯一真值）+ Cloudflare Access（写口）+ aws4fetch（预签名）+ fflate / mind-elixir / @mind-elixir/import-xmind（全在浏览端）。

上架**不消耗任何构建**：资源进 R2、索引进 D1，静态壳只在改代码时重新 deploy。

---

## 2. 目录结构

| 路径 | 作用 |
|---|---|
| `wrangler.toml` | 单 Worker 配置：Assets / D1 / R2 绑定、路由、vars |
| `worker/src/index.ts` | **唯一 Worker**：Access、预签名、**成本闸门**、上架断言、D1 读写、下载兜底 |
| `worker/src/schema.ts` / `access.ts` / `presign.ts` / `token.ts` / `types.ts` | zod 契约、Access JWT 断言、R2 预签名、prepare→finalize 令牌、绑定类型 |
| `shared/*.js` | **唯一口径出处**：枚举 / slug / 路径剥顶层 / 依赖解析 / xmind 格式判定 / **成本闸门**；Worker、上传端、预览页、测试共用 |
| `shared/cost.js` | 成本控制唯一出处：体积/数量/累计容量阈值、真实 `head().size` 复核、fail-closed 判定、一键熔断开关；4 个阈值 + `WRITES_ENABLED` 在 `wrangler.toml` 里可调 |
| `shared/*.test.js` | 71 条单元测试（`npm test`，含 W2-b 更新模式唯一口径 12 条） |
| `web/index.html` `web/module.html` `web/mindmap.html` | 首页 / 条目页（仅两入口）/ xmind 预览页 |
| `web/upload/index.html` | `/upload` 三区输入（受 Access 保护） |
| `web/assets/*.js` `web/assets/site.css` | **源码**：改这里 |
| `web/vendor/*` | **生成物**：改完 `web/assets/*.js` 跑 `npm run build` 重出，不直接手改 |
| `migrations/0001_init.sql` | D1 `modules` 表（一条目一行，upsert；**`total_bytes` 供累计容量锁**）+ **`upload_locks` 预留量表** |
| `r2-cors.json` | R2 CORS 模板：粘贴到 Dashboard 的 CORS Policy JSON tab，同时放行 `GET` 与 `PUT` |
| `scripts/build-web.mjs` `scripts/smoke.mjs` | 前端打包 / 离线冒烟（**42 项**：两代 xmind 合成样本 + 封面并入 + `return await` 静态审计 + 上传页版式回归 + **W2-b 勾选项 / Worker 双侧 / D-01 分叉静态断言** + 成本闸门 + fail-closed + 预览页缩放静态断言） |
| `docs/部署指引_纯点击.md` | **部署步骤唯一出处**（网页点选，零命令行） |
| **`docs/项目档案_trpg-warehouse_v7.md`** | **当前参考版本 v7 ＝ 项目唯一信息载体**。`docs/` 里 v1 / v2 / v3 / v4 / v5 / v6 等旧版**并存、不删、不作依据**；S1 完成后由用户手动归入 `docs/archive/`。**§0.11 是每个新对话开场必读的「硬盘体系」规程**（v7 已澄清「工作区留存备查、不纳入后续窗口、不打包交付」） |

---

## 3. 部署（纯点击 · 不需要命令行）

仓库已建立：**https://github.com/Luffy852/trpg_warehouse**（`main`，Public）。

**部署全程在浏览器里完成**：GitHub 网页编辑 + Cloudflare Dashboard / Zero Trust 点选 + Workers Builds 自动构建。**不需要 clone、不需要装 Node、不需要任何 `npm` / `wrangler` / `git` 命令。**

> 📄 **详细步骤只写在 [`docs/部署指引_纯点击.md`](docs/部署指引_纯点击.md)**：值清单、每一步点哪里、粘贴哪段 SQL / JSON、排错表、纯点击验收清单都在那里；**该指引已于 2026-11-20 首次部署实测修订、2026-11-23 W1 收官再修订**（Zero Trust 新界面、自定义域兜底、Free 档限制、W1 收官记录）。本节只给路线图，避免两份说明不一致。

### 3.1 路线图

| 阶段 | 在哪个网页 | 做什么 |
|---|---|---|
| 0 | GitHub | 上传 `W2-b收尾_文档同步包.zip`（**档案只增不删**：新增 `docs/项目档案_trpg-warehouse_v7.md`，不用删旧版、不用管覆盖；`README.md` 与 `docs/部署指引_纯点击.md` 为**同名替换**，仅同步「当前参考版本」与 W2-b 结论） |
| 1 | — | 备好「值清单」（6 个配置值 + 3 个 Secret） |
| 2 | Cloudflare Dashboard | 建 D1 `trpg-warehouse-db`、R2 `trpg-warehouse-assets`、**R2 自定义域**、R2 S3 API token；停用 r2.dev |
| 3 | Zero Trust | 设 team domain + 建 Self-hosted Access 应用（`/upload*`、`/api/upload*` 两条 path） |
| 4 | GitHub | 网页编辑 `wrangler.toml`，一次填 5 个 `REPLACE_*` 值（第 6 个值「站点域名」用在 Access 应用与 CORS） |
| 5 | Workers & Pages | **Create application → GitHub → Save and Deploy**（站点上线） |
| 6 | Worker → Settings | 加 3 个 Secret → Deploy |
| 7 | D1 → Studio | 粘贴建表 SQL（**含 `total_bytes` 与 `upload_locks`**）→ Run all statements |
| 8 | R2 / zone / Billing | CORS + **Cache Rules / WAF 限流 / 防盗链 / 生命周期 / 账单告警**（成本控制闭环） |
| 9 | Zero Trust + Worker Settings | **复核** Access 应用域名 / 自定义域仍在 / 绑定与 Secret 仍在（AUD 不变） |
| 10 | 浏览器 | 按验收清单点一遍（含成本控制 6 项） |

### 3.2 五条最容易踩的坑

1. **Project name 必须是 `trpg-warehouse`**（与 `wrangler.toml` 的 `name` 完全一致），否则 Workers Builds 直接报 name mismatch。
2. **真实值必须写进 `wrangler.toml`**：Workers Builds 每次部署以仓库里的 Wrangler 配置为唯一真值，只在 Dashboard 手加的 D1 / R2 绑定与 vars 会被覆盖掉；**3 个 Secret 是例外**，在 Dashboard 加后会保留。
3. **不要用 Worker → Settings → Domains & Routes 的「Enable Cloudflare Access」一键开关**：它会把整个站点（含公开浏览端）一起锁上。本项目只在 Zero Trust 建 Self-hosted 应用，用两条 path 锁写口；Worker 内再验一次 JWT 断言兜底。
4. **第 8 步的成本控制不是可选项**：R2 无原生硬性账单上限，Spend Management 只覆盖 Workers / Durable Objects。必须用**自定义域**（`r2.dev` 不支持缓存与 WAF）+ Cache Rules + WAF 限流，并靠 `total_bytes` + `upload_locks` 容量锁卡住累计存储。第三方「用 Worker 代理 R2 借 Workers 硬上限兜底」的前提与官方文档不符，取舍见部署指引附录 A。
5. **设计原则是「宁停不烧钱」**：不引入任何 cron / alarm / 定时遍历（历史上这类机制一天烧爆过 DO 免费读写次数）；容量核算只在写口做，数字不可信一律拒。发现用量异常时，把 `wrangler.toml` 的 `WRITES_ENABLED` 改成 `"0"` 并在 GitHub 网页 Commit，再 Disable R2 自定义域，即可一键停机。详见部署指引 8.8。

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
2. 填元数据：`slug` 必须英文小写短横线（纯中文标题请手动填，如 `frozen-malice`）；`system` / `kind` 人工语义判定；`status=draft` 不进浏览端；**「模组更新」勾选项在状态右侧格** —— 不勾选时同 slug 一律拒绝，勾选才允许覆盖同 slug 条目（含 draft），勾选但 slug 不存在则正常新建。**slug 上传后不允许改**，改名须删 D1 行 + R2 对象后重新上传（W2-c）。
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
   - **重新拉 `/api/modules` 做行为断言**：新建判「卡片数 +1」，覆盖更新判「卡片数不变、内容已更新」（逐字段比对 + Worker 写后读回）；状态 draft↔published 变化时按旧状态算 ±1，通过才显示成功

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
| V-08 性能 | 已实现（无构建、首屏一次列表 API、Worker bundle 486 KB < 3 MB）；**限额真机待验** |
| V-09 资源包不推送 | ✅ 列表接口不返回资源清单，条目页不列举 |
| V-10 目录格局保持 | ✅ 沙盒已验（≥2 层子目录、剥顶层、中文 / 特殊字符 key） |
| V-11 两入口文件名 / 重名拒 | ✅ 沙盒已验 |
| V-12 xmind 浏览器预览 | ✅ 两代格式合成样本解析出图 + 占位 XML / 损坏文件可见兜底；**真实样本与浏览器渲染待验** |
| V-13 不养副本 / 不占 Worker | ✅ 解析全在访客浏览器，预览库在静态壳 |

> **以上真机项按 [`docs/部署指引_纯点击.md`](docs/部署指引_纯点击.md) 第 10 步在浏览器里逐条点验，不需要命令行。**
> 若你想在开发机上额外跑一遍离线断言（**部署完全不需要这一步**），才用得到 `npm test`（71 条单测）、`npm run smoke`（42 项离线冒烟）、`npm run typecheck`（Worker TypeScript）。
> **成本控制真机项**（缓存命中不回源、WAF 限流 / 防盗链、Billing 告警、`QUOTA_EXCEEDED` / `BUCKET_CAP_EXCEEDED` 413 回执、累计容量锁、一键熔断 503、预留量累积）按部署指引第 10 步第 11–16 项点验，沙盒没有把它们混进「已完成」。

---

## 7. 已知限制（不夸大）

- **浏览器内预览是「结构可读预览」**：节点树、标题、折叠、缩放 / 平移 / 多 sheet 切换可靠；主题色、标记、关系线、外框、概要、嵌入图片等可能简化，不等同 XMind 客户端 100% 还原。
- **加密（密码保护）/ 损坏 / 过新版本 `.xmind`** 解析必失败，预览页给可见错误 + 「下载原文件」兜底，不留白屏。
- **元宝侧收不到 `.xmind`**：B1 用合成样本验了两代格式解析与失败兜底；渲染保真度须你用本地真实样本验。你的浏览器上传不受此限。
- **完整主控台与真实资源树未到手**：`relativePath` 剥顶层是否与主控台内实际引用写法一致、根相对 `/...` 路径、中文路径编码，均待真机验。Worker 与上传端会把检出的根相对路径单独回执提示，不擅自改整体路由口径。
- 不做中文搜索 / 全文检索 / 搜索输入框；条目多了只能靠分类点击找。
- 浏览端不做登录 / 评论 / 用户系统；**`draft → published` 轻量上架 / 删除重传 / 受保护删除写口**留到 **W2-c**（见档案 v7 §5 / §5.2）。
- 单次上架依赖 D1 写入成功；上传端已用「卡片 +1」行为断言兜住「回执成功但没上架」。
- **R2 成本控制不是「自动硬熔断」，但可以一键停机**：Cloudflare 目前没有 R2 的硬性账单上限，Spend Management 只覆盖 Workers / Durable Objects。本项目靠「写口体积/累计容量闸门（8 GB 锁）+ 预留量 + CDN 缓存 + WAF 限流 + 账单告警」压低风险，异常时把 `WRITES_ENABLED` 改成 `"0"` 并 Disable R2 自定义域即可停机；但**不能承诺 100% 零费用，也不能承诺无需人工干预**；恶意刷自定义域且持续制造缓存未命中，理论上仍会累积 Class B。自动熔断脚本需要常驻 Cron + API Token，且「定时遍历」正是历史上一天烧爆 DO 免费读写的模式，本轮明确不引入（部署指引 8.8 反模式登记）。
- **容量账面宁可高估、绝不低估**：`prepare` 先记 `upload_locks` 预留量再签 URL，上传中途放弃 / `finalize` 失败会留下永久预留，容量锁可能提前拦死上架 —— 这是刻意的 fail-closed 行为，不是 bug；清理办法见部署指引排错表。为「精确到字节」去遍历桶反而更贵，不做。
- **同 slug 修订后需手动清缓存**：Cache Rules 长 Edge TTL 下，覆盖同名对象时边缘可能仍返回旧副本，须在自定义域所在 zone 执行 Purge（部署指引第 8.2 步）。W2-b 起覆盖必须先勾选「模组更新」，不再有静默覆盖。
- **不允许修改 slug**：D1 改 slug 不会搬 R2 里的 `modules/<旧slug>/...` 对象 → 前端链接全变、主控台 / 导图 / 封面全 404；改名须删 D1 行 + 按前缀清 R2 对象后重新上传（W2-c）。
- **不要给 R2 桶加「N 天后删除对象」的生命周期规则**：这是图床 / 备份场景的做法，对本永久资料库会删掉已上架资源而 D1 索引还在。只保留未完成分片上传的清理。

---

## 8. 边界与版权

中文译文为**非官方粉丝翻译，禁止商用**；原译者声明与第三方物料声明在公开站原样保留。站点与代码仓库全部公开，不因版权设浏览访问限制；唯一写口 `/upload` 由 Cloudflare Access 保护。

明确不做：中文搜索、登录评论、浏览端列资源包清单、摊平 / 重命名拖拽树、上传时重写 HTML 引用、生成第二份预览产物、在 Worker 里解析 xmind、可编辑预览、构建期静态生成分类页、重绘主控台内部版式。
