// dsh-memory-router —— DeepSeek Harness 跨会话记忆（分层披露版）
//
// 与旧插件 dsh-core-memory 的关系：**并存、不互相破坏**。
//   · 读同一份 $DSH_HOME/memory/，写的格式是旧格式的**超集**（旧插件忽略未知字段）；
//   · 工具名全部用 mem_ 前缀，与旧的 memory_* / persona **零重名**，不会注册冲突；
//   · 自己写的 index.json 带 marker，被旧插件重写成旧格式时自动从 notes/ 重建。
//
// 注入分层（DESIGN.md §2）：
//   L0  systemPrompt.section（order 60）：核心记忆 + 归档索引（一行一条）
//   L1  agent/pre-step：按当轮用户输入检索，命中才注入一张「记忆召回卡」，命中为 0 时零成本
//   L2  mem_recall / mem_get / mem_index：按需拉正文
//
// 官方规范要点（cordis-plugin-development/references/practices.md，已逐条核对）：
//   · 加提示词文本用 ctx.systemPrompt.section()，**不要**监听 system-prompt/assemble；
//   · 每会话状态用 WeakMap 挂在活 agent 对象上，随对象回收，不需要额外释放；
//   · 不追加自定义 session 事件类型；调优项进 Config（这里手写校验，不用 schemastery——
//     与 dsh-todo-keeper 一致，规避 junction 安装时的模块解析问题）。
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  memoryDir, corePath, notesDir, indexPath, statsPath,
  readSyncOrNull, readJsonSyncOrNull, atomicWrite, nowIso, parseNoteFile, renderNoteFile,
  normalizeNote, noteMeta, noteSort, makeId, parseCore, renderCore, backupMemory,
  daysSince,
} from './store.js';
import { buildIndex, search, findSimilar, makeSnippet, tokenize, isInvalidNote } from './search.js';
import { buildL0, buildCoreBlock, buildRecallCard, guardText, recordStats, readStats, POLICY } from './inject.js';

export const name = 'dsh-memory-router';
export const inject = ['tools', 'systemPrompt'];

/** 工具名全部 mem_ 前缀：与旧插件 memory_* / persona 零重名。 */
const TOOL_PREFIX = 'mem_';

const DEFAULTS = {
  // 常驻预算（字符）。先用保守值，靠 mem_stats 记账再调。
  coreBudgetChars: 5000,
  indexBudgetChars: 2000,
  indexMaxLines: 40,
  // L0 段在 system prompt 里的排序位；60 与旧插件一致（紧跟 persona 前缀）。
  l0Order: 60,
  // 每轮自动召回
  autoRecall: true,
  recallTopK: 5,
  recallMaxChars: 3000,
  recallMinScore: 0,
  recallChannel: 'prestep', // prestep=改写本步消息（当步可见） | inject=agent.inject()（官方通道）
  recallCooldownMs: 1200,
  // 检索加权
  halfLifeDays: 180,
  wTime: 0.25,
  wFreq: 0.15,
  // 治理
  coldDays: 120,
  duplicateHintAt: 0.5,
  // 视图缓存：目录内容不变且未过期时复用内存索引
  viewTtlMs: 2000,
  // 首次启动给旧笔记补 summary/scope（会先整目录备份）
  enrich: true,
};

/** 手写校验，fail loud，绝不静默回退到半对的状态。 */
function resolveConfig(raw) {
  const c = raw === undefined || raw === null ? {} : raw;
  if (typeof c !== 'object') throw new Error('dsh-memory-router: config 必须是对象');
  const out = { ...DEFAULTS };
  const ints = [['coreBudgetChars', 200], ['indexBudgetChars', 0], ['indexMaxLines', 0],
    ['l0Order', -1e6], ['recallTopK', 1], ['recallMaxChars', 200], ['halfLifeDays', 1],
    ['coldDays', 0], ['viewTtlMs', 0], ['recallCooldownMs', 0]];
  for (const [key, min] of ints) {
    if (c[key] === undefined) continue;
    const value = Number(c[key]);
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`dsh-memory-router: config.${key} 必须是不小于 ${min} 的整数（收到 ${JSON.stringify(c[key])}）`);
    }
    out[key] = value;
  }
  for (const key of ['wTime', 'wFreq', 'recallMinScore', 'duplicateHintAt']) {
    if (c[key] === undefined) continue;
    const value = Number(c[key]);
    if (!Number.isFinite(value)) throw new Error(`dsh-memory-router: config.${key} 必须是有限数字`);
    out[key] = value;
  }
  for (const key of ['autoRecall', 'enrich']) {
    if (c[key] === undefined) continue;
    if (typeof c[key] !== 'boolean') throw new Error(`dsh-memory-router: config.${key} 必须是布尔值`);
    out[key] = c[key];
  }
  if (c.recallChannel !== undefined) {
    if (c.recallChannel !== 'prestep' && c.recallChannel !== 'inject') {
      throw new Error("dsh-memory-router: config.recallChannel 只能是 'prestep' 或 'inject'");
    }
    out.recallChannel = c.recallChannel;
  }
  return out;
}

