# dsh-better-output

[![test](https://github.com/zhll666/dsh-better-output/actions/workflows/test.yml/badge.svg)](https://github.com/zhll666/dsh-better-output/actions/workflows/test.yml)

[English](README.en.md) · 简体中文

给 **DeepSeek Harness（DSH）** 用的会话归档插件：每开一个会话，就在当前工作区建一个文件夹，自动用 **txt** 记录这次会话的

- 用户输入、助手输出；
- 完成任务时下发给工具 / 命令行 / 网页的**指令原文**；
- 读、写、编辑、搜索过的**文件**；
- 搜索过、抓取过的**网页**；
- 工具调用、失败、交付物与完整事件时间线。

不依赖第三方包，不改 DSH 源码，只在旁边看 `session/event`，把公开事件翻译成人能直接翻的文本。

```
工作区/
├─ sessions-index.txt                    所有会话的索引
└─ 2026-11-05_15-41-53_504ef586/         一个会话一个文件夹
   ├─ README.txt                         本目录说明
   ├─ session.txt                        会话总览：标题、模型、统计
   ├─ projects/                          本会话产出的项目（新会话的工作目录）
   ├─ inputs/inputs.txt                  用户输入
   ├─ outputs/outputs.txt                助手输出（汇总）
   ├─ outputs/turns/0001.txt             按轮拆分的完整输出
   ├─ prompts/tool-calls.txt             工具 / 命令行指令原文
   ├─ prompts/context-injections.txt     DSH 注入的运行时上下文（非用户输入）
   ├─ prompts/skills.txt                 加载过的 Skill
   ├─ logs/events.txt                    事件时间线
   ├─ logs/files.txt                     调用的文件
   ├─ logs/web.txt                       浏览的网页
   ├─ logs/tools.txt                     工具调用 + 结果 + 耗时
   ├─ logs/errors.txt                    失败与异常
   ├─ artifacts/artifacts.txt            交付物清单
   └─ .dsh-better-output.json            断点状态（重启续写、防重复）
```

## 它解决什么问题

DSH 自己的会话日志是给机器回放用的：zstd 压缩、JSONL、事件类型多，想回答「这次会话到底改了什么、查了什么资料」得先写脚本解压再翻。这个插件在事件提交后顺手把同一批事实写成纯文本，按用途分文件，会话结束就能直接交给别人、归档或贴进工单。

它不替代 DSH 的会话持久化，也不改模型上下文：删掉输出目录，会话照常工作。

## 装法

要求 **DSH 0.2.x 桌面版**（在 0.2.1-rc.5 上验证），插件本身是 **bundle 级**（`dsh.bundle.patch` + `cordis.patch.yml`），只有 Host 半边，没有客户端 UI。

**方式一：脚本（推荐）**

```powershell
# 在本仓库目录
node scripts/install.mjs
```

脚本会：

1. 把插件复制到 `$DSH_HOME/plugins/dsh-better-output`；
2. 在 profile 的 `package.json` 里加 `"dsh-better-output": "link:<绝对路径>"`；
3. 把 `dsh-better-output` 追加到 `dsh.profile.bundles`；
4. 在 profile 的 `node_modules` 下建 junction，保证加载器能解析到包；
5. 备份原 `package.json` 为 `package.json.dsh-better-output.bak`。

然后**重启 DSH**。宿主只在启动时扫描 bundle 列表，客户端 HMR 不会加载新增的 Host 插件。

**方式二：手动**

把仓库放到任意目录，然后：

1. profile（`$DSH_HOME/profiles/desktop/`）的 `package.json` 依赖里加
   `"dsh-better-output": "link:C:/绝对/路径/dsh-better-output"`；
2. `dsh.profile.bundles` 数组末尾加 `"dsh-better-output"`；
3. 建链接：
   `mklink /J node_modules\dsh-better-output C:\绝对\路径\dsh-better-output`；
4. 重启 DSH。

**验证**：重启后随便发一句话，工作区应出现 `2026-…_<短ID>/` 会话文件夹；新会话的 `projects/` 就是它的工作目录，`logs/events.txt` 里能看到 `user/message`、`assistant/message` 等行。

**卸载**：

```powershell
node scripts/uninstall.mjs            # 移除依赖、bundle 条目与链接
node scripts/uninstall.mjs --purge    # 同时删掉 $DSH_HOME/plugins 下的副本
```

已生成的归档目录不会动，需要的话自己删。

## 配置

配置写在 profile 的插件行里，全部可选：

```yaml
- id: dsh-better-output
  name: dsh-better-output
  config:
    rootDir: .
    includeReasoning: false
    includeSubagents: true
    backfill: true
    eventLog: true
    redactSecrets: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `rootDir` | `.` | 会话文件夹的父目录。`.` 表示直接放在工作区根目录；也接受 `sessions` 之类的相对路径。`..`、盘符、前导斜杠会被消掉，保证不会写出工作区。 |
| `includeReasoning` | `false` | 是否把助手的思考写进输出。默认关：思考是过程稿，不该混进「答案」。 |
| `includeSubagents` | `true` | 是否给子代理 / fork 会话单独建夹。关掉后连目录都不建。 |
| `backfill` | `true` | 首次接管会话时，用 `session.snapshotEvents()` 回填插件装载前的历史。 |
| `eventLog` | `true` | 是否写 `logs/events.txt`。会话特别长、只关心业务记录时可以关。 |
| `redactSecrets` | `true` | 对 `sk-…`、`Bearer …`、`api_key=…` 这类片段做脱敏。 |
| `maxEntryChars` | `200000` | 单条正文上限，超出截断并标注原长。 |
| `maxToolResultChars` | `8000` | 单条工具结果写入 `logs/tools.txt` 的上限。 |
| `maxLiveArchives` | `32` | 内存中同时保留的归档对象数；超出只丢引用，磁盘记录不受影响。 |

## 记录规则

### 输入与输出

- **输入**只收 `source.kind === 'user'` 的 `user/message`。DSH 会把运行时上下文、时间快照、Skill 目录也以 `user/message` 追加，这些不是用户输入，单独写进 `prompts/context-injections.txt`，避免把系统提示当成用户说的话。
- **输出**收 `assistant/message` 的 `text` 块；默认跳过 `reasoning`。工具调用参数不混进输出。
- 每轮第一次产生输出时创建 `outputs/turns/NNNN.txt`，之后边产生边追加；`turn/end` 追加结束时间与原因。这样热重载或崩溃不会丢掉已经写下的段落。

### 文件

从工具参数里提取路径，按读 / 写 / 搜分类：

| 分类 | 工具（不区分大小写） | 取哪些字段 |
| --- | --- | --- |
| 读 | `read` `read_file` `view` `open_file` `read_image` … | `file_path` `path` `filePath` `target` … |
| 写 | `write` `edit` `apply_patch` `multi_edit` `notebook_edit` … | 同上；`apply_patch` 还会从补丁头 `*** Update File:` 里提取 |
| 搜 | `glob` `grep` `find_files` `list_dir` … | `pattern` `glob` 与 `path` |

### 网页

- `web_fetch` / `fetch_url` / `browser_*`：记抓取 URL、HTTP 状态码、是否截断；
- `web_search` / `search_web`：记查询词；结果里的 `meta.sources` 记 URL + 标题；
- 两者都会在 `logs/web.txt` 里按时间排好，搜索与结果来源紧挨着。

### 工具与失败

- `prompts/tool-calls.txt`：每次调用的**指令原文**。命令行保持原样（多行也保留），其他工具展示结构化参数；
- `logs/tools.txt`：调用 + 结果摘要 + 耗时（按 `callId` 配对）；
- `logs/errors.txt`：`tool/result` 带 `error` 或 `isError` 时单独记一份，含错误码与结果片段；
- `artifacts/artifacts.txt`：`deliverables/presented` 事件里的交付物路径。

### 事件与总览

- `logs/events.txt`：每个已提交事件一行，含 `seq`、轮次、步骤与摘要，用来还原顺序；
- `session.txt`：标题、模型、工作区、统计，随 `session/title`、`request/context` 更新而重写；
- `sessions-index.txt`：工作区根目录索引，每建立一个会话夹追加一行。

## 设计要点

**为什么监听 `session/event`，而不是读 DSH 的 zstd 日志？**
`session/event` 是事件**提交后**的广播，带连续 `seq`、`time` 与结构化 `data`，不需要解析压缩格式，也不受日志格式版本影响；插件只依赖公开的 `Session` / `SessionHeader` / `SessionEvent` 契约。

**为什么每次都要写状态文件？**
会话可能被恢复、DSH 可能重启。`.dsh-better-output.json` 里存 `lastSeq`，下次接管时只补 `seq > lastSeq` 的事件，避免把整段历史重复写一遍。状态用「临时文件 + rename」写入，降低半截文件概率。

**为什么失败不影响会话？**
`session/event` 的监听器是 fire-and-forget：observer 抛错不会回滚已提交事件，但会污染日志。插件的每一次归档都包在 try/catch 里，写盘串行化到一条 Promise 链，单条失败只 `logger.warn`，后续事件继续。

**为什么每个会话一个目录，项目怎么进去？**
插件在会话第一次出现事件时建立 `<创建时间>_<短ID>/`，并在里面建 `projects/`。如果这是刚创建的新会话（5 分钟内、非 subagent），插件通过公开的 `WorkingDirectoryService.set(agent, path)` 把该会话的工作目录切到 `<会话目录>/projects`；之后模型与工具用相对路径创建的文件自然落在里面。历史会话、恢复的旧会话和子代理不切换，避免把正在运行的工作区整体搬走。服务缺失时只归档、不切换。

**为什么用 txt，而不是 JSON/Markdown？**
需求就是「打开就能看、能直接交给别人」。txt 没有渲染依赖，Windows 记事本、VS Code、`Get-Content`、`grep` 都能读；需要结构化数据时，DSH 自己的 JSONL 才是权威来源，这里不重复造一份。

## 已知限制

- **只对新会话切换工作目录**：历史会话、插件装载前已存在的会话、subagent 不自动切换；它们的项目需要手工放进会话目录的 `projects/`；
- **只记录会话里可见的事实**：图片不落盘（只写 `[图片]`），文件不复制（只记路径），网页不存正文（只记 URL / 标题 / 状态码）；
- **工具分类是启发式**：不在内置名单里的自定义工具仍会进 `tool-calls.txt` 与 `tools.txt`，但不会被识别成文件 / 网页；
- **回填有边界**：只回填当前进程里 `snapshotEvents()` 能拿到的历史。插件安装前就已关闭、且之后没被恢复的会话不会被补档；
- **热重载的轮次文件**：如果在一轮进行中热重载插件，`outputs/turns/NNNN.txt` 只会包含重载后的段落；该轮完整内容仍在 `outputs/outputs.txt` 里（只追加，不丢）。正常重启发生在两轮之间时不受影响；
- **追加而非轮转**：超长会话的 `events.txt`、`tools.txt` 会持续变大，可用 `eventLog: false` 或 `maxToolResultChars` 收敛；
- **不校验工作区权限**：Host 插件直接用 Node `fs` 写盘，不受模型工具的 workspace-write 沙箱约束；`rootDir` 已限制在工作区内；
- **多实例写入**：同一工作区同时跑两个 DSH 实例、且打开同一个会话时，两边会各自追加；正常单实例使用不受影响。

## 开发与测试

```powershell
node test/format.test.mjs     # 纯函数：时间、分类、参数提取、脱敏、截断
node test/archive.test.mjs    # 假 Session + 假 ctx：目录、txt、去重、失败、子代理
node test/plugin.test.mjs     # 入口契约：name / inject / apply / effect 收尾
```

如果所在环境禁止 `node --test` 派生子进程（Windows 沙箱下会 `spawn EPERM`），上面的「直接执行测试文件」方式会在当前进程内跑完。

**真实日志回放**（需要 Node ≥ 23.8 的内置 zstd）：

```powershell
node scripts/replay-session.mjs `
  "$env:DSH_HOME\sessions\<工作区目录>\<会话ID>\session.v4.jsonl.zstd" `
  ".\_tmp\replay-check"
```

它把已持久化的事件重新喂给插件，在输出目录生成归档副本，用来验证真实事件结构，不会碰原会话。当前版本用本机一个 600+ 事件的真实会话回放：0 警告，输入、输出、工具调用、文件访问、网页访问全部落盘；本机 desktop profile 的真实会话也已由插件持续归档。

**历史会话补档**（需要 Node ≥ 23.8）：

```powershell
node scripts/backfill-workspace.mjs "<工作区绝对路径>" [--skip <会话ID>] [--dry-run]
```

扫描 `$DSH_HOME/sessions`，读取每份日志头的 `cwd`，命中目标工作区的就交给同一个 `SessionArchive` 落盘。已经归档过的会话按 `.dsh-better-output.json` 里的 `lastSeq` 自动跳过；当前活动会话通过 `DSH_SESSION_ID` 自动排除，也可以显式 `--skip`。本机默认工作区与 `微软大战代码` 的历史会话就是用这个脚本补齐的。

## 文件结构

```
index.js                     Host 入口：name / inject / apply，订阅 session/event
src/config.js                配置合并与 rootDir 收敛
src/format.js                纯函数：时间、正文提取、工具分类、网页/文件条目
src/archive.js               单会话归档器：目录、txt、去重、总览、收尾
src/keeper.js                会话 → 归档器映射、首次回填、卸载收尾
cordis.patch.yml             bundle 插入行
scripts/install.mjs          profile 安装脚本
scripts/uninstall.mjs        profile 卸载脚本
scripts/replay-session.mjs   真实日志回放工具
scripts/backfill-workspace.mjs 历史会话批量补档
test/*.test.mjs              18 个断言组
```

## License

MIT © Chen-Zhenghao
