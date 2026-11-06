import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, inject, name } from '../index.js';

/** 模拟 cordis 上下文，只实现插件用到的 on / effect / logger。 */
function fakeContext() {
  const handlers = new Map();
  const effects = [];
  const warnings = [];
  return {
    warnings,
    handlers,
    effects,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      effect(factory) {
        effects.push(factory);
        return () => {};
      },
      logger: {
        info() {},
        warn(...args) {
          warnings.push(args.map(item => (item instanceof Error ? item.message : String(item))).join(' '));
        },
      },
    },
  };
}

test('插件入口导出契约并完整处理一个会话事件', async t => {
  assert.equal(name, 'dsh-better-output');
  assert.deepEqual(inject, ['sessions']);

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-better-output-entry-'));
  t.after(async () => { await rm(workspace, { recursive: true, force: true }); });

  const event = {
    type: 'user/message',
    seq: 0,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text: '入口测试输入' }] },
  };
  const session = {
    id: 'session-entry-test',
    header: { id: 'session-entry-test', cwd: workspace, createdAt: Date.now() },
    snapshotEvents: () => [event],
    isOwnSeq: () => true,
  };

  const { ctx, handlers, effects, warnings } = fakeContext();
  apply(ctx, { rootDir: 'out' });

  const onEvent = handlers.get('session/event');
  assert.equal(typeof onEvent, 'function', '应订阅 session/event');
  onEvent(session, event);

  assert.equal(effects.length, 1, '应注册一个卸载 effect');
  const dispose = effects[0]();
  await (typeof dispose === 'function' ? dispose() : dispose);

  assert.deepEqual(warnings, []);

  const root = join(workspace, 'out');
  const index = await readFile(join(root, 'sessions-index.txt'), 'utf8');
  assert.match(index, /session-entry-test/);

  const folders = await stat(root);
  assert.ok(folders.isDirectory());
  const entries = await readdir(root, { withFileTypes: true });
  const dir = entries.find(entry => entry.isDirectory());
  assert.ok(dir);
  const inputs = await readFile(join(root, dir.name, 'inputs', 'inputs.txt'), 'utf8');
  assert.match(inputs, /入口测试输入/);
});