// ---------- 小工具 ----------
/** 读取并限制请求体大小，返回 UTF-8 文本。 */
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        try { req.destroy(); } catch { /* 忽略 */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 注入消息（与 dsh-todo-keeper 同构，带手搓回退） ----------
// v4 会话格式硬门禁：source.kind 必须是 producer 自有的非空字符串，旧式 'plugin' 会被拒
// （SessionFormatError: format v4 message requires a producer-owned source kind）。
// 与已升级的 dsh-todo-keeper 写法保持一致。
const PLUGIN_SOURCE = { kind: 'dsh-memory-router', plugin: 'dsh-memory-router' };

let createUserMessage = null;
try {
  const mod = await import('@deepseek-ai/dsh-llm/message');
  if (typeof mod.createUserMessage === 'function') createUserMessage = mod.createUserMessage;
} catch { /* junction 安装时可能解析不到 → 走手搓回退 */ }

/** 手搓一条与官方 createUserMessage 形状一致的、冻结过的 user 消息。 */
function makeNoticeFallback(text, summary) {
  const message = {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary },
  };
  const clone = structuredClone(message);
  const seen = new WeakSet();
  const pending = [clone];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) pending.push(node[key]);
  }
  return clone;
}

/** `source.plugin` 必填，缺了会被当成用户真实输入渲染（见 dsh-todo-keeper 注释）。 */
function makeNotice(text, summary) {
  if (createUserMessage !== null) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary },
    });
  }
  return makeNoticeFallback(text, summary);
}

// ---------- 视图缓存（section 的 text() 必须同步返回，所以索引走同步构建 + 缓存） ----------
let viewCache = { notes: [], index: null, builtAt: 0, listing: '' };

function listNoteNames() {
  try { return readdirSync(notesDir()).filter((n) => n.endsWith('.md')); } catch { return []; }
}

/** 同步构建视图。55 条约几毫秒；目录清单或索引 mtime 变化、或超过 TTL 时重建。 */
function getView(config = null) {
  const names = listNoteNames();
  const listing = `${names.length}|${names.sort().join(',')}`;
  const idxMtime = (() => { try { return statSync(indexPath()).mtimeMs; } catch { return 0; } })();
  const fresh = viewCache.index !== null
    && viewCache.listing === listing
    && viewCache.idxMtime === idxMtime
    && (Date.now() - viewCache.builtAt) < (config?.viewTtlMs ?? DEFAULTS.viewTtlMs);
  if (fresh) return viewCache;

  const notes = [];
  for (const fileName of names) {
    try {
      const text = readFileSync(join(notesDir(), fileName), 'utf8');
      const parsed = parseNoteFile(text);
      if (parsed.meta.deleted === 'true') continue;
      notes.push(normalizeNote(fileName.slice(0, -3), parsed.meta, parsed.body, text.length));
    } catch { /* 跳过读不了的文件 */ }
  }
  notes.sort(noteSort);
  // 命中次数外挂在 usage.json，避免每次召回都改写笔记文件
  const usage = readJsonSyncOrNull(join(memoryDir(), 'usage.json')) || {};
  for (const note of notes) {
    const u = usage[note.id];
    if (u) { note.hits = Number(u.hits) || 0; note.lastHit = String(u.lastHit || ''); }
  }
  viewCache = { notes, index: buildIndex(notes), builtAt: Date.now(), listing, idxMtime };
  return viewCache;
}

function invalidateView() { viewCache = { notes: [], index: null, builtAt: 0, listing: '', idxMtime: 0 }; }

let tail = Promise.resolve();
function enqueue(job) {
  const run = tail.then(job, job);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

async function saveUsage(ids, ts) {
  const path = join(memoryDir(), 'usage.json');
  const usage = readJsonSyncOrNull(path) || {};
  for (const id of ids) {
    const cur = usage[id] || { hits: 0, lastHit: '' };
    usage[id] = { hits: (Number(cur.hits) || 0) + 1, lastHit: ts };
  }
  await atomicWrite(path, JSON.stringify(usage, null, 2));
  invalidateView(); // 命中数变了：不让视图缓存继续拿旧的 hits
}

// ---------- 工作区解析 ----------
/** currentWorkspace = 会话 cwd 的目录名（与用户 8 个工作区的目录名一致）。 */
function workspaceOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return basename(cwd);
  } catch { /* 拿不到就退化 */ }
  return '';
}

function scopeMatchFor(mode, workspace) {
  if (mode === 'all') return null;
  if (mode === 'workspace') return (n) => workspace !== '' && n.scope === 'workspace:' + workspace;
  if (mode === 'global') return (n) => (n.scope || 'global') === 'global';
  // auto：全局 + 当前工作区（拿不到工作区时只给全局，宁可少给也不错过滤）
  return (n) => (n.scope || 'global') === 'global'
    || (workspace !== '' && n.scope === 'workspace:' + workspace);
}

function extractUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    const kind = message?.source?.kind;
    if (kind !== undefined && kind !== 'user') continue; // 插件自己注入的通知不算用户输入
    const content = message?.content;
    if (typeof content === 'string') { parts.push(content); continue; }
    if (Array.isArray(content)) {
      for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

// ---------- 工具 ----------
const outputText = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

function makeTools(config) {
  /** 工具侧统一从执行上下文（execute 的第二个参数）拿 agent，才能按会话工作区过滤。 */
  const workspaceOfExec = (exec) => workspaceOf(exec?.agent);

  return [
    {
      name: TOOL_PREFIX + 'save',
      description: '保存一条归档记忆（跨所有会话持久）。适用：用户偏好/纠正、项目决策、环境事实、重要结论。'
        + '务必填 summary（索引行里给未来自己看的一句话）与 keywords（同义改写/别名，补足关键词检索的语义盲区）；'
        + '项目细节用 scope="workspace:<工作区目录名>"，通用事实留 scope="global"；'
        + '新记忆推翻旧记忆时传 supersedes=[旧id]，旧记忆被标记失效而不删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '简短标题（也用于生成文件名与检索）' },
          content: { type: 'string', description: '记忆正文，自包含（未来会话看不到当前对话）' },
          summary: { type: 'string', description: '一句话摘要，≤60 字，会出现在常驻索引行里' },
          keywords: { type: 'array', items: { type: 'string' }, description: '同义词/别名/英文名，供检索命中' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          scope: { type: 'string', description: 'global（默认）或 workspace:<工作区目录名>' },
          topic: { type: 'string', description: '可选主题名，用于同主题冲突检测' },
          supersedes: { type: 'array', items: { type: 'string' }, description: '本条取代的旧记忆 id' },
        },
        required: ['title', 'content'],
      },
      output: outputText,
      async execute(args) {
        const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
        const content = typeof args.content === 'string' ? args.content : '';
        if (!title || !content.trim()) return '保存失败：title 与 content 都不能为空。';
        const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
        const keywords = Array.isArray(args.keywords) ? args.keywords.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
        const supersedes = Array.isArray(args.supersedes) ? args.supersedes.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : [];
        const rawScope = typeof args.scope === 'string' ? args.scope.trim() : '';
        const scope = rawScope === '' ? 'global' : rawScope;
        if (scope !== 'global' && !scope.startsWith('workspace:')) {
          return '保存失败：scope 只能是 global 或 workspace:<工作区目录名>。';
        }
        const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
        const summary = typeof args.summary === 'string' ? args.summary.replace(/\s+/g, ' ').trim().slice(0, 120) : '';

        try {
          return await enqueue(async () => {
            const view = getView(config);
            const notes = view.notes;
            const id = makeId(title, notes);
            const now = nowIso();
            const note = {
              id, title, tags, created: now, updated: now, summary, keywords, scope, topic,
              related: [], status: 'active', supersedes, supersededBy: '', hits: 0, lastHit: '', body: content,
            };
            const fileText = renderNoteFile(noteMeta(note), content);
            await atomicWrite(join(notesDir(), id + '.md'), fileText);

            const hints = [];
            // 近似重复提示（不阻断写入）
            const similar = findSimilar(view.index, { title, tags, body: content }, 3)
              .filter((s) => s.sim >= config.duplicateHintAt);
            if (similar.length > 0) {
              hints.push('疑似与已有记忆重复（相似度）：'
                + similar.map((s) => `[${s.note.id}] ${s.note.title}（${s.sim.toFixed(2)}）`).join('、')
                + '。若确认是同一件事，请用 supersedes 合并，或用 mem_forget 清理重复项。');
            }
            // 同主题新旧并存 → 冲突提示
            if (topic) {
              const sameTopic = notes.filter((n) => n.topic === topic && n.status !== 'superseded' && n.id !== id);
              if (sameTopic.length > 0) {
                hints.push(`主题「${topic}」下已有 ${sameTopic.length} 条未失效记忆：`
                  + sameTopic.map((n) => `[${n.id}] ${n.title}`).join('、')
                  + '。请确认新旧关系，必要时在本条或旧条上用 supersedes 明确取代。');
              }
            }
            // 落地 supersedes
            for (const oldId of supersedes) {
              const target = notes.find((n) => n.id === oldId);
              if (!target) { hints.push(`supersedes 里的 [${oldId}] 不存在，已忽略。`); continue; }
              const meta = noteMeta(target);
              meta.status = 'superseded';
              meta.supersededBy = id;
              meta.updated = now;
              await atomicWrite(join(notesDir(), oldId + '.md'), renderNoteFile(meta, target.body));
              hints.push(`已标记 [${oldId}] 为 superseded（文件保留，仍可 mem_get 追溯）。`);
            }

            // 索引：重读磁盘保证与文件一致
            invalidateView();
            const rebuilt = getView(config).notes;
            await atomicWrite(indexPath(), JSON.stringify({
              version: 2, marker: 'dsh-memory-router', builtAt: nowIso(),
              notes: rebuilt.map((n) => { const c = { ...n }; delete c.body; return c; }),
            }, null, 2));
            await recordStats({ kind: 'save', id, scope, chars: fileText.length });

            return [`已保存归档记忆 [${id}] ${title}`,
              `scope=${scope}${tags.length ? ' ｜ #' + tags.join(' #') : ''}${keywords.length ? ' ｜ 关键词 ' + keywords.length + ' 个' : ''}`,
              hints.length > 0 ? '\n提示：\n- ' + hints.join('\n- ') : ''].filter(Boolean).join('\n');
          });
        } catch (error) { return '保存失败：' + (error?.message || String(error)); }
      },
    },
    {
      name: TOOL_PREFIX + 'recall',
      description: '按关键词检索归档记忆（中文友好：单字 + 二字组切分、字段化 BM25、RRF 融合、MMR 去冗余）。'
        + '需要回忆过往会话保存的细节时主动使用；命中为 0 时会回退给出最近记忆与索引提示。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索词，可多个（空格分隔）' },
          limit: { type: 'integer', description: '最多返回几条，默认 6' },
          scope: { type: 'string', enum: ['auto', 'global', 'workspace', 'all'], description: 'auto=全局+当前工作区（默认）' },
          withBody: { type: 'boolean', description: '是否直接附带正文片段（默认 true）' },
          includeInvalid: { type: 'boolean', description: '是否把已失效记忆纳入候选，默认 false（仅追溯旧结论时打开）' },
        },
        required: ['query'],
      },
      output: outputText,
      async execute(args, exec) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return '检索失败：query 不能为空。';
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 30) : 6;
        const scopeMode = typeof args.scope === 'string' ? args.scope : 'auto';
        const withBody = args.withBody !== false;
        const includeInvalid = args.includeInvalid === true;
        try {
          const view = getView(config);
          const workspace = workspaceOfExec(exec);
          const hits = search(view.index, query, {
            scopeMatch: scopeMatchFor(scopeMode, workspace),
            topK: limit,
            halfLifeDays: config.halfLifeDays, wTime: config.wTime, wFreq: config.wFreq, includeInvalid,
          });
          const ts = nowIso();
          if (hits.length === 0) {
            const recent = view.notes.filter((n) => !isInvalidNote(n)).slice(0, 8);
            return [`没有匹配「${query}」的记忆（已检索 ${view.notes.length} 条）。`,
              '回退给出最近 8 条，供你自己挑（也可用 mem_index 浏览全貌）：',
              ...recent.map((n) => `[${n.id}] ${n.title}${n.summary ? ' ｜ ' + n.summary : ''}`)].join('\n');
          }
          enqueue(() => saveUsage(hits.map((h) => h.note.id), ts)).catch(() => {});
          await recordStats({ kind: 'search', query: query.slice(0, 80), hits: hits.length, ids: hits.map((h) => h.note.id) });
          const lines = [`找到 ${hits.length} 条（按相关度排序；正文用 mem_get <id> 拉取）：`];
          for (const hit of hits) {
            const n = hit.note;
            lines.push('', `[${n.id}] ${n.title} ｜ 相关度 ${hit.score.toFixed(3)}`
              + (n.scope !== 'global' ? ` ｜ ${n.scope}` : '')
              + ((n.tags || []).length ? ' ｜ #' + n.tags.join(' #') : ''));
            if (n.summary) lines.push(`  摘要：${n.summary}`);
            if (withBody) lines.push(`  片段：${makeSnippet(n.body, query)}`);
            if (n.status === 'superseded') lines.push(`  ⚠ 已失效（被 [${n.supersededBy}] 取代）`);
          }
          return lines.join('\n');
        } catch (error) { return '检索失败：' + (error?.message || String(error)); }
      },
    },
    {
      name: TOOL_PREFIX + 'get',
      description: '按 id 读取一条归档记忆的完整正文。id 来自 mem_recall / mem_index 的结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '记忆 id（可带 .md；支持唯一前缀）' } },
        required: ['id'],
      },
      output: outputText,
      async execute(args) {
        const ref = typeof args.id === 'string' ? args.id.trim().replace(/\.md$/, '') : '';
        if (!ref) return '读取失败：id 不能为空。';
        try {
          const view = getView(config);
          let matches = view.notes.filter((n) => n.id === ref);
          if (matches.length === 0) matches = view.notes.filter((n) => n.id.startsWith(ref));
          if (matches.length === 0) return `未找到记忆「${ref}」。可用 mem_index 浏览全部 ${view.notes.length} 条。`;
          if (matches.length > 1) {
            return 'id 有歧义，候选：\n' + matches.map((n) => `- [${n.id}] ${n.title}`).join('\n');
          }
          const note = matches[0];
          let text = '';
          try { text = await readFile(join(notesDir(), note.id + '.md'), 'utf8'); } catch { text = ''; }
          const parsed = parseNoteFile(text);
          enqueue(() => saveUsage([note.id], nowIso())).catch(() => {});
          const related = (note.related || []).length ? `\n关联：${note.related.map((r) => '[' + r + ']').join(' ')}` : '';
          let out = [`[${note.id}] ${note.title}`,
            `创建：${note.created} ｜ 更新：${note.updated} ｜ scope：${note.scope} ｜ 命中：${note.hits}`
            + (note.status === 'superseded' ? ` ｜ ⚠ 已被 [${note.supersededBy}] 取代` : ''),
            (note.tags || []).length ? `标签：${note.tags.join(', ')}` : '',
            (note.keywords || []).length ? `关键词：${note.keywords.join(', ')}` : '',
            related,
            '', parsed.body || note.body || '（正文为空）'].filter((l) => l !== '').join('\n');
          if (out.length > 12000) out = out.slice(0, 12000) + '\n…（内容过长已截断）';
          return out;
        } catch (error) { return '读取失败：' + (error?.message || String(error)); }
      },
    },
    {
      name: TOOL_PREFIX + 'index',
      description: '列出归档索引（一行一条：id ｜ 标题 ｜ 标签 ｜ 摘要），可按 scope 与标签过滤，支持分页。'
        + '用于浏览记忆库全貌，或在 mem_recall 搜不到时人工挑。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '每页条数，默认 30' },
          offset: { type: 'integer', description: '从第几条开始，默认 0' },
          scope: { type: 'string', enum: ['auto', 'global', 'workspace', 'all'], description: '默认 auto' },
          tag: { type: 'string', description: '可选：只列带此标签的记忆' },
          includeCold: { type: 'boolean', description: '是否包含从未命中过的旧记忆（默认 true）' },
          includeInvalid: { type: 'boolean', description: '是否包含已失效记忆，默认 false' },
        },
        required: [],
      },
      output: outputText,
      async execute(args, exec) {
        try {
          const view = getView(config);
          const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 30;
          const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
          const scopeMode = typeof args.scope === 'string' ? args.scope : 'auto';
          const tag = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : '';
          const includeCold = args.includeCold !== false;
          const includeInvalid = args.includeInvalid === true;
          const match = scopeMatchFor(scopeMode, workspaceOfExec(exec));
          const isCold = (n) => (n.hits || 0) === 0 && daysSince(n.updated || n.created) > config.coldDays;
          // 默认只列有效记忆；要追溯已失效的，用 includeInvalid 显式打开
          const pool = includeInvalid ? view.notes : view.notes.filter((n) => !isInvalidNote(n));
          let notes = pool.filter((n) => includeCold || !isCold(n));
          if (match) notes = notes.filter(match);
          if (tag) notes = notes.filter((n) => (n.tags || []).some((t) => String(t).toLowerCase() === tag));
          const page = notes.slice(offset, offset + limit);
          if (page.length === 0) return `没有符合条件的记忆（共 ${pool.length} 条）。`;
          const lines = page.map((n) => {
            const tags = (n.tags || []).slice(0, 4).map((t) => '#' + t).join(' ');
            return `[${n.id}] ${n.title}${tags ? ' ｜ ' + tags : ''}${n.summary ? ' ｜ ' + n.summary : ''}`
              + (n.status === 'superseded' ? ' ｜ ⚠已失效' : '') + (n.scope !== 'global' ? ` ｜ ${n.scope}` : '');
          });
          return [`归档记忆共 ${pool.length} 条，筛选后 ${notes.length} 条，显示第 ${offset + 1}～${offset + page.length} 条：`,
            ...lines,
            notes.length > offset + limit ? `\n（还有 ${notes.length - offset - limit} 条，用 offset=${offset + limit} 继续）` : ''].filter(Boolean).join('\n');
        } catch (error) { return '列出失败：' + (error?.message || String(error)); }
      },
    },
    {
      name: TOOL_PREFIX + 'edit_core',
      description: '读写核心记忆 MEMORY.md——它在每个会话的系统提示里常驻注入，务必保持精炼。'
        + 'action=read 查看全文与分节优先级；append 追加到分节；replace 整体替换分节；remove 删除分节；'
        + 'prio 调整分节优先级（超预算时优先级高的先保留）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['read', 'append', 'replace', 'remove', 'prio'] },
          section: { type: 'string', description: '分节名（MEMORY.md 里的 ## 标题）' },
          text: { type: 'string', description: 'append/replace 的正文' },
          prio: { type: 'integer', description: 'prio 动作的优先级，越大越先保留（默认 0）' },
        },
        required: ['action'],
      },
      output: outputText,
      async execute(args) {
        const action = args.action;
        if (!['read', 'append', 'replace', 'remove', 'prio'].includes(action)) {
          return '编辑失败：action 必须是 read / append / replace / remove / prio。';
        }
        const section = typeof args.section === 'string' ? args.section.trim() : '';
        const text = typeof args.text === 'string' ? args.text : '';
        try {
          if (action === 'read') {
            const raw = readSyncOrNull(corePath());
            if (raw === null) return 'MEMORY.md 尚不存在。';
            const parsed = parseCore(raw);
            const lines = parsed.sections.map((s) => `- ## ${s.title}（prio=${s.prio}，${s.body.length} 字符）`);
            return [`MEMORY.md 共 ${raw.length} 字符，${parsed.sections.length} 个分节（注入预算 ${config.coreBudgetChars}）：`,
              ...lines, '', '—— 全文 ——', '', raw].join('\n');
          }
          if (!section) return '编辑失败：section 不能为空。';
          if ((action === 'append' || action === 'replace') && !text.trim()) return '编辑失败：append/replace 需要提供 text。';
          return await enqueue(async () => {
            const raw = readSyncOrNull(corePath());
            const parsed = parseCore(raw === null ? '' : raw);
            let target = parsed.sections.find((s) => s.title.toLowerCase() === section.toLowerCase());
            const titles = parsed.sections.map((s) => s.title).join('、') || '（无）';
            if (action === 'remove') {
              if (!target) return `删除失败：找不到分节「${section}」。现有分节：${titles}`;
              parsed.sections = parsed.sections.filter((s) => s !== target);
            } else if (action === 'append') {
              if (target) target.body = (target.body.replace(/\s+$/, '') ? target.body.replace(/\s+$/, '') + '\n' : '') + text;
              else { target = { title: section, body: text, prio: 0 }; parsed.sections.push(target); }
            } else if (action === 'replace') {
              if (!target) return `替换失败：找不到分节「${section}」。现有分节：${titles}`;
              target.body = text;
            } else {
              const prio = Number.isInteger(args.prio) ? args.prio : 0;
              if (!target) return `设置失败：找不到分节「${section}」。现有分节：${titles}`;
              target.prio = prio;
            }
            const next = renderCore(parsed);
            await atomicWrite(corePath(), next);
            invalidateView();
            const verb = { append: '追加', replace: '替换', remove: '删除', prio: '设置优先级' }[action];
            const warn = next.length > config.coreBudgetChars
              ? `（注意：核心记忆 ${next.length} 字符已超预算 ${config.coreBudgetChars}，超出部分会在注入时被裁剪。`
                + '建议把细节用 mem_save 下沉成归档记忆，或给重要分节设置更高的 prio。）' : '';
            return `已${verb}核心记忆分节「${section}」。当前 MEMORY.md ${next.length} 字符。${warn}`;
          });
        } catch (error) { return '编辑失败：' + (error?.message || String(error)); }
      },
    },
    {
      name: TOOL_PREFIX + 'forget',
      description: '清理一条归档记忆。mode=soft（默认）标记失效但保留可追溯；mode=hard 写墓碑并从索引移除。'
        + '用于清理过时、错误或重复的记忆。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要清理的记忆 id' },
          mode: { type: 'string', enum: ['soft', 'hard'], description: '默认 soft' },
          reason: { type: 'string', description: '可选：失效原因，写进 frontmatter' },
        },
        required: ['id'],
      },
      output: outputText,
      async execute(args) {
        const ref = typeof args.id === 'string' ? args.id.trim().replace(/\.md$/, '') : '';
        if (!ref) return '清理失败：id 不能为空。';
        const mode = args.mode === 'hard' ? 'hard' : 'soft';
        const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
        try {
          return await enqueue(async () => {
            const view = getView(config);
            const matches = view.notes.filter((n) => n.id === ref || n.id.startsWith(ref));
            if (matches.length === 0) return `清理失败：未找到「${ref}」。可用 mem_index 浏览全部。`;
            if (matches.length > 1) {
              return 'id 有歧义，请精确指定：\n' + matches.map((n) => `- [${n.id}] ${n.title}`).join('\n');
            }
            const note = matches[0];
            if (mode === 'hard') {
              await atomicWrite(join(notesDir(), note.id + '.md'),
                `---\ndeleted: true\nid: ${note.id}\ntitle: ${note.title}\n---\n\n（此记忆已删除${reason ? '：' + reason : ''}）\n`);
            } else {
              const meta = noteMeta(note);
              meta.status = 'superseded';
              meta.updated = nowIso();
              if (reason) meta.invalidReason = reason;
              await atomicWrite(join(notesDir(), note.id + '.md'), renderNoteFile(meta, note.body));
            }
            invalidateView();
            const rebuilt = getView(config).notes;
            await atomicWrite(indexPath(), JSON.stringify({
              version: 2, marker: 'dsh-memory-router', builtAt: nowIso(),
              notes: rebuilt.map((n) => { const c = { ...n }; delete c.body; return c; }),
            }, null, 2));
            return mode === 'hard'
              ? `已删除记忆 [${note.id}] ${note.title}（墓碑保留，不会复活）。`
              : `已把记忆 [${note.id}] ${note.title} 标记为失效（文件保留，mem_get 仍可追溯）。`;
          });
        } catch (error) { return '清理失败：' + (error?.message || String(error)); }
      },
    },
    {
      name: TOOL_PREFIX + 'stats',
      description: '查看记忆库的运行记账：常驻注入字数、召回次数与命中、各 scope 条数、冷热分布。'
        + '用于判断注入预算该调大还是调小——业界没有公开的标准值，本插件靠这份数据调参。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: outputText,
      async execute() {
        try {
          const view = getView(config);
          const stats = readStats();
          const byScope = new Map();
          let cold = 0; let superseded = 0; let totalChars = 0;
          for (const n of view.notes) {
            byScope.set(n.scope, (byScope.get(n.scope) || 0) + 1);
            totalChars += n.size || 0;
            if (n.status === 'superseded') superseded += 1;
            if ((n.hits || 0) === 0) cold += 1;
          }
          const lastL0 = [...(stats.events || [])].reverse().find((e) => e.kind === 'l0');
          const lastRecall = [...(stats.events || [])].reverse().find((e) => e.kind === 'recall');
          return [
            `记忆库：${memoryDir()}`,
            `归档记忆 ${view.notes.length} 条（${(totalChars / 1024).toFixed(1)} KB 正文），其中从未命中 ${cold} 条、已失效 ${superseded} 条`,
            `按 scope：${[...byScope.entries()].map(([k, v]) => `${k}=${v}`).join('，')}`,
            `常驻预算：核心 ${config.coreBudgetChars} 字符 / 索引 ${config.indexBudgetChars} 字符（上限 ${config.indexMaxLines} 行）`,
            lastL0 ? `最近一次 L0 注入：${lastL0.chars} 字符（核心 ${lastL0.coreChars}，列出 ${lastL0.indexListed} 行，`
              + `预算外 ${lastL0.truncated || 0} · 裁剪分节 ${lastL0.croppedSections || 0}）` : '尚无 L0 注入记账',
            lastRecall ? `最近一次自动召回：${lastRecall.chars} 字符，命中 ${(lastRecall.ids || []).length} 条` : '尚无自动召回记录',
            `累计：L0 注入 ${stats.totals?.l0 || 0} 次，自动召回 ${stats.totals?.recall || 0} 次，写入 ${stats.totals?.saves || 0} 次，检索 ${stats.totals?.searches || 0} 次`,
          ].join('\n');
        } catch (error) { return '统计失败：' + (error?.message || String(error)); }
      },
    },
  ];
}

