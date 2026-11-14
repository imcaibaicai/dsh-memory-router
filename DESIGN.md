# dsh-memory-router 架构方案（v1 草案）

> 状态：**待你确认**。确认后我才开始写代码。
> 作者：DSH Agent（2026-10-13）
> 前置结论来自：本地源码侦察、两轮联网调研（含取证 URL）、DSH 官方插件编写规范（`cordis-plugin-development` skill）、以及你答的 7 个取舍。

---

## 0. 你的 7 项决策（本方案的输入）

| # | 问题 | 你的选择 |
|---|---|---|
| 1 | 插件形态 | **新建 `dsh-memory-router`，与旧 `dsh-core-memory` 并存试跑** |
| 2 | 注入与召回 | **分层索引常驻 + 每轮自动召回正文** |
| 3 | 检索算法 | BM25+二元组切分、写入时补 summary/keywords、时间衰减+访问频次加权；embedding 列为待办 |
| 4 | 记忆库治理 | 近似去重与合并提示、冷记忆衰减、冲突检测（不做会话结束自动抽取） |
| 5 | 作用域 | **全局共享 + 按工作区打标过滤**；默认先披露全局，绑定工作区/具体任务的到工作区再披露 |
| 6 | 核心记忆超预算 | 按分节优先级 + 最近使用自动裁剪 |
| 7 | 交付节奏 | 先出方案文档，你确认后再写代码 |

第二轮追问后的补充决定（v1.1 落实）：

| # | 问题 | 你的选择 |
|---|---|---|
| 8 | 常驻预算数字 | **先用保守值**（core 5000 / index 2000 字符），靠 `stats.json` 记账数据再调 |
| 9 | 召回内容通道 | **只用路线 A**：`agent.inject()`，接受召回卡在会话记录里可见 |
| 10 | 试跑方式 | **直接完整接管**：新插件一次提供 L0+L1+L2，验证通过后停用旧插件 |
| 11 | persona 归属 | **直接停用，不移植**（原话「这个我不用」，只要求不出 bug） |

---

## 1. 现状诊断（旧插件：`plugins/dsh-core-memory/lib/index.js`，629 行）

| 症状 | 证据（行号） | 后果 |
|---|---|---|
| 核心记忆硬截断 3000 字符 | `index.js:244-247` `if (core.length > 3000) core = core.slice(0, 3000)` | 超限部分**静默消失**，模型完全不知道它存在 |
| 归档索引固定"最近 12 条" | `index.js:256-258` `notes.slice(0, 12)` | 第 13 条之后的历史记忆，不主动搜就永远想不起来 |
| 纯关键词打分，无 IDF、无长度归一 | `index.js:123-145`（标题+3、标签+3、正文每次出现+1、整串+2） | 长文档天然高分；高频词不降权；中文同义改写基本搜不到 |
| 无去重、无冲突、无衰减 | 全库无相关代码 | 记忆越写越烂，新旧矛盾同时被注入 |
| 无作用域概念 | 全库无相关代码 | 8 个工作区的记忆互相污染注意力 |
| 无注入记账 | 全库无相关代码 | 不知道每次注入花了多少字节，无法调参 |

结论：**不是"上限数字调大"能解决的**，是缺少"分层披露 + 相关性路由 + 记账"这三件事。

---

## 2. 架构总览：把工作区的四级渐进披露搬进插件

对称映射（左边是你两个工作区已验证的机制，右边是插件里的落地形态）：

```text
工作区（Agent自学 / Agent时间管理）        dsh-memory-router
─────────────────────────────────────  ────────────────────────────────────────
L0 AGENTS.md（首屏 ≤90 行极简指针）   ←→  L0 常驻注入块（systemPrompt.section）
                                           核心记忆（预算内）+ 主题索引（一行/条）
L1 ROUTER.md（意图→文件映射表）        ←→  L1 每轮自动召回（命中才注入，未命中零成本）
L2 00_协作协议 / 02_运行规则           ←→  L2 工具按需检索（mem_recall / mem_get）
L3 03_科目资料库/{学科}/...            ←→  L3 记忆正文（notes/<id>.md，工具或直接读文件）
```

