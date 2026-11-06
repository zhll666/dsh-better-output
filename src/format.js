/**
 * 纯函数层：时间格式、文本提取、工具调用归一化、网页/文件条目格式化。
 *
 * 这一层不碰文件系统，也不依赖 DSH 运行时，便于单元测试；archive.js 只负责
 * 把这些字符串按事件顺序落盘。
 */

const READ_TOOLS = new Set([
  'read', 'read_file', 'read_text_file', 'view', 'open_file', 'read_image',
]);
const WRITE_TOOLS = new Set([
  'write', 'write_file', 'create_file', 'edit', 'edit_file', 'multi_edit',
  'apply_patch', 'notebook_edit', 'str_replace_editor',
]);
const SEARCH_TOOLS = new Set([
  'glob', 'grep', 'find_files', 'search_files', 'list_dir', 'ls',
]);
const FETCH_TOOLS = new Set(['web_fetch', 'fetch_url', 'fetch']);
const SEARCH_WEB_TOOLS = new Set(['web_search', 'search_web', 'web-search']);
const SHELL_TOOLS = new Set([
  'pwsh', 'powershell', 'bash', 'sh', 'shell', 'terminal', 'run_command', 'exec_command',
]);

const PATH_KEYS = ['file_path', 'filePath', 'path', 'target', 'target_path', 'notebook_path', 'absolute_path'];
const COMMAND_KEYS = ['command', 'cmd', 'script'];

const FILE_KIND_LABEL = { read: '读', write: '写', search: '搜' };

export function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss`。 */
export function localStamp(ms = Date.now()) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '????-??-?? ??:??:??';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 目录名用时间戳 `YYYY-MM-DD_HH-mm-ss`（不含冒号，Windows 友好）。 */
export function folderStamp(ms = Date.now()) {
  return localStamp(ms).replace(' ', '_').replace(/:/g, '-');
}

/** 会话 id → 8 位短标识；非十六进制 id 也能退化出稳定短名。 */
export function shortSessionId(id) {
  const raw = typeof id === 'string' && id !== '' ? id : 'session';
  const tail = raw.replace(/^session[-_]?/i, '').replace(/[^0-9a-z]/gi, '');
  const pick = tail !== '' ? tail : raw.replace(/[^0-9a-z]/gi, '') || 'session';
  return pick.slice(0, 8).toLowerCase();
}

/** 目录/文件名安全化。 */
export function safeSegment(value, fallback = 'untitled') {
  const text = typeof value === 'string' ? value : '';
  const cleaned = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  return cleaned === '' ? fallback : cleaned.slice(0, 80);
}

/** 按字符截断（不劈开代理对）。 */
export function clip(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const limit = Number.isFinite(max) && max > 0 ? Math.trunc(max) : 0;
  if (limit === 0 || value.length <= limit) return value;
  let cut = limit;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut)}\n…（已截断，原长 ${value.length} 字符）`;
}

/** 单行化，用于事件流和标题。 */
export function oneLine(text, max = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***'],
  [/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, '$1***'],
];

/** 脱敏常见密钥形态；只处理明显像凭据的片段，尽量不误伤正文。 */
export function redactSecrets(text) {
  let value = typeof text === 'string' ? text : String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

function blockText(block) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block !== 'object') return '';
  return typeof block.text === 'string' ? block.text : '';
}

function blockPlaceholder(block) {
  if (block == null || typeof block !== 'object') return '';
  switch (block.type) {
    case 'image':
      return '[图片]';
    case 'image_url':
      return '[图片]';
    case 'file':
    case 'attachment':
    case 'document': {
      const name = block.name ?? block.filename ?? block.fileName;
      return typeof name === 'string' && name !== '' ? `[文件: ${name}]` : '[文件]';
    }
    default:
      return '';
  }
}

/**
 * 提取消息正文。
 * @param {unknown} content Message.content（ContentBlock[]）。
 * @param {{ includeReasoning?: boolean }} options
 */
export function textOfContent(content, options = {}) {
  if (content == null) return '';
  const list = Array.isArray(content) ? content : [content];
  const parts = [];
  for (const block of list) {
    const type = block && typeof block === 'object' ? block.type : undefined;
    if (type === 'reasoning' || type === 'thinking') {
      if (options.includeReasoning) {
        const text = blockText(block);
        if (text.trim() !== '') parts.push(`[思考]\n${text.trim()}`);
      }
      continue;
    }
    if (type === 'tool-call' || type === 'tool_call') continue;
    const text = blockText(block);
    if (text.trim() !== '') {
      parts.push(text);
      continue;
    }
    const placeholder = blockPlaceholder(block);
    if (placeholder !== '') parts.push(placeholder);
  }
  return parts.join('\n').trim();
}

/** 工具调用的粗分类。 */
export function classifyTool(name) {
  const tool = String(name ?? '').trim().toLowerCase();
  if (tool === '') return 'other';
  if (FETCH_TOOLS.has(tool) || SEARCH_WEB_TOOLS.has(tool) || tool.startsWith('browser_')) return 'web';
  if (READ_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (SEARCH_TOOLS.has(tool)) return 'search';
  if (SHELL_TOOLS.has(tool)) return 'shell';
  if (tool === 'skill') return 'skill';
  if (tool === 'present') return 'present';
  if (tool === 'subagent' || tool === 'subagent_fork' || tool === 'workflow') return 'agent';
  return 'other';
}

/** 解析工具参数；DSH 的 tool/call.arguments 是 JSON 字符串，但也容忍对象。 */
export function parseArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
    return { __raw: text, value: parsed };
  } catch {
    return { __raw: text };
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function stringList(value) {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim());
}

