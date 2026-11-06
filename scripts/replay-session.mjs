#!/usr/bin/env node
/**
 * 离线回放：把 DSH 已持久化的 session.v4.jsonl.zstd 重新喂给插件，
 * 在指定目录生成一份归档，用来验证真实事件结构而不必重启 DSH。
 *
 * 用法：
 *   node scripts/replay-session.mjs <session.v4.jsonl.zstd> [输出目录]
 *
 * 需要 Node >= 23.8（内置 zstd）。DSH 运行时自带 Node 24。
 */
import { createZstdDecompress } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ArchiveKeeper } from '../src/keeper.js';
import { normalizeConfig } from '../src/config.js';

/** DSH 的日志是「多帧追加」的 zstd，逐帧解压后再拼接。 */
async function decompressAll(buffer) {
  const chunks = [];
  let rest = buffer;
  let frames = 0;
  while (rest.length > 0 && frames < 100_000) {
    frames += 1;
    const text = await new Promise((resolveFrame, rejectFrame) => {
      const stream = createZstdDecompress();
      const parts = [];
      stream.on('data', part => parts.push(part));
      stream.on('error', rejectFrame);
      stream.on('end', () => {
        const consumed = stream.bytesWritten;
        resolveFrame({ text: Buffer.concat(parts).toString('utf8'), consumed });
      });
      stream.end(rest);
    });
    chunks.push(text.text);
    if (!Number.isSafeInteger(text.consumed) || text.consumed <= 0) break;
    rest = rest.subarray(text.consumed);
  }
  return chunks.join('');
}

const input = process.argv[2];
if (!input) {
  console.error('用法: node scripts/replay-session.mjs <session.v4.jsonl.zstd> [输出目录]');
  process.exit(1);
}
const source = resolve(input);
const outCwd = resolve(process.argv[3] ?? join(dirname(source), 'replay-output'));

const raw = await readFile(source);
const text = await decompressAll(raw);
const lines = text.split('\n').filter(line => line.trim() !== '');
if (lines.length === 0) {
  console.error('日志为空:', source);
  process.exit(1);
}

const header = JSON.parse(lines[0]);
const events = [];
for (const line of lines.slice(1)) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed.seq === 'number') events.push(parsed);
  } catch {
    // 跳过损坏行
  }
}
header.cwd = outCwd;

const warnings = [];
const logger = {
  info() {},
  warn(...args) { warnings.push(args.map(item => (item instanceof Error ? item.message : String(item))).join(' ')); },
};

const session = {
  id: header.id,
  header,
  snapshotEvents: () => events.slice(),
  isOwnSeq: () => true,
};

const keeper = new ArchiveKeeper({ logger }, normalizeConfig({ rootDir: 'dsh-better-output' }));
if (events.length > 0) keeper.observe(session, events[0]);
await keeper.flush();

const root = join(outCwd, 'dsh-better-output');
const dirs = (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);
const folder = dirs[0] ? join(root, dirs[0]) : '(未生成)';

console.log(`会话      : ${header.id}`);
console.log(`事件      : ${events.length}`);
console.log(`归档目录  : ${folder}`);
console.log(`警告      : ${warnings.length}`);
for (const warning of warnings.slice(0, 5)) console.log(`  - ${warning}`);
console.log(`\n提示: 这是回放副本，不影响 ${basename(source)}。`);
