# OpenMAIC 全部已确定与已接受改造 · 总纲（2026-09-30 → 2026-10-06）

> **本文定位**：把项目开工以来**用户明确拍板、并已实施（含已上线）**的所有改造点，做一份**纯文字的功能视角总纲**。
>
> - 素材来源 = 7 天工作日志（`.workbuddy/memory/2026-09-30.md` … `2026-10-06.md`，共 46 万字符）+ 15 份 `docs/*.md` 分析文档 + 7 份 `topics/*.md` 主题笔记 + 项目 `MEMORY.md` **69 条**红线。
> - **本文不重复实现细节** —— 数据模型、状态机、验收矩阵见 `docs/chapter-directory.md`（3045 行，唯一事实源）。
> - **本文不重复时间线与踩坑** —— 那部分见 `docs/change-trajectory.md` 与本文 §9。
> - 它回答一个问题：**从 09-30 到今天，OpenMAIC 到底多了哪些能力、每一条解决什么问题、用户拍的是哪一个方案。**

## 与既有文档的分工（三份，互不重叠）

| 文档 | 回答的问题 | 篇幅 |
|---|---|---|
| **本文（总纲）** | 「从头到尾多了哪些能力」 | 功能视角，不含实现细节 |
| `docs/rebuild-to-final-state-20261006.md` | 「**按什么顺序改**、每步接线点、验收命令、避开哪些坑」 | **14 阶段实施手册**（1,539 行 / 32 条实测校验过的路径 / 39 个命令块） |
| `docs/feature-changes-summary.md` | 同上，但**只覆盖 09-30 → 10-04**（25 项 / 8 组） | 本文的前半段速查版 |
| `docs/chapter-directory.md` | 「怎么实现 / 数据模型 / 验收矩阵」 | 唯一事实源，3045 行 |
| `docs/change-trajectory.md` | 「什么时候做的 / 镜像演进 / 踩坑」 | 09-30 → 10-04 时间线 |

> ⚠️ 本文是 `feature-changes-summary.md` 的**超集**：保留其 A–H 全部条目，补上 10-04 之后（provider 托管、说明卡、局域网、Debian、门禁免刷新、方案 B 根治、腾讯云复刻）的全部改造。

---

## 0. 一页速览

按能力域分成 **11 组**：

| 组 | 能力域 | 条目 | 解决的问题 |
|---|---|---|---|
| **A** | 材料上传与章节目录 | 6 | 「十几章教材怎么管、怎么只生成一章、怎么不丢」 |
| **B** | 抽取与归档（材料层） | 4 | 「同一份 PDF 不重复抽、换设备不用重传、图片不撑爆库」 |
| **C** | 抽取过程可观测性 | 3 | 「解析卡住时用户干等 15 分钟，且分不清超时还是没配额」 |
| **D** | 材料 ↔ 课堂关联 | 2 | 「同一批材料不要重复建课」 |
| **E** | 课型与教学场景 | 7 | 「除了课件，还要能出题、能做案例教学」 |
| **F** | 交互一致性 | 3 | 「点了返回首页输入框必须空」「选章后按钮要亮」 |
| **G** | 生成产物归属 | 2 | 「在文件夹里生成的课件要落在这个文件夹里」 |
| **H** | 解析器与凭据托管 | 3 | 「默认解析器要真生效，不是被 store 静默打回」 |
| **I** | 访问与部署 | 7 | 「本机 → 局域网 → 另一台物理机 → 公网云主机」 |
| **J** | 数据一致性与缺陷根治 | 4 | 「两端数据分叉」「首页章节两次被清空」 |
| **K** | 交付物与工程基建 | 9 | 「让上面这些能上线、能搬到别的机器、能被后人重建」 |

**贯穿全程的两条主线**：

1. **「材料」从临时上传物 → 可持久、可复用、可跨设备的一等公民**。字节在本机、清单在服务端、抽取结果落库归档，任何一端失败都不再毁掉全部。
2. **「课堂」从单一课件 → 有课型轴（正课 / 单元测试 / 案例教学）、有归属（文件夹）、有关联（来源 digest）**。

**统计口径**：按上表逐条计数，共 **50 项**已接受的改造（A 6 · B 4 · C 3 · D 2 · E 7 · F 3 · G 2 · H 3 · I 7 · J 4 · K 9）。

- **已上线 49 项**，其中 **48 项**用户可直接验证；**1 项**（I5 腾讯云 MCP）代码与配置就绪，但需用户重启 WorkBuddy 并在「自定义连接器」点「信任」才生效。
- 另有 **33 项**只做了可行性分析、用户未拍板开工，列在 **§12** —— **它们不算已接受改造**，单列正是为了避免「分析过」被误当成「已经有了」。

---

## 1. A 组｜材料上传与章节目录

### A1. 分章上传 + 选择章节生成（上限 5→15 / 150MB→750MB）

- **轮次**：09-30 实施轮；09-30 23:38–23:46 真机验收轮
- **用户诉求**：在最左侧上方新增附件上传按钮，支持 MD/PDF，按上传顺序成为第 1~15 章，每章前有选择按钮；选中第 N 章 + 输入需求 + 点「进入课堂」，**只针对第 N 章**走生成流程。
- **锁定的口径**（用户逐条确认）：① PDF 与 MD 都要支持；② **不选章节 = 保持现状**（合并全部）；③ UI = 左上角固定按钮 + 复用现有 popover；④ 先做最小版；⑤ 总量上限 750MB、格式与现状一致。
- **问题**：`MAX_DOCUMENT_BUNDLE_FILES = 5`、`MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES = 150MB`（`lib/document/bundle.ts:4-5`）—— 15 个教材分章（10–50MB）必然超限，**只改数量上限的方案事实上不可用**。过滤必须发生在唯一合流点 `buildDocumentBundle` 之前。
- **改造内容**（5 文件 + 12 语言包）：
  - `bundle.ts`：文件数 **5 → 15**，总量 **150MB → 750MB**（常量全仓库仅一处定义，两个消费点自动派生）。
  - `generation-toolbar.tsx`：新增 `selectedMaterialId` / `onSelectMaterial` / 受控 panel；列表加 `role="radiogroup"` + 每行 `role="radio"`（点击已选可取消）；**批量上传由「全有或全无」改为「剔除不支持项 + 提示跳过数」**；pill 有选中时显示「已选第 N 章」。
  - `app/page.tsx`：新增 `FormState.selectedMaterialId` + **派生校验 `effectiveSelectedMaterialId`**（选中项已不在列表 → 视为未选，免疫所有删除路径）；`handleGenerate` 冻结快照后过滤（循环内 `order: index+1` 自动重编号）。
  - i18n × 12：数字改 `{{n}}` 模板（原 12 个语言包全部不含占位符，插值被静默忽略）+ 新增 5 键。
- **关键裁定**：不选 = 合并全部（否则老用户上传 2~5 份材料会莫名只生成第一章）；「返回首页后材料列表清空」列为**已知遗留、用户接受**。
- **验收**：四道门控全绿；真机 Chromium **13/13 通过**（含 C3：**4×45MB = 180MB 全部被接受**；C4：800MB 单文件先被 50MB 守卫拦；B4：只抽取 1 次、第一二章字节从未离开浏览器）。
- **状态**：✅ 已上线

### A2. 章节目录从弹层迁移到左上角常驻（方案 A）

- **轮次**：10-01 第一轮
- **用户诉求**：「第一章、第二章、第三章…」依次显示在页面**左上角**，原有上传入口位置不变。
- **问题**：改前左上角那颗胶囊只是工具栏材料 popover 的**远程开关**，列表本体渲染在 composer 下方的浮层里、点开后出现在画面中部——这正是用户圈红的两处。
- **改造内容**：**新增** `components/generation/chapter-directory.tsx`（`fixed top-4 start-4 z-40`、宽 264px、锚点 `data-chapter-directory`；header = 「课程章节 N」/「已选第 N 章」+ 折叠按钮；`max-h-[26rem]` 内部滚动；**无材料时 `return null`**）；`generation-toolbar.tsx` 删掉浮层里的章节列表块（约 45 行）并回归非受控；`app/page.tsx` 左上角 pill 整体替换为 `<ChapterDirectory>`；i18n × 12 新增 3 键（逐行插入，diff 只多 3 行）。
- **关键裁定**：浮层仍锚定在 composer 的 📎（左上角按钮只驱动 `open`），避免复制整套浮层状态、也避免压住 logo；窄屏默认折叠**不用 `useEffect + matchMedia + setState`**（React Compiler 的 `react-hooks/set-state-in-effect` 禁止），改用 `useSyncExternalStore`。
- **验收**：真机 **16/16**（含「位于 x=16 y=16 w=264」「折叠后高 38px」）。
- **状态**：✅ 已上线

### A3. 章节目录细修：序号去重 / 去滚动条 / 删除二次确认

- **轮次**：10-01 第二轮
- **用户诉求**：① 行内序号重复，保留 1.2.3.4 即可；② 页面高度够，不要滚动条；③ 删除必须先弹确认。
- **问题**：序号重复的根因是行渲染 `{order}. {name}`，而 `order` 是**位置**序号（删除后重排）、`name` 是浏览器 `File.name` 原文（用户文件叫 `01-第一章-….md`）→ 显示成 `1. 01-第一章-…`，**两者不可能自动一致**。滚动条根因是 `max-h-[26rem]`(416px) + `overflow-y-auto`，12 章≈420px 就越界。
- **改造内容**：序号拆成独立列（`w-4` 右对齐 `tabular-nums` + `aria-hidden`），标题走新的 `chapterDisplayName()`：正则 `/^\s*\d{1,3}\s*[-–—_.,)）:：、]\s*/` **只在显示时**剥离前缀（**限 3 位数字**，所以 `2024-年度总结.md` 不被误剥）；去掉 `max-h/overflow`；删除改 `pendingRemovalId` + `AlertDialog`（**待删项用 id + 派生校验**，材料被外部移除时弹窗自动关）；radio 的 `aria-label` 补成「选择章节 {order}: {displayName}」。
- **关键裁定**：**程序触发的删除不能弹确认** —— 切换解析器时会自动丢弃不兼容材料（可能一次删多个），该路径继续静默；确认只加在用户主动点的 ✕ 上。
- **验收**：真机 **16/16**（E3：15 章 `overflowY=visible` 且 `scrollH==clientH`；F1~F5 弹窗五种路径；A/B/C 零回归）。
- **状态**：✅ 已上线

### A4. 首页章节目录跨设备持久化（`app_kv` + `/api/kv/**`）

- **轮次**：10-01 · 侦察两轮 → 实施 → 10:31 上线
- **用户诉求**：章节目录要**换设备/换浏览器也在**。用户对「一直保留」的答复：**保留范围 = 仅首页**；**换设备/换浏览器也在**（须落到服务端）；**只看得到目录**（只存清单，不存文件字节）。
- **侦察结论**（决定性）：项目已有 `owner_material` 表天然跨设备，但 `/api/materials` 被 `isAgentRuntimeConfigured()` 门控 → **当前不可用**；`account` scope 虽是预留通路，但 `resolveKv()` 默认回落 `BrowserKVStore`（localStorage）⇒ **account 目前实际不跨设备**；`HttpKVStore`/`HttpAccountKV` 已实现但 `app/api/` 下**没有任何 KV 端点**、全仓库无人实例化。
- **改造内容**（8 处落点）：
  1. **新增** `lib/persistence/app-kv.ts` —— PG 表 `app_kv(owner_id, key, value jsonb, updated_at)`，PK `(owner_id,key)`；prefix 用 `LIKE … ESCAPE '!'` 并转义 `!%_`（**不用反斜杠**，`standard_conforming_strings` 会改变其含义）。
  2. `server-provider.ts`：建表序列补 `ensureAppKvSchema`。
  3. `owner-claims.ts`：新增 claim 参与者 `app-kv`（order 900）；**同 key 冲突必须保留 account 的**。
  4. **新增** `app/api/kv/entries/[...key]/route.ts` + `app/api/kv/keys/route.ts`；gate 用 `isServerPersistenceConfigured()`，**不需要开 agent runtime**。
  5. **新增** `lib/document/course-material-persistence.ts` —— 客户端 `HttpKVStore` 单例 + 清单形状逐字段校验 + 从 IndexedDB 重建 `File`。
  6. `lib/types/generation.ts`：`SelectedCourseMaterial.file` 改为**可选**（承载「跨设备占位」这一真实状态），新增 `storageKey?`。
  7. `app/page.tsx`：上传即落 IndexedDB 拿 `storageKey`（**整批只 setForm 一次**）、挂载恢复、变化写回、生成时复用 storageKey、缺字节则明确报错。
  8. `chapter-directory.tsx`：占位行（`data-chapter-missing` 锚点 + 灰名 + ⚠ + radio disabled）。
- **关键裁定**：走既有 KV 体系而非自建并行 API；写入**必须自己串行化**（`HttpKVStore` 契约是 last-writer-wins，并发 PUT 乱序会把旧快照变成权威值）；**不用防抖**（窗口期内刷新会丢写入），改成「每次变化立即写 + 队列串行」。
- **验收**：真机 **14/14 通过**（用 `browser.newContext()` 天然等于「另一台设备」）。**上线验证四层缺一层都不算上线**：产物层（路由存在 + `grep -rl app_kv`）、迁移层（容器一起来表已存在）、接口层（GET 404 KEY_NOT_FOUND / PUT 204 / GET `{value}` / DELETE 204）、端到端层 15/15。
- **状态**：✅ 已上线

### A5. 缺字节守卫：点名报错是哪一章

- **出处**：`chapter-directory.md` §4.2 末
- **行为变化**：改前一份没字节的材料会一路走下去，表现为一门空课或半成品课 → 改后在复制/发送之前就拒绝，并**点名是哪一章**（`toolbar.chapterFileMissingNamed`）。
- **实现要点**：`materialsToIngest.find(m => !m.file)` ⇒ `setError` + `return`。
- **状态**：✅ 已上线

### A6. 文件夹 ↔ 材料目录（方案从 A 自我修正为 D：行内 `folderId`）

