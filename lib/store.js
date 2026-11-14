// lib/store.js — dsh-memory-router 的磁盘层。
//
// 设计红线（与 DESIGN.md §4 一致）：
//   1. 格式是旧插件 dsh-core-memory 的**超集**，因此两套插件可以并存读同一份数据；
//   2. 索引损坏/被别人重写成旧格式时，能从 notes/ 完整重建（notes/ 永远是真相源）；
//   3. 任何写入都走「临时文件 + rename」，不会写出半个文件；
//   4. 动手改用户既有笔记之前先整目录备份。
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------- 路径 ----------
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
export const memoryDir = () => join(dshHome(), 'memory');
export const corePath = () => join(memoryDir(), 'MEMORY.md');
export const notesDir = () => join(memoryDir(), 'notes');
export const indexPath = () => join(memoryDir(), 'index.json');
export const statsPath = () => join(memoryDir(), 'stats.json');
// 备份放 memory 同级，避免被别的插件当成"一条记忆"扫描到。
export const backupsRoot = () => join(dshHome(), 'memory-backups');

export function readSyncOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
export function readJsonSyncOrNull(path) {
  const raw = readSyncOrNull(path);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export function nowIso() { return new Date().toISOString(); }

// ---------- 小工具 ----------
export function splitList(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(',').map((s) => s.trim()).filter(Boolean);
}
export function joinList(list) {
  return (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean).join(', ');
}
export function noteSort(a, b) {
  return String(b.created || '').localeCompare(String(a.created || ''));
}
export function daysSince(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 86400000);
}

/** 与旧插件同构的 id 生成：时间戳 + ASCII slug（保持一致，避免同一库出现两种风格）。 */
export function makeId(title, existing) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  const base = stamp + (slug ? '-' + slug : '');
  const taken = new Set((existing || []).map((n) => n.id));
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) { candidate = base + '-' + n; n++; }
  return candidate;
}

// ---------- frontmatter ----------
// 注意：**只支持单行 `key: value`**，与旧插件的解析器一致——多行值会让旧插件读错。
export function parseNoteFile(text) {
  const out = { meta: {}, body: String(text === undefined || text === null ? '' : text) };
  if (typeof text === 'string' && text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) {
      const fm = text.slice(3, end);
      out.body = text.slice(end + 4).replace(/^\n+/, '');
      for (const line of fm.split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) out.meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    }
  }
  return out;
}

const FM_ORDER = ['id', 'title', 'tags', 'created', 'updated', 'summary', 'keywords',
  'scope', 'topic', 'related', 'status', 'supersedes', 'supersededBy', 'hits', 'lastHit'];

export function renderNoteFile(meta, body) {
  const lines = ['---'];
  for (const key of FM_ORDER) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) { if (value.length === 0) continue; lines.push(key + ': ' + joinList(value)); }
    else if (value === '') continue;
    else lines.push(key + ': ' + value);
  }
  // 旧插件不认识的字段也原样保留，避免并存期间互相丢字段。
  for (const key of Object.keys(meta)) {
    if (FM_ORDER.includes(key)) continue;
    const value = meta[key];
    if (value === undefined || value === null || value === '') continue;
    lines.push(key + ': ' + (Array.isArray(value) ? joinList(value) : value));
  }
  lines.push('---', '', String(body || '').replace(/\s+$/, ''), '');
  return lines.join('\n');
}

/** 把 frontmatter 元数据规范化成内存里的 note 对象（缺字段补默认值）。 */
export function normalizeNote(id, meta, body, size) {
  const status = String(meta.status || 'active').trim() || 'active';
  const scope = String(meta.scope || 'global').trim() || 'global';
  return {
    id,
    title: String(meta.title || id),
    tags: splitList(meta.tags),
    created: String(meta.created || ''),
    updated: String(meta.updated || meta.created || ''),
    summary: String(meta.summary || ''),
    keywords: splitList(meta.keywords),
    scope,
    topic: String(meta.topic || ''),
    related: splitList(meta.related),
    status,
    supersedes: splitList(meta.supersedes),
    supersededBy: String(meta.supersededBy || ''),
    hits: Number.isFinite(Number(meta.hits)) ? Number(meta.hits) : 0,
    lastHit: String(meta.lastHit || ''),
    size: Number.isFinite(size) ? size : 0,
    body: String(body || ''),
  };
}

export function noteMeta(note) {
  const meta = {
    id: note.id, title: note.title, tags: note.tags,
    created: note.created, updated: note.updated,
    summary: note.summary, keywords: note.keywords, scope: note.scope,
    status: note.status, hits: note.hits,
  };
  if (note.topic) meta.topic = note.topic;
  if (note.related && note.related.length) meta.related = note.related;
  if (note.supersedes && note.supersedes.length) meta.supersedes = note.supersedes;
  if (note.supersededBy) meta.supersededBy = note.supersededBy;
  if (note.lastHit) meta.lastHit = note.lastHit;
  return meta;
}

