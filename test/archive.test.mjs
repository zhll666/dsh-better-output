import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionArchive } from '../src/archive.js';
import { normalizeConfig } from '../src/config.js';
import { ArchiveKeeper } from '../src/keeper.js';

const CREATED_AT = new Date('2026-11-05T15:41:53+08:00').getTime();
const SESSION_ID = 'session-504ef586-79c0-44be-96ec-62229a62e8e0';

function makeSession({ id = SESSION_ID, cwd, createdAt = CREATED_AT, origin } = {}) {
  const events = [];
  const session = {
    id,
    header: { id, cwd, createdAt, ...(origin ? { origin } : {}) },
    events,
    snapshotEvents() {
      return events.slice();
    },
    isOwnSeq() {
      return true;
    },
    push(event) {
      events.push(event);
      return event;
    },
  };
  return session;
}

function event(seq, type, data, timeOffset = 0) {
  return { type, seq, time: CREATED_AT + timeOffset, data };
}

function logger() {
  const warnings = [];
  return {
    warnings,
    warn(...args) {
      warnings.push(args.map(item => (item instanceof Error ? item.message : String(item))).join(' '));
    },
    info() {},
  };
}

async function firstDirectory(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const dir = entries.find(entry => entry.isDirectory());
  assert.ok(dir, `expected a session directory under ${root}`);
  return join(root, dir.name);
}

function count(haystack, needle) {
  if (needle === '') return 0;
  let total = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    total += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return total;
}

function sampleEvents() {
  return [
    event(0, 'request/context', { provider: 'deepseek', model: 'deepseek-chat' }),
    event(1, 'session/title', { title: '安装与测试' }),
    event(2, 'turn/start', { turn: 1 }),
    event(3, 'step/start', { turn: 1, step: 0 }),
    event(4, 'user/message', {
      role: 'user',
      id: 'm1',
      content: [{ type: 'text', text: '请读取 README' }],
    }),
    event(5, 'assistant/message', {
      turn: 1,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '好的，我先读文件。' }] },
    }),
    event(6, 'tool/call', {
      turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"C:\\\\work\\\\README.md"}',
    }),
    event(7, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: '# README' }],
      },
    }),
    event(8, 'tool/call', {
      turn: 1, step: 1, callId: 'call-2', name: 'web_search', arguments: '{"queries":["dsh plugin"]}',
    }),
    event(9, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool', toolCallId: 'call-2', source: { kind: 'tool', callId: 'call-2' },
        content: [{ type: 'text', text: 'Sources: [A](https://a.example)' }],
      },
      meta: { sources: [{ url: 'https://a.example', title: 'A' }] },
    }),
    event(10, 'tool/call', {
      turn: 1, step: 1, callId: 'call-3', name: 'web_fetch', arguments: '{"url":"https://b.example/page"}',
    }),
    event(11, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool', toolCallId: 'call-3', source: { kind: 'tool', callId: 'call-3' },
        content: [{ type: 'text', text: 'Fetched https://b.example/page (HTTP 200)' }],
      },
      meta: { url: 'https://b.example/page', statusCode: 200, truncated: false },
    }),
    event(12, 'deliverables/presented', { turn: 1, callId: 'call-4', files: [{ path: 'out/result.txt', description: '结果' }] }),
    event(13, 'assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '全部完成。' }] },
    }),
    event(14, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(15, 'user/message', {
      role: 'user',
      source: { kind: 'runtime-context', form: 'snapshot' },
      content: [{ type: 'text', text: 'Current runtime context. 运行时快照' }],
    }),
  ];
}

async function makeWorkspace(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-better-output-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
  return workspace;
}