- **轮次**：10-01 · 可行性两轮 → 实施 17:20 → 上线 17:38
- **用户诉求**：点「舆情学」文件夹，左上角就显示它对应的课程章节。**用户确认语义**：要的是「文件夹自己的**待生成材料清单**」（不是「列出该文件夹里已生成的课」）。
- **问题**：**两个红圈是两个不同实体** —— 文件夹 = 对已生成课堂分组（`document_folders` + `document_stages.folder_id`）；左上角目录 = 一份待生成的材料清单（全 owner 只有一把 KV 键）。断点：`document_stages` 全列**没有任何「来源章节」字段** ⇒ 关联必须新增存储。
- **⚠️ 方案从 A 改版为 D（16:45 → 16:57 自我修正）**：16:45 首推方案 A（键位分区 `home.courseMaterials.v2.<folderId>`）；深读代码后否掉，理由四条：① 恢复门须按文件夹重新武装 → 引入「拿上一文件夹的材料建课」的**正确性风险**；② 切文件夹是异步 → 需「加载期间禁止生成」第二道门；③ `readHomeMaterials` 对「无行」与「读失败」都返 `null` → 新增一类静默数据丢失；④ `currentFolderId` 是纯内存 state → 顺序耦合。方案 D 把文件夹降级为**纯显示过滤**，读取时机/恢复门/写回时序/IndexedDB 字节**全部不变** ⇒ **不新增任何失败模式**。另否掉方案 B（单键 `{byFolder}`，无 CAS 的 last-writer-wins 下跨文件夹互相覆盖）与方案 C（清单挂 `document_folders` 行，跨包改 schema + 迁移）。
- **改造内容**（4 源文件 + 2 测试 + 12 语言包，**后端零改动**）：`SelectedCourseMaterial` 加可选 `folderId`；新增 `courseMaterialsInView`（文件夹视图 = 只该文件夹，根视图 = 未归档 ∪ 孤儿行）；`visibleMaterials`（过滤 + **读时重排序号 1..n**）；`visibleSelectedMaterialId`；`dropMaterialsOfFolder` 接入 `confirmDeleteFolder`；空列表在文件夹视图下渲染带文件夹名的空壳（`data-chapter-directory-empty`）。
- **验收**：真机 **12/12 全绿**（含「在该文件夹里生成只抽取该文件夹的 1 个文件」「一条 KV 记录装 3 行、2 行带 folderId」）；新增单测 16 例（`course-material-persistence.ts` 此前**零测试**）。
- **状态**：✅ 已上线

---

## 2. B 组｜抽取与归档（材料层）

> 这三项把「抽取结果」从一次性响应变成**可复用、可去重、可跨设备读取**的落库资产。

### B1. 抽取归档落库 + 命中跳过（P0 + P1）

- **轮次**：10-01 · 需求分析 → 决策确认 12:3x → 实施 13:0x → 上线 14:16
- **用户诉求**：MinerU 云解析的原始 MD 存数据库，与首页课程目录里每个文件一一对应；后续「选择课程目录」时，新功能能按选中项调取该 MD。三点拍板：**(a) 原始 MD 含图片，一次实现；(b) 归档与省钱都要**（既要全量留存也要命中跳过）；**(c) 同一份 PDF 换解析器并存多份**。
- **关键发现**：这**不是新设计，而是仓库里一份「已设计未落地」的能力** —— `DocumentExtractorProvider.version` 的注释写着 *"Nothing consumes it yet"*；`extractors/manifest.ts` 头注释**点名** `lib/document/extraction-cache.ts` —— 该文件**不存在**。实测确认抽取产物全程不落 PG（18 张表无任何抽取/文本表）。
- **落点评判**：`app_kv` 不推荐（契约「sized for small configuration values」且 `/kv/keys` 不分页）；资产池有硬冲突（`document_asset_refs.stage_id` NOT NULL，而 MD 产生于建课之前 → 无引用条目会被 collector 回收）；**新表是推荐落点**。
- **改造内容**：
  - **新表** `material_extraction`，PK = `(owner_id, content_digest, extractor_id, extractor_version)`；同事务内按 `updated_at DESC LIMIT 1000` 剪枝；`MAX_MATERIAL_EXTRACTION_IMAGE_BYTES = 24MB`。
  - **新增** `lib/document/extraction-archive.ts`：`archivedToParsedPdfContent`（与实时抽取响应形状完全一致，只多 `metadata.extractionCache={digest,extractorId,extractorVersion,hit:true}`）、`archiveExtractionBestEffort`（**写失败只记日志，抽取照常成功**）。
  - **新增** `lib/document/content-digest.ts`：浏览器端 `computeContentDigest(file)`，`crypto.subtle` 不可用时返回 `undefined`，**绝不抛**。
  - `app/api/extract-document/route.ts`：新增 best-effort 解析 owner（未配库 ⇒ 不归档不命中，**抽取行为完全不变**；multipart 路历史上不需要 owner，不能因此变成 401）；**命中检查放在 provider 定型之后、端点可达性检查之前**（命中不该依赖抽取器端点今天还活着）。
  - KV 键 **v1 → v2**；`PersistedCourseMaterial` 增可选 `contentDigest`；**读是链**（v2 → 落空读 v1），**写只写 v2 并 best-effort 删 v1**。
  - 测试：新增 `material-extraction.test.ts`（6 例）+ `extraction-archive.test.ts`（6 例，含「浏览器 digest == 服务端 digest」防两端算法漂移）；顺手修掉既存缺陷（`tests/persistence/route.test.ts` 未 mock `app-kv` 导致 36/39 全挂）。
- **关键裁定**：必须用 `contentDigest = sha256(原始字节)`，**不能用 `SelectedCourseMaterial.id`**（nanoid 客户端生成、附着时新建）；必须用**响应里实际生效的** `metadata.parser`，不是请求里的 `providerId`。⚠️ **变量名不能含厂商 token**：`archiveOwnerId` 因含子串 `veo` 被 `provider-neutrality-guard` 判失败 → 改名 `extractionOwnerId`（守卫只看标识符 AST）。
- **验收**：真机接口级 —— 第 1 次 200 无 `extractionCache`（真解析）；第 2 次同文件 `hit:true` ⇒ **命中跳过成立**；3 次请求覆盖 2 个文件 → 库里**恰好 2 行**，命中那次**没有改写 `updated_at`**。
- **状态**：✅ 已上线

### B2. 无字节凭 digest 生成（P2-A）

- **轮次**：10-01 实施 14:0x（用户回「先做 A」）
- **问题**：材料字节只存在原设备 IndexedDB，换设备后目录能看见但**无法生成**。
- **改造内容**：
  - **新增** `app/api/material-extraction/route.ts`：`GET ?digest=<64hex>[&extractor=<id>]`；未配库 → 裸 404；配库但无行 → `404 ASSET_NOT_FOUND` + `reason: NOT_ARCHIVED`（客户端据此把「部署答不了」与「没有这一章」分开记日志）。
  - `selectArchivedExtraction`：**点名优先 → 回落该 digest 下最新的非空派生 → 全空则 null**。回落必须存在（换设备后 `settings` 是设备本地的，本机选中项常常不是当初跑的那个解析器）；空正文被排除是有意的（**解析出空文本比没有更糟**）。
  - **新增** `extraction-archive-client.ts`（返回 `null` 而不是抛）+ `course-material-availability.ts`（`isCourseMaterialUsable = file || contentDigest`，目录灰显与生成守卫**共用**它）。
  - `generation-preview/page.tsx`：抽出 `parseSource(source)` —— **字节优先** → 无字节但有 digest 则 `GET /api/material-extraction` → 都没有抛 `courseMaterialLoadFailed` → 归档也没有抛**新增的** `generation.courseMaterialNotArchived`（**重试同一请求不会有别的结果**）。
  - `app/page.tsx`：**新增 `directoryRestored` 门** —— 清单恢复是异步的，`form.courseMaterials` 在它回来前还是空数组，而「没字节」与「根本没章节」在建 session 时长得一样 → 抢跑就会静默产出一节不含教材的课（**老实现里的真实竞态**）。try/finally，成功/失败/没有都翻。
- **关键裁定**：让「本机没有字节但清单里有 digest」的章节能直接生成属于**用户可见的行为变更**，必须单独确认后才做。
- **验收**：新增 **31** 例单测；浏览器级 **12/12**（三 context）。**B 案（新 context = 另一台设备）** 断言 `__extractPosts = []` ⇒ 字节一步都没离开这台设备。
- **状态**：✅ 已上线

### B3. 图片入去重字节层 + md 链接对齐（P2-B）

- **轮次**：10-01 实施（用户「现在开工」）→ 上线 14:16
- **用户诉求**：用户回「现在开工」——即三步里的第 ③ 步「图片入字节存储 + 改写 md 链接」。
- **问题**：A 把「本机没字节的章节」变成主流程后，图片仍**内联 base64 存在归档行**里 → 行随扫描图膨胀，且**两张章节共用的同一张插图会被存两遍**。同时 MinerU 的 markdown 用 `![](images/fig-1.jpg)` 引用图片，而管线其余部分一律按 `img_N` 寻址 ⇒ **链接根本解析不到**。
- **改造内容**：
  - **新表 `material_image_blob`**（`lib/persistence/material-image-blob.ts`），PK = `sha256(图片原始字节)`，`bytes BYTEA`；`writeMaterialImageBlobs`（`ON CONFLICT DO UPDATE` 刷新 `last_seen_at`）、`pruneMaterialImageBlobs`（引用检查式回收）。
  - `extraction-archive.ts`：新增 `toStorageImages`（data URL → 字节）、`archivedRecordToResponse`（取字节 → 重建 data URL，**逐图 best-effort**）、`readArchivedExtractionResponseBestEffort`。
  - `lib/pdf/mineru-parser.ts`：新增 `rewriteMarkdownImageRefs`（`![](images/x.jpg)` → `![](img_1)`，只改**能解析到已知图片**的链接；注册 `key` / `basename` / `images/${basename}` 三种拼法 + URL 解码）。
- **关键裁定（三条）**：
  1. **新表 `material_image_blob`，PK = sha256(原始字节)，不 owner 键控**（内容寻址天然跨 owner 去重、哈希不外泄）⇒ **不需要 claim 参与者**。明确**不复用 `asset_blobs`**：池条目只能经 `asset_entries` 被 `document_asset_refs` 认领，而材料产生于**建课之前** → 放进池子会被 collector 回收，归档会悄悄丢图。
  2. **归档行只存 `contentHash`**（旧行内联 `src` 仍可读、不重写）；读时重建 data URL → **响应形状完全不变**（A 建立的「实时与归档不可分辨」不变量得以维持）。
  3. **md 相对链接改写放在抽取器**，**不放归档侧** —— 放归档侧会让实时抽取与归档答复的正文不一致，正好破坏上面那条不变量。
  - 回收策略：要求**同时**满足「30 天未刷新」**且**「无任何 `material_extraction` 行引用」；回收在归档写事务**之外**、best-effort（善后不该回滚一行已正确落库的归档）。
- **验收**：真机库 **11 条**，含：用 `unpdf` 抽带图 PDF → 归档行只存 `contentHash`；**归档读回重建 data URL 与实时响应逐字相同**；**跨行去重**（3 个不同 PDF、同一张图 → `distinct_hashes=1`、`blobs=1`）；**真实 PG 上跑回收 SQL**（有引用→`DELETE 0`、删引用行后→`DELETE 1`）。
- **状态**：✅ 已上线

### B4. AliDocMind 正文图片引用对齐（`version` 升 `'2'`）

- **轮次**：10-02 上线轮第 2 项
- **问题**：`aliDocMindLayoutsToParsedPdf` 对 figure/picture 块先抓走 OSS URL 去下载，随后把整段 `md` **替换成 `l.llmResult ?? ''`** ⇒ **正文里不留任何图像位置**，图片只在 `metadata.pdfImages` 且无正文锚点。对照 MinerU：正文/`imageMapping`/`pdfImages[].id` **三处对齐**。
- **根本约束与四条「别简化」的理由**：① 不能直接写 `![](url)`（OSS 签名 URL 会过期）；② 不能边下边定号（**`img_N` 只有在全部图片下载结算后才能定号**，失败会让后续 id 前移）；③ token 必须**连 `![alt](...)` 外壳一起匹配**（否则无法区分「下载失败→整段消失」vs「成功→`![]()` 保留」）；④ 不能用普通占位串（可能与正文碰撞），**NUL 才安全**。
- **改造内容**：`pdf-providers.ts`（`imageRefToken` / `IMAGE_REF_TOKEN_RE` / `MARKDOWN_IMAGE_RE` 捕获 alt / 两遍解析）；`extractors/manifest.ts` 的 `alidocmind.version` **`'1'` → `'2'`**（**归档键必须跟着正文变**，否则命中旧归档）；新增测试 6 例。
- **验收**：先验产物 —— `aidm-img` 探针命中 3 个 server chunk、`alidocmind … version:"2"`（媒体抽取器仍 `"1"`）。
- **状态**：✅ 已上线

---

## 3. C 组｜抽取过程可观测性

> 三件事：**① 实时透出进度 ② 超时保留句柄可续取 ③ 失败文案区分原因**。先在 MinerU 侧做（C1），再把同一套接到 AliDocMind（C2）。

### C1. MinerU 侧三件事（NDJSON 流式 + 续取 + 失败分类）

- **轮次**：10-01 · 线上故障诊断 22:09 → 实施 22:45 → 上线（10-02 合并部署）
- **用户诉求**：在 web 上解析 PDF，**长时间无进度**；后续指令「把第五节那三个缺口做掉」。
- **根因（由决定性判别实验确定）**：MinerU 免登录轻量接口 4 次探测（2 份不同文档、跨 4 分钟）全部 5 秒内回 `err_code=-60007 model service is temporarily unavailable` ⇒ **云端服务级故障，与用户文件/账号/额度/容器/代码全部无关**。代码事实：轮询只在 `state` 变化时打日志 ⇒ 停在 `pending` 就是「十几分钟一个字都不打」；`batch_id` 是局部变量，**超时即丢**。前端 Step 0 是 `await fetch(...)` 一把等到底，UI 只显示「分析课程材料」转圈。
- **改造内容**：
  - **新建 5 文件**：`extraction-failure.ts`（**provider 中立的分类错误契约**：五值 `ExtractionFailureKind` + `ExtractionFailureError`（带 `kind`/`resumeToken`））、`extraction-resume-store.ts`（`sessionStorage`，24h TTL，token 形状校验，坏/过期条目**读到即删**）、`extraction-stream-client.ts`（`EXTRACTION_STREAM_MEDIA_TYPE='application/x-ndjson'`，响应非 ndjson 时自动回落读单 body）+ 2 个测试文件。
  - **NDJSON 流式协议**：`Accept: application/x-ndjson` **opt-in**；响应 = 零或多 progress + **恰好一条** result；**状态行恒 200**（失败时真状态码早在线上，故不靠状态行判成败）；**不带 `Accept` → 完全旧行为**（形态逐字相同）。
  - ① 进度：`readPageProgress` 读 `extract_progress`；`${state}|${completedPages}|${totalPages}` 做 key **只在变化时上报**；⚠️ **没有页码就不编造**（`0/0` 读起来像卡死）→ 显示「已提交，等待解析服务处理」。
  - ② 续取：`resumeBatchId` 存在则**跳过建批次与上传**；键 = **内容 digest**（不是文件名 —— 重名会串味）。
  - ③ 分类：`classifyHttpStatus`（401/403→auth、429→quota、≥500→service-unavailable、其余 failed）+ `classifyUpstreamFailure`（**`-60007` 是唯一语义无歧义的码**）→ **认不出落 `failed`**（判错方向代价不对称）。
- **⚠️ 本轮抓到两个真缺陷**：
  1. **包裹型重试会吞掉错误分类** —— `fetchWithRetry` 把内层错误重新包成 `MinerU Cloud <context> failed: <msg>`，分类在这一步丢了。**真机 curl 才发现，单测全绿时存在**（HTTP 401 得到 `reason:"failed"` 而不是 `auth`）。修法：`isRetryable` 里对分类错误 false + 末尾原样重抛。
  2. **规避 provider 中立守卫** —— `extract-document/route.ts` 在 `TEMPORARY_VENDOR_DEBT` 名单里（对 `mineru` 是精确计数 15）⇒ 路由里绝不能出现 `MinerUCloud*`/`mineru`，所以把 `ExtractionProgress`/`ExtractionFailureError` 放在中立模块。