// ---------- 核心记忆分节 ----------
// 支持分节级优先级标记：分节正文第一行的 `<!-- prio: N -->`（N 越大越先保留）。
export function parseCore(text) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  const header = [];
  const sections = [];
  let current = null;
  let body = [];
  const push = () => {
    if (current === null) return;
    const raw = body.join('\n');
    const m = /<!--\s*prio\s*:\s*(-?\d+)\s*-->/.exec(raw);
    sections.push({
      title: current,
      body: raw.replace(/<!--\s*prio\s*:\s*-?\d+\s*-->\s*/g, '').replace(/^\n+/, '').replace(/\n+\s*$/, ''),
      prio: m ? Number(m[1]) : 0,
    });
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { push(); current = m[1]; body = []; }
    else if (current !== null) body.push(line);
    else header.push(line);
  }
  push();
  return { header: header.join('\n'), sections };
}

export function renderCore(parsed) {
  let text = String(parsed.header || '').replace(/\s+$/, '');
  for (const s of parsed.sections) {
    const body = String(s.body || '').replace(/^\n+/, '').replace(/\n+\s*$/, '');
    const marker = s.prio ? '<!-- prio: ' + s.prio + ' -->\n' : '';
    text += '\n\n## ' + s.title + '\n' + (body || marker ? marker + body + '\n' : '');
  }
  return text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

// ---------- 索引 ----------
const INDEX_MARKER = 'dsh-memory-router';

export async function listNoteFiles() {
  try {
    const entries = await readdir(notesDir());
    return entries.filter((n) => n.endsWith('.md'));
  } catch { return []; }
}

/** 从 notes/ 全量重建索引（真相源是文件，索引只是缓存）。 */
export async function rebuildIndex() {
  const out = [];
  for (const name of await listNoteFiles()) {
    try {
      const text = await readFile(join(notesDir(), name), 'utf8');
      const parsed = parseNoteFile(text);
      if (parsed.meta.deleted === 'true') continue; // 墓碑文件不复活
      const id = name.slice(0, -3);
      out.push(normalizeNote(id, parsed.meta, parsed.body, text.length));
    } catch { /* 跳过无法解析的文件 */ }
  }
  return out.sort(noteSort);
}

/**
 * 读索引。若索引不是本插件写的（例如并存期间被旧插件重写成 version 1），
 * 就从 notes/ 重建——这样两套插件互相写索引也不会丢字段。
 */
export async function loadIndex() {
  const parsed = readJsonSyncOrNull(indexPath());
  if (parsed && Array.isArray(parsed.notes) && parsed.marker === INDEX_MARKER
      && Number(parsed.version) >= 2) {
    const notes = parsed.notes.filter((n) => n && typeof n.id === 'string');
    if (notes.length === parsed.notes.length) return notes.sort(noteSort);
  }
  return rebuildIndex();
}

export async function saveIndex(notes) {
  const payload = {
    version: 2,
    marker: INDEX_MARKER,
    builtAt: nowIso(),
    notes: (notes || []).map((n) => {
      const copy = { ...n };
      delete copy.body; // 正文留在 notes/，索引只存元数据
      return copy;
    }),
  };
  await atomicWrite(indexPath(), JSON.stringify(payload, null, 2));
}

/** 把索引里的元数据与磁盘正文合成完整 note。 */
export async function withBody(note) {
  if (note.body !== undefined && note.body !== '') return note;
  const text = await readFile(join(notesDir(), note.id + '.md'), 'utf8');
  const parsed = parseNoteFile(text);
  return normalizeNote(note.id, { ...parsed.meta, ...noteMeta(note) }, parsed.body, text.length);
}

export async function readNoteFile(id) {
  const text = await readFile(join(notesDir(), id + '.md'), 'utf8');
  const parsed = parseNoteFile(text);
  return normalizeNote(id, parsed.meta, parsed.body, text.length);
}

// ---------- 备份 ----------
async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await writeFile(dst, await readFile(src));
  }
}

/** 整目录备份。返回备份路径；memory/ 不存在时返回 null。 */
export async function backupMemory(tag) {
  const src = memoryDir();
  if (readSyncOrNull(corePath()) === null) {
    // 连 MEMORY.md 都没有，视为尚未初始化
    try { await readdir(src); } catch { return null; }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const dst = join(backupsRoot(), `${stamp}${tag ? '-' + tag : ''}`);
  await copyDir(src, dst);
  return dst;
}
