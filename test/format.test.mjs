import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTool,
  clip,
  describeCall,
  extractUrls,
  folderStamp,
  formatCallDetail,
  formatFileEntries,
  formatWebCall,
  formatWebSources,
  localStamp,
  redactSecrets,
  shortSessionId,
  textOfContent,
} from '../src/format.js';
import { sanitizeRootDir } from '../src/config.js';

test('时间与目录名格式稳定', () => {
  const ms = new Date('2026-11-05T15:41:53+08:00').getTime();
  const d = new Date(ms);
  const p = value => String(value).padStart(2, '0');
  const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  assert.equal(localStamp(ms), expected);
  assert.equal(folderStamp(ms), expected.replace(' ', '_').replace(/:/g, '-'));
  assert.equal(shortSessionId('session-504ef586-79c0-44be-96ec-62229a62e8e0'), '504ef586');
  assert.equal(shortSessionId('abcXYZ'), 'abcxyz');
});

test('rootDir 只能落在工作区内', () => {
  assert.equal(sanitizeRootDir('dsh-better-output'), 'dsh-better-output');
  assert.equal(sanitizeRootDir('a\\b'), 'a/b');
  assert.equal(sanitizeRootDir('/abs/path'), 'abs/path');
  assert.equal(sanitizeRootDir('../../escape'), 'escape');
  assert.equal(sanitizeRootDir('C:\\Windows'), 'C_/Windows');
  assert.equal(sanitizeRootDir('   '), '.');
  assert.equal(sanitizeRootDir('.'), '.');
  assert.equal(sanitizeRootDir('./'), '.');
  assert.equal(sanitizeRootDir('a/../b'), 'a/b');
});

test('消息正文提取跳过思考与工具调用', () => {
  const content = [
    { type: 'reasoning', text: '内部推理' },
    { type: 'text', text: '最终回答' },
    { type: 'tool-call', name: 'read', arguments: '{}' },
    { type: 'image' },
    { type: 'file', name: 'a.pdf' },
  ];
  assert.equal(textOfContent(content), '最终回答\n[图片]\n[文件: a.pdf]');
  assert.equal(textOfContent(content, { includeReasoning: true }), '[思考]\n内部推理\n最终回答\n[图片]\n[文件: a.pdf]');
  assert.equal(textOfContent(undefined), '');
  assert.equal(textOfContent('plain'), 'plain');
});

test('工具分类覆盖读写、搜索、网页与命令行', () => {
  assert.equal(classifyTool('read'), 'read');
  assert.equal(classifyTool('edit'), 'write');
  assert.equal(classifyTool('grep'), 'search');
  assert.equal(classifyTool('web_fetch'), 'web');
  assert.equal(classifyTool('web_search'), 'web');
  assert.equal(classifyTool('browser_click'), 'web');
  assert.equal(classifyTool('pwsh'), 'shell');
  assert.equal(classifyTool('skill'), 'skill');
  assert.equal(classifyTool('subagent'), 'agent');
  assert.equal(classifyTool('mystery'), 'other');
});

test('shell 调用保留命令行原文', () => {
  const desc = describeCall('pwsh', JSON.stringify({ command: 'Get-ChildItem\nWrite-Host done' }));
  assert.equal(desc.kind, 'shell');
  assert.equal(desc.command, 'Get-ChildItem\nWrite-Host done');
  assert.match(desc.label, /pwsh Get-ChildItem/);
  const detail = formatCallDetail(desc);
  assert.match(detail, /command:/);
  assert.match(detail, /  Get-ChildItem/);
  assert.doesNotMatch(detail, /\{"/);
});

test('文件调用提取路径、搜索模式与 apply_patch 目标', () => {
  const read = describeCall('read', JSON.stringify({ file_path: 'C:\\work\\a.md' }));
  assert.equal(read.kind, 'read');
  assert.deepEqual(read.paths, ['C:\\work\\a.md']);
  const lines = formatFileEntries('2026-11-05 15:00:00', read);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /读/);
  assert.match(lines[0], /a\.md/);

  const grep = describeCall('grep', JSON.stringify({ pattern: 'TODO', path: 'src' }));
  assert.equal(grep.kind, 'search');
  assert.deepEqual(grep.patterns, ['TODO']);
  assert.deepEqual(grep.paths, ['src']);

  const patch = describeCall('apply_patch', JSON.stringify({
    patch: '*** Begin Patch\n*** Update File: src/app.js\n@@\n-old\n+new\n*** End Patch',
  }));
  assert.equal(patch.kind, 'write');
  assert.deepEqual(patch.paths, ['src/app.js']);
});

test('网页调用区分抓取与搜索，来源可格式化', () => {
  const fetch = describeCall('web_fetch', JSON.stringify({ url: 'https://example.com/a' }));
  assert.deepEqual(fetch.urls, ['https://example.com/a']);
  assert.match(formatWebCall('t', fetch)[0], /抓取.*https:\/\/example\.com\/a/);

  const search = describeCall('web_search', JSON.stringify({ queries: ['one', 'two'] }));
  assert.deepEqual(search.queries, ['one', 'two']);
  const lines = formatWebCall('t', search);
  assert.match(lines.join('\n'), /查询: one/);
  assert.match(lines.join('\n'), /查询: two/);

  const sources = formatWebSources('t', [
    { url: 'https://a.example', title: 'A' },
    { url: 'https://b.example' },
    { url: '' },
  ]);
  assert.equal(sources.length, 3);
  assert.match(sources[1], /a\.example/);
  assert.match(sources[1], /A/);
});

test('URL 提取去重并清理尾部标点', () => {
  const urls = extractUrls('见 https://a.example/x), 以及 https://a.example/x 和 https://b.example/y。');
  assert.deepEqual(urls, ['https://a.example/x', 'https://b.example/y']);
});

test('敏感片段脱敏', () => {
  assert.equal(redactSecrets('key sk-abcdefghijklmnopqrstuvwx end'), 'key sk-*** end');
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets('api_key = "supersecret123"'), 'api_key = ***');
});

test('超长正文截断并标注原长', () => {
  const text = 'x'.repeat(50);
  const cut = clip(text, 10);
  assert.match(cut, /^x{10}/);
  assert.match(cut, /原长 50 字符/);
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('any', 0), 'any');
});