- **验收**：真机 Chromium **6/6 PASS**（其中 `askedForStream` 是单测无法证明的 —— 证明浏览器真的发了 `Accept`）；接口级 A–E 全中（含「不带 `Accept` → 形态与改造前逐字相同」「带 resumeToken 时错误落在 `extract-results/batch` 而非 `file-urls/batch` ⇒ 确实跳过了建批次」「非法句柄 `../../etc/passwd` → 被丢弃且不报错」）。
- **状态**：✅ 已上线

### C2. AliDocMind 接入同一套（百分比进度 + jobId 续取 + 失败分类）

- **轮次**：10-01 分析 23:15 → 实施 23:45（用户回「从 1 开始」）
- **用户诉求**：MinerU 云端仍在 `-60007`，而**用户当时的主力解析器是 AliDocMind**，却拿不到这三条体验 ——「这是下一轮最值钱的一步」。
- **问题**：`extractors/pdf.ts:39-44` 的 `alidocmind` 分支**既不传 `onProgress` 也不传 `resumeToken`**（代码注释就写着 mineru-cloud 是 *"the only extractor that can report progress and resume"*）。
- **关键发现**：**上游给的是百分比，不是页码**。`QueryDocParserStatus` 的 `numberOfSuccessfulParsing` 官方定义是「已成功解析的**模块**数」，**不是页数**，与 `pageCountEstimate` 量纲不同（永远到不了「最后一页」）⇒ 新增 `ExtractionProgress.percent`（**不换算成页码，那是编造**）；显示优先级 **页码 > 百分比 > 等待**。
- **改造内容**（11 源文件 + 12 i18n + 4 测试）：`AliDocMindParseOptions { onProgress?, resumeJobId? }` 作为**第三参**；`submitJob` 抽成函数（失败**不带句柄**）；`classifyAliDocMindFailure`（`Throttling*`→quota、`InvalidAccessKeyId.NotFound`/`SignatureDoesNotMatch`/`Forbidden`/`NoPermission`/`SecurityToken*`/缺凭据→auth、`ServiceUnavailable`/`InternalError`→service-unavailable、其余 failed）；缺凭据从 `Error` 改为 `ExtractionFailureError(kind:'auth')`。
- **⚠️ 两个新不变量**：
  1. **句柄必须认签发者** —— 同一浏览器可能同时有两个 provider 的句柄，而存储只按 digest 索引 ⇒ **切换解析器会把 A 家句柄交给 B 家**（而「切换解析器」正是当前解析器故障时用户会做的事）→ B 轮询不存在的 job → 失败又带回句柄 → **自我复位的死循环**（只能等 24h TTL）。修法：条目加 `extractorId`，只有签发者能取回；别人的条目**留着不删**；**旧形态条目读到即删**。
  2. `BizIdNotExistOrResultExpired` 时**不给 `details`**，否则每次失败都把死句柄重新存回去。
- **⚠️ 一个只有浏览器验收抓得到的静默丢失**：`readProgress` 是**逐字段重建**的收窄函数，写于 `percent` 存在之前 ⇒ **服务端发着百分比、浏览器读到 `{}`、界面永远「等待」**。单测两端全绿，只有真机观察中间那一跳才发现。→ **规矩：`ExtractionProgress` 加字段必须同时命名在 `readProgress` 里。**
- **验收**：**本机无任何 AliDocMind 凭据**（四项 env 全 len=0）⇒ 活的正例跑不了，用**判别法**：`details` 只挂在「任务已提交」的失败上（接口矩阵 A/B/D 无 details，C/E 有 details）；四条 `reason` 都 = `auth`（上游真返回 `InvalidAccessKeyId.NotFound`，非 stub）。真机 Chromium 把抽取请求改写到本地「慢速吐 NDJSON」替身服务（2.5s/条），屏幕依次出现 `已完成 17% → 43% → 71%`。
- **状态**：✅ 已上线（10-02 合并部署，日志铁证 `Job docmind-… resumed for … (no upload)`）

### C3. 抽取失败分诊手册（用户侧排障能力）

- **出处**：`topics/troubleshooting.md` + `openmaic-pdf-extract-triage` 技能
- **内容**：「解析半天没进展」的完整分诊路径 —— 先看 HTTP 码（**402 = 余额耗尽**）；服务端 key 多**空壳** ⇒ 按**值长度**判而不是按 key 名；真 key 在浏览器 `localStorage['settings-storage']`；按 provider 分支逐一定位。
- **状态**：✅ 已交付（技能 + 文档）

---

## 4. D 组｜材料 ↔ 课堂关联

### D1. `Stage.sourceDigests`（材料与课堂的关联落库）

- **轮次**：10-01 · 可行性分析 19:52 → 实施 20:05~20:36 → 判定收紧 21:30 → 上线 21:36
- **用户诉求**：用 MinerU 重抽第一章扫描版 PDF 补真文本，但**保留已有的第一章 PPT**；问能否改造代码 —— ① 检测到已有对应 PPT → 只解析生成 MD；② 若 MD 也在 → 直接进对应课堂。用户拍板实施**方案 A**，并要一条回填 SQL。
- **前提纠正**：**上传什么都不触发**，抽取发生在点生成之后的预览页 Step 0 ⇒ 「抽了但没建课」是天然可达的中间态。架构性阻碍：`Stage` **没有任何来源材料字段**；`documentSources`（含 digest）只存在于 `sessionStorage.generationSession`，**从不落库**。
- **核心选择：关联住 JSONB，不加列、不加表、不加路由、不加常量。**
  - `Stage.sourceDigests?: string[]`（dsl `stage.ts`）—— `validateStage` 只查 `id/name/createdAt/updatedAt`，**无字段白名单** ⇒ 零迁移。
  - 唯一的新 SQL 是**一条只读单键投影** `stages.data -> 'sourceDigests' AS source_digests`。
  - 「空数组即缺省」两个后端同一规则（写侧 `length>0` 才挂；读侧 `filter(typeof === 'string')` 丢坏元素、为空则不挂）。
  - **字段缺席 = 「未知」，不是「没有材料」** —— 保留的失败方向是「可能多建一节同名课」。
- **关键裁定**：判定由「相交（`some`）」**收紧为「包含（`every`）」**（用户裁定「按推荐执行」）—— 相交只要求「有一份对上」，于是最常见的动作会出错：已有前两章的课、用户又加了第 3 章、不选章节直接点生成 ⇒ 相交命中 → 进老课 → 第 3 章只进归档不进那节课，界面上没有任何提示。⚠️ `every` 对**空集恒真** ⇒ `digestSet.size > 0` 那道前置门从「优化」升级为**语义必需**。
- **验收**：真机四模式各 8~9 条全绿。`superset` 是**唯一能分辨相交/包含**的用例（文件夹 2 份材料、老课只覆盖其中 1 份 ⇒ 期望**不进老课**）。回填 SQL 在生产库 `BEGIN…ROLLBACK` 里先验键集合再 COMMIT。
- **状态**：✅ 已上线

### D2. `handleGenerate` 三岔路（不重复建课）

- **出处**：`chapter-directory.md` §4.8
- **改造内容**：生成页新增 `extractOnly` + `targetStageId` 会话标记：Step 0 跑完 `router.replace('/classroom/<id>')` 后立即 `return` → **不建 stage/outline/scene、不 `saveToStorage`**（用 `replace` 不用 `push`，返回键不该回到自毁页）。客户端谓词 `hasUsableArchivedExtraction` 有两条**比 HTTP 200 更严**的规定：`text.trim().length > 0`、响应里 `metadata.extractionCache.extractorId` 与点名解析器一致。
- **关键裁定**：为什么进课堂前还要再查一遍归档 —— `sourceDigests` 只证明「这门课是从这份字节建的」，**不证明「现在这台设备能拿到那份 MD」**。归档是 best-effort 写的、可能被剪枝 ⇒ 缺派生时直接进课堂会打开一节教材缺失的课。
- **已知副作用（真机实测）**：客户端点名 `settings.pdfProviderId`（本机默认 `unpdf`），而抽取路由**按 mime 定型** —— `.md`/`.txt` 落库的是 `plain-text` ⇒ 这类材料**每次点生成都会多一次往返**（但服务端命中归档，不重解析、不重复建课、不丢材料）。
- **状态**：✅ 已上线

---

## 5. E 组｜课型与教学场景

### E1. 「单元测试 / 案例教学」两个入口按钮

- **轮次**：10-02 · 可行性三轮 → 裁定定稿 21:40（11 条）→ 实施 10:35 → 上线 10:33~10:45
- **用户诉求**：红框（左上章节目录）下方加「单元测试」「案例教学」两个按钮，**要求列表因上传数量下延时不遮挡按钮**。
- **用户定下的四条**：① 列表**限高 12 行**，第 13 行起内部滚动；② 按钮位置 = 面板底部、提示语之下；③ 中文「单元测试」，**英文取 `unitQuiz`**；④ **有选中章才可用**。**裁定定稿 11 条**追加：⑤ 点「进入课堂」→ 跳课件；点「单元测试」→ 跳出题链路；⑥ 测验页加「换一批」；⑦ 参考要点在**提交后**展开；⑧ 产物 = 只有 quiz 场景的课堂；⑨ 题量固定 5/5/1；⑩ 进同一文件夹；⑪ 「换一批」靠 prompt 注入 `attempt: N`；论述题走 LLM 判分；**案例教学本次仅占位、不做动作**。
- **⭐ 重大发现**：**`quiz` 场景类型早已存在且已在生产数据里跑通** —— `SceneType = 'slide'|'quiz'|'interactive'|'pbl'`；`QuizQuestion` 的字段与需求逐字对应；`quiz-view.tsx`（1119 行）已实现完整状态机 + 本地判分 + `/api/quiz-grade`；i18n `quiz` 段已 27 键，**UI 文案零新增**；实测线上库 3 个课堂共 **6 个 quiz 场景**。
- **实测的两个真风险**：① **视口溢出** —— 面板 `fixed`、无 max-h、无滚动，超出视口就**永远滚不到**（15 章 + 按钮底 ≈717px，而 1366×768 笔记本 innerHeight 约 620–660px）；② **既有横向冲突** —— `composer.x = (视口宽 − 815)/2`，面板右缘恒 280px ⇒ **≤1366px 宽就已重叠**（当前不暴露只因面板仅 117px 高、与 composer 纵向不相交）。
- **关键裁定**：**零 DDL** —— `persistStage` 用 `encodeJson(stageRow)` 把整个 stageRow 写进 `data` jsonb ⇒ stage 上加 `lessonKind` 自动持久化。但**必须在三处显式登记**（dsl `stage.ts` / `storage` 的 `DocumentSummary` / `stage-storage` 的 `StageListItem`），否则静默丢失。**按钮语义由「模式位」改为即时动作按钮**（不需要 `FormState.lessonKind` 这个用户可选状态）。⚠️ **唯一会改到既有逻辑的坑**：与「已有课堂」去重冲突 —— 用第三章材料点「单元测试」会命中第三章那个普通课堂 ⇒ **把课型并入去重键**（`classroom.quizMode` 缺省视为 `'lesson'`）。⚠️ 键名别用 `unitTest`（中文「单元测试」在教育语境是「单元测验」，英文会误解成软件单元测试）。
- **验收**：七段实施门控全绿；单测 26 passed；e2e `unit-quiz-entry.spec.ts` **3 例全绿**；先验产物五条全过。
- **状态**：✅ 已上线

### E2. 出题链路：5 单选 + 5 多选 + 1 论述（`questionMix` + `optionCount`）

- **轮次**：10-02 实施第 ⑤ 段
- **核心缺口**：`quizConfig.questionCount` 是**总数**、`questionTypes` 是**类型集合**，**不表达「每种几道」** ⇒ `{questionCount:11, questionTypes:[...]}` 出的是混合题，**不保证 5/5/1**。另 `normalizeQuizOptions` 按序自动派 A/B/C/D/E ⇒ 5 个选项天然得 A–E 无需改码，只需改 prompt 示例（现为 4 个 A–D）；⚠️ `findQuizOptionsContractFailure` 只校验 `value ∈ A-Z` 且 `answer ⊆ values`，**不校验选项数量** ⇒ 「答案提到 E 但只给了 4 个选项」这类错位**能过闸**。
- **改造内容**：新增 `questionMix: [{type,count}]`（`questionCount` 保留为派生和，向后兼容）+ `optionCount`；出题 prompt 补 5/5/1 配比；**补一条选项数契约**（`requiredOptionCount`）。
- **关键裁定**：`optionCount` 为**可选**参数，**不收紧普通路径**。
- **状态**：✅ 已上线

### E3. 测验页「换一批」+「点了没用」真实 bug 修复

- **轮次**：10-02 实施 → **11:40 用户报障定位根因（仅审核未修）** → 12:11 修复 + 部署 + 红绿验收（用户授权「你可以开始修了」）
- **用户诉求**：裁定第 ⑥ 条「测验页加『换一批』」；随后报障：「换一批」**点了没用** —— 转圈 ~34s → 停 → 点「开始答题」题面**完全没变**、无任何报错。
- **根因**：`handleChangeSet` 里 `if (!content || content.type !== 'quiz') { return; }`，而 `/api/generate/scene-content` 返回的 `content` 是**未组装的生成态** `GeneratedQuizContent = { questions }`，**没有 `type`**（`type` 只在组装 Scene 时补）⇒ **每次都早退**，其后的 `updateScene`/`setOutlines`/`saveToStorage()`/`clearAllForScene`/`handleRetry()` **一次都没执行**。
- **证据链 5 条全实测**：容器日志两次 `Generating content … (quiz) → Content generated successfully`（排除请求失败/超时）；之后**零写库**；`runtime_sessions` 无新 retry；场景内容仍是原题；镜像内客户端 chunk 的 `handleChangeSet` 与磁盘源码**逐字一致**。
- **⚠️ 为什么门控没抓到**：e2e 的 `page.route` 桩把响应写成 `{success:true, content:{type:'quiz', questions}}` —— **多给了真服务端从不返回的 `type`** ⇒ 桩内一切正常、生产全挂；`result.content` 类型是 `unknown`，TS 也看不见。
- **改造内容**：新增模块级 `quizQuestionsFromGeneratedContent(content: unknown)` **结构式**识别（`typeof === 'object'` + `Array.isArray(content.questions)` + **长度 > 0**，拒空以免空生成覆盖在看的题套）；写回改成 `const content: SceneContent = { type: 'quiz', questions }`（**必须自己补判别字段** —— `mergeSceneContentForUpdate` 对非 pbl 是整份替换）；失败两处补 `toast.error`；`fetchSceneContent` 补传 `languageDirective`。
- **关键裁定**：备选修法「让路由给 `content` 盖判别字段」被否 —— 要改所有消费方的线上契约，风险大。
- **验收**：**红→绿两侧都真跑** —— 对新镜像 **3 passed**；**对旧镜像跑同一条用例 1 failed**，失败点正是等 `PUT /api/persistence/documents/*` **20s 超时**，与线上「零写库」症状逐字吻合 ⇒ **证明用例非空过**。
- **状态**：✅ 已上线

