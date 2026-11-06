# dsh-better-output

[![test](https://github.com/zhll666/dsh-better-output/actions/workflows/test.yml/badge.svg)](https://github.com/zhll666/dsh-better-output/actions/workflows/test.yml)

简体中文 · English

A session archive plugin for **DeepSeek Harness (DSH)**. Every session gets its own folder in the workspace, containing the session's `projects/` plus plain-text records of:

- user input and assistant output;
- tool / shell / web instructions issued while completing the task;
- files read, written, edited, or searched;
- web searches, fetched URLs, and sources;
- tool calls, failures, deliverables, and a full event timeline.

No third-party dependencies. The plugin only observes the public `session/event` stream and translates committed events into readable text.

## Layout

```text
<workspace>/
├─ sessions-index.txt
└─ 2026-11-05_15-41-53_504ef586/
   ├─ README.txt
   ├─ session.txt
   ├─ projects/                  projects produced by this session
   ├─ inputs/inputs.txt
   ├─ outputs/outputs.txt
   ├─ outputs/turns/0001.txt
   ├─ prompts/tool-calls.txt
   ├─ prompts/context-injections.txt
   ├─ prompts/skills.txt
   ├─ logs/events.txt
   ├─ logs/files.txt
   ├─ logs/web.txt
   ├─ logs/tools.txt
   ├─ logs/errors.txt
   ├─ artifacts/artifacts.txt
   └─ .dsh-better-output.json
```

For a newly created session, the plugin creates `<session>/projects/` and moves that session's working directory there through the public `WorkingDirectoryService`, so relative tool writes land inside the session folder. Historical sessions, restored sessions, and subagents are left untouched.

## Install

Requires DSH 0.2.x desktop and Node >= 22.19.

```powershell
node scripts/install.mjs
```

The installer copies the plugin to `$DSH_HOME/plugins/dsh-better-output`, adds a `link:` dependency and a bundle entry to the profile, and creates a junction in the profile's `node_modules`. Restart DSH afterwards.

Manual install and uninstall instructions are in the Chinese README.

## Configuration

All fields are optional:

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

`rootDir: .` places session folders directly in the workspace. `includeReasoning` is off by default; `redactSecrets` masks common token shapes before writing.

## Backfill existing sessions

```powershell
node scripts/backfill-workspace.mjs "<workspace>" [--skip <session-id>] [--dry-run]
```

Reads persisted DSH session logs, matches them by `cwd`, and rebuilds archives. Already-archived sessions are skipped by `lastSeq`.

## Test

```powershell
node test/format.test.mjs
node test/archive.test.mjs
node test/plugin.test.mjs
```

The test suite covers formatting, tool classification, redaction, archive layout, restart deduplication, failure records, and working-directory adoption.

## License

MIT © Chen-Zhenghao
