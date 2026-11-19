-- trpg-warehouse · 索引唯一真值：一条目一行，表单字段写入 D1。
-- 主控台 HTML 不是索引源；不另养 modules.json 或包内第二份清单（原则 6）。
-- total_bytes：该条目实际占用 R2 的字节数（由 finalize 用 head().size 累加）。
--   成本闸门用它做 8GB 累计容量锁，替代外部 Cron 熔断脚本；draft 也计入。
CREATE TABLE IF NOT EXISTS modules (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  system        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  cover         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  console_file  TEXT NOT NULL,
  mindmap_file  TEXT NOT NULL,
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_modules_status ON modules(status);
CREATE INDEX IF NOT EXISTS idx_modules_system_kind ON modules(system, kind);

-- 预留量表（B1-3）：prepare 签 URL 前先记一笔，finalize 成功后删。
-- 浏览器上传完关掉页面 / finalize 失败 → R2 里有对象但 D1 没有索引，
-- 预留量永久留下，容量锁宁可提前拦死也不少算。绝不加定时清理任务去遍历它。
CREATE TABLE IF NOT EXISTS upload_locks (
  slug           TEXT PRIMARY KEY,
  reserved_bytes INTEGER NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 若你之前已按旧版指引建过表，补这两句即可（纯点击：D1 → Studio → Query 粘贴执行）：
-- ALTER TABLE modules ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0;
-- CREATE TABLE IF NOT EXISTS upload_locks (
--   slug TEXT PRIMARY KEY, reserved_bytes INTEGER NOT NULL,
--   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
-- );
