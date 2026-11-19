-- trpg-warehouse · 索引唯一真值：一条目一行，表单字段写入 D1。
-- 主控台 HTML 不是索引源；不另养 modules.json 或包内第二份清单（原则 6）。
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
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_modules_status ON modules(status);
CREATE INDEX IF NOT EXISTS idx_modules_system_kind ON modules(system, kind);