### E4. 第 5 种场景类型 `case` 与案例教学内容生成（阶段 1）

- **轮次**：10-02 · 盘点 → 二次分析（用户上传《案例教学法.md》）→ **阶段 1 实施 14:15**（第五轮）
- **用户诉求**：选章 → 点「案例教学」→ 取该章 MD → LLM 提知识点 → LLM 搜真实案例 → LLM 写案例正文 → LLM 出题 → 点「案例解析」→ 生成与知识点结合的解析。**三个决策 = 1A 单场景 + 分期揭示 / 2A 客户端先搜 / 3A 强制引用来源**。
- **枢纽结论**（来自用户上传样本）：**知识点提取是整个链路的枢纽**，下游全部锚定于它 ⇒ 数据模型**必须把 `keyPoints` 持久化进 outline**；样本文末「备用案例」= 「换一个案例」的天然形态；**文件本身就是幻觉风险的证据**（主案例日期/姓名极具体但无法核实）⇒ 设计必须把案例**钉在搜索结果的 URL 上**。
- **五条关键设计裁定**：
  1. **知识点不新建 outline 字段** —— `SceneOutline.keyPoints` 已是一等字段且整份落库，`caseConfig` 只放 `{questionCount?, attempt?}` ⇒ **零 DDL**。
  2. **「解析结合知识点」做成类型而非 prompt 要求** —— `CaseAnalysis.entries: {point, bearing}[]`，模型没法交一段笼统散文过关。
  3. ⚠️⚠️ **`questions` 必须改名 `discussionQuestions`** —— 生成态靠 `'x' in content` 结构式识别，与 `GeneratedQuizContent.questions` 同名时无法唯一收窄，tsc 直接报联合不可赋 ⇒ **改名消歧而不加断言**。
  4. case 分支用 `outline.type === 'case'` 守门 + 逐字段校验（无 `caseTitle`/`narrative` 即 `return null`，绝不组装白页）。
  5. `normalizeCaseSources()` **丢弃任何没有合法 `http(s)://` URL 的来源**（带标题无链接看着像证据却无从核实，**比没有来源更糟**）；全丢时 `sources` 字段整个不出现。
- **⚠️ 两个必然真机炸的登记点**：⚠️ `LLM_STAGES` 必须加 `'scene-content:case'`（不加则案例场景解析不出模型）；⚠️ **`validateAppScene`（`lib/document-store/validators.ts`）是唯一编译器抓不到的 `SceneType` 登记点** —— 漏了它则 `tsc`/单测/eslint 全绿、页面照常渲染，但 `saveToStorage` 发 `PUT` 被 **`400 VALIDATION_FAILED`** 静默拒写，而 `/api/persistence/**` 只对 `status >= 500` 打 log ⇒ **这个 4xx 在 `docker logs` 里一行都没有** ⇒ 结果是「课堂正常打开、刷新后课程不见了」。**自检链：`SCENE_TYPES` → `Record` → `validateAppScene` → `LLM_STAGES` → `createDefaultContent`。**
- **另一处刻意**：`generateDefaultCaseActions` 是全链路唯一**故意不调模型**的动作分支 —— 案例是读+议场景，一段总结案情的旁白会抢在讨论题前把答案说了。
- **验收**：包单测全绿（含 `case-content.test.ts` 10 例）；镜像内五条产物验证全命中；e2e **5/5**；顺带修掉两个「本就红」的测试。
- **状态**：✅ 已上线

### E5. 案例检索（阶段 2：客户端先搜 → `caseContext` 注入）

- **轮次**：10-02 第六轮
- **用户诉求**：决策 **2A 客户端先搜**。
- **⚠️ 先补阶段 1 的旧账**：阶段 1 的 `system.md` 写的是「exactly these **five** keys」，**`sources` 根本不在其中** ⇒ 阶段 1 从没让模型写过来源，那张来源列表**永远是空的**。
- **核心难点 = 顺序**：现有 `web-search` 步排在 outline **之前**且搜整章 requirement，而 2A 要搜**知识点**（由 outline 产生）⇒ 那一步不能复用。
- **三个已落地决策**：① **新增独立步骤 `case-search`**，排在 `outline` 之后、`agent-generation` 之前；② **每个知识点一条 query，并发，上限 6**（`CASE_RESEARCH_MAX_QUERIES`）—— 合并成一条会让只回 5 条结果的引擎偏向一两个知识点；③ **口味拼进 query 文本**，复用 `WEB_SEARCH_QUERY_REWRITE`（不新增 prompt id）。
- **3A 在这里才真正落地**：从「核不实就丢掉」→「给真料让它引用」—— `caseSources` 是**白名单**（`selectCaseSources()`，模型写的 URL 不在集合内一律丢，因为集合外的 URL **按构造就是编造**）；模型一条不引 → 用 `caseSources` 顶上（截 5 条）。
- **⚠️ fan-out 的副作用**：`caseContext` 会出现多个互不相关的事件 ⇒ `system.md` Grounding 补第 2 条「**只挑一个事件**，不许缝合两个事件」；搜空的知识点**照样写进 context** 并标 `No usable material`（整段略去等于让模型悄悄用记忆补上）。
- **⚠️ `caseContext` / `caseSources` 不落库**（只放页面局部变量）—— 这直接导致 E6「换一个案例」必须**重新检索**而不只是 bump `attempt`。
- **验收**：包单测 222 ✅（`case-content` 10→17 例）；`case-research.test.ts` 新增 11 例；e2e **6/6**（含「with web search enabled」）。
- **状态**：✅ 已上线

### E6. 案例解析 + 「换一个案例」（阶段 3）

- **轮次**：10-02 第七轮
- **⚠️ 动工前发现原方案有个洞，当场与用户确认后改版**：原方案「换一个案例 = bump `caseConfig.attempt` → 重跑 `scene-content`」，但 `caseContext` **不落库** ⇒ 只重跑生成的话，新案例**必然**没有来源、每次换都带 `case.noSources`，把阶段 2 刚建立的「有据可查」一次抹掉。**用户选了重新检索 + 重新生成**。
- **八个关键实现点**：
  1. 「案例解析」**新开路由 `/api/generate/case-analysis`**（不复用 `scene-content`：后者语义是「从 outline 造内容」，这一遍输入是「已有 content」）。
  2. `point` **白名单**（不在 `knowledgePoints` 里的丢弃，全丢 ⇒ 失败）；比对做空白折叠 + 大小写不敏感但**输出用调用方原措辞**；按知识点顺序重排。
  3. ⚠️⚠️ `'case-analysis'` **不含冒号 ⇒ 必须显式进 `STATION_STAGE_KEYS`**（有「无孤儿 stage」检测，不列出就红；含冒号的 `scene-content:*` 会经父级回溯自动覆盖，不含的不会）。
  4. ⚠️⚠️ **写回 spread 是承重的** —— `mergeSceneContentForUpdate` 对非 pbl 整份替换 ⇒ 解析写回必须是 `{ ...content, analysis }`，否则把 narrative/知识点/讨论题/来源一起写没，**而页面看起来完全正常**。
  5. ⚠️ **换案例必须清掉旧 `analysis`**（旧解析解释的是旧事件，留着不是「过期」而是「错的」）。
  6. ⚠️ **绝不用 `setStage`** —— 整份替换会清空 `scenes`。
  7. 换案例的检索与 `case-search` 步受同一个 `webSearchEnabled` 门控。
  8. 顺带收敛重复：`getApiHeaders`/`withThinkingConfig` 两份合一。
- **验收**：包 237 ✅（`case-analysis.test.ts` 14 例）；根相关子树 1927 ✅；**镜像重建 2 次**（3m6s 作废 —— **构建期间改了源码 ⇒ `COPY . .` 在早期执行，源码 ≠ 镜像，且 `grep` 分不清落在哪个 chunk**）；真机 e2e **8/8**（含「案例解析写回并保全文其余字段」「换一个案例重新检索 3 次 fan-out + 重新生成 + 旧解析消失」）。
- **状态**：✅ 已上线

### E7. 案例多变体缓存 + 解析隐藏

- **轮次**：10-02 第十一轮（多变体）/ 第十二轮（解析隐藏）
- **用户诉求（第十轮 → 第十一轮裁定）**：换一个案例最多存 3 个；**第十一轮用户裁定原话即规则**：① 计量单位按**案例课**（一个 stage ≤3 变体）；② 未满 3 生成并**追加**（调 LLM）；③ 满 3 后**顺序轮换下一个**、**不调 LLM**；④ 满 3 后**不替换、不删除**，此后一律**只读轮换**。
- **⚠️ 第十轮的关键事实修正**：用户需求的前提假设「3 个都存进库了」被实测否定 —— `case-view.tsx:186` 是 `store.updateScene(sceneId, { content: nextContent })`，`content` **整份替换** ⇒ **每门案例课在库里永远只有 1 个案例**，点多少次都只有最后一个存活。
- **改造内容**：`CaseVariant`（= `CaseContent` 去 `type` 与变体列表本身，含 `analysis` —— **解析属于变体，不属于场景**）；`CaseContent` 加两个**可选**字段 `caseVariants?`（≤3）+ `activeVariantIndex?`（**顶层字段继续镜像当前变体**）⇒ **`CaseView` 零改动、老数据零迁移**；**新增 `lib/classroom/case-variants.ts` 单一写入口**（纯函数：`toVariant`/`readVariants`/`activeVariantIndex`/`isAtCap`/`nextVariantIndex`/`applyVariant`（**逐字段重建、不 spread**）/`appendVariant`（满 3 返回原引用））；UI 徽标「案例 n / total」。
- **「解析隐藏」（第十二轮，用户裁定按 A 方案）**：改前解析展开后无法收起 → 改后在解析区标题右侧加按钮（与「换一个案例」**同款样式** —— 两者都是"把这一场景退后一步"），点击后回到「仅是案例的页面」，该状态**持久化**。
  - **隐藏 ≠ 删除**（解析内容仍在库里，重新展开只翻标志位：**零 LLM**、文本逐字不变）。
  - 三态：① 未生成 → 紫色按钮调 API；② 已展开 → 解析全文 + 「解析隐藏」；③ 已收起 → 回到 ① 的按钮外观但点击**只翻标志位**。
  - `CaseVariant` 与 `CaseContent` 各加可选 `analysisHidden?`（**按变体存**）；**新增 `updateActiveVariant(content, patch)`**。
- **⚠️ 第十轮最有价值的发现（新坑）**：`applyVariant` 是 `{ type:'case', ...variants[safe], caseVariants, activeVariantIndex }` ⇒ **从 `caseVariants[i]` 重建顶层**。所以把 `analysisHidden` 只写到**顶层镜像**上，下一次 re-mirror 就**丢了**，而在此之前页面一直看着正常（「页面正常、库里没有」的又一变体）。⚠️ **且这个 bug 只在存了第二个案例之后才出现** —— 单案例文档没有 `caseVariants`，`readVariants` 回落到 `[toVariant(content)]`，此时**镜像就是源**，只改镜像「碰巧能用」。⇒ 一律走 `updateActiveVariant`。
- **另一处**：⚠️「重新展开」**绝不能走 `handleAnalyse`** —— 它开头是 `if (analysing || analysis) return;` ⇒ 已有解析时**静默早退**，按钮点了没反应、不报错、不打日志。
- **验收**：定向单测 290 passed；e2e `case-variants.spec.ts` **3/3**（新例含「落库 poll + 刷新仍收起 + 再展开零 LLM」）；**活体探针**：运行中进程服务的 client chunk 含「解析隐藏」；**写入屏障 PUT**（同 id 三次）：合法 **204** / 顶层 `analysisHidden:"yes"` **400** / 变体内 `analysisHidden:1` **400**。
- **状态**：✅ 已上线

---

## 6. F 组｜交互一致性

### F1. 选中章节 → 自动预填输入框

- **轮次**：10-02 · 可行性分析 18:30 → 实施 17:35–17:55（第八轮）
- **用户诉求**：左侧目录选中第 N 章 → composer 自动填入 `开始 {order} {章标题} 的课程学习` →「进入课堂」按钮自动激活。
- **用户裁定三条规则（原话即规则）**：① 只在「输入框为空」或「上次内容本身就是自动填的」时才写，用户手动改过即 dirty、之后不再覆盖；② 取消选择（再点一次 radio = `null`）时自动填的清空、手写的保留；③ **不写草稿缓存**。追加边界：**按钮变亮 ≠ 自动进课堂**，仍须用户自己点。
- **可行性结论**：完全可行且比预想便宜 —— ① 注入点唯一（`<button role="radio">` 是全应用唯一的章节选择入口）；② **「按钮激活」是免费的** —— `canGenerate` 不参与章节选择，只要把文字写进 `form.requirement`，按钮**自然就亮**，按钮逻辑一行都不用改；③ 真难点只有**章标题从哪来** —— 材料表里只有 `name = "01-第一章-舆论的定义.pdf"`，而用户要的是「第一章 舆论的定义与构成要素」，**文件名是缩写不是真章标题**；但映射现成 —— `document_stages.data.sourceDigests` ↔ 材料 `contentDigest` 实测**逐字对上** ⇒ **零新接口、零 schema 变更、零新持久化**。
- **改造内容**：新增 `lib/utils/chapter-naming.ts`（`chapterDisplayName` 从 `chapter-directory.tsx` **迁出、行为逐字不变** + `chapterTitleFromFileName` + `resolveChapterTitle`）；`app/page.tsx` 新增 `autoFilledRequirementRef` + `applyChapterSelection`；i18n × 12 新增 `toolbar.chapterRequirementTemplate`。
- **三条实现红线**：① `updateForm('requirement', v)` **会连带写草稿缓存** ⇒ 想「不写草稿」必须**绕开**它、直接 `setForm`；② `onSelectMaterial` 只回传 `chapter.id` ⇒ 反查**必须用 `visibleMaterials`**（视图位序），用文件夹里存储的 `order` 会写出「第 3 章」而用户看到的是「第 1 章」；③ 判定要在事件回调里算完，**`setForm` 的 updater 保持纯函数**（StrictMode 双调用下「取消选择」分支第二次重放时 ref 已被置空 ⇒ requirement 漏清）。
- **验收**：单测 11 ✅；e2e **5 ✅**（含「全程零生成请求」承重断言 + 「手输仍写草稿」对照）；**正向印证**：库里课名 `第一章：舆论的定义与构成要素` 与用户举例**逐字一致**。
- **状态**：✅ 已上线

### F2. `resetHomeComposer`：把「回到首页视图」统一成一个手势

