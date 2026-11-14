# dsh-memory-router

> DeepSeek Harness 的跨会话记忆插件：**核心记忆常驻 + 归档索引一行一条 + 每轮按话题自动召回 + 中文友好 BM25/RRF 检索**，并自动做去重、冲突提示与冷记忆降级。
>
> 纯 ESM、**零第三方依赖**、无向量库、无 sidecar 进程；记忆是磁盘上的普通 Markdown，随时可手工编辑。

## 为什么不是"把上限调大"

旧插件（`dsh-core-memory`）的三个硬伤不是数字问题：

| 症状 | 旧实现 | 本插件 |
|---|---|---|
| 核心记忆超 3000 字符**静默消失** | 硬截断尾巴 | 按分节优先级 + 文件顺序装入预算，超出的分节**列名告知**，磁盘全文完整 |
| 索引固定"最近 12 条" | `notes.slice(0, 12)` | 预算内尽量多列（实测 21/51 行）+ 未列出部分的**标签分布**兜底 |
| 中文同义改写搜不到 | 朴素关键词加分 | 单字 + 二字组分词、字段化 BM25、RRF 融合、MMR 去冗余 |

核心思路是**渐进披露**（与工作区里 `AGENTS.md → ROUTER.md → 规则 → 资料库` 的四级结构同构）：

```text
L0  systemPrompt.section(order 60)  核心记忆 + 归档索引，每步组装时同步生成
L1  agent/pre-step                  按你当轮说的话检索，命中才注入一张「记忆召回卡」
L2  mem_recall / mem_get / mem_index 按需拉正文
L3  notes/<id>.md                    正文文件，也可直接用编辑器打开
```

L1 是相对旧插件**新增的一层**：命中为 0 时一个 token 都不花，命中时只注入摘要卡。

## 安装

本机（Windows + 第三方 Electron 壳 + `desktop` profile）实际可行的是**既有那套约定**：

1. 在共享的 `profiles/node_modules/` 里建 junction 指向本包目录：

   ```powershell
   New-Item -ItemType Junction -Path "$env:DSH_HOME\profiles\node_modules\dsh-memory-router" -Target "<本包绝对路径>"
   ```

2. 在**当前正在运行的那个 profile** 的 `cordis.patch.yml` 末尾加一行（先备份）：

   ```yaml
   - insert:
       - id: memory-router
         name: 'dsh-memory-router'
         config:
           coreBudgetChars: 5000
           indexBudgetChars: 2000
   ```

   注意：YAML 里不认 `${DSH_HOME}` 这类变量，路径要写死或走 `!!js dshHomePath(...)`。

3. **完全退出并重启 DSH**——首次加载新包必须重启，热重载不足以载入新的 JS 生成。

> ⚠️ **`plugin_manager` 的 `install_bundle` 在本机不可用**：它把安装转交 pnpm，而本机 profile 的
> `node_modules` 是从 `C:\Users\<你>\AppData\Local\pnpm\store\v11` 链接的，pnpm 现在却想用
> `D:\.pnpm-store\v11`，于是直接报 `[ERR_PNPM_UNEXPECTED_STORE]`。
> **不要**为了装插件去重装依赖或改全局 store 配置——本包零依赖，junction 就够。
> 另外：`install_bundle` 作用于 `DSH_PROFILE` 指向的**当前** profile（本机是 `desktop`），不是 `web`。

## 设置页

装好后在 **设置 → 跨会话记忆**（slot `settings.section`，order 18）有本插件自己的面板：

- **概览**：归档条数 / 已失效 / 从未命中 / 常驻注入字符 / 核心记忆字符，外加预算占用条与作用域分布；
- **预算模拟**：拖动核心预算、索引预算、行数上限，点「试算」实时看到「这一档会注入多少字符、列出多少行、裁掉几个分节」，并可展开**注入全文**——这是唯一能直观感受"预算取舍"的地方（不会写盘，真实预算仍在 `cordis.patch.yml`）；
- **记忆浏览**：关键词检索 + 作用域过滤 + 展开正文 + 一键「标记失效」（软删，文件保留可追溯）；
- **最近活动**：L0 注入与自动召回的记账。

界面只用主题 token（`--dsw-alias-*`），亮/暗主题通用。

## 数据布局

与旧插件**共用** `$DSH_HOME/memory/`，写的格式是旧格式的**超集**（旧插件忽略它不认识的字段），因此两套插件可以并存读同一份数据。

```text
$DSH_HOME/memory/
├── MEMORY.md      核心记忆（L0 常驻）。分节写 `<!-- prio: N -->` 可提高保留优先级
├── notes/         归档记忆正文，一条一文件（frontmatter 为旧格式超集）
├── index.json     元数据索引（带 marker；被旧插件重写成旧格式时自动从 notes/ 重建）
├── usage.json     命中次数与最近命中时间（外挂，避免每次召回都改写笔记文件）
└── stats.json     注入记账：每次 L0 注入多少字符、列了几行、召回命中几条
```

备份落在 `$DSH_HOME/memory-backups/<时间戳>/`。

新增的 frontmatter 字段：`summary`、`keywords`、`scope`、`topic`、`related`、`status`、`supersedes`、`supersededBy`、`hits`、`lastHit`。

## 七个工具（`mem_` 前缀，与旧插件的 `memory_*` 零重名）

