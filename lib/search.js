// lib/search.js — 零依赖检索核心（不引入任何第三方包、不引入向量库）。
//
// 设计依据见 DESIGN.md §5，逐条来源：
//   分词：CJK 字符 unigram + 相邻二元组 bigram
//         —— LUCENE-4286 取证："About 10% of our queries that contain Han characters are
//            single character queries"，而纯 bigram 在有相邻可组词字符的位置**不产出单字 token**。
//            （Elasticsearch 的 output_unigrams 默认 false，即默认那档有代价。）
//   打分：字段化 BM25，k1 = 1.2 / b = 0.75（SQLite FTS5 与 Lucene 的通用默认值），
//         IDF 用 ln(1 + (N-df+0.5)/(df+0.5))，+1 是防止高频词 IDF 变负。
//   融合：RRF，k = 1 —— Graphiti 源码取证（rank_const = 1）。
//   去冗余：MMR，λ = 0.5 —— Graphiti 源码取证（DEFAULT_MMR_LAMBDA = 0.5），
//         相似度用本地 Jaccard（零依赖，不引入向量）。
//   加权：时间衰减 + 访问频次 + scope（DESIGN.md §5.5）。
export const K1 = 1.2;
export const B = 0.75;
export const RRF_K = 1;
export const MMR_LAMBDA = 0.5;

/** 四个独立字段各自建倒排、各自排名——来自 Graphiti「四类命名空间各自召回」的做法。 */
export const FIELDS = ['title', 'tags', 'summary', 'body'];

/**
 * 「已失效」记忆（被新记忆取代 / 被软删）默认不进入任何上下文：
 * 不进自动召回、不进关键词检索、不算重复候选。它们是历史证据，只留追溯用；
 * 需要追溯时显式传 includeInvalid，或直接用 mem_get 按 id 读。
 */
export function isInvalidNote(note) {
  return !!note && (note.status === 'superseded' || note.status === 'invalid');
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const WORD = /[a-z0-9_\-.\/\\:]+/g;
const SEP = /[-_.:\/\\]+/;
const MAX_WORD = 40;

/**
 * 分词。中文产出「单字 + 相邻二字组」；拉丁字母/数字按词切分，并把 `-_.:/\\`
 * 视为词内字符，使 `20261013-091552-dsh-glob`、`D:\...\plugins`、
 * `deepseek-v4.1-flash` 这类 id 与路径整体可检索（basic-memory 的 tokenchars 0x2F 同源教训）。
 * 同时产出被分隔符切开的子词，保证「a-b-c」与「abc」互相能命中。
 */
export function tokenize(text) {
  const out = [];
  const lower = String(text === undefined || text === null ? '' : text).toLowerCase();

  // 1) CJK：unigram + bigram
  let run = '';
  const flush = () => {
    if (run.length === 0) return;
    for (let i = 0; i < run.length; i += 1) out.push(run[i]);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of lower) {
    if (CJK.test(ch)) run += ch;
    else flush();
  }
  flush();

  // 2) 拉丁/数字/路径类
  const words = lower.match(WORD) || [];
  for (const raw of words) {
    const w = raw.replace(/^[-_.:\/\\]+/, '').replace(/[-_.:\/\\]+$/, '');
    if (w.length === 0) continue;
    if (w.length <= MAX_WORD) out.push(w);
    if (SEP.test(w)) {
      for (const part of w.split(SEP)) if (part.length >= 2) out.push(part);
    } else if (w.length > MAX_WORD) {
      // 超长无分隔符 token（例如超长 hash）只保留尾部窗口，避免单个 token 撑爆索引
      out.push(w.slice(-MAX_WORD));
    }
  }
  return out;
}

/** 一条记忆的四个可检索字段文本。 */
function fieldsOf(note) {
  return {
    title: `${note.title || ''} ${note.id || ''}`,
    tags: `${(note.tags || []).join(' ')} ${note.topic || ''}`,
    summary: `${note.summary || ''} ${(note.keywords || []).join(' ')}`,
    body: note.body || '',
  };
}

/** 建内存倒排索引。notes 需要 id/title/tags/summary/keywords/body。 */
export function buildIndex(notes) {
  const index = { N: notes.length, docs: new Map(), fields: {} };
  for (const field of FIELDS) index.fields[field] = { postings: new Map(), len: new Map(), avgdl: 1 };

  for (const note of notes) {
    const texts = fieldsOf(note);
    const allTokens = new Set();
    for (const field of FIELDS) {
      const tokens = tokenize(texts[field]);
      const target = index.fields[field];
      target.len.set(note.id, tokens.length);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [token, count] of tf) {
        let posting = target.postings.get(token);
        if (!posting) { posting = []; target.postings.set(token, posting); }
        posting.push([note.id, count]);
      }
      for (const t of tokens) allTokens.add(t);
    }
    index.docs.set(note.id, { note, tokens: allTokens });
  }

  for (const field of FIELDS) {
    const target = index.fields[field];
    let sum = 0;
    for (const value of target.len.values()) sum += value;
    target.avgdl = target.len.size > 0 ? sum / target.len.size : 1;
  }
  return index;
}