- **轮次**：10-02 · 可行性分析（第十三轮）→ 实施 + 部署验收（第十四轮）
- **用户诉求**：「无论在**什么地方**，只要点击了『返回首页』，输入框都像首页初始态（空）」；现状：从案例教学页返回首页 → 空的（对）；但**选了章节之后**某一步点「返回主页」→ 回首页后输入框**还留着**「开始 1 第一章：… 的课程学习」。
- **用户裁定四条**：1. 按方案 A（统一手势 + 持久化）；2. **连手打的提示语也一起清**；3. 根视图点「最近学习」**不清**（那是折叠面板），**只有离开文件夹那一次清**；4. **已选中的章节也一起复位**。
- **机制**：输入框文本 = **首页组件局部 state**，跨路由会卸载重挂 ⇒ 天然是空的；唯一能把它带回来的持久层是 `localStorage['requirementDraft']`（只有用户手打/语音输入才写；自动填的章节句**故意不写**）。附带发现一个真 bug 口味：从文件夹返回根视图后，输入框留着「某章」的句子而该章在根视图**根本不显示**，`visibleSelectedMaterialId` 也解析为 null（两个课型按钮回到 disabled）—— 一句话处于「悬空」状态。
- **改造内容**：
  - **新建 `lib/home/composer-reset.ts`（唯一手势）**：`resetHomeComposer()` = ① 清 `requirementDraft` ② 落 `sessionStorage['openmaic:home-composer-reset-pending']` ③ 广播自定义事件 ④ fire-and-forget 清服务端选中。**全程不 await**（导航不能等网络）。`consumePendingHomeComposerReset()` —— **消费**而非读（否则「返回首页→重新选章→离开」会把刚选的又清掉）。
  - `course-material-persistence.ts` 新增 `clearStoredHomeSelection()`：目录是**整份写** ⇒ 只清选中 = read-modify-write，**必须走同一条 `writeChain`**。
  - **7 个跨路由入口**：`scene-sidebar.tsx` / `SlideNavRail.tsx`（logo）、`header.tsx` / `CommandBar.tsx`（**仅当** `resolveClassroomExit().href === '/'`）、`generation-preview/page.tsx`、`ClassroomSurface.tsx`。
- **⚠️ 本轮最关键发现（已进红线 23/24）**：`goBackToHome` **一个函数服务四种文案** —— 「返回首页」×2、「返回修改需求」、「返回重试」。**后两个刻意不清**（「返回修改需求」存在的意义就是让用户打的那句还在）⇒ 必须在**调用点**分叉成 `leaveToHome`。
- **验收**：新单测 **20 例**（含「写永不 resolve 仍同步通知已挂载方」+ 逐文件扫源码断言 7 入口都在）；新 e2e **3/3**（含「根视图折叠面板文本必须留着」并断言 `recentClassroomsOpen` 真的翻转）；**活体探针**：运行中进程首页 40 个 chunk 中某 chunk 含 `openmaic:home-composer-reset`。
- **状态**：✅ 已上线

### F3. 把「返回首页」从折叠开关里拆成独立控件

- **轮次**：10-02 · 可行性分析（第十五轮）→ 实施 + 部署 + 验收（第十六轮）
- **用户诉求**：把「最近学习」旁圈红的 ↑ 改为**纯返回首页**功能，位置移到「最近学习」图标**前面**，形态为**返回图标 + 「返回首页」文字**。
- **侦察结论**：圈红的 ↑ **不是独立按钮** —— 它是 `motion.div animate={{rotate: recentOpen ? 180 : 0}}`，和「🕐最近学习 + 数量」同属**同一个 `<button>`** ⇒「把它改成返回首页」在代码上等价于**新增一个独立控件**，且 ↑ 指示器必须保留（否则失去展开态视觉线索）。那个按钮是**双语义**的：在文件夹里 = 真的返回；根视图 = 只折叠。**用户这次诉求的本质 = 把这两个语义拆成两个单一语义控件。**
- **用户裁定（方案 A）**：根视图**不显示**返回按钮；搜索面包屑那条「最近学习」**一起改成「返回首页」**；图标 `ArrowLeft`；文案复用 `classroom.backToHome`（**i18n 零新增**，12/12 语种已齐）。
- **改造内容**（3 文件）：`app/page.tsx` 补 `ArrowLeft` 导入；控件组最前插条件按钮 `{currentFolderId && (<><button data-home-back-button …>…)}`；原折叠按钮的 `if (currentFolderId) {…} else {…}` **退化为无条件 `persistRecentOpen(!recentOpen)`**。测试新增 1 例断言「旧分叉形状不再出现」（合回去 = 回归）。
- **验收**：e2e **4/4**（含新增用例「文件夹内两控件并存：折叠**不**离开文件夹」）；**产物侧 0 → N 取证**：同一把 `grep data-home-back-button` 打在**回滚标签**上 = **0**，打在新镜像 + 运行中进程引用的 chunk 上 = 命中。真机取证：根视图返回按钮计数 **0**、文件夹内计数 **1**、`backBoxX=457 < clockBoxX=554`（**确实在前面**）。
- **状态**：✅ 已上线

---

## 7. G 组｜生成产物归属

### G1. 生成的教学课件自动归入当前文件夹（方案 A）

- **轮次**：10-04 · 第一轮分析 → 追问「不选文件夹会不会误归档」→ **第十七轮实施**（12:16–13:2x）
- **用户诉求**：「点『舆情学』文件夹 → 章节目录选第 4 章 → 点『进入课堂』→ 生成的教学课件落在文件夹**外面**，要手工拖回去。要求分析『如何实现自动归入』」。裁定原句：「按方案 A 开工（会话带 `targetFolderId` + 建课后 `setStageFolder`）」。
- **问题：链路只做对了一半，不是坏掉的功能**：
  1. `currentFolderId` 仅是首页组件状态，**不持久化、不读 URL**；`runGeneration` 构造 `sessionState` 时没带 folderId。
  2. `persistStage` 的 INSERT 列与 `ON CONFLICT ... DO UPDATE SET` **都不含 `folder_id`** ⇒ 新课恒 `NULL`。
  3. 唯一归属写入入口 `setStageFolder` 全仓只有 4 处调用，`handleGenerate` **不在其中**。
  - 讽刺的是第 ① 条的反面：同一个 `currentFolderId` **已经被用来过滤材料** ⇒ 系统**已经理解**「用户是在某个文件夹里生成」，只是没把产物也放进去。
- **方案 A 三处改动（不动 SQL、不动 DSL、不动存储层）**：
  1. `GenerationSessionState` 新增**可选** `targetFolderId?: string`（缺省 = 不归档 = 落根视图）。该接口是 `JSON.parse(saved) as GenerationSessionState`（**无白名单**）⇒ 旧会话缺键即 `undefined`，行为不变，**无需"登记"**。
  2. `runGeneration`：与 `frozenMaterials` 并列冻结 `frozenFolderId`；`sessionState` 改用**条件展开**（**`extractOnlySession` 不带** —— 那条路只补抽取、不建课，带了是脏数据）。
  3. 生成页：把 `await store.saveToStorage()` 改成 `const saved = …` **接住返回值**，随后 `if (saved && currentSession.targetFolderId) await setStageFolder(...)`；**位置强制在 `saveToStorage` 之后、`router.push` 之前**；try/catch + `toast.error(t('classroom.moveFailed'))`（**复用现成文案，i18n 零新增**）。
  - 覆盖面：`handleUnitQuiz` / `handleCaseTeaching` 都走同一 `runGeneration` ⇒ **三条课型路径一次全覆盖**。
- **⚠️ 三条关键约束**：
  - `setStageFolder` 是带 `EXISTS` 校验的 UPDATE，**匹配 0 行就回 `404 FOLDER_NOT_FOUND`** ⇒ 必须排在 `saveToStorage()` 之后，且**要看返回值**（`false` = `'stale-dropped'`，什么都没落库）。
  - **不要用材料的 `folderId` 反推文件夹** —— 根视图会渲染「孤儿行」（指向已删文件夹的材料仍显示）⇒ 用它归档必 404。`currentFolderId` 是唯一可信来源。
  - 归档失败**不阻断**（用户开两个标签页、另一个把文件夹删了 ⇒ 404）⇒ 降级为「落根视图」。
- **用户追问的答复**：**未选文件夹时会落根视图，与今天一致，是期望行为，不是误归档**。判据只看 `currentFolderId`，与输入框内容无关；`setCurrentFolderId` 全仓仅 4 处，`onOpen` 是**唯一给出真值**的路径。三层守卫全按 falsy 短路；**即便守卫写漏（无条件写 / `?? null`）也仍落根视图 ⇒ 无"空态被误归档"窗口**。
- **明确划边界（当轮不做）**：不自动移动「复用的已有课堂」—— 那节课可能本就在别的文件夹。（⚠️ 此边界在 **10-06 被修正**，见 G2。）
- **两个需产品知悉**：① 方案 A 唯一扩展的行为 = **在文件夹内输入与材料无关的新需求也会归入该文件夹**（语义 = 按「视图」归属，非按「材料」归属）；② `currentFolderId` 不持久化 ⇒ 文件夹内 F5 回根视图，此后生成落根（**本轮不改变，根治需落 URL/持久化**）。
- **验收**：四道门控全绿；真机 2/2 ✅（判据用 `page.on('request')` 读应用自己发出的请求 + **配正向对照**）；查库实证 `document_stages.id=GlAmZWMcZ0 → folder_id=folder-PWydouislhWU`。
- **状态**：✅ 已上线（非计划内 —— 第二十轮重建镜像时这 3 个源文件已在工作树，随 3002 镜像一并生效）

### G2. 复用分支只补空归属

- **轮次**：10-06（同轮施工，第十四轮之后）
- **用户诉求**：「单元测试」「案例教学」生成的内容不进文件夹。
- **⚠️ 先说一个被推翻的推断**：初判是「用户看到的是被复用的老课」—— **不成立**。查库实测证明那 5 门 `lessonKind ∈ {unitQuiz, caseTeaching}` 老课 `deleted_at` **非空**，而 `listStages` 的 tombstone 条件正是 `deleted_at IS NULL` ⇒ **它们不可能是复用目标**，当时走的是**新建**路径。
- **两个事实叠加**：① **新生成路径本来就会归档**（镜像内 `grep -rl targetFolderId /app/.next` = 4 个产物；库里 10-04 11:45「舆论的主体」确实带 `folder_id`）；② **复用分支从不归档**（`app/page.tsx` 命中 `existingClassroom` ⇒ toast「该材料已有对应课堂，正在打开」+ push 老课 + `return`）。当年「不自动移动复用的已有课堂」的理由成立，但**漏掉了"目标课无归属"这一支**。
- **改造内容**：复用分支内补 —— **仅当目标课无归属时才归档**：`if (frozenFolderId && !existingClassroom.folderId) await setStageFolder(existingClassroom.id, frozenFolderId)` + try/catch。
- **⚠️ 与新建路径的约束相反**：复用路径**没有**「必须排在 `saveToStorage()` 之后」的要求（老课行早已存在，`EXISTS` 必过）。
- **关键裁定**：只补「空归属」、**绝不搬动已有归属**；历史数据（5 门，含 3 门重复案例课）**建议 UI 手工拖，不写 SQL**。
- **验收**：**双向查库对照**。正向 —— UI 把某课移出文件夹 → 从文件夹复用（toast 证明走复用分支）→ `folder_id` **被写回**，课程数仍 11（未新建）；反向 —— 已有归属的复用**未被动过**。
- **状态**：✅ 已双端上线

---

## 8. H 组｜解析器与凭据托管

### H1. 文档解析器默认值改为 AliDocMind（三处联动）

- **轮次**：10-02 17:12（第八轮）
- **用户诉求**：首页「上传课程材料」弹窗的「文档解析器」默认改为 **AliDocMind**（用户截图圈红）。
- **⚠️ 光改默认值无效 —— 三处必须联动，只改一处会被静默打回**：
  1. **`isProviderUsable`（`lib/store/settings-validation.ts`）只认 `apiKey` / `isServerConfigured`，不认 AK/SK** —— 而 AliDocMind 用 AK/SK 认证 ⇒ 用户填在浏览器里的 AK/SK 被判「无凭据」⇒ 每次 `fetchServerProviders()` 都被打回 `unpdf`。**UI 层认 AK/SK、store 层不认 —— 这是本仓最典型的「两层判定不一致」陷阱。**
  2. **`alidocmind.enabled` 默认 `false`** ⇒ 第一段 `if (cfg.enabled === false) return false;` 直接判死；⚠️ 该判定**排在 `isServerConfigured` 之前**，所以连服务端托管条目也会被本地开关拦掉。
  3. 默认值本身 `pdfProviderId: 'unpdf'`。
- **改造内容**（3 文件）：`settings-validation.ts`（`ProviderCfgLike` + `accessKeyId/accessKeySecret`；新增 `hasAccessKeyPair()`；`isProviderUsable` 与 `buildUsableFallbackOrder` 的 client 过滤都改认 AK/SK）；`settings.ts`（`pdfProviderId` → `'alidocmind'`、`enabled` → `true`）；测试 +5 例。
- **关键裁定**：**`validateProvider(..., 'unpdf')` 的回退目标刻意不动** —— `unpdf` 是唯一零凭据的本地解析器，无凭据用户必须有地方可落。
- **验收**：真机 **2/2**（注入 AK/SK 后首页解析器**保持 AliDocMind**；无凭据时**降级 unpdf**）。
- **⚠️ 关键交付事实**：**设置存在浏览器本地，不在服务端** ⇒ 改代码默认值对「已有持久化设置的浏览器」不生效，用户必须在设置页操作一次；新浏览器/新设备才会自动拿到 AliDocMind 默认。
- **状态**：✅ 已上线

### H2. 删除 MinerU / MinerU(Cloud) 两个解析 provider

- **轮次**：10-04 · 第二十六轮分析 → **第二十七轮落地并上线**（17:30–19:00）
- **用户诉求**：「文档解析器里删除 MinerU 与 MinerU(Cloud)，且整个项目默认用 AliDocMind」。拍板原句：「① 不会用到 `.doc/.ppt/.xls` ⇒ **两个都删**；② **能**提供阿里云 AK/SK ⇒ 按**方案 A** 落地；③ 火山方舟（Agent Plan）的 key 也配上。总目标：**全站自动托管、默认真生效**」。
- **问题**：删 MinerU 代价接近于零（现役 env 里 `PDF_MINERU*` / `ALIDOCMIND_*` **全部为空**，两条链路本来就不可用），**但会丢两类格式**：能力矩阵显示 **`.doc/.ppt/.xls` 只有 `mineru-cloud` 支持**、**`.webp/.jp2` 只有 MinerU 支持** ⇒ 用户明确接受放弃。
- **「AliDocMind 作默认」在代码层已经是默认，但当前部署不会落地**：`alidocmind.requiresApiKey=true` 且无 AK/SK、服务端未托管（`applyAliDocMindFallback` 缺键即删条目）⇒ `isProviderUsable=false` ⇒ **被静默打回 unpdf**。
- **改造内容（彻底删除，含实现/测试/静态资源/文档站/部署 env）**：
  - 类型联合去掉两个值；删两个注册表条目；`pdf-providers.ts` 删 `parseWithMinerUDocument`/`parseWithMinerU`/`describeSelfHostedMinerUError`/`getMinerUBackend`/两个 switch case。
  - **整文件删除** `mineru-cloud.ts`、`mineru-parser.ts`（已验证只被 MinerU 两条链路引用）。
  - **10 个调用点同步**：`extractors/pdf.ts`、`extractors/manifest.ts`、`mime.ts`、`pdf-compat.ts`、`provider-config.ts`、`fetch-url.ts`、`extract-document/route.ts`、`verify-pdf-provider/route.ts`、`settings.ts`、`pdf-settings.tsx`（删 `isCloud`/`isSelfHosted` 分支与文案）。
  - **死代码**（源码 grep 扫不到但已删）：`AUTH_FAILED_MESSAGE`、`requestedTypeLabel()`。
  - **孤儿静态资源** `public/logos/mineru.png`。
  - **文档站内容** `packages/docs/content/docs/{configuration,supported-models}*.mdx` × **6 语种** —— ⚠️ 它们**会被 Next trace 进镜像**（`.dockerignore` 只根锚定 `*.md`，`.mdx` 不受影响）⇒ 对用户可见。
  - 测试：删 9 个文件、改 13 个；**`provider-neutrality-guard.test.ts` 是爆炸半径最大的一处**（按文件精确钉死厂商 token 次数、次数下降即抛错）⇒ 同步删两条债项。
  - `.env.example` 删 MinerU 段与 `ALLOW_MINERU_CLOUD_FALLBACK`、12 语言的死键、探测脚本。
  - 部署 env 删 13 行 ⇒ 容器 env **142 → 136**。