// ---------- 首次启动：给旧笔记补 summary/scope（先备份） ----------
const ENRICH_MARK = 'routerEnrichedAt';

/** 写 enrich 标记。用 read-modify-write 合并，绝不整份重建（否则会抹掉记账）。 */
async function markEnriched() {
  const current = readJsonSyncOrNull(statsPath()) || {};
  await atomicWrite(statsPath(), JSON.stringify({ ...current, [ENRICH_MARK]: nowIso() }, null, 2));
}

/**
 * 首次启动给旧笔记补 summary/scope。
 * 关键：**先扫出真正需要补的条目，再决定要不要备份**——否则每次启动都会多留一份整库备份。
 * 只补 frontmatter 两行，正文一字不动（已用备份逐条 byte 比对验证过）。
 */
async function enrichOnce(config) {
  const stats = readStats();
  if (stats[ENRICH_MARK] || !config.enrich) return null;
  const pending = [];
  for (const fileName of listNoteNames()) {
    try {
      const path = join(notesDir(), fileName);
      const text = await readFile(path, 'utf8');
      const parsed = parseNoteFile(text);
      if (parsed.meta.deleted === 'true') continue;
      const needSummary = !parsed.meta.summary;
      const needScope = !parsed.meta.scope;
      if (!needSummary && !needScope) continue;
      const meta = { ...parsed.meta };
      if (needScope) meta.scope = 'global';
      if (needSummary) {
        const firstLine = String(parsed.body || '').split('\n')
          .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
          .find((line) => line.length > 0) || parsed.meta.title || '';
        meta.summary = firstLine.slice(0, 80);
      }
      pending.push({ path, meta, body: parsed.body });
    } catch { /* 单条读不了就跳过，不影响其余 */ }
  }
  if (pending.length === 0) {
    await markEnriched();
    return null;
  }
  const backup = await backupMemory('pre-enrich');
  let changed = 0;
  for (const item of pending) {
    try {
      await atomicWrite(item.path, renderNoteFile(item.meta, item.body));
      changed += 1;
    } catch { /* 单条失败不影响其余 */ }
  }
  await markEnriched();
  invalidateView();
  return { changed, backup };
}