function patchPaths(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const pattern = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1]?.trim();
    if (path) out.push(path);
  }
  return out;
}

/**
 * 把一次工具调用归一化成归档需要的字段。
 * @returns {{tool:string, kind:string, args:Record<string, unknown>, paths:string[],
 *   patterns:string[], urls:string[], queries:string[], command:string|undefined,
 *   label:string, summary:string}}
 */
export function describeCall(name, rawArguments) {
  const tool = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'unknown';
  const kind = classifyTool(tool);
  const args = parseArguments(rawArguments);
  const paths = [];
  const patterns = [];
  const urls = [];
  const queries = [];
  let command;

  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') paths.push(value.trim());
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim() !== '') paths.push(item.trim());
    }
  }
  for (const path of patchPaths(args.patch ?? args.input ?? args.__raw)) paths.push(path);
  for (const item of stringList(args.patterns)) patterns.push(item);
  patterns.push(...stringList(args.pattern));
  patterns.push(...stringList(args.glob));
  urls.push(...stringList(args.url), ...stringList(args.urls));
  queries.push(...stringList(args.queries), ...stringList(args.query));
  command = firstString(...COMMAND_KEYS.map(key => args[key]));
  if (command === undefined && typeof args.__raw === 'string' && kind === 'shell') command = args.__raw;

  const uniquePaths = [...new Set(paths)];
  const uniquePatterns = [...new Set(patterns)];
  const uniqueUrls = [...new Set(urls)];
  const uniqueQueries = [...new Set(queries)];

  let label = tool;
  if (kind === 'web' && uniqueUrls.length > 0) label = `${tool} ${uniqueUrls[0]}`;
  else if (kind === 'web' && uniqueQueries.length > 0) label = `${tool} ${uniqueQueries[0]}`;
  else if ((kind === 'read' || kind === 'write') && uniquePaths.length > 0) label = `${tool} ${uniquePaths[0]}`;
  else if (kind === 'search' && uniquePatterns.length > 0) label = `${tool} ${uniquePatterns[0]}`;
  else if (kind === 'shell' && command) label = `${tool} ${oneLine(command, 100)}`;
  else if (kind === 'skill') label = `skill ${firstString(args.name, args.skill) ?? ''}`.trim();

  return {
    tool,
    kind,
    args,
    paths: uniquePaths,
    patterns: uniquePatterns,
    urls: uniqueUrls,
    queries: uniqueQueries,
    command,
    label,
    summary: oneLine(label, 160),
  };
}

/** 写入「指令」文件的派生内容：shell 优先展示原始命令行，其余展示结构化参数。 */
export function formatCallDetail(desc) {
  const lines = [`tool: ${desc.tool}`];
  if (desc.kind === 'shell' && typeof desc.command === 'string') {
    lines.push('command:');
    for (const line of desc.command.split(/\r?\n/)) lines.push(`  ${line}`);
    return clip(lines.join('\n'), 6_000);
  }
  const body = desc.args && Object.keys(desc.args).length > 0
    ? JSON.stringify(desc.args, null, 2)
    : '(无参数)';
  lines.push('arguments:');
  for (const line of body.split(/\r?\n/)) lines.push(`  ${line}`);
  return clip(lines.join('\n'), 6_000);
}

/** 从任意文本里收集 http(s) 链接，去掉尾部标点并去重。 */
export function extractUrls(text, limit = 30) {
  if (typeof text !== 'string' || text === '') return [];
  const found = [];
  const seen = new Set();
  const pattern = /https?:\/\/[^\s)\]"'<>]+/g;
  for (const match of text.matchAll(pattern)) {
    let url = match[0];
    while (/[.,;:!?，。；：！？]$/.test(url)) url = url.slice(0, -1);
    if (url.length < 8 || seen.has(url)) continue;
    seen.add(url);
    found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}

/** `[时间] 读  read  path` 形式的一行文件访问记录。 */
export function formatFileEntries(time, desc) {
  const label = FILE_KIND_LABEL[desc.kind] ?? '访问';
  const heads = [];
  for (const path of desc.paths) heads.push(`[${time}] ${label}  ${desc.tool.padEnd(10)} ${path}`);
  for (const pattern of desc.patterns) heads.push(`[${time}] ${label}  ${desc.tool.padEnd(10)} pattern: ${pattern}`);
  if (heads.length === 0 && desc.kind === 'search') {
    heads.push(`[${time}] ${label}  ${desc.tool.padEnd(10)} (未提供路径/模式)`);
  }
  return heads;
}

/** web 调用发生时的一行记录。 */
export function formatWebCall(time, desc) {
  const lines = [];
  for (const url of desc.urls) lines.push(`[${time}] 抓取  ${desc.tool}  ${url}`);
  if (desc.queries.length > 0) {
    lines.push(`[${time}] 搜索  ${desc.tool}`);
    for (const query of desc.queries) lines.push(`  查询: ${query}`);
  }
  return lines;
}

/** web 结果里的来源列表（web_search 的 meta.sources）。 */
export function formatWebSources(time, sources, limit = 30) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const lines = [`  结果来源:`];
  let count = 0;
  for (const source of sources) {
    if (source == null || typeof source !== 'object') continue;
    const url = typeof source.url === 'string' ? source.url : '';
    if (url === '') continue;
    const title = typeof source.title === 'string' ? oneLine(source.title, 120) : '';
    lines.push(`    - ${url}${title !== '' ? `  ${title}` : ''}`);
    count += 1;
    if (count >= limit) break;
  }
  return count === 0 ? [] : lines;
}

/** 从任意文本里收集 http(s) 链接，去掉尾部标点并去重。 */