- **红利**：删注册表 key 后 `ensureValidProviderSelections` 会把**存量选了 mineru 的用户自动重置到默认值** ⇒ **无需写迁移**。历史归档不受损（`material_extraction` 里 `mineru-cloud|1` 那行原样保留、仍可读出）。
- **验收**：**删除彻底性** —— 镜像内 `grep -ril mineru /app | wc -l` **172 ⇒ 0**；启动日志 `1 LLM, 0 TTS, 0 ASR, 1 PDF, …`；**默认真生效硬证据** —— 自造 1 页 PDF，`POST /api/extract-document` **只带 `file` + `providerId=alidocmind`、零凭据** → **HTTP 200**，真实云 `taskId=docmind-20261004-…` ⇒ 服务端 AK/SK 生效。
- **状态**：✅ 已上线（3002 + 3003）

### H3. AliDocMind 成为「真默认」+ 火山方舟 Ark key 接入 + 模型白名单收敛

- **轮次**：10-04 第二十七轮（同上轮）
- **问题**：`settings.ts` 的默认值只是光标上的初值，服务器同步一跑就打回 unpdf ⇒ 只改 `settings.ts:720` 不够。
- **改造内容**：在部署 env 里配 `ALIDOCMIND_ACCESS_KEY_ID` + `ALIDOCMIND_ACCESS_KEY_SECRET` ⇒ `applyAliDocMindFallback` 不再删条目 ⇒ **所有用户自动可用、默认落地，无需逐个配置**。配火山方舟 key，并把 `DOUBAO_MODELS` **从 13 个裁到 10 个**（删掉 `doubao-seed-2.0-lite` / `deepseek-v3.2` / `glm-5.2`，它们回 `The requested model does not support the agent plan feature`）。
- **⚠️ 关键裁定**：**火山方舟有两套端点、模型白名单不同** —— `…/api/**plan**/v3` 是 **Agent Plan 专用端点**，不是标准 `/api/v3`。**key 有效 ≠ 所有模型可用** ⇒ 换 key / 换 plan 必须**逐个探测** `POST /api/verify-model`。裁剪只重建容器、无需重建镜像。
- **验收**：同 H2（同一镜像与容器）。
- **状态**：✅ 已上线

---

## 9. I 组｜访问与部署

| 编号 | 改造 | 轮次/日期 | 状态 |
|---|---|---|---|
| **I1** | **cookie `Secure` 属性收敛为单一策略源** | 10-04 第十八轮分析 → 第二十轮实施 | ✅ |
| **I2** | **3002 对局域网开放（方案 C）** | 10-04 第二十轮 | ✅ |
| **I3** | **换访问码 = 重建容器（机制澄清 + 换码执行 + 事实更正）** | 10-04 第二十一~二十三轮 | ✅ |
| **I4** | **Windows 防火墙放行 3002（局域网第三关）** | 10-04 第二十四~二十五轮 | ✅ |
| **I5** | **迁移到局域网 Debian 物理机（3003）** | 10-04 分析 → 20:17–20:4x 施工 | ✅ |
| **I6** | **门禁解锁免刷新（三条支路）** | 10-06 上午 | ✅ 双端 |
| **I7** | **腾讯云轻量复刻（3006）+ 三通道 + provider env 修复** | 10-06 13:2x–14:25 | ✅ |

### I1. cookie `Secure` 属性收敛为单一策略源

- **用户诉求**：「容器跑在 Docker Desktop，现只本机可访问，如何让局域网其他电脑都能访问？」
- **⚠️ 最硬的发现（代码写死且无退出开关）**：`app/api/access-code/verify/route.ts:71-77` 的 `secure: process.env.NODE_ENV === 'production'`。对比匿名 cookie 有 `COOKIE_SECURE !== '0'` 退出开关，**访问码 cookie 漏接了这个开关**。而 `OWNER_SINGLE_USER=true` 下根本不生成匿名 cookie ⇒ 那个开关在本部署里碰不到。
- **⚠️ 实测（Chromium + Firefox 双探针）**：`http://192.168.31.139:3019/` 的 `window.isSecureContext` = **false**（两浏览器一致），服务端下发的 `Secure` cookie **被丢弃**；而 `http://127.0.0.1:3019/`、`http://localhost:3019/` 均 true 且保留。**这就是「本机一直好好的」的原因**：loopback 是浏览器特批的安全上下文。
- **改造内容**：**新增** `lib/server/secure-cookies.ts`：`cookiesUseSecureAttribute()` = 唯一 Secure 策略源 = `NODE_ENV === 'production' && COOKIE_SECURE !== '0'`；**零依赖**（满足 `cookie-guard` 身份边界）。`anonymous-cookie.ts` 改为**委托**；`verify/route.ts` 改用共享决策。新增测试（纯函数 + 源契约：两处调用点都读共享决策、**不重内联**）。
- **验收**：**探针 0→N**（旧镜像 vs 新镜像 grep）：`cookiesUseSecureAttribute` **0→8**、`COOKIE_SECURE` **3→8**、回归对照 `targetFolderId` **0→4**。A/B：旧镜像 LAN IP cookie **丢弃**（重新要码、401）→ 新镜像 **保留**（200），两者 `isSecureContext=false` 相同 ⇒ **差异纯代码**。
- **状态**：✅ 已上线

### I2. 3002 对局域网开放（方案 C 的部署侧）

- **三道关**（互相独立）：① 容器绑定 `HostIp`（原 `127.0.0.1` → `0.0.0.0`）；② Windows 防火墙（当时**未过**）；③ 凭据层（`ACCESS_CODE` 未设 ⇒ 闸门整条关闭 + `OWNER_SINGLE_USER=true` = 谁打开谁就是全库所有者）。
- **用户拍板方案 C**（绑 `0.0.0.0` + `ACCESS_CODE` + 改 verify 接 `COOKIE_SECURE` 开关 + `COOKIE_SECURE=0`）。**否决方案 B**（Caddy 内网 HTTPS，每台设备要装内部 CA）、**方案 D**（`netsh portproxy`，一样要改防火墙、一样绕不过 cookie 坑，还多一层排障面）、**方案 A**（只绑 `0.0.0.0` 不加访问码 ⇒ 全库管理权交给任何连上 Wi-Fi 的设备）。
- **验收**：三 URL（127.0.0.1 / localhost / 192.168.31.139）全 200；DB 行数不变；env 差异**恰好 3 行**。⚠️ **当轮防火墙规则未加** ⇒ 第二台 LAN 设备仍打不开（第三关在第二十五轮才补齐）。
- **状态**：✅ 已上线（三关全通在 I4）

### I3. 换访问码 = 重建容器（含一次事实更正）

- **用户诉求**：「如何更换访问码」→ 选择「我生成新码并直接重建」→ 再问「用户能自定义访问码吗」→ 给出 16 位自定义码要求换码。
- **机制**：`ACCESS_CODE` 是**创建期**环境变量 ⇒ `docker restart`/`start` 无效，**必须 `docker rm -f` + `docker run`**。现役启动规格逐字节核对：容器 **142 个 env** = 镜像自带 6 + `--env-file` 131 项有效 + 命令行 **5 个 `-e`**（**差集闭合**）；`.env.local` 里这 5 个键**全是注释态** ⇒ 只能靠 `-e` 给。
  > ⚠️ **2026-10-09 订正**：本行的「142 个 env / 131 项」是**当时**值 —— `.env.local` 于 10-06 22:54 改动后现存 **125 键**、现役容器实测 **38 个 env**。**「142/136/140」这些条数一律作废，只认键名集合双向差集。**
  > 另：env 唯一源已迁到 **`D:\OpenMAIC\.env.local`**（`D:\soft\OpenMAIC\.env.local` 冻结仅供回退）；
  > 换码可执行版：`bash /d/OpenMAIC/.workbuddy/deploy/start-3002.sh --run`。**机制本身（创建期 env ⇒ 必须重建）依然成立。**
- **⚠️ 事实更正（第二十三轮）**：此前告诉用户的「访问码只能 `[A-Za-z0-9._-]`、1–128、禁 `anon:`」**是错的** —— 把 **owner ID** 的规则安到了访问码上。**`ACCESS_CODE` 没有任何字符/长度校验**：`access-token.ts` 只对它做 HMAC、`verify/route.ts` 用 `timingSafeEqual` 按字节比、`validateBootConfiguration()` **不查它**；官方文档也只**建议 ≥16 字符**。
- **连带返工**：更正 **8 处文档/脚本** —— 两份部署指南、局域网分析文档，以及 **`D:\OpenMAIC-V5-deploy\deploy.sh`：硬拦 `die` → 仅告警**（原来会拒掉合法自定义码）。
- **验收**：两次换码均全绿 —— env 142 条 ✅、库行数不变 ✅、旧码 401 ✅、新码 200 + cookie **无 `Secure`** ✅、`RestartCount=0`。
- **状态**：✅ 已上线（⚠️ 后续 10-06 又统一改为 8 位 `openmaic`，3002/3003/腾讯云三端一致）

### I4. Windows 防火墙放行 3002

- **用户诉求**：「`http://192.168.31.139:3002` 在**别的电脑**上打不开」→ 由用户在管理员 PowerShell 执行后贴回输出。
- **诊断（非提权 shell 实测）**：防火墙全 profile `Enabled=True`、`InboundDefault=NotConfigured`；搜到的唯一相关规则是 **`Docker Desktop Backend`（Profile=Public）**，**没有任何覆盖 3002 / Private 的规则**；本机网络 `Redmi_7154_5G = Private`。监听 `127.0.0.1:3002 (wslrelay.exe)` + `0.0.0.0:3002 (com.docker.backend.exe)` —— **两个监听都是 Docker 自带组件，不是端口冲突**。⇒ 根因 = **第②关未过**，从「未验证的推断」升级为「**实测复现**」。
- **改造**：用户手动执行 `New-NetFirewallRule … -LocalPort 3002 -Profile Private,Domain -RemoteAddress LocalSubnet`（规则收窄：`RemoteAddress=LocalSubnet`）。
- **⚠️ AI 不得代跑提权**：实测两条路都被安全策略拦（`-EncodedCommand` → "Encoded commands hide the actual code"；`Start-Process -Verb RunAs` → "…spawns a child process that bypasses PowerShell command validation"）⇒ **提权类操作只能由人手动执行**。
- **顺带排到一个新线索**：核对期间 `docker ps` 报 `npipe://…dockerDesktopLinuxEngine` 不存在、3002 无监听，而 Docker Desktop 在跑 ⇒ **根因 = Docker Desktop 正在重启、Linux 引擎尚未就绪**，轮询 ~10s 后容器凭 `--restart unless-stopped` 自动恢复 ⇒ **日后「3002 突然打不开」的排障第一步 = 先确认 Docker Desktop 在运行**。
- **状态**：✅ 局域网三关全通

### I5. 迁移到局域网 Debian 物理机（3003）

- **用户诉求**：「把运行中的 `openmaic-new` + `openmaic-new-db` **完整原样**复制到局域网 Debian 物理机的 Docker，容器名 `openmaic`/`openmaic-db`，端口 **3003**」。拍板：① 访问码**沿用**；② `postgres:16` **从本机搬**；③ 3002/3003 **长期并存**；④ **开工**。
- **两侧实测盘点**：源端 Windows 11 + Docker Desktop（`overlay2`）；目标端 **Debian 13 (trixie)** / 4 vCPU / 7.6 GiB / Docker 29.8.2（驱动 **`overlayfs`（containerd 镜像存储）**），**0 容器 0 镜像 0 卷**，**1Panel 已装且运行**。⚠️ 目标机 **Docker Hub 直连不通**；**无 ufw/firewalld/nftables**，实测 1Panel 端口从源端可达 ⇒ **入站不拦，3003 只需发布在 `0.0.0.0`，不需要加任何防火墙规则**（与 3002 那次完全不同）。
- **关键裁定**：**方案 A（镜像搬运 + 逻辑备份）** 而非物理卷拷贝 —— ① 不用停 3002（物理卷拷贝必须停 DB）；② 无 uid/gid、PGDATA 布局、卷名耦合；③ 可重复执行。
- **施工（7 阶段）**：阶段 0.3 先用极小镜像做 containerd 往返测试（**唯一风险点清零**）；镜像 540MB→30.0s、451MB→25.0s；`pg_dump -Fc | ssh | pg_restore --exit-on-error` **退出码 0 / 33.4s**；`/app/data` 卷单文件 sha256 双端一致。
- **四处定制**：`DATABASE_URL` 主机名改 `openmaic-db`；**`COOKIE_SECURE=0` 必须显式传**；落地目录改**家目录**（目标机 sudo 需密码、`/opt` 属 root）⇒ **不复用 `deploy.sh`**（那条 `*[!A-Za-z0-9]*` 会被含连字符的口令卡死），改用手写 compose。
- **验收**：7 阶段全绿，**源端 3002 零影响**。含真实浏览器：无码 401 / 正确码 200 / **错误码 401**；`Set-Cookie` **无 `Secure`**；`/api/server-providers` = `doubao`(10 模型) + `alidocmind`；**真实 LLM 调用 OK**；**真实 AliDocMind 解析 HTTP 200 并落库**；浏览器走完「访问码门 → 首页」，console error = 0、3 个文件夹全部呈现、「三种使用方式」说明卡随镜像一并迁移。
- **状态**：✅ 已上线

### I6. 门禁（访问码）解锁免刷新 —— 同一 401 根因的三条支路