const TEMPLATE = [
  '# DSH 核心记忆',
  '',
  '> 由 dsh-memory-router 维护，注入每个会话的系统提示。保持精炼——超预算会被裁剪（但磁盘全文完整）。',
  '> 分节级优先级：在分节正文里写 `<!-- prio: 3 -->`，数字越大越先保留。',
  '',
  '## 用户',
  '<!-- prio: 5 -->',
  '- （长期有效的用户画像与偏好）',
  '',
  '## 环境',
  '<!-- prio: 4 -->',
  '- （机器、部署、常用路径等长期事实）',
  '',
  '## 项目',
  '<!-- prio: 3 -->',
  '- （进行中的项目、关键决策与约定）',
  '',
].join('\n');

// ---------- apply ----------
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  // 引导创建（不阻塞激活）
  enqueue(async () => {
    await mkdir(notesDir(), { recursive: true });
    if (readSyncOrNull(corePath()) === null) await atomicWrite(corePath(), TEMPLATE);
    if (readSyncOrNull(indexPath()) === null) {
      await atomicWrite(indexPath(), JSON.stringify({ version: 2, marker: 'dsh-memory-router', notes: [] }, null, 2));
    }
  }).then(async () => {
    const result = await enrichOnce(config);
    if (result) {
      console.log(`dsh-memory-router: 已为 ${result.changed} 条旧笔记补全 summary/scope，原库备份在 ${result.backup}`);
    }
  }).catch((error) => console.error('dsh-memory-router: bootstrap failed', error));

  const toolDefs = makeTools(config);
  for (const def of toolDefs) ctx.tools.register(def);

  // L0：常驻注入。text() 必须同步返回，因此走同步视图缓存。
  // 注意 AssembleContext 实际带 agent（dsh-agent-loop 自己就用 context.agent?.session.header.cwd），
  // 所以这里能按会话工作区过滤索引。
  let lastL0Log = 0;
  ctx.systemPrompt.section({
    name: 'dsh-memory-router:l0',
    order: config.l0Order,
    interpolate: false,
    text: (context) => {
      try {
        const built = buildL0(getView(config).notes, config, workspaceOf(context?.agent));
        const now = Date.now();
        if (now - lastL0Log > 5000) { // 热路径：5 秒内只记一次账
          lastL0Log = now;
          recordStats({ kind: 'l0', ...built.stats }).catch(() => {});
        }
        return built.text;
      } catch (error) {
        return '（跨会话记忆：本段暂不可用 — ' + (error?.message || String(error)) + '）';
      }
    },
  });

  // L1：每轮自动召回。只在"这一步含真实用户输入"时触发，命中为 0 时什么都不做。
  const recallStates = new WeakMap();
  function stateOf(agent) {
    let state = recallStates.get(agent);
    if (state === undefined) { state = { injected: new Set(), recalledAt: 0 }; recallStates.set(agent, state); }
    return state;
  }

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    try {
      if (!config.autoRecall || decision?.kind !== 'enter') return decision;
      const userText = extractUserText(messages);
      if (userText.length < 2) return decision;
      const state = stateOf(agent);
      if (Date.now() - state.recalledAt < config.recallCooldownMs) return decision;
      state.recalledAt = Date.now();

      const workspace = workspaceOf(agent);
      const view = getView(config);
      const hits = search(view.index, userText, {
        scopeMatch: scopeMatchFor('auto', workspace),
        topK: config.recallTopK,
        halfLifeDays: config.halfLifeDays, wTime: config.wTime, wFreq: config.wFreq,
        exclude: state.injected,
      }).filter((h) => h.score >= config.recallMinScore);
      if (hits.length === 0) return decision;

      for (const hit of hits) state.injected.add(hit.note.id);
      const card = buildRecallCard(hits, { maxChars: config.recallMaxChars });
      const ids = hits.map((h) => h.note.id);
      enqueue(() => saveUsage(ids, nowIso())).catch(() => {});
      recordStats({ kind: 'recall', chars: card.length, ids, workspace }).catch(() => {});

      if (config.recallChannel === 'inject' && typeof agent.inject === 'function') {
        agent.inject(makeNotice(card, `记忆召回 ${ids.length} 条`));
        return decision;
      }
      return { ...decision, messages: [...decision.messages, makeNotice(card, `记忆召回 ${ids.length} 条`)] };
    } catch (error) {
      console.error('dsh-memory-router: 自动召回失败', error);
      return decision;
    }
  });

  // ---------- 设置页 API（webServer 是可选的：缺席时插件照常工作，只是设置页不可用） ----------
  ctx.inject(['webServer'], (scoped) => {
    // 按路径分端点（不用查询串做分发）：exact 路由是否含查询串匹配没有把握，
    // 拆成 5 条 exact 路径就完全没有这个不确定性。
    const route = async (req, res) => {
        const send = (code, payload) => {
          try {
            res.statusCode = code;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(payload));
          } catch { /* 响应已发出时忽略 */ }
        };
        const slim = (n) => ({
          id: n.id, title: n.title, tags: n.tags, summary: n.summary, scope: n.scope,
          topic: n.topic, hits: n.hits || 0, lastHit: n.lastHit || '',
          created: n.created, updated: n.updated, status: n.status,
          supersededBy: n.supersededBy || '', chars: n.size || 0,
        });
        const num = (value, fallback) => {
          // 注意 Number(null) === 0：缺参数时必须回落，否则会被当成显式的 0
          if (value === null || value === undefined || value === '') return fallback;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : fallback;
        };
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const op = url.pathname.split('/').filter(Boolean).pop() || 'summary';
          const workspace = url.searchParams.get('workspace') || '';

          if (req.method === 'POST' && op === 'forget') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const def = toolDefs.find((d) => d.name === TOOL_PREFIX + 'forget');
            const message = await def.execute({ id: body.id, mode: body.mode === 'hard' ? 'hard' : 'soft', reason: body.reason });
            send(200, { ok: true, message });
            return;
          }

          if (op === 'summary') {
            const view = getView(config);
            const stats = readStats();
            const byScope = {};
            const scopes = new Set();
            let cold = 0; let superseded = 0; let bytes = 0;
            for (const n of view.notes) {
              byScope[n.scope] = (byScope[n.scope] || 0) + 1;
              scopes.add(n.scope);
              bytes += n.size || 0;
              if (n.status === 'superseded') superseded += 1;
              if ((n.hits || 0) === 0) cold += 1;
            }
            const built = buildL0(view.notes, config, workspace);
            const coreRaw = readSyncOrNull(corePath()) || '';
            const core = parseCore(coreRaw);
            const events = stats.events || [];
            send(200, {
              dir: memoryDir(),
              notes: view.notes.length, byScope, scopes: [...scopes].sort(), cold, superseded, bytes,
              budget: {
                coreBudgetChars: config.coreBudgetChars, indexBudgetChars: config.indexBudgetChars,
                indexMaxLines: config.indexMaxLines, autoRecall: config.autoRecall,
                recallTopK: config.recallTopK, recallChannel: config.recallChannel, coldDays: config.coldDays,
              },
              l0: built.stats,
              core: {
                rawChars: coreRaw.length,
                sections: core.sections.map((s) => ({ title: s.title, prio: s.prio, chars: s.body.length })),
              },
              recent: {
                l0: [...events].reverse().find((e) => e.kind === 'l0') || null,
                recall: [...events].reverse().find((e) => e.kind === 'recall') || null,
                totals: stats.totals || {},
              },
            });
            return;
          }

          if (op === 'preview') {
            const override = {
              ...config,
              coreBudgetChars: Math.max(200, num(url.searchParams.get('core'), config.coreBudgetChars)),
              indexBudgetChars: Math.max(0, num(url.searchParams.get('index'), config.indexBudgetChars)),
              indexMaxLines: Math.max(0, num(url.searchParams.get('lines'), config.indexMaxLines)),
            };
            const built = buildL0(getView(config).notes, override, workspace);
            send(200, { chars: built.stats.chars, stats: built.stats, text: built.text });
            return;
          }

          if (op === 'note') {
            const id = url.searchParams.get('id') || '';
            const view = getView(config);
            const note = view.notes.find((n) => n.id === id);
            if (!note) { send(404, { error: '未找到记忆 ' + id }); return; }
            send(200, { ...slim(note), body: note.body, keywords: note.keywords, related: note.related });
            return;
          }

          if (op === 'notes') {
            const view = getView(config);
            const query = (url.searchParams.get('query') || '').trim();
            const scopeMode = url.searchParams.get('scope') || 'all';
            const limit = Math.min(200, Math.max(1, num(url.searchParams.get('limit'), 40)));
            const offset = Math.max(0, num(url.searchParams.get('offset'), 0));
            const match = scopeMode === 'all' ? null : scopeMatchFor(scopeMode, workspace);
            if (query.length > 0) {
              const hits = search(view.index, query, {
                scopeMatch: match, topK: limit + offset,
                halfLifeDays: config.halfLifeDays, wTime: config.wTime, wFreq: config.wFreq,
              });
              send(200, {
                total: view.notes.length, matched: hits.length,
                rows: hits.slice(offset).map((h) => ({ ...slim(h.note), score: Number(h.score.toFixed(4)) })),
              });
              return;
            }
            const all = view.notes.filter((n) => !match || match(n));
            send(200, {
              total: view.notes.length, matched: all.length,
              rows: all.slice(offset, offset + limit).map(slim),
            });
            return;
          }

          send(400, { error: '未知 op：' + op });
        } catch (error) {
          send(500, { error: (error && error.message) ? error.message : String(error) });
        }
    };
    scoped.effect(() => {
      const disposers = [];
      for (const path of ['summary', 'notes', 'note', 'preview', 'forget']) {
        disposers.push(scoped.webServer.register({
          kind: 'exact', path: '/dsh-memory-router/' + path, handler: route,
        }));
      }
      return () => { for (const dispose of disposers) { try { dispose(); } catch { /* 忽略 */ } } };
    }, 'dsh-memory-router: settings api routes');
  });

  console.log(`dsh-memory-router: 已激活，记忆库 ${memoryDir()}`
    + `（L0 order=${config.l0Order}，预算 ${config.coreBudgetChars}+${config.indexBudgetChars} 字符，`
    + `自动召回 ${config.autoRecall ? '开' : '关'}，通道 ${config.recallChannel}）`);
}

/** 测试用：暴露内部纯函数，便于在无 DSH 环境下做单元验证。 */
export const __test = { resolveConfig, DEFAULTS, extractUserText, workspaceOf, scopeMatchFor, POLICY, guardText };