test('一个会话生成完整归档目录与 txt 记录', async t => {
  const workspace = await makeWorkspace(t);
  const session = makeSession({ cwd: workspace });
  for (const item of sampleEvents()) session.push(item);

  const log = logger();
  const keeper = new ArchiveKeeper({ logger: log }, normalizeConfig({ rootDir: 'dsh-better-output' }));
  keeper.observe(session, session.events[0]);
  await keeper.flush();

  assert.deepEqual(log.warnings, []);

  const root = join(workspace, 'dsh-better-output');
  const folder = await firstDirectory(root);

  for (const relative of [
    'README.txt', 'session.txt', 'inputs/inputs.txt', 'outputs/outputs.txt',
    'outputs/turns/0001.txt', 'prompts/tool-calls.txt', 'prompts/skills.txt',
    'prompts/context-injections.txt',
    'logs/events.txt', 'logs/files.txt', 'logs/web.txt', 'logs/tools.txt',
    'logs/errors.txt', 'artifacts/artifacts.txt', '.dsh-better-output.json',
  ]) {
    const info = await stat(join(folder, ...relative.split('/')));
    assert.ok(info.isFile(), `${relative} should exist`);
  }
  assert.ok((await stat(join(folder, 'projects'))).isDirectory(), 'projects/ should exist');

  const inputs = await readFile(join(folder, 'inputs', 'inputs.txt'), 'utf8');
  assert.match(inputs, /请读取 README/);
  assert.doesNotMatch(inputs, /运行时快照/);

  const injections = await readFile(join(folder, 'prompts', 'context-injections.txt'), 'utf8');
  assert.match(injections, /runtime-context\/snapshot/);
  assert.match(injections, /运行时快照/);

  const outputs = await readFile(join(folder, 'outputs', 'outputs.txt'), 'utf8');
  assert.match(outputs, /好的，我先读文件。/);
  assert.match(outputs, /全部完成。/);
  assert.doesNotMatch(outputs, /想一下/);

  const turn = await readFile(join(folder, 'outputs', 'turns', '0001.txt'), 'utf8');
  assert.match(turn, /第 1 轮/);
  assert.match(turn, /原因: completed/);
  assert.match(turn, /全部完成。/);

  const calls = await readFile(join(folder, 'prompts', 'tool-calls.txt'), 'utf8');
  assert.match(calls, /tool: read/);
  assert.match(calls, /file_path/);
  assert.match(calls, /tool: web_fetch/);
  assert.match(calls, /https:\/\/b\.example\/page/);

  const files = await readFile(join(folder, 'logs', 'files.txt'), 'utf8');
  assert.match(files, /README\.md/);

  const web = await readFile(join(folder, 'logs', 'web.txt'), 'utf8');
  assert.match(web, /查询: dsh plugin/);
  assert.match(web, /https:\/\/a\.example/);
  assert.match(web, /HTTP 200/);

  const tools = await readFile(join(folder, 'logs', 'tools.txt'), 'utf8');
  assert.match(tools, /完成 · read/);
  assert.match(tools, /完成 · web_fetch/);

  const artifacts = await readFile(join(folder, 'artifacts', 'artifacts.txt'), 'utf8');
  assert.match(artifacts, /out\/result\.txt/);

  const overview = await readFile(join(folder, 'session.txt'), 'utf8');
  assert.match(overview, /安装与测试/);
  assert.match(overview, /deepseek\/deepseek-chat/);
  assert.match(overview, /seq 15/);

  const index = await readFile(join(root, 'sessions-index.txt'), 'utf8');
  assert.match(index, /session-504ef586/);

  const state = JSON.parse(await readFile(join(folder, '.dsh-better-output.json'), 'utf8'));
  assert.equal(state.lastSeq, 15);
  assert.equal(state.title, '安装与测试');
  assert.equal(state.counts.inputs, 1);
  assert.equal(state.counts.tools, 3);
});

test('重启后按 lastSeq 续写，不重复历史', async t => {
  const workspace = await makeWorkspace(t);
  const session = makeSession({ cwd: workspace });
  for (const item of sampleEvents()) session.push(item);

  const config = normalizeConfig({ rootDir: 'dsh-better-output' });
  const first = new ArchiveKeeper({ logger: logger() }, config);
  first.observe(session, session.events[0]);
  await first.flush();

  const next = event(16, 'user/message', {
    role: 'user', id: 'm2', content: [{ type: 'text', text: '第二条输入' }],
  });
  session.push(next);

  const second = new ArchiveKeeper({ logger: logger() }, config);
  second.observe(session, next);
  await second.flush();

  const folder = await firstDirectory(join(workspace, 'dsh-better-output'));
  const inputs = await readFile(join(folder, 'inputs', 'inputs.txt'), 'utf8');
  assert.equal(count(inputs, '请读取 README'), 1, '历史输入不应重复');
  assert.equal(count(inputs, '第二条输入'), 1);

  const outputs = await readFile(join(folder, 'outputs', 'outputs.txt'), 'utf8');
  assert.equal(count(outputs, '好的，我先读文件。'), 1, '历史输出不应重复');

  const state = JSON.parse(await readFile(join(folder, '.dsh-better-output.json'), 'utf8'));
  assert.equal(state.lastSeq, 16);
});