- **轮次**：10-06 上午（可行性分析 → 用户拍板 → 施工 → 双端验收）
- **用户诉求**：「`localhost:3002` 输访问码后要刷新才见文件夹，能否免刷新」（原文提三项诉求之一，明确"要求仅分析 + 改造步骤"，后拍板施工）。
- **根因**：`AccessCodeGuard` **不阻塞 children 渲染** ⇒ 首页在**无 cookie** 时就挂载取数；挂载 effect（依赖 `[]`，只跑一次）打 `/api/stages` + `/api/folders` ⇒ `middleware.ts` 对 `/api/**` 回 **401** ⇒ 抛错 ⇒ `setClassrooms`/`setFolders` **从未执行** ⇒ 首页走空态。解锁成功 `onSuccess` **只**补 `fetchServerProviders()`，**没补课程库** ⇒ 必须 F5。同一根因共三条支路：① 课程库/文件夹不重读；② **材料目录**挂载 effect 不重读（"刷新才看到**章节**"）；③ `persistenceProbe` 把 401 的失败结果**缓存住了** —— 这条才是"刷新才看到章节"的**真正根因**。
- **改造内容**（6 处）：
  1. `access-code-guard.tsx`：`onSuccess` 补发 `LIBRARY_CHANGED_EVENT`。选此方案而非新增专用事件，因为首页**本就订阅该事件** ⇒ 零新增监听/常量/i18n/SQL，仅 2 行。
  2. `app/page.tsx`：`loadClassrooms` 的 catch 对 **401** 不再报「持久化不可用」误导 toast。
  3. `app/page.tsx`：挂载 effect 抽出 `restoreDirectory()`，**订阅同一广播**，并加 `readAnswered` 护栏。
  4. `course-material-persistence.ts`：`persistenceProbe` **不再缓存「未答复」** ⇒ 401 拒答不再污染探针缓存。
  5. `stage-storage.ts`：`LIBRARY_CHANGED_EVENT` 注释补「或门禁刚放行本浏览器」。
  6. `app/page.tsx`：复用分支补归属（见 G2）。
- **关键裁定**：用户拍板 **D3 = 只做方案 A**（复用现有事件），**不做方案 C**（`<Fragment key={epoch}>` 重挂载子树 —— 覆盖面最广但**解锁瞬间整页闪一次**）；**D4 = 不纳入「当前文件夹落 URL/持久化」**（独立议题）。
- **验收**：四道门控全绿。真机 **3002 与 3003 各一次、全新 context**：锁定态文件夹全 **0**（正向对照）→ 输 `openmaic` 后**不刷新**各 **1**；JS 标记存活（**证明确实没重载**）；无误导 toast；非 401 console error 0。进「舆情学」12 章 / 5 章，均无需刷新。
- **状态**：✅ 双端上线

### I7. 腾讯云轻量复刻（3006）+ 三通道 + provider env 修复

- **轮次**：10-06 13:2x 仅分析 → 13:4x 拍板 → 13:42–13:52 全流程施工 → 14:0x 诊断按钮灰 → 14:05–14:25 修复
- **用户诉求**：给了一台腾讯云轻量（`49.235.171.87`，Ubuntu 24.04 + Docker 29），要求把本机运行中的栈**完整相同**复刻过去（容器名 `openmaic`/`openmaic-db`、端口 **3006**、网页可经 IP 被其它电脑访问），并打通 **SSH 免密 / Docker context / MCP** 三通道。第一轮**明确只要分析与步骤，不执行**。
- **前置实测**：22 端口可达；3006/80/443 **未监听**；SSH 回 `Permission denied(publickey,password)`。两个 🔴 风险：① 公网 + 弱码 `openmaic`(8位) + `OWNER_SINGLE_USER=true` = **全库可改删**；② **http + `Secure` cookie ⇒ 谁都登不进** ⇒ 必须 `COOKIE_SECURE=0`。3006 是**非标端口，免备案**。
- **三通道**：A `~/.ssh/config` 追加 `Host tencent`；B `docker context create tencent --docker "host=ssh://tencent"`；C `~/.workbuddy/mcp.json` 合并 `tencent` 条目。
- **⚠️ 推公钥踩坑（已写入红线 51）**：我给的推公钥命令是 **Bash 语法**（`PUB=$(cat …)`），用户在 **Windows PowerShell** 里粘贴 ⇒ 变量为空 ⇒ 远端 `echo '' >>` **静默只写了个空行**（命令"看起来成功了"）。**规则**：交付给用户粘贴的命令必须先确认 shell，或两种都给，末尾加自证行（`grep -c`）。
- **施工与验收（实测耗时约 10 分钟）**：镜像 **81s**（1.14 GB + 934 MB 一条流）；`pg_dump -Fc` **42s**（263 MB）；`pg_restore -j 2` **13s、零错误**；卷单文件 <1s（⚠️ 需 `chown` 对齐属主 `1001:65533`）。
  - **逐表指纹 21 行 `diff` 为空**（用 `count(*)` + `sum(pg_column_size(x))`，对 `bytea` 安全），连 `asset_blobs` **273,955,960 B** 都分毫不差。
  - **HTTP 端到端对账三 BASE 逐行 `diff` 为空**，其中第三个 BASE 是**本机经公网 IP 发起的**（= "另一台电脑"的真实答案）。
  - **4 处与计划的偏差（计划偏保守）**：① **3006 无需放行安全组**（本机直连公网已 200）⇒ 从人工阻塞降为**零动作**；② **sudo 免密** ⇒ 一行搞定；③ 卷迁移加 chown；④ DB 迁移改「流式落远端文件 → `docker cp` → `pg_restore`」。
  - ⚠️ **`ubuntu` 不在 `docker` 组时 `docker --context` 的表象是 `Cannot connect to the Docker daemon at http://docker.example.com`** —— 极易误判成 context 写错，真因是远端 socket 权限。
- **第二轮缺陷（14:0x）**：用户报「进入课堂」永久灰。
  - **根因**：**腾讯云栈缺 provider env** —— 镜像**零凭据**（6 个键、`grep -c API_KEY` = 0），而 3002/3003 的 provider 是**部署时注入**的（3002 容器比镜像**多 130 个键**）；腾讯云 compose **只声明了 5 个 `environment:`、没写 `env_file`** ⇒ 服务端 provider 为空。门控 `canGenerate = requirement && hasUsableProvider && directoryRestored`，前两项都成立 ⇒ 唯一为假的是 `hasUsableProvider`。
  - **连带损失**：`pdf: ['alidocmind']` 也没了 ⇒ **3006 上传 PDF 解析同样失败**。
  - **为什么"换个端就点不动"**：设置存 **localStorage（按 origin 隔离）** ⇒ `localhost:3002` 与 `49.235.171.87:3006` 是两个 origin。
  - **修复（方案 ①）**：新增 `~/openmaic/.env` = `D:\soft\OpenMAIC\.env.local` **字节级原样**（**LF、零 `\r`、chmod 600**）；compose 加 `env_file: - .env`；**只重建 web 容器**（DB 与源端 3002 全程未动）。
  - **验收（四组全绿）**：`/api/server-providers` 双端**逐字节相同**；逐表指纹一致且 `asset_blobs` 恒定（**一次性 GC 未回收**）；`verify.sh` 公网与基线逐行一致；**按钮 A/B 决定性** —— 同一页面同一套点击，只换 provider 变量：real=ENABLED / stub=**DISABLED（精确复现用户截图症状）**。
  - **记忆订正**：红线 45 原写「3002 容器 env 靠 `docker run` 的 **5 个 `-e`** 注入」——**这条是错的/严重不完整**，正是本次漏配的根源。
- **状态**：✅ 已上线（剩 MCP「信任」待用户点）

---

## 10. J 组｜数据一致性与缺陷根治

### J1. 两库全量对齐（3003 → 3002，一次性）

- **轮次**：10-06 上午
- **用户诉求**：「需要调整让 3002 的库数据和 3003 的数据保持一致」。
- **盘点发现是双向分叉，不是单向落后**：对齐前仅 3002 有某课 + 一个**空壳文件夹**；仅 3003 有 2 门 LIVE 课、2 份材料、`app_kv` 一行；同 id 不同内容两处（含一课 3002 只 2 场景 vs 3003 完整 10 场景）⇒ 3003 全面领先。
- **施工**：备份双份（各 263 MB）→ `docker stop` → `DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE` → `pg_restore`（**9s，零错误**）→ `docker start`。**3003 全程只读。**
- **关键裁定**：用户选 **A 方案（以 3003 为准覆盖 3002）** + "只做这一次"。
- **验收三层全绿**：① **20 张表行数 + 整行 md5 指纹完全一致**（`asset_blobs` 含二进制，用 `md5(content_hash‖byte_size‖md5(bytes))` 逐行哈希）；② `/api/stages` 与 `/api/folders` 两端**逐字节相同**；③ 关键行抽查正确。
- **两处订正**：文档记的 3003「8 live」**已过时**（实测 6 live / 13 总）；两门测试课的 `deleted_at = 10-06 10:30` 落在**验收时段内、无法回溯操作来源** ⇒ 现为两端一致的既定状态。
- **回滚锚点**：两份 263 MB dump（保留）。
- **⚠️ 由此确立的纪律**：两库**已全量对齐，此后任一端写入即重新分叉**；且对齐/备份**必须显式含 `app_kv`**（首页章节清单只活在那里，不在任何 `document_*` 表）。

### J2. 方案 A：3002 补回 `app_kv` 一行（纯数据修复）

- **轮次**：10-06 11:16–11:22
- **根因**：`persistHomeMaterials()` 在 `materials.length === 0` 时**直接 DELETE 整行** ⇒ 一次空清单写回就丢光全部章节，**服务端无第二份**。
- **施工**：3003 侧 base64 无损导出 → 本地校验 → 生成**幂等** UPSERT 写回 3002。**源码 0 改、容器 0 重建、3003 全程只读。** 回放脚本留档。
- **验收三层全绿**：数据层两端 md5 相同 + 全库 19/20 表逐行指纹一致；协议层 `GET /api/kv/entries/…` **404 → 200**；浏览器层全新 context 点「舆情学」→ **5 章 + 已选第 1 章**。唯一残留差异 = `app_kv.updated_at`（首页每次挂载会刷新时间戳，**刻意对齐无意义**）。
- **状态**：✅（⚠️ **事后证明只是暂时补回，11:5x 即再次消失 ⇒ 引出方案 B**）

### J3. 章节目录再次为空 → 定性为「同一行 KV 被第二次 DELETE」

- **轮次**：10-06 11:5x
- **硬证据（新手段）**：`pg_stat_user_tables.n_tup_del` —— 3002 = **2**、3003 = **0**；**del=2 正好对应 `removeStoredHomeMaterials()` 一次删 v2+v1 两行** ⇒ **这是真删过**，不是显示问题。
- **逐条排除（均实测）**：两端文件夹/课程结构相同；没删过「舆情学」；工具栏「解析器不支持就删材料」的 effect 不命中；KV 5 条**都有 `storageKey`**（不会被过滤光）；非库对齐所致。
- **施工**：① 复刻方案 A 恢复（解码 **1523 B 与上次的 `value.json` 逐字节相同**）；② **安装临时审计**：3002 加 `app_kv_audit` 表 + `AFTER INSERT/UPDATE/DELETE` 触发器。**基线自检**：跑一遍正常读-写循环，审计恰好捕获 1 条 `UPDATE(value_len=1523)`、无 DELETE ⇒ 触发器工作正常。
- **状态**：✅ 数据恢复 + 审计装上；⛔ **真根因当时仍未定**（审计的作用就是区分"用户真的清空"与"还没读出来就写回"）

### J4. ★ 方案 B：根治「空清单写回 = DELETE 整行」（本日最重要的产品级改造）

- **轮次**：10-06 11:46–12:25
- **用户诉求**：**「现在就开工方案 B」** —— 杜绝首页「课程章节」清单再次被清空。
- **核心洞察**：`persistHomeMaterials()` 在载荷空时直接 DELETE 整行。而「空列表」有**两种含义** —— ① 用户真的清空；② 页面还没读到 / 读不进去。**删除必须被请求，而非被推断。**
- **确定性复现（旧镜像，KV 读打 500 时）**：
  ```
  GET v2(500) → DELETE v2 + DELETE v1 →（上传 1 个文件）PUT v2 →（移除）DELETE v2 + DELETE v1
  ```
  即**探测端点正常（`persistence: true`）而 KV 读失败**，旧代码就在**页面刚加载**、用户什么都没做的情况下把目录擦掉。**两道旧保护全部挡不住** —— arming（首次 effect 只 arm 不写）只防"挂载瞬间"，不防"列表真的为空时的一次写回"。
- **五处源码改动（改后 = 三重条件，缺任何一条就一个字节都不写）**：

  | # | 文件 | 改动 | 拦住的情形 |
  |---|---|---|---|
  | 1 | `course-material-persistence.ts` | **新增** `readHomeMaterialsResult(): { answered, stored }` —— 读取层区分「读到空 / 没读到 / 读失败」；`readHomeMaterials()` 退化为薄包装 | 读取层不再把"读失败"和"确实没有"折叠成一个 `null` |
  | 2 | 同文件 | `writeHomeMaterials(state, { allowEmpty })`，**默认 `false`**；未授权 ⇒ 跳过 + `log.warn('Refusing to erase the stored chapter directory: …')` | 任何调用方忘了门控；告警落在容器日志里（**可观测**） |
  | 3 | 同文件 | **载荷空 ≠ 目录空**：`if (state.materials.length > 0) return;`（既不写也不删） | **上传途中那一帧**（行还没有 `storageKey`，被 `toPersistedMaterials` 滤掉 ⇒ 内存 1 行、载荷 0 行）—— **每次上传都会走到，比下面两条更根本** |
  | 4 | `app/page.tsx` | 新增 `directoryLoaded`（读**答复过**才翻真），**写在恢复 effect 的 `finally` 里、`setForm` 之后** | 读还没答复（含未解锁的 401 窗口）就写回；以及"标志先翻真、章节还没进 state"的多余一帧 |
  | 5 | `app/page.tsx` | 新增 `heldMaterialsRef`（本页**曾持有过**非空清单），作 `allowEmpty` 的唯一凭据 | 本页从未见过的目录（别的设备/标签页写进来的）被本页空写回擦掉 |

  - **不动**：`clearHomeMaterials()`（显式清空 API）语义不变；「空目录 = 删行」这条既有语义不变；v1 老键升级不变。
- **⚠️ 施工中自抓两个洞（都在"我的第一版修复"里，由临时审计表 + 实测抓到）**：
  - **洞 1 · 排序**：首版把 `setDirectoryLoaded(true)` 写在 `await restoreCourseMaterials(stored)` **之前** ⇒ 中间多出一帧"已算读过、列表还空"的渲染 ⇒ 写回 effect 恰好在那一帧发 DELETE、跟着再 PUT 回来。审计表实锤（id 5/6、7/8 两组 DELETE+INSERT 配对，相隔 **90ms / 93ms**）。**修法**：标志移进 `finally`、`setForm` 之后。
  - **洞 2 · 语义**：`allowEmpty:true` 配"载荷空但内存非空"仍会擦除（上传瞬间行无 `storageKey`）⇒ 实测 `9.265 DELETE v2 → 9.279 PUT v2 n=1`。**修法**：模块加 `if (state.materials.length > 0) return;`。
