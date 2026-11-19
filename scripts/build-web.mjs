// 重新生成 web/vendor/*（改了 web/assets/*.js 后跑 `npm run build`）。
// vendor 产物随仓库提交，clone 后无需构建即可 `wrangler deploy`。
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = {
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  // 库内部的 CSS import 交给 empty loader；样式统一由下方复制一份
  loader: { '.css': 'empty' },
  absWorkingDir: root,
};

const jobs = [
  ['web/assets/app.js', 'web/vendor/site.js'],
  ['web/assets/mindmap-app.js', 'web/vendor/mindmap.js'],
  ['web/assets/upload-app.js', 'web/vendor/upload.js'],
];

mkdirSync(resolve(root, 'web/vendor'), { recursive: true });
for (const [entry, out] of jobs) {
  await build({ ...shared, entryPoints: [entry], outfile: out });
  console.log(`✓ ${entry} → ${out}`);
}
cpSync(
  resolve(root, 'node_modules/mind-elixir/dist/MindElixir.css'),
  resolve(root, 'web/vendor/mindmap.css'),
);
console.log('✓ mind-elixir CSS → web/vendor/mindmap.css');