/** 单字段 BM25。返回 id → score（只含命中该字段的文档）。 */
function bm25Field(field, tokens) {
  const scores = new Map();
  const N = Math.max(1, field.len.size);
  for (const token of tokens) {
    const posting = field.postings.get(token);
    if (!posting || posting.length === 0) continue;
    const df = posting.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    if (!(idf > 0)) continue;
    for (const [id, tf] of posting) {
      const dl = field.len.get(id) || 1;
      const denom = tf + K1 * (1 - B + B * (dl / (field.avgdl || 1)));
      if (denom <= 0) continue;
      scores.set(id, (scores.get(id) || 0) + (idf * (tf * (K1 + 1))) / denom);
    }
  }
  return scores;
}

export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function timeBoostOf(note, halfLifeDays) {
  const t = Date.parse(note.updated || note.created || '');
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  return 1 / (1 + ageDays / Math.max(1, halfLifeDays));
}

/**
 * 检索。
 * @param index buildIndex 的产物
 * @param query 查询串
 * @param options
 *   scopeMatch(note) -> boolean  作用域过滤（DESIGN.md §9）
 *   topK        取前几条（默认 8）
 *   mmr         是否做 MMR 去冗余（默认 true）
 *   halfLifeDays/wTime/wFreq     加权参数
 *   exclude     Set<id> 需要排除的 id（同会话已注入过）
 *   includeInvalid 是否把已失效（superseded / invalid）记忆也纳入候选，默认 false
 */
export function search(index, query, options = {}) {
  const {
    scopeMatch = null, topK = 8, mmr = true,
    halfLifeDays = 180, wTime = 0.25, wFreq = 0.15, exclude = null, includeInvalid = false,
  } = options;
  const tokens = tokenize(query);
  if (tokens.length === 0 || index.N === 0) return [];

  // 四路各自排名 → RRF 融合
  const rrf = new Map();
  for (const field of FIELDS) {
    const scores = bm25Field(index.fields[field], tokens);
    if (scores.size === 0) continue;
    const sorted = [...scores.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    sorted.forEach(([id], rank) => {
      rrf.set(id, (rrf.get(id) || 0) + 1 / (rank + RRF_K));
    });
  }
  if (rrf.size === 0) return [];

  // 过滤 + 归一化 + 加权
  const pool = [];
  let maxRrf = 0;
  for (const [id, value] of rrf) {
    if (exclude && exclude.has(id)) continue;
    const doc = index.docs.get(id);
    if (!doc) continue;
    if (!includeInvalid && isInvalidNote(doc.note)) continue;
    if (scopeMatch && !scopeMatch(doc.note)) continue;
    if (value > maxRrf) maxRrf = value;
    pool.push([id, value]);
  }
  if (pool.length === 0) return [];

  const rel = new Map();
  for (const [id, value] of pool) {
    const note = index.docs.get(id).note;
    const boost = 1 + wTime * timeBoostOf(note, halfLifeDays) + wFreq * Math.log2(1 + (note.hits || 0)) * 0.1;
    rel.set(id, (value / (maxRrf || 1)) * boost);
  }

  const ordered = [...rel.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const chosen = [];
  if (mmr) {
    const remaining = ordered.slice();
    while (chosen.length < topK && remaining.length > 0) {
      let bestAt = 0;
      let bestValue = -Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const [id, value] = remaining[i];
        let maxSim = 0;
        const tokensI = index.docs.get(id).tokens;
        for (const picked of chosen) {
          const sim = jaccard(tokensI, index.docs.get(picked).tokens);
          if (sim > maxSim) maxSim = sim;
        }
        const score = MMR_LAMBDA * value - (1 - MMR_LAMBDA) * maxSim;
        if (score > bestValue) { bestValue = score; bestAt = i; }
      }
      chosen.push(remaining[bestAt][0]);
      remaining.splice(bestAt, 1);
    }
  } else {
    for (const [id] of ordered.slice(0, topK)) chosen.push(id);
  }

  return chosen.map((id, i) => ({
    note: index.docs.get(id).note,
    score: rel.get(id),
    rank: i + 1,
    matched: tokens.filter((t) => index.docs.get(id).tokens.has(t)).slice(0, 8),
  }));
}

/** 命中片段：优先取 query token 首次出现处附近（与旧插件同思路，长度收紧）。 */
export function makeSnippet(body, query, width = 110) {
  const flat = String(body || '').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const lower = flat.toLowerCase();
  const tokens = tokenize(query).filter((t) => t.length >= 2).slice(0, 12);
  let at = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, width) + (flat.length > width ? '…' : '');
  const start = Math.max(0, at - 30);
  const end = Math.min(flat.length, at + width);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/**
 * 写入时的近似重复检测（DESIGN.md §8）：返回最相似的前 N 条。
 * 用正文 token 集合的 Jaccard，零依赖、可解释。
 */
export function findSimilar(index, candidate, limit = 3) {
  const candTokens = new Set(tokenize(`${candidate.title || ''} ${(candidate.tags || []).join(' ')} ${candidate.body || ''}`));
  const scored = [];
  for (const [id, doc] of index.docs) {
    if (candidate.id && id === candidate.id) continue;
    if (isInvalidNote(doc.note)) continue; // 已失效记忆不算重复候选
    const sim = jaccard(candTokens, doc.tokens);
    if (sim > 0) scored.push({ note: doc.note, sim });
  }
  scored.sort((a, b) => (b.sim - a.sim) || a.note.id.localeCompare(b.note.id));
  return scored.slice(0, limit);
}