- **单测**：17 → **18 例**（harness 加 `readError` 注入；新增/改写 4 例：默认拒绝擦除、显式授权才擦除、`readHomeMaterialsResult` 区分三态、**未捕获 storageKey 的行是"待写"而非"空目录"**）。
- **验收（全部实测非推断）**：
  - **四模式验收矩阵**（全程 `page.route` stub，不碰真实数据）：

    | 模式 | 场景 | 期望 | 旧镜像 | 新镜像 |
    |---|---|---|---|---|
    | `unread` | KV 读恒 500 → 上传 1 个 → 移除 | **完全不写** | ❌ `DELETE v2+DELETE v1 → PUT → DELETE v2+DELETE v1` | ✅ 仅 `GET v2`，PUT 0 / DELETE 0 |
    | `seeded` | 读返回真实 5 章 → 上传/移除 | **不得擦除当前键** | —（新增回归） | ✅ `erasure(v2)=0` |
    | `erase` | 用户**逐条删完** | **必须擦除当前键** | — | ✅ `erasure(v2)=1` |

    `seeded` 是**正向对照**、`erase` 是**反向对照** —— 只做 `unread` 无法区分"修好了"与"写坏了"。
  - **产物探针**：新镜像 `Refusing to erase the stored chapter directory` = 1 chunk、`readHomeMaterialsResult` = 7 chunks；**旧镜像两条新串均为 0**（触发词必须用**字符串字面量** —— 局部变量名会被压缩）。
  - **真机**：3002 / 3003 点「舆情学」均显示 **5 章**；KV 流量只有 `GET/PUT v2 + DELETE v1`，**全程无 `DELETE v2`**。
  - **库级**：3002 `n_tup_del` 停在 **4**（全是调试期）之后 **0 删除**，同期 `n_tup_upd` 14 → 16（写入确实在跑）；3003 恒 **0**。
- **诚实记录的残留局限（未修）**：① **多标签页/多设备 last-writer-wins** —— 要根治需给记录加**修订号（revision）**，不是把空分支改得更严；② **读永远不答复 ⇒ 写永远不发生** —— **刻意取舍**（这种部署下写本来也可能失败，而"擦掉"不可恢复）；③ 两端 `selectedMaterialId` 差 6 字节 —— **正常产品行为**（跨设备同步的单一槽位）。
- **清理**：临时审计已 `DROP TRIGGER/FUNCTION/TABLE`，两端 `app_kv*` 表计数恢复 1:1。
- **状态**：✅ 双端上线（⚠️ 用户需按 Ctrl+F5 强刷）

---

## 11. K 组｜交付物与工程基建

| 编号 | 项 | 内容 | 状态 |
|---|---|---|---|
| **K1** | `.dockerignore` 锚定缺陷修复 | `node_modules` 只匹配根目录 ⇒ 需 `**/node_modules`（+ `**/dist`、`**/.next` 等）；**保持根锚定不动** `docs`/`assets`/`*.md`/`.env*`（`packages/docs` 是真实独立子应用）。诊断诀窍：镜像里出现 `*.CMD`/`*.ps1` Windows shim 即坐实上下文被污染 | ✅ |
| **K2** | 源码快照 OpenMAIC-V1 → **V8** | 8 个版本，全部在 `D:\` 根（**不放源码树内**）；最新 `D:\OpenMAIC-V8.zip`（3,373 文件 / 93.4 MB / sha256 `e907cf29…`）。⚠️ 改完源码**不自动进包**，每轮重打 | ✅ |
| **K3** | `docs/feature-changes-summary.md` | 09-30→10-04 的功能点汇总（25 项 / 8 组），**三份文档分工从此确立** | ✅ |
| **K4** | `docs/rebuild-from-pristine.md` | **从 pristine 复刻到 V5 的实施手册**（791 行 / 12 个有序阶段）。关键方法：**清单不靠记忆，靠 md5** —— 两侧 `find` → `comm` 拆增删 → 3241 个共有文件逐个 md5 比对（约 4 分钟须后台跑）。实测：新增 141（含 72 个构建产物 ⇒ 真实 69）、删除 **0**、修改 84、新增 11,765 行 + 改动净增 5,008 行 ≈ **1.68 万行**。**「删除 0 个文件」是个强信号** ⇒ 实施策略是「几乎全在加」，只有 12 个文件是真正原地改的热点 | ✅ |
| **K5** | 部署手册四份 | `v5-redeploy-guide.md`（换机，464 行 / 三条路径 A 镜像 B 源码 C 本地 dev）、`v5-cloud-deploy-guide.md`（云主机，602 行 / 11 节）、`debian-migration-analysis.md`（含 §10 增量同步 + §11 库全量对齐）、`tencent-cloud-migration-analysis.md`（**§7 实际执行记录 + §8 provider env 修复**） | ✅ |
| **K6** | 四套运行栈 | `openmaic-new`(3002 本机) / `openmaic`(3003 Debian) / `openmaic`(3006 腾讯云) / `OpenMAICV2`(Exited)；每轮留**回滚标签**（`pre-planb-20261006` 等）与 DB dump 锚点 | ✅ |
| **K7** | 记忆体系治理 | `MEMORY.md` 两次瘦身（19,974 → 6,813 B → 19,690 → **10,636 B**），红线全文下沉 `topics/red-lines.md`（**65 条**）；另有 6 份主题笔记（门控/抽取/章节/环境/持久化/排障） | ✅ |
| **K8** | 技能订正 | `openmaic-docker-deploy`、`docker-stack-migration`（新增 §8 空写入加固 / §9 云主机差异 / provider env 专节）、`openmaic-pdf-extract-triage`、`openmaic-source-package`、`lan-docker-host`（订正「不适用：云主机」） | ✅ |
| **K9** | 首页说明卡（三种使用方式） | 10-04 用户拍板三条后实施上线：宽屏常驻卡片 + 窄屏 `?` 图标 Dialog；`localStorage` 记住折叠状态；12 语种 11 个新键。⚠️ 定位受**318×500 硬约束区**限制（宽须 `≤ W/2−448`、**只能用 `absolute`**）；1440px 档余量仅 24.5px。**文案隐含前提**：依赖 F1 的选章自动预填，若日后去掉预填须同步补回文案 | ✅ |
| **K10** | 课程模型配置三项默认值 + TTS 卡片文案 | 11-02：① **默认值机制查清** —— 不是写死，而是「服务端托管清单第一项」：`DOUBAO_MODELS` / `IMAGE_SEEDREAM_MODELS` 的**首位即默认模型**，TTS 取 `data.tts` 第一项（`settings.ts` 首次同步 `autoConfigApplied=false` 时 auto-select）。服务端只有 `DEFAULT_MODEL`（兜底，优先级最低：operator `MODEL_ROUTES` > 用户 stage route > `x-model` > `DEFAULT_MODEL`）与 `DEFAULT_IMAGE_PROVIDER`（仅 agent 工具），**无 `DEFAULT_TTS_PROVIDER`**。② 3003 补 `DEFAULT_MODEL=doubao:doubao-seed-2-1-pro-260915`，实测不带 `x-model` 调 `POST /api/generate/agent-profiles` → 成功且日志 `[model=doubao:doubao-seed-2-1-pro-260915]`。③ 前端 `course-model-config.tsx` 的 TTS 站点在 `ttsModelName` 为空（doubao-tts 无模型概念）时回退 provider 显示名并剥掉括号补充说明 ⇒ 卡片由只剩「循环」标签变为「豆包 TTS 2.0」。真机 3002/3003 双端确认 | ✅ |

---

## 12. 只做过可行性分析、未实施（**不算已接受改造**）

> 单独成节的理由：**「分析过」最容易被误当成「已经有了」**。以下每一项都只产出了可行性报告与步骤，用户未拍板开工。
>
> 共 **33 项**：产品方向类 12 项 · 工程方案类 21 项（含被明确否决的备选方案 —— 否决同样是确定的结果，故一并留档）。

**产品方向类**
1. 参考要点在**答题前**显示（当前是提交后展开）—— 需给 `QuizQuestion` 加字段 + 改 dsl + 渲染器 + 编辑面 3 处。
2. 「换一批」开放到**普通课件课堂**（当前只在 unit-quiz）。
3. PPTX 导入做成真功能 —— `useImportPptx` 是**半成品脚手架**（无 `onImported` 消费者），入口被 `NEXT_PUBLIC_ENABLE_PPTX_IMPORT` 默认 OFF；教学资源包无 `manifest.json`。四种产物里**只有「导出课堂 ZIP」可回灌**。
4. `.doc/.ppt/.xls` 进格式矩阵、`.webp/.jp2` 支持 —— **用户已明确接受放弃**（随 MinerU 一并删除）。
5. 豆包搜索作为联网检索 provider —— 4 把 key 实测：tavily/bocha/baidu ✅200，**doubao ❌500 `invalid_api_key`**；豆包搜索要的是**火山方舟 Agent Plan 专用 key**，不是普通 ark 大模型 key。
6. 章节目录在**生成页 / 课堂页**也常驻 —— 用户明确限定**保留范围 = 仅首页**；且课堂页左侧已被场景侧栏占用（**场景侧栏 ≠ 课程章节**）。
7. 多端并集合并（KV 无 CAS，last-writer-wins）。
8. 材料从一个文件夹**移到**另一个文件夹。
9. 把新章节**追加**进已有课堂（课堂不是可增量容器）。
10. 归档缺失时自动回退到重新解析（当前只点名报错要求重新上传）。
11. `currentFolderId` 落 URL / 持久化 —— 用户 10-06 明确裁定「**不纳入，独立议题，先把归档主链路修对**」。
12. 给 `material_extraction` 加 `metadata jsonb` 列做真回放 —— 上线验收发现既有形状偏差，但**全仓库无任何消费方读那个键**，用户选择改文档（诚实化）而非加列。

**工程方案类（被明确否决的备选）**
13. 文件夹↔目录关联的方案 A（键位分区）/ B（单键 `{byFolder}`）/ C（清单挂 `document_folders` 行）—— 逐一被否，理由见 A6。
14. 局域网方案 A（只绑 `0.0.0.0` 不加访问码）/ B（Caddy 内网 HTTPS）/ D（`netsh portproxy`）。
15. 归档方案 B（改 INSERT 直接写 `folder_id` / 给 `Stage` 加字段）—— `Stage` 是落库判别联合，加字段要过 3 处显式登记；且 `folder_id` 是"组织关系"，方案 B 是往回耦合。
16. 迁移方案 B（物理卷拷贝）—— 要停服、uid/gid/PGDATA/卷名耦合。
17. AliDocMind 落地方案 B（逐用户填 AK/SK）/ C（改回退默认 + 放宽 `isProviderUsable`）—— 方案 C 会让无凭据用户停在一个**不可用**的 provider 上。
18. 腾讯云修复方案 ②（浏览器 ⚙ 填 key）/ ③（只补两组键）。
19. 门禁方案 B（新增专用事件）/ C（`<Fragment key={epoch}>` 重挂载）。
20. 「解析隐藏」的方案 B（纯本地 `useState`）/ C（直接删 `analysis`）—— C **明确否决**（丢内容、下次要重新调 LLM 且生成**不同的**解析，与变体缓存直接冲突）。
21. 案例教学多场景 / 多课程 / 挂 outline 的 `caseConfig`。
22. 「换一个案例」的原方案（bump `attempt` → 只重跑 `scene-content`）—— 已被 E6 的改版取代。
23. 让路由给 `content` 盖判别字段 —— 要改所有消费方的线上契约。
24. 案例教学走 agent 通路做搜索 —— 交互面要重设计、风险大。
25. 悬停说明卡第 2 条时左侧【新建文件夹】图标闪一下的联动高亮（一期不做）。
26. 说明卡内「右上角 ⚙」做成可点深链 —— 会与文案语义矛盾。
27. 历史数据回填 SQL（5 门课含 3 门重复案例课）—— 按建议 **UI 手工拖**。
28. 3003 上的复用分支归档实测 —— 会在**用户正在使用的库**上写库 ⇒ 以「镜像产物逐文件同名 + 3002 实测」作替代证据。
29. 去 Chrome profile 读用户浏览器里的搜索 key —— 判定**越界**，明确不做。
30. 本机跑云主机部署包的 `deploy.sh` —— 会撞用户栈，只做静态与函数级验证。
31. 用仓库自带 `playwright.config.ts` 打 dev —— 默认 baseURL 指向 3002 旧镜像，验 dev 必须写临时配置覆写。
32. AI 代跑提权命令（防火墙规则）—— 安全策略拦，只能由人手动执行。
33. 修 5 个「本就红」的测试里与本次无关的既存债 —— 刻意不修以免偏离现状。

---

## 13. 贯穿全程的三条通用经验

1. **页面正常 ≠ 写进去了。** 本项目最贵的教训：`mergeSceneContentForUpdate` 对非 pbl 是**整份替换**，漏一个 spread 就把整页内容写没，**而页面看起来完全正常**（内存 store 就是屏幕上那一份），只有刷新/换设备/查库才暴露。同类变体还有：顶层镜像字段不落列表（`applyVariant`）、`setStage` 清空 `scenes`。**验收必须真机 + 查库，不能只看渲染。**
2. **测试桩会撒谎。** e2e 的 `page.route` 桩若**多给一个真服务端从不返回的字段**，用例会全绿而生产全挂 —— 典型是「换一批」那个 bug（桩多给了 `type`）。**桩的响应形状必须照抄真路由。**
3. **静默的东西最容易被当成存在的。** 「分析过」≠「有了」；「读失败」≠「读到空」；「改了默认值」≠「默认值生效」（会被 store 静默打回）；「设了 `ACCESS_CODE`」≠「闸门关上了」（要看字符集规则与 cookie 属性）。本文 §12 单列未实施项、§ 每条都标「改前 vs 改后」，就是这个原则的落地。

---

## 14. 当前运行态（截至 2026-10-06 15:00）

| 端 | 地址 | 容器 | 访问码 | 状态 |
|---|---|---|---|---|
| 本机 | `http://localhost:3002` | `openmaic-new` + `openmaic-new-db` | `openmaic` | ✅ 现行主力 |
| 局域网 Debian | `http://192.168.31.66:3003` | `openmaic` + `openmaic-db` | `openmaic` | ✅ 与 3002 数据已全量对齐 |
| 腾讯云轻量 | `http://49.235.171.87:3006` | `openmaic` + `openmaic-db` | `openmaic` | ✅ 公网可达，provider env 已补 |

三端共享同一份源码产物与同一份数据（对齐时点 10-06 上午）；**此后任一端写入即重新分叉**。

**⚠️ 三件仍待人工的事**：① 三端页面按 **Ctrl+F5** 强刷（旧标签页仍是旧 bundle）；② MCP `tencent` 条目需重启 WorkBuddy + 手动点「信任」；③ 腾讯云那条老账 —— 访问码沿用 8 位弱码 + 公网可达 + 单用户模式，**建议给腾讯云防火墙加一条「来源 = 你的固定公网 IP」**（比换码更管用且不影响使用）。