两层互联机制同样照搬：
- **自上而下**：L0 索引里每行带 `[id]`，模型据此决定要不要 `mem_get`；
- **文尾辐射**：每条 note 的 frontmatter 带 `related`（同类/上下游 id），读到一条能顺链展开。

**与旧插件的关键差异：L1 是新增的**。旧插件只有"常驻 L0 + 工具 L2"，而 L0 里塞不下正文，工具又依赖模型自觉。L1 补上了"系统主动、按当轮话题、只注入命中正文"这一层——这正是"大量跨对话记忆"能真正被用起来的地方。

---

## 3. 注入点与官方硬约束（这一节决定实现可行性）

DSH 官方插件规范（`cordis-plugin-development/references/practices.md`）里逐条取证到的约束：

| 规范原文（英） | 对本插件的含义 |
|---|---|
| "Add prompt text with `ctx.systemPrompt.section()`." | L0 常驻块用它，不用 `system-prompt/assemble` |
| "Add per-agent context with `agent.inject()`; it is logged as `agent/inbox/spliced` at call time and enters the next admitted step." | **L1 的官方通道**：注入即入账（符合"会话日志是唯一真相源"） |
| "`agent/request` listeners cannot change request messages." | 排除"篡改当次请求"这条捷径 |
| "Register per-agent behavior on `agent.ctx`, obtained in an `agent/created` listener … Wrap it in one `agent.ctx.effect()` … keep that disposer keyed by agent in your plugin's own effect." | 每会话状态的正确挂法与双重释放要求 |
| "Do not listen to `system-prompt/assemble` to add or remove tools or text." | 明确禁止 |
| "Keep per-session state derived from the log in a `ctx.sessionProjections` unit instead of subscribing to `session/event` and rescanning." | 别自己订阅事件重扫 |
| "Do not append session events with a new `type`." | 不许自定义事件类型（否则会话打不开） |
| "Put tunable values in the plugin's `Config`." | 所有预算/阈值走 `cordis.patch.yml`，升级不丢 |

已取证的常量（`app.asar` 内 `dsh-system-prompt` 源码）：

```js
SECTION_ORDERS = { HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500,
                   TEAM_POLICY: 600, …, TOOLS_SDK: 5000, DELIVERABLE_FILE_REFERENCES: 9000,
                   HARNESS_SOURCE: 10000, WEB_SURFACE: 10100, DEPLOYMENT_PERSONA_SUFFIX: 10200 }
CONTEXT_ORDERS = { SANDBOX_POLICY: 110, APPROVAL_POLICY: 115, SUBAGENT_DELEGATION: 120 }
```

**L0 用 `order: 60`**（= 紧跟 persona 前缀、在计划/团队策略之前；旧插件已验证可用）。
**L1 用 `order: 8900`**（= 放在全部工具段之后、deliverable 之前）。理由：prompt 前缀的 KV cache 复用取决于前缀稳定性，把每步都可能变的 L1 放到尾部、把稳定的 L0 留在前部，可以让 L0 及其之前的全部段落缓存命中最大化。

L1 的两条候选实现路线（**风险点，见 §10**）：

- **路线 A（先落地，官方明确支持）**：`agent.inject()` 投递一条 user 消息，内容形如
  `〔记忆召回·自动〕命中 3 条：…（这不是用户本人说的话）…`
  代价：会作为 user 消息留在会话记录里（可见、持久）。好处：官方推荐、语义明确、同一条不必重复注入。
- **路线 B（优化项，需实现时验证）**：在 `agent/created` 里用该 agent 的 `agent.ctx` 注册一个 agent 作用域的动态 section（`text` 是函数，每步重算），从插件缓存的"该会话最新用户消息"推导召回内容。彻底临时、不落账、下一轮自动消失；但依赖"agent 作用域动态 section"这一能力，**必须先用 `cordis_inspect_query` 验证**。