| 工具 | 作用 |
|---|---|
| `mem_save` | 写归档记忆。**请顺手填 `summary` 与 `keywords`**——summary 进索引行，keywords 补足关键词检索的语义盲区 |
| `mem_recall` | 检索（中文友好）。命中为 0 时回退给出最近记忆，不返回空 |
| `mem_get` | 按 id 读全文 |
| `mem_index` | 分页浏览索引，可按 scope / 标签过滤 |
| `mem_edit_core` | 读写核心记忆分节（read/append/replace/remove/prio） |
| `mem_forget` | soft 标记失效（可追溯）/ hard 写墓碑 |
| `mem_stats` | 查看注入记账与冷热分布——**预算该调大还是调小看这里** |

## 配置

写在 `cordis.patch.yml` 的那一行 `config` 里；没写的键回落到代码默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `coreBudgetChars` | 5000 | 核心记忆常驻预算（字符） |
| `indexBudgetChars` | 2000 | 归档索引预算（字符） |
| `indexMaxLines` | 40 | 索引行数上限 |
| `l0Order` | 60 | L0 段在 system prompt 中的排序位 |
| `autoRecall` | true | 每轮自动召回开关 |
| `recallTopK` | 5 | 每轮最多召回几条 |
| `recallMaxChars` | 3000 | 召回复卡字数上限 |
| `recallChannel` | `prestep` | `prestep`=改写本步消息（当步可见）；`inject`=`agent.inject()` 官方通道 |
| `coldDays` | 120 | 从未命中且超过此天数 → 降级出常驻索引（仍可搜到） |
| `halfLifeDays` / `wTime` / `wFreq` | 180 / 0.25 / 0.15 | 时间衰减与访问频次加权 |
| `duplicateHintAt` | 0.5 | 写入时相似度超过它就给"疑似重复"提示 |
| `enrich` | true | 首次激活给旧笔记补 `summary`/`scope`（会先整目录备份） |

> ⚠️ **注入预算没有业界标准值**。Anthropic / Cline / OpenClaw / Letta 都没有公开统一数值，只有 Cline 给出"有效上限约为窗口的 75%～80%"。所以这里的默认值是保守的初始值，请用 `mem_stats` 的记账数据来调。

## 检索是怎么算的

1. **分词**：中文产出「字符 unigram + 相邻 bigram」。纯 bigram 打不中单字查询——LUCENE-4286 的原文数据是"含汉字的查询里约 10% 是单字查询"。拉丁字母/数字按词切，`-_.:/\\` 视为词内字符，使 id 与路径整体可检索。
2. **打分**：四个字段（title / tags / summary / body）各自建倒排、各自 BM25，`k1=1.2 b=0.75`，`IDF = ln(1 + (N-df+0.5)/(df+0.5))`。
3. **融合**：RRF，`k=1`（Graphiti 源码实测值，不是常被引用的 60）。
4. **去冗余**：MMR，`λ=0.5`（Graphiti 实测值），相似度用本地 Jaccard。
5. **加权**：时间衰减 + 访问频次 + scope。

## 作用域

`scope` 只有两个取值：`global`（任何会话都注入）或 `workspace:<工作区目录名>`（只在那个工作区注入）。当前工作区取自会话的 `cwd`，取不到时退化为"只给 global"——**宁可少给，也不错过滤**。

全局组渲染在工作区组之前，这样跨工作区的前缀保持稳定，有利于 prompt 前缀的 KV cache 复用。

## 已知限制

- 检索是**关键词**（BM25 系），不是语义检索。同义改写靠 `keywords` 字段和 bigram 兜底；embedding 是明确的待办，不是遗漏。
- 索引受预算限制会截断，未列出的部分只有标签分布 + 可检索，**不会**出现在常驻提示里。
- **注入文本里的半角 `~` 会被统一转成全角 `～`**：本机 GFM 开了 `singleTilde`，半角 `~` 会被当删除线定界符。副作用是"讲到半角波浪号"的内容字符本身会被替换。
- 自动召回只在"这一步含真实用户输入"时触发，且同一会话内同一条记忆不重复注入。

## 回滚

三条，任选：

1. `plugin_manager` `action: set_bundle`，`enabled: false`
2. `plugin_manager` `action: remove_bundle`
3. 删掉包目录

旧插件 `dsh-core-memory` 全程未被修改，因此回滚零风险。数据侧可直接把 `memory-backups/<时间戳>/` 覆盖回 `memory/`。

## 参考来源（关键设计都有出处）

- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（context rot / attention budget / just-in-time 检索）
- [Anthropic — Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)（三级渐进披露）
- [OpenClaw — Memory concepts](https://docs.openclaw.ai/concepts/memory.md)（四层 markdown 记忆；**超预算只截断注入副本**；compaction 前的 memory flush）
- [Graphiti search_utils.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/search/search_utils.py)（RRF `rank_const=1`、`DEFAULT_MMR_LAMBDA=0.5`、`RELEVANT_SCHEMA_LIMIT=10`）
- [Letta — Memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks.md)（常驻块上限单位是**字符**，示例 5000；块不参与检索）
- [Basic Memory 技术架构](https://github.com/TylerJNewman/basic-memory/blob/883beff75d23d55b0ada1ccb433d27fc4ab2ce1e/memories/technical/Basic%20Memory%20Technical%20Architecture%20-%20Deep%20Dive%20for%20JavaScript%20Rebuild.md)（markdown 为真源、字段化索引、四级降级检索）
- [LUCENE-4286](https://issues.apache.org/jira/browse/LUCENE-4286)（纯 bigram 无法命中单字查询）
- [Elasticsearch — CJK bigram token filter](https://www.elastic.co/docs/reference/text-analysis/analysis-cjk-bigram-tokenfilter)（`output_unigrams` 默认 `false`）

## License

MIT