test('close 会收尾未结束的轮次', async t => {
  const workspace = await makeWorkspace(t);
  const session = makeSession({ cwd: workspace });
  const events = [
    event(0, 'turn/start', { turn: 7 }),
    event(1, 'assistant/message', {
      turn: 7, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '半截回答' }] },
    }),
  ];
  for (const item of events) session.push(item);

  const keeper = new ArchiveKeeper({ logger: logger() }, normalizeConfig({ rootDir: 'out' }));
  keeper.observe(session, events[0]);
  await keeper.flush();

  const folder = await firstDirectory(join(workspace, 'out'));
  const turn = await readFile(join(folder, 'outputs', 'turns', '0007.txt'), 'utf8');
  assert.match(turn, /会话关闭/);
  assert.match(turn, /半截回答/);
});

test('关闭 includeSubagents 后子代理会话不建目录', async t => {
  const workspace = await makeWorkspace(t);
  const session = makeSession({ cwd: workspace, id: 'session-subagent-1', origin: 'subagent' });
  session.push(event(0, 'user/message', { role: 'user', content: [{ type: 'text', text: '子任务' }] }));

  const keeper = new ArchiveKeeper({ logger: logger() }, normalizeConfig({ rootDir: 'out', includeSubagents: false }));
  keeper.observe(session, session.events[0]);
  await keeper.flush();

  await assert.rejects(stat(join(workspace, 'out')));
});

test('工具失败写入 errors.txt', async t => {
  const workspace = await makeWorkspace(t);
  const session = makeSession({ cwd: workspace });
  const events = [
    event(0, 'tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{"file_path":"missing.md"}' }),
    event(1, 'tool/result', {
      turn: 1,
      step: 0,
      message: { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] },
      error: { name: 'FsError', code: 'ENOENT', reason: 'missing.md' },
    }),
  ];
  for (const item of events) session.push(item);

  const keeper = new ArchiveKeeper({ logger: logger() }, normalizeConfig({ rootDir: 'out' }));
  keeper.observe(session, events[0]);
  await keeper.flush();

  const folder = await firstDirectory(join(workspace, 'out'));
  const errors = await readFile(join(folder, 'logs', 'errors.txt'), 'utf8');
  assert.match(errors, /ENOENT/);
  assert.match(errors, /missing\.md/);

  const tools = await readFile(join(folder, 'logs', 'tools.txt'), 'utf8');
  assert.match(tools, /失败 · read/);
});

test('新会话把工作目录切到 projects，旧会话不动', async t => {
  const workspace = await makeWorkspace(t);
  const calls = [];
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') {
        return {
          get: () => workspace,
          set: async (_agent, path) => { calls.push(path); return path; },
        };
      }
      if (name === 'agents') return { get: () => ({ id: 'agent-1' }) };
      return undefined;
    },
    logger: logger(),
  };

  const fresh = makeSession({ cwd: workspace, createdAt: Date.now() });
  const freshArchive = new SessionArchive(fresh, normalizeConfig({}), logger(), ctx);
  freshArchive.observe(event(0, 'user/message', { role: 'user', content: [{ type: 'text', text: '新会话' }] }));
  await freshArchive.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], join(freshArchive.path, 'projects'));

  const old = makeSession({ cwd: workspace, createdAt: Date.now() - 60 * 60 * 1000 });
  const oldArchive = new SessionArchive(old, normalizeConfig({}), logger(), ctx);
  oldArchive.observe(event(0, 'user/message', { role: 'user', content: [{ type: 'text', text: '旧会话' }] }));
  await oldArchive.close();
  assert.equal(calls.length, 1, '旧会话不应切换工作目录');
});

test('SessionArchive 可直接用于单事件路径', async t => {
  const workspace = await makeWorkspace(t);
  const session = makeSession({ cwd: workspace });
  const archive = new SessionArchive(session, normalizeConfig({ rootDir: 'out' }), logger());
  const item = event(0, 'user/message', { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  archive.observe(item);
  await archive.close();
  assert.ok(archive.path.startsWith(join(workspace, 'out')));
  const written = await readFile(join(archive.path, 'inputs', 'inputs.txt'), 'utf8');
  assert.match(written, /hello/);
});