**决定（v1.1）：只用路线 A。** 你已确认接受"召回卡在会话记录里可见"这一代价。路线 B 本次不实现，只作为未来优化项登记在 §13，避免把未验证的能力塞进第一版。

召回卡的固定格式（**供模型区分"这不是用户说的话"**）：

```text
〔记忆召回·自动〕这不是用户输入。以下是与当前话题相关的历史记忆摘要：
[20261013-185928-markdown] Markdown 单波浪号误判为删除线 ｜ #DSH #渲染
  半角 ~ 会被 GFM singleTilde 当删除线定界符；源头禁写半角 ~ 是唯一可行解法。
…（共 3 条，正文用 mem_get <id> 拉取）
```

---

## 4. 数据布局

沿用 `$DSH_HOME/memory/`（= `D:\DeepSeekHarness\.dsh\memory\`），**格式做旧格式的超集**，因此旧插件能继续读同一份数据（并存试跑的关键前提）。

```text
$DSH_HOME/memory/
├── MEMORY.md              核心记忆（L0 常驻）。新增可选分节级标记，兼容旧 ## 分节
├── notes/                 归档记忆正文，一条一文件
│   └── <YYYYMMDD-HHMMSS-slug>.md
├── index.json             元数据索引（旧字段原样保留 + 新字段），损坏可从 notes/ 重建
├── router.json            [新增] 主题路由图：tag/topic → note id 列表 + 热度
├── stats.json             [新增] 注入记账与命中统计（供调参）
└── PERSONA.md             回复风格（仍归旧插件管，本插件不碰、不重复注入）
```

单条 note 的 frontmatter（`*` = 新增字段；旧插件忽略未知字段，因此向后兼容）：

```yaml
---
id: 20261013-185928-markdown
title: Markdown 单波浪号误判为删除线：真根因
tags: DSH, Markdown, 前端渲染, 根因定位
created: 2026-10-13T18:59:28.000Z
updated: 2026-10-13T18:59:28.000Z
summary: 本机 Markdown 把半角 ~ 当删除线定界符；源头禁写半角 ~ 是唯一可用解法。   # *
keywords: 波浪号, tilde, 删除线, GFM, singleTilde, 划线, 渲染                  # *
scope: global            # * global | workspace:<工作区名>，默认 global
topic: dsh-ui            # * 可选，用于冲突检测
related: 20261013-192157-until-ics-08-20-08-02                                      # *
status: active           # * active | superseded
supersedes:              # * 本条取代了哪些 id
supersededBy:            # * 被谁取代（不删除，只失效）
hits: 7                  # * 被召回/读到的累计次数
lastHit: 2026-10-13T19:10:00.000Z   # *
---
```

**与你现有 55 条记忆的关系**：不迁移、不改名、不重写。新插件首次启动时做一次**增量补全**——给缺 `summary/keywords/scope` 的旧 note 只补 frontmatter 三行（正文一字不动），并把原文件备份到 `backups/memory-<时间戳>/` 后再写。宁可少补，不可改坏。

---

## 5. 检索：分词、打分、融合、去冗余

### 5.1 分词（零依赖，为中文和你"会打空格"的习惯设计）

1. **中文**：同时产出**字符 unigram + 相邻二元组 bigram**。理由有来源：纯 bigram 无法命中单字查询，故 Lucene 社区给 `CJKBigramFilter` 补了 unigram 开关（LUCENE-4286）；Elasticsearch 的 `cjk_bigram` 同样提供 `output_unigrams`。
2. **英文/数字**：小写化后按非字母数字切分。
3. **保留词内字符** `-` `_` `.` `/` `:`：让 `20261013-091552-dsh-glob`、`D:\...\plugins`、`deepseek-v4.1-flash` 这类 id 与路径整体可检索（basic-memory 的 `tokenchars 0x2F` 是同源教训）。
4. **你打的空格**：空格切出来的 token 额外加权（见下），因为它是你主动给出的语义边界。

### 5.2 BM25（字段化 + 前缀）

常数取 SQLite FTS5 / Lucene 通用默认值：`k1 = 1.2`、`b = 0.75`。

```text
IDF(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))        // +1 防止高频词 IDF 变负
score  = Σ_t IDF(t) · (tf·(k1+1)) / (tf + k1·(1 - b + b·dl/avgdl))
```

四个**独立字段**各自建倒排：`title`、`tags`、`summary+keywords`、`body`。字段间不混在一个分数里——这直接来自 Graphiti 取证到的做法（四类命名空间各自召回）。

前缀索引：中文取 2～3 字、英文取 1～4 字符。

### 5.3 RRF 融合（Graphiti 取证值）

```text
RRF(d) = Σ_over_fields 1 / (rank_field(d) + k)      k = 1     // 取证值：Graphiti rank_const=1
```

`k = 1` 是实测取证（第 1 名 1.0、第 2 名 0.5、第 3 名 0.333），**不是**常被引用的 60。

### 5.4 MMR 去冗余（λ = 0.5，Graphiti 取证值）

```text
MMR(d) = λ·rel(d) - (1-λ)·max_{s∈已选} sim(d, s)    λ = 0.5
sim 本地用 token 集合 Jaccard（零依赖，不引入向量）
```

作用：避免"三条记忆讲同一件事"把 5 个召回名额占满。

### 5.5 时间与频次加权

```text
timeBoost = 1 / (1 + ageDays / halfLifeDays)     halfLifeDays 默认 180
freqBoost = 1 + log2(1 + hits) · 0.1              hits 来自 frontmatter
final     = RRF_after_MMR · (1 + 0.25·timeBoost + 0.15·freqBoost) · scopeFactor
scopeFactor: 当前工作区 1.0 ｜ global 0.9 ｜ 其他工作区 默认直接过滤（不参与）
```

### 5.6 三级兜底（来自 Cline + Letta + basic-memory 的组合）

| 档 | 触发 | 行为 |
|---|---|---|
| ① 常驻档 | 永远 | L0：核心记忆 + 主题索引一行/条。保证"检索空手时仍有最低自我认知" |
| ② 检索档 | 命中 ≥ 1 | 返回 top-k（默认 5）的**摘要 + 片段**，不直接给全文 |
| ③ 空结果档 | 命中 = 0 | **不返回空**，回退「最近 8 条 + 全库一行式索引」，让模型自己挑 |

---

## 6. 注入预算与超限裁剪

**先讲一个必须诚实说明的缺口**：两轮调研没有找到任何官方或可核查的"记忆注入预算标准值"。唯一可核查的定量锚点是 Cline 文档给出的"有效上限为上下文窗口的 75%～80%、约 80% 触发 auto-compact"，以及子代理只回传 1000～2000 token 的浓缩结论。因此下面的数字**是本项目自定的初始值，必须靠记账指标调参**，不要当成行业标准。你已确认先走保守值这条路线。

**上游印证（第三轮取证，一手正文）**：OpenClaw 官方文档对它自己的 `MEMORY.md` 描述的是**完全相同的语义**——超预算时"磁盘文件保留完整、**只截断注入上下文的副本**"，并把截断当作信号（把细节移入 `memory/*.md`）。我们与它的唯一差别是：我们会在注入文本里**显式告诉模型被裁了哪些分节**，它不会。另外它给 `USER.md` 配的是"a separate small budget"，与我们"核心记忆 / 索引"两块分开算预算的做法同构。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `coreBudgetChars` | 5000 | 核心记忆常驻预算（旧插件是 3000 硬截断）。参考 Letta 官方 memory block 示例的 `limit: 5000` 字符 |
| `indexBudgetChars` | 2000 | 主题索引预算，一行/条 |
| `indexMaxLines` | 40 | 索引行数硬上限 |
| `recallMaxNotes` | 5 | 每轮自动召回条数（参考 Graphiti `RELEVANT_SCHEMA_LIMIT = 10` 的下调版） |
| `recallMaxChars` | 3000 | 每轮召回注入字数上限 |
| `recallMinScore` | 0 | RRF 融合后最低分（Graphiti 默认同样不做分数过滤） |
| `coldDays` | 120 | 冷记忆降级阈值 |

**超限裁剪规则（回答你的第 6 项决策）**：
1. 按分节优先级排序（`MEMORY.md` 分节可写可选标记 `<!-- prio: 3 -->`，默认 0）；
2. 同优先级按"最近被命中/更新"倒序；
3. 超预算时从队尾整节裁掉，**但绝不静默**：在注入文本尾部固定追加一行
   `〔已裁剪 N 个分节：<标题列表>；全文仍在 $DSH_HOME/memory/MEMORY.md，可用 mem_core 查看〕`。
4. **全文永不删除**——裁剪只影响"这一次注入什么"。

**记账（每次注入都算）**：注入字节数、条数、命中的 note id、耗时，追加到 `stats.json`；`mem_stats` 工具可查。没有这个数字，预算永远调不准。

---

## 7. 每轮自动召回（L1）的完整流程

```text
用户发消息
  → 取该会话最新用户文本（从 agent 事件/投影取，不重扫日志）
  → 用 §5 的检索算 top-k
  → 过滤：本会话已注入过的 id 跳过（去重）  ／ 分数 < recallMinScore 跳过
  → 命中为 0 → 什么都不做（零成本，不打扰）
  → 命中 ≥ 1 → 组织「记忆召回卡」（摘要 + 关键行，≤recallMaxChars）
       → 路线 A：agent.inject(召回卡)     （入账为 agent/inbox/spliced，下一步生效）
       → 路线 B：更新该 agent 的动态 section 内容（临时，不落账）
  → 更新 stats.json、被命中 note 的 hits/lastHit
```

**为什么"不命中就零成本"很重要**：这直接回应你说的"模型注意力性能优化"——旧插件是**无差别常驻**（不管这次聊什么，12 条索引永远在），新插件是**按需路由**（不相关的话题一个 token 都不花）。

---

## 8. 记忆库治理（回答你的第 4 项决策）

| 机制 | 触发 | 行为 |
|---|---|---|
| 近似去重 | `mem_save` 时 | 与已有 note 算相似度；> 0.75 时**不阻断写入**，返回"疑似重复，候选：`[id]`（相似度 0.83）。要么改标题，要么用 `supersedes` 合并" |
| 合并/失效 | `mem_save(supersedes: [id])` | 旧 note 标 `status: superseded` + `supersededBy` + 时间；**不删除**，仍可 `mem_get` 追溯 |
| 冲突检测 | `mem_save` 时 | 同 `topic` 且关键词重叠高、标题语义距离大 → 提示"可能与 `[id]` 冲突，请确认新旧关系" |
| 冷记忆衰减 | 每次重建索引 | `hits == 0 && age > coldDays` → 降级出常驻索引（仍可 `mem_recall` 搜到）；再写一行说明"另有 M 条冷记忆未列出" |

设计原则来自两处取证：mem0 的"写时决策（ADD/UPDATE/DELETE/NOOP）"思路，与 Graphiti 的双时态"**不删只失效**"。我们用纯 JSON 字段实现后者，零成本。

**明确不做**（你未选）：会话结束时自动抽取候选记忆。原因：需要额外模型调用，且会把噪声写进长期库；等你用一段时间后觉得"总是忘了记"再补。

---

## 9. 作用域（回答你的第 5 项决策）

三个层级，与你的原话对齐："开始默认全局的那部分显示，其他的尤其是很绑定工作区甚至具体任务的就到工作区再披露"：

| scope 值 | 何时注入 | 例子 |
|---|---|---|
| `global` | **任何会话**都进 L0/L1 | 用户画像与偏好、机器环境事实、隐私红线 |
| `workspace:<名>` | 仅当前工作区匹配时进 L0/L1 | "Agent自学工作区用 verify_workspace_links.py 校验死链" |
| 未指定 | 默认按 `global` 处理 | — |

当前工作区的判定：优先用会话的 `cwd`，从 `workspaceRegistry.resolveByPath()`/会话头部取；取不到就退化为 `global`（宁可多给，不可错过滤）。

跨工作区强制可见的例外：隐私红线、用户交互契约这类"必须每次记得"的条目，固定 `global` 且在 L0 里不参与裁剪。

---

## 10. 风险与未验证假设（必须先看这一节）

| # | 假设 | 状态 | 处置 |
|---|---|---|---|
| 1 | `agent.inject()` 能注入自定义文本并进入下一步 | **已取证**（规范原文 + `inject(input){ this.send(input,"next-step",false) }` 源码） | 直接用；**但 `input` 的确切形状（UserMessage 构造与唯一 id）尚未逐字取证** |
| 2 | agent 作用域动态 section（路线 B）可用 | **未验证** | 实现时先 `cordis_inspect_query` 验证；不可用就只用路线 A，方案不塌 |
| 3 | 中文 bigram 的召回损失 | **已取证机制与量化**：LUCENE-4286 原文 "About 10% of our queries that contain Han characters are single character queries"，且纯 bigram 在"有相邻可组词汉字"的位置**根本不产出单字 token** | 采用 unigram+bigram 混合（对应 ES 的 `output_unigrams: true`，其默认值是 `false`，即默认那档有代价） |
| 3b | unigram+bigram 的**索引体积倍数** | **未取证**（Jira 评论未渲染、未取 GitHub 镜像） | 不引用任何膨胀倍数；索引是本进程内存态、随用随建，风险有界 |
| 4 | OpenClaw 的记忆分层/归档/写入时机/检索机制 | **已取证**（`docs.openclaw.ai/concepts/memory.md` 一手正文） | 已并入 §6、§8、§13 |
| 4b | OpenClaw 的 bootstrap budget 具体数值、`memory_search` 的 top-k/阈值/权重 | **未取到**（在 `/reference/memory-config` 与 `/concepts/memory-search`） | 不影响本项目：我们自定数值 + 记账调参 |
| 5 | 注入预算的"业界标准值" | **确认不存在公开标准**（Anthropic/Cline/OpenClaw/Letta 都没给统一数值） | 自定初始值 + 记账调参，绝不写"业界推荐 8K"这类无源结论 |
| 6 | 旧插件与新插件并存会不会重复注入 | 可控 | 见 §11 的分阶段开关 |
| 7 | 注入文本含半角 `~` 会被渲染成删除线 | **已确认**（本机 GFM `singleTilde: true`） | 写死校验：注入文本一律用全角 `～`；加单测 |

---

## 11. 分期实施、部署与回滚

**你选择了"直接完整接管"**，因此不做影子模式，但**执行顺序必须严格**（这是"不出 bug"的唯一保障）：

```text
Step 1  备份：整目录复制 memory/ → backups/memory-<时间戳>/
Step 2  装新插件（install_bundle），此时旧插件仍在跑
       → 两套 L0 会短暂重复占上下文，这是刻意的：新插件出错时旧插件兜底
Step 3  验证：新会话触发召回 → 看 stats.json 记账 → 确认工具可调用
Step 4  验证通过后才停用 dsh-core-memory（plugin_manager set_plugin enabled=false）
Step 5  重启一次，确认没有插件报错、没有工具重名冲突
```

**停用旧插件的连带影响（已确认接受）**：旧插件带的 persona（AI 回复风格）注入、`persona` 工具、设置页「AI 回复风格」区块会一起消失。你的答复是「直接停用，不出 bug 就行，这个我不用」。`PERSONA.md` 文件保留不删，新插件不读它。
**必须确认的"不出 bug"点**：新插件工具名全部用 `mem_` 前缀，与旧插件的 `memory_*` / `persona` **零重名**，因此并存期间不会触发注册冲突。

### 部署方式（v1.2 更正：官方路径在本机不可用，改回你既有的 junction + patch 约定）

本节原写"按官方规范走 `plugin_manager install_bundle`"。**实测失败**，原因已定位并留证：

```text
[ERR_PNPM_UNEXPECTED_STORE] The dependencies at "<DSH_HOME>\profiles\desktop\node_modules"
are currently linked from the store at "C:\Users\<你>\AppData\Local\pnpm\store\v11".
pnpm now wants to use the store at "D:\.pnpm-store\v11"
```

即 `install_bundle` 把安装转交 pnpm，而本机 profile 的依赖来自另一个 store，pnpm 直接拒绝。
**决定不去修它**——重装依赖或改全局 store 正是"把 dsh 修坏"的典型方式，而本包零依赖，junction 就够。

实际采用（= 你 12 个插件的既有约定，patch 已备份）：

1. 在共享的 `profiles/node_modules/` 建 junction 指向包目录；
2. 在**当前运行 profile**（本机 `DSH_PROFILE=desktop`，**不是 `web`**）的 `cordis.patch.yml` 末尾加 `insert` 行；
3. 完全退出重启。

**两条实测更正**：

- **主机端不需要重启**：改完 patch 后 loader 自行 reconcile 就激活了。证据：`mem_*` 七个工具出现在工具表、
  L0 段进入系统提示、`stats.json` 开始记账（首次激活后几分钟内累计 20 条 L0 记账）。
- **浏览器端必须重启**：`settings.section` 的占用列表里没有 `memory-router`，
  说明新的 `dsh.client` 声明还不在已构建的客户端模块图里。

### 回滚（三条，任选）
1. `plugin_manager set_bundle enabled=false`
2. `plugin_manager remove_bundle`
3. 极端情况：删除包目录。**旧插件全程未改动**，因此回滚零风险
- 数据侧：动手前先整目录备份 `memory/` → `backups/memory-<时间戳>/`

---

## 12. 验证计划（可量化、可复现）

| 项 | 方法 | 通过标准 |
|---|---|---|
| 检索质量 | 用**现有 55 条真实记忆**建索引，跑 12 条固定 query（含中文同义改写、id 片段、路径片段），打印 top-5 与打分明细 | 每条 query 的预期目标 note 进 top-3 |
| 预算与裁剪 | dry-run 打印 L0/L1 注入全文 + 字节数 | L0 ≤ core+index 预算；超限时必须出现"已裁剪 N 个分节"提示 |
| 渲染安全 | 单测扫描注入文本 | 半角 `~` 出现次数 = 0 |
| 向后兼容 | 旧插件读新格式的 note 与 index.json | 旧插件 `memory_list` / `memory_read` 正常返回 |
| 增量补全 | 在 55 条库副本上跑补全 | 正文哈希不变（只改 frontmatter），且原文件已备份 |
| 部署 | 主机端：junction + patch → `mem_*` 工具出现 + L0 记账；浏览器端：重启后看 `settings.section` 占用列表 | 主机端**已通过**；浏览器端待重启验证 |

---

## 13. 明确不做的（避免过度设计）

- 不做 embedding/向量检索（你要求列为待办，后续当学习练习）
- 不做会话结束自动抽取记忆
- 不做设置页 UI（Phase 3 再说；若要做，按官方规范走 React slot + `--dsw-alias-*` token）
- 不动 `PERSONA.md`（仍归旧插件，避免风格文本重复注入）
- 不改旧插件源码（并存试跑的前提）

---

## 14. 来源

**本地取证**
- 旧插件源码 `plugins/dsh-core-memory/lib/index.js`（629 行，行号见 §1）
- 官方规范：`app.asar → dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`（已导出副本到 `plugins/_tools/dsh-skill-ref/`）
- `app.asar → dsh/node_modules/@deepseek-ai/dsh-system-prompt`（`SECTION_ORDERS` / `CONTEXT_ORDERS`）
- `app.asar → dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（`inject/steer/followup` + `agent/inbox/spliced` 投影）

**联网取证（第一轮）**
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（context rot / attention budget / JIT 检索 / 子代理回传 1000～2000 token）
- [Anthropic — Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)（三级渐进披露）
- [Anthropic — Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)（客户端文件工具、`/memories` 由宿主映射）
- [Cline — Understanding Context Management](https://raw.githubusercontent.com/cline/cline/17cbff33c135976dac725a305ffbcd73bc9cada1/docs/prompting/understanding-context-management.mdx)（75%～80% 有效上限、80% 触发 auto-compact）
- [basic-memory 技术架构（JS 重写版）](https://github.com/TylerJNewman/basic-memory/blob/883beff75d23d55b0ada1ccb433d27fc4ab2ce1e/memories/technical/Basic%20Memory%20Technical%20Architecture%20-%20Deep%20Dive%20for%20JavaScript%20Rebuild.md)（markdown 为真源、SHA256 增量、FTS5 配置、四级降级检索）
- [Graphiti search_config.py](https://github.com/getzep/graphiti/blob/526dcad7/graphiti_core/search/search_config.py)（四类对象各自限流、默认 rrf）

**联网取证（第二轮）**
- [Graphiti search_utils.py](https://raw.githubusercontent.com/getzep/graphiti/main/graphiti_core/search/search_utils.py)（`rrf` 的 `rank_const = 1`、`DEFAULT_MIN_SCORE = 0.6`、`DEFAULT_MMR_LAMBDA = 0.5`、`RELEVANT_SCHEMA_LIMIT = 10`、`MAX_QUERY_LENGTH = 128`）
- [Letta — Memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks.md)（`limit` 单位是字符、示例 5000、注入 `chars_current/chars_limit`、**always visible 不参与检索**、整体替换语义）
- [Claw/OpenClaw Engine — Memory](https://docs.claw.so/engine/concepts/memory/)（页面目录取证：markdown 记忆文件、`Automatic memory flush (pre-compaction ping)`、`Hybrid search (BM25 + vector)`）
- [LUCENE-4286](https://issues.apache.org/jira/browse/LUCENE-4286)（**原文取证**："About 10% of our queries that contain Han characters are single character queries"；纯 bigram 只在"无相邻可组词字符"时才输出单字）
- [Elasticsearch — CJK bigram token filter](https://www.elastic.co/docs/reference/text-analysis/analysis-cjk-bigram-tokenfilter)（`output_unigrams` 定义与 `Defaults to false`）

**联网取证（第三轮）**
- [OpenClaw — Memory concepts](https://docs.openclaw.ai/concepts/memory.md)（**一手正文**：四层文件 `USER.md` / `MEMORY.md` / `memory/YYYY-MM-DD[-slug].md` / `DREAMS.md`；`USER.md` 有单独的小预算；**超预算只截断注入副本、磁盘文件完整**；daily 文件只索引不注入；compaction 之前的 silent-turn memory flush，用自己的私有对话副本；dreaming 后台整合带 score / recall-frequency / query-diversity 三道门槛与 taint gate）

> 取数方法备注：OpenClaw 文档站任意页面 URL **加 `.md` 后缀**即返回干净 Markdown（绕开巨型导航挤占正文的问题）；`ClawHQ/claw-desktop` 这个仓库路径三个 raw 全 404，不要再试。
> 数值区间一律用全角 `～`：本机 Markdown 渲染把半角 `~` 当删除线定界符。

> 数值区间一律用全角 `～`：本机 Markdown 渲染把半角 `~` 当删除线定界符。
