#!/usr/bin/env node
// tools/dryrun.mjs —— dsh-memory-router 的离线验证（**只读**：先把真实记忆库复制到临时目录再跑）。
//
// 用法：
//   node tools/dryrun.mjs              跑固定 query 集 + 打印 L0 注入全文与预算
//   node tools/dryrun.mjs --queries    只跑检索质量
//   node tools/dryrun.mjs --l0         只打印 L0 注入文本
//
// 关键：先设置 DSH_HOME 指向临时副本，再**动态 import** 业务模块，
// 这样 store.js 里的路径解析会落在副本上，原库一个字节都不会被写。
import { cpSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
const realMemory = join(REAL_DSH_HOME, 'memory');

if (!existsSync(realMemory)) {
  console.error('找不到真实记忆库：' + realMemory);
  process.exit(2);
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-router-dryrun-'));
cpSync(realMemory, join(sandbox, 'memory'), { recursive: true });
process.env.DSH_HOME = sandbox;
console.log(`[dryrun] 真实库 ${realMemory}`);
console.log(`[dryrun] 沙箱副本 ${sandbox}（本次只读，原库不会被修改）\n`);

const store = await import('../lib/store.js');
const searchMod = await import('../lib/search.js');
const inject = await import('../lib/inject.js');
const plugin = await import('../lib/index.js');

const config = { ...plugin.__test.DEFAULTS, coreBudgetChars: 5000, indexBudgetChars: 2000 };
const args = process.argv.slice(2);
const wantQueries = args.length === 0 || args.includes('--queries');
const wantL0 = args.length === 0 || args.includes('--l0');

// ---------- 建索引 ----------
const notes = await store.rebuildIndex();
const index = searchMod.buildIndex(notes);
console.log(`[索引] ${notes.length} 条记忆，字段 ${searchMod.FIELDS.join(' / ')}，`
  + `RRF k=${searchMod.RRF_K}，MMR λ=${searchMod.MMR_LAMBDA}，BM25 k1=${searchMod.K1} b=${searchMod.B}\n`);

// ---------- 检索质量 ----------
const QUERIES = [
  { q: '波浪号 删除线', expect: 'markdown' },
  { q: 'ICS UNTIL 多排一周', expect: 'until-ics' },
  { q: '插件注入 style 被删', expect: 'dsh-data-plugin' },
  { q: 'glob 找不到文件 只给前100', expect: 'dsh-glob' },
  { q: '推理等级滑条 Default 滞后', expect: 'default-max-off' },
  { q: '课表数据 权威源 重建', expect: '20261013-192103' },
  { q: '高数A2 重修 考核 权重', expect: 'a2' },
  { q: 'verify_workspace_links 括号 死链', expect: 'verify-workspace-links' },
  { q: 'core-memory 3000 字符 截断', expect: 'core-memory' },
  { q: '电量 充电 实测', expect: '140829' },
  { q: '物化B 教学大纲 归档', expect: '184751' },
  { q: '输入框上方挂着的队列面板', expect: '130315' },
  { q: '子代理 工具调用次数 上限', expect: '091552-7' },
  { q: 'privacy 隐私 不写校名', expect: 'privacy' },
];

let hit3 = 0;
if (wantQueries) {
  console.log('='.repeat(78));
  console.log('检索质量：预期目标是否进 top-3');
  console.log('='.repeat(78));
  for (const { q, expect } of QUERIES) {
    const hits = searchMod.search(index, q, { topK: 5, halfLifeDays: config.halfLifeDays, wTime: config.wTime, wFreq: config.wFreq });
    const rank = hits.findIndex((h) => h.note.id.includes(expect) || h.note.title.toLowerCase().includes(expect));
    const ok = rank >= 0 && rank < 3;
    if (ok) hit3 += 1;
    console.log(`\n${ok ? '[OK  ]' : '[MISS]'} 「${q}」 → 期望含「${expect}」，位次 ${rank >= 0 ? rank + 1 : '未命中'}`);
    for (const h of hits) {
      console.log(`        ${h.score.toFixed(3)}  [${h.note.id}] ${h.note.title.slice(0, 42)}`
        + `  ⟵ ${h.matched.slice(0, 4).join(',')}`);
    }
    if (hits.length === 0) console.log('        （无命中 → 会走"最近记忆 + 索引"兜底）');
  }
  console.log(`\n[小计] top-3 命中 ${hit3}/${QUERIES.length}`);
}

// ---------- L0 注入 ----------
if (wantL0) {
  console.log('\n' + '='.repeat(78));
  console.log('L0 常驻注入：预算与裁剪');
  console.log('='.repeat(78));
  const built = inject.buildL0(notes, config, 'Agent学习');
  console.log(`字符数 ${built.stats.chars}（预算 ${config.coreBudgetChars + config.indexBudgetChars}）`
    + ` ｜ 核心 ${built.stats.coreChars} 字符 ｜ 裁剪分节 ${built.stats.croppedSections} 个`
    + ` ｜ 索引列出 ${built.stats.indexListed}/${built.stats.indexTotal} 行`
    + ` ｜ 未列出：预算外 ${built.stats.truncated} · 冷记忆 ${built.stats.cold} · 其他工作区 ${built.stats.otherScope}`);
  const halfTilde = (built.text.match(/~/g) || []).length;
  console.log(`半角 ~ 出现次数：${halfTilde} ${halfTilde === 0 ? '（通过）' : '（不合格！渲染会被当删除线）'}`);
  console.log(`未拆开的 {{ 出现次数：${(built.text.match(/\{\{/g) || []).length}`);
  console.log('\n----- 注入全文开始 -----');
  console.log(built.text);
  console.log('----- 注入全文结束 -----');

  // 召回卡样例：用第一条 query 的命中
  const demo = searchMod.search(index, '波浪号 删除线 渲染', { topK: 2 });
  if (demo.length > 0) {
    console.log('\n----- 召回卡样例（L1）-----');
    console.log(inject.buildRecallCard(demo, { maxChars: config.recallMaxChars }));
    console.log('----- 召回卡样例结束 -----');
  }
}

// ---------- 旧插件兼容性 ----------
console.log('\n' + '='.repeat(78));
console.log('向后兼容（旧插件 dsh-core-memory 能否照常读）');
console.log('='.repeat(78));
const sample = notes[0];
if (sample) {
  const parsed = store.parseNoteFile(await (await import('node:fs/promises')).readFile(join(store.notesDir(), sample.id + '.md'), 'utf8'));
  const oldKnown = ['title', 'tags', 'created', 'updated'];
  const missing = oldKnown.filter((k) => !parsed.meta[k]);
  console.log(`样本 [${sample.id}]：旧插件需要的字段 ${oldKnown.join('/')} —— ${missing.length === 0 ? '全部存在（兼容）' : '缺 ' + missing.join(',')}`);
  console.log(`新增字段（旧插件忽略）：${['summary', 'keywords', 'scope', 'status', 'hits'].filter((k) => parsed.meta[k] !== undefined).join(', ') || '（本条尚未补全）'}`);
}
const stats = inject.readStats();
console.log(`stats.json：${stats.routerEnrichedAt ? '已补全过（' + stats.routerEnrichedAt + '）' : '尚未补全（首次激活时会做）'}`);

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n[dryrun] 沙箱已清理：${sandbox}`);
