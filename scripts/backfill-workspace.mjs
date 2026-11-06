#!/usr/bin/env node
/**
 * 为指定工作区的历史会话补档。
 *
 * 扫描 $DSH_HOME/sessions 下的 session.v4.jsonl.zstd，读取每份日志头里的 cwd，
 * 命中目标工作区的就交给插件的 SessionArchive 重新生成 .dsh-better-output 归档。
 *
 * 已经归档过的会话由 .dsh-better-output.json 里的 lastSeq 自动跳过，不会重复；
 * 当前正在运行的会话应通过 --skip 或 DSH_SESSION_ID 排除，避免和活插件抢写。
 *
 * 用法：
 *   node scripts/backfill-workspace.mjs "<工作区绝对路径>" [--skip <会话ID>]... [--dry-run]
 *
 * 需要 Node >= 23.8（内置 zstd）。
 */
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionArchive } from '../src/archive.js';
import { normalizeConfig } from '../src/config.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipIds = new Set();
let workspaceArg;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--skip') {
    if (args[index + 1]) skipIds.add(args[index + 1]);
    index += 1;
  } else if (arg === '--dry-run') {
    // 已处理
  } else if (workspaceArg === undefined) {
    workspaceArg = arg;
  }
}
if (!workspaceArg) {
  console.error('用法: node scripts/backfill-workspace.mjs "<工作区绝对路径>" [--skip <会话ID>]... [--dry-run]');
  process.exit(1);
}

const workspace = resolve(workspaceArg);
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
if (process.env.DSH_SESSION_ID) skipIds.add(process.env.DSH_SESSION_ID);

async function decompressFrames(buffer, maxFrames = 200_000) {
  const out = [];
  let rest = buffer;
  let frames = 0;
  while (rest.length > 0 && frames < maxFrames) {
    frames += 1;
    const result = await new Promise((resolveFrame, rejectFrame) => {
      const stream = createZstdDecompress();
      const parts = [];
      stream.on('data', part => parts.push(part));
      stream.on('error', rejectFrame);
      stream.on('end', () => resolveFrame({
        text: Buffer.concat(parts).toString('utf8'),
        consumed: stream.bytesWritten,
      }));
      stream.end(rest);
    });
    out.push(result.text);
    if (!Number.isSafeInteger(result.consumed) || result.consumed <= 0) break;
    rest = rest.subarray(result.consumed);
  }
  return out.join('');
}

function firstHeader(buffer) {
  try {
    // 单个 zstd 同步解压只会返回第一帧，正好是日志头。
    const text = zstdDecompressSync(buffer).toString('utf8');
    const line = text.split('\n').find(item => item.trim() !== '');
    return line ? JSON.parse(line) : undefined;
  } catch {
    return undefined;
  }
}

async function sessionLogs() {
  const root = join(dshHome, 'sessions');
  const result = [];
  let workspaces = [];
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let sessions = [];
    try {
      sessions = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = join(dir, session.name, 'session.v4.jsonl.zstd');
      try {
        const info = await stat(file);
        if (info.size < 400) continue;
        result.push(file);
      } catch {
        /* 没有日志就跳过 */
      }
    }
  }
  return result;
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const norm = value => resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return norm(left) === norm(right);
}

const config = normalizeConfig({ rootDir: '.dsh-better-output' });
const warnings = [];
const logger = {
  info() {},
  warn(...items) {
    warnings.push(items.map(item => (item instanceof Error ? item.message : String(item))).join(' '));
  },
};

let scanned = 0;
let matched = 0;
let archived = 0;
let skipped = 0;
let failed = 0;

console.log(`工作区: ${workspace}`);
console.log(`会话目录: ${join(dshHome, 'sessions')}`);
console.log(dryRun ? '模式: dry-run\n' : '');

for (const file of await sessionLogs()) {
  scanned += 1;
  const buffer = await readFile(file);
  const header = firstHeader(buffer);
  if (!header || !samePath(header.cwd, workspace)) continue;
  matched += 1;

  const id = header.id ?? header.sessionId ?? file;
  if (skipIds.has(id)) {
    skipped += 1;
    console.log(`跳过 ${id}（当前活动会话）`);
    continue;
  }

  const text = await decompressFrames(buffer);
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const events = [];
  for (const line of lines.slice(1)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.seq === 'number') events.push(parsed);
    } catch {
      /* 容忍损坏行 */
    }
  }
  if (events.length === 0) {
    skipped += 1;
    console.log(`跳过 ${id}（无事件）`);
    continue;
  }

  const session = {
    id,
    header,
    snapshotEvents: () => events.slice(),
    isOwnSeq: () => true,
  };

  if (dryRun) {
    archived += 1;
    console.log(`会归档 ${id} · ${events.length} 事件 · 创建于 ${new Date(header.createdAt).toLocaleString()}`);
    continue;
  }

  try {
    const archive = new SessionArchive(session, config, logger);
    archive.observeSnapshot(events);
    await archive.close();
    archived += 1;
    console.log(`归档 ${id} · ${events.length} 事件 → ${archive.path}`);
  } catch (error) {
    failed += 1;
    console.error(`失败 ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('');
console.log(`扫描 ${scanned} 份日志，匹配 ${matched} 份，归档 ${archived} 份，跳过 ${skipped} 份，失败 ${failed} 份。`);
if (warnings.length > 0) {
  console.log(`警告 ${warnings.length} 条：`);
  for (const warning of warnings.slice(0, 10)) console.log(`  - ${warning}`);
}
