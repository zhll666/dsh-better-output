/**
 * 单个会话的磁盘归档。
 *
 * 目录布局（rootDir 默认 `.`，即工作区根目录）：
 *
 *   <workspace>/
 *     sessions-index.txt                   所有会话的索引
 *     <创建时间>_<会话短ID>/                每个会话一个文件夹
 *       README.txt                         本目录说明
 *       session.txt                        会话总览（可重写）
 *       projects/                          本会话产出的项目（新会话会切换到此目录）
 *       inputs/inputs.txt                  用户输入
 *       outputs/outputs.txt                助手输出（汇总）
 *       outputs/turns/0001.txt             按轮输出
 *       prompts/tool-calls.txt             完成任务时下发的工具指令
 *       prompts/skills.txt                 加载过的 Skill
 *       logs/events.txt                    事件流水
 *       logs/files.txt                     调用的文件
 *       logs/web.txt                       浏览的网页
 *       logs/tools.txt                     工具调用与结果
 *       logs/errors.txt                    失败记录
 *       artifacts/artifacts.txt            交付物清单
 *       .dsh-better-output.json            去重/断点状态
 *
 * 所有写入都串行化到一条 Promise 链上：DSH 的 session/event 是 fire-and-forget，
 * 顺序由插件自己保证；任何一次写盘失败只记日志，不向宿主抛错。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  clip,
  describeCall,
  extractUrls,
  folderStamp,
  formatCallDetail,
  formatFileEntries,
  formatWebCall,
  formatWebSources,
  localStamp,
  oneLine,
  redactSecrets,
  shortSessionId,
  textOfContent,
} from './format.js';

export const LAYOUT = Object.freeze({
  index: 'sessions-index.txt',
  readme: 'README.txt',
  overview: 'session.txt',
  projects: 'projects',
  inputs: 'inputs/inputs.txt',
  contextInjections: 'prompts/context-injections.txt',
  outputs: 'outputs/outputs.txt',
  turns: 'outputs/turns',
  toolCalls: 'prompts/tool-calls.txt',
  skills: 'prompts/skills.txt',
  events: 'logs/events.txt',
  files: 'logs/files.txt',
  web: 'logs/web.txt',
  tools: 'logs/tools.txt',
  errors: 'logs/errors.txt',
  artifacts: 'artifacts/artifacts.txt',
  state: '.dsh-better-output.json',
});

const DIRECTORIES = ['inputs', 'outputs', 'outputs/turns', 'prompts', 'logs', 'artifacts', 'projects'];

/** 会话文件夹命名：`2026-11-06_10-01-54_504ef586`。 */
const SESSION_DIR_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{8}$/;

/**
 * 如果 DSH 恢复会话时把 cwd 设成了 `<会话>/projects`（或 `<会话>`），
 * 反推出真正的窗口根目录，避免在建目录时套娃。
 */
export function workspaceRootOf(cwd) {
  const parent = dirname(cwd);
  if (basename(cwd).toLowerCase() === 'projects' && SESSION_DIR_RE.test(basename(parent))) {
    return dirname(parent);
  }
  if (SESSION_DIR_RE.test(basename(cwd))) return parent;
  return cwd;
}

const STATE_VERSION = 1;
const MAX_PENDING_TOOLS = 500;

function isDirectoryKind(kind) {
  return kind === 'read' || kind === 'write' || kind === 'search';
}

function indent(text, prefix = '    ') {
  return String(text)
    .split(/\r?\n/)
    .map(line => (line === '' ? line : `${prefix}${line}`))
    .join('\n');
}

/** 单会话归档器。构造本身不碰磁盘，第一次事件（或快照回填）时才建目录。 */
export class SessionArchive {
  /**
   * @param {object} session DSH Session（至少含 id / header / snapshotEvents）。
   * @param {ReturnType<import('./config.js').normalizeConfig>} config
   * @param {{ warn?: Function }} [logger]
   * @param {object} [ctx] cordis 上下文，用于给新会话切换工作目录。
   */
  constructor(session, config, logger, ctx) {
    const header = session && typeof session === 'object' && session.header ? session.header : {};
    this.session = session;
    this.config = config;
    this.logger = logger;
    this.ctx = ctx;
    this.sessionId = String(session?.id ?? header.id ?? 'session-unknown');
    const rawCwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : process.cwd();
    this.cwd = workspaceRootOf(rawCwd);
    this.createdAt = Number.isFinite(header.createdAt) ? header.createdAt : Date.now();
    this.origin = typeof header.origin === 'string' ? header.origin : '';
    this.parentSession = typeof header.parentSession === 'string' ? header.parentSession : '';
    this.depth = Number.isFinite(header.delegationDepth) ? header.delegationDepth : undefined;

    const segments = config.rootDir === '.' ? [] : config.rootDir.split('/').filter(Boolean);
    this.root = segments.length === 0 ? this.cwd : join(this.cwd, ...segments);
    this.folderName = `${folderStamp(this.createdAt)}_${shortSessionId(this.sessionId)}`;
    this.folder = join(this.root, this.folderName);
    this.projectsDir = join(this.folder, LAYOUT.projects);

    this.isNew = false;
    this.adopted = false;
    this.adoptAttempts = 0;

    this.state = {
      version: STATE_VERSION,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      lastSeq: -1,
      title: '',
      provider: '',
      model: '',
      updatedAt: 0,
    };
    /** 只用于总览展示；随状态文件一起持久化，重启后仍然准确。 */
    this.counts = { inputs: 0, outputs: 0, tools: 0, files: 0, web: 0 };

    this.chain = Promise.resolve();
    this.ready = null;
    this.disposed = false;
    this.turn = null;
    this.step = null;
    /** 已经开始写盘、尚未收尾的轮次；用于关闭时补结束标记。 */
    this.turnFiles = new Set();
    this.turnStart = new Map();
    this.pendingTools = new Map();
  }

  get path() {
    return this.folder;
  }

  /** 塞入一个已提交事件；内部串行处理。 */
  observe(event) {
    if (this.disposed) return this.chain;
    return this.#enqueue(() => this.#ingest([event]));
  }

  /** 首次接管会话时回填历史事件（插件装载前已经发生的内容）。 */
  observeSnapshot(events) {
    if (this.disposed || !Array.isArray(events) || events.length === 0) return this.chain;
    return this.#enqueue(() => this.#ingest(events));
  }

  /** 等待队列排空、写完断点状态并收尾未结束的轮次。 */
  close() {
    if (this.disposed) return this.chain;
    this.disposed = true;
    return this.#enqueue(async () => {
      await this.#ensure();
      await this.#flushOpenTurns('会话关闭');
      await this.#saveState();
    });
  }

  #enqueue(task) {
    this.chain = this.chain.then(task).catch(error => {
      this.#warn('archive write failed', error);
    });
    return this.chain;
  }

  #warn(message, error) {
    try {
      this.logger?.warn?.(`dsh-better-output: ${message} (${this.sessionId})`, error);
    } catch {
      /* 日志失败也不能影响归档 */
    }
  }

  #ensure() {
    if (this.ready === null) {
      this.ready = this.#setup().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async #setup() {
    for (const dir of DIRECTORIES) await mkdir(join(this.folder, ...dir.split('/')), { recursive: true });
    await mkdir(this.root, { recursive: true });

    let fresh = true;
    try {
      const raw = await readFile(join(this.folder, LAYOUT.state), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        fresh = false;
        this.state = {
          ...this.state,
          lastSeq: Number.isSafeInteger(parsed.lastSeq) && parsed.lastSeq >= -1 ? parsed.lastSeq : -1,
          title: typeof parsed.title === 'string' ? parsed.title : '',
          provider: typeof parsed.provider === 'string' ? parsed.provider : '',
          model: typeof parsed.model === 'string' ? parsed.model : '',
          updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
        };
        const counts = parsed.counts;
        if (counts && typeof counts === 'object') {
          for (const key of ['inputs', 'outputs', 'tools', 'files', 'web']) {
            if (Number.isSafeInteger(counts[key]) && counts[key] >= 0) this.counts[key] = counts[key];
          }
        }
      }
    } catch {
      // 新会话（或状态文件被删）：重新写说明与表头，历史 txt 保留。
    }

    await this.#writeIfMissing(LAYOUT.readme, this.#readmeText());
    await this.#writeIfMissing(LAYOUT.inputs, this.#banner('用户输入', '每次用户发送的消息，按时间顺序追加。'));
    await this.#writeIfMissing(LAYOUT.contextInjections, this.#banner('上下文注入', 'DSH 注入的运行时上下文、时间快照、Skill 目录等，不是用户输入。'));
    await this.#writeIfMissing(LAYOUT.outputs, this.#banner('助手输出', '助手每次产出的正文（不含工具调用参数）。'));
    await this.#writeIfMissing(LAYOUT.toolCalls, this.#banner('工具指令', '完成任务时下发给工具/命令行/网页的指令原文。'));
    await this.#writeIfMissing(LAYOUT.skills, this.#banner('Skill 调用', '模型加载过的 Skill。'));
    await this.#writeIfMissing(LAYOUT.files, this.#banner('文件访问', '读、写、编辑、搜索过的文件与目录。'));
    await this.#writeIfMissing(LAYOUT.web, this.#banner('网页访问', '搜索查询、抓取地址与结果来源。'));
    await this.#writeIfMissing(LAYOUT.tools, this.#banner('工具调用', '工具调用 + 结果摘要 + 耗时。'));
    await this.#writeIfMissing(LAYOUT.errors, this.#banner('失败记录', '工具失败、中断等异常。'));
    await this.#writeIfMissing(LAYOUT.artifacts, this.#banner('交付物', '通过 present 交付或标记为产物的文件。'));
    if (this.config.eventLog) {
      await this.#writeIfMissing(LAYOUT.events, this.#banner('事件流水', '会话事件的时间线摘要，用于还原顺序。'));
    }
    await this.#writeRootIndexIfMissing();
    await this.#writeOverview();
    if (fresh) await this.#appendIndex();
    this.isNew = fresh;
    this.state.updatedAt = Date.now();
    // 新会话：把工作目录切到本会话的 projects/，后续工具产物自然落在这里。
    if (fresh) await this.#maybeAdoptWorkingDirectory();
  }

  /**
   * 只对「插件看着创建」的新会话切换 cwd：
   * - 不碰历史会话，避免恢复旧会话时把它整体搬家；
   * - 不碰 subagent，子任务通常要继续操作父会话的文件；
   * - 只用公开的 WorkingDirectoryService + AgentRegistry，服务缺失就安静跳过。
   */
  async #maybeAdoptWorkingDirectory() {
    if (!this.isNew || this.adopted || this.adoptAttempts >= 3) return;
    if (this.origin === 'subagent') return;
    // 只接管刚创建的会话（例如 5 分钟内），避免把正在运行的旧会话切走。
    if (Date.now() - this.createdAt > 5 * 60 * 1000) return;
    this.adoptAttempts += 1;
    try {
      const workingDirectory = this.ctx?.get?.('workingDirectory');
      const agents = this.ctx?.get?.('agents');
      const agent = typeof agents?.get === 'function' ? agents.get(this.sessionId) : undefined;
      if (workingDirectory == null || typeof workingDirectory.set !== 'function' || agent == null) return;
      if (typeof workingDirectory.get === 'function') {
        const current = workingDirectory.get(this.session);
        if (typeof current === 'string' && current.toLowerCase() === this.projectsDir.toLowerCase()) {
          this.adopted = true;
          return;
        }
      }
      await mkdir(this.projectsDir, { recursive: true });
      await workingDirectory.set(agent, this.projectsDir);
      this.adopted = true;
    } catch (error) {
      this.#warn('working directory adoption failed', error);
    }
  }

  #banner(title, description) {
    return [
      `# dsh-better-output · ${title}`,
      `# 会话: ${this.sessionId}`,
      `# 工作区: ${this.cwd}`,
      `# 说明: ${description}`,
      `# 本文件由插件自动维护；可安全删除，下一次事件会重新建立。`,
      '# ' + '-'.repeat(70),
      '',
    ].join('\n');
  }

  #indexHeader() {
    return [
      '# dsh-better-output · 会话索引',
      `# 工作区: ${this.cwd}`,
      '# 每次新建会话归档时追加一行。',
      '# ' + '-'.repeat(70),
      '',
    ].join('\n');
  }

  #readmeText() {
    return [
      'dsh-better-output · 会话归档',
      '='.repeat(64),
      '',
      `会话 ID : ${this.sessionId}`,
      `工作区  : ${this.cwd}`,
      `会话目录: ${this.folder}`,
      `创建时间: ${localStamp(this.createdAt)}`,
      '',
      '这个文件夹由 DSH 插件 dsh-better-output 自动建立和维护。一个会话一个',
      '文件夹，本会话产出的项目放在 projects/，会话记录放在其余子目录。',
      '',
      '目录说明',
      '  projects/              本会话产出的项目（新会话的工作目录）',
      '  session.txt            会话总览：模型、标题、目录说明、统计',
      '  inputs/inputs.txt      用户输入（按时间追加）',
      '  outputs/outputs.txt    助手输出汇总',
      '  outputs/turns/*.txt    按轮拆分的完整输出',
      '  prompts/tool-calls.txt 完成任务时下发的工具指令原文',
      '  prompts/skills.txt     加载过的 Skill',
      '  logs/events.txt        事件流水（时间线摘要）',
      '  logs/files.txt         调用的文件：读 / 写 / 搜索',
      '  logs/web.txt           浏览的网页：搜索词、抓取地址、结果来源',
      '  logs/tools.txt         工具调用 + 结果 + 耗时',
      '  logs/errors.txt        失败与异常',
      '  artifacts/artifacts.txt 交付物清单',
      '  .dsh-better-output.json 断点状态（用于重启续写、避免重复）',
      '',
      '约定',
      '  - 全部为纯文本 UTF-8，可直接用记事本 / VS Code 打开；',
      '  - 只追加，不改写历史；只有 session.txt 会随标题/模型更新而重写；',
      '  - 插件失败不会中断会话；删除本目录也不影响会话本身。',
      '',
      '='.repeat(64),
      '',
    ].join('\n');
  }

  async #writeIfMissing(relativePath, content) {
    const target = join(this.folder, ...relativePath.split('/'));
    try {
      await readFile(target, 'utf8');
      return false;
    } catch {
      await writeFile(target, content, 'utf8');
      return true;
    }
  }

  async #append(relativePath, text) {
    await this.#appendWith(relativePath, text, true);
  }

  async #appendLine(relativePath, text) {
    await this.#appendWith(relativePath, text, false);
  }

  async #appendWith(relativePath, text, blankLine) {
    if (typeof text !== 'string' || text === '') return;
    const target = join(this.folder, ...relativePath.split('/'));
    let payload = text.endsWith('\n') ? text : `${text}\n`;
    if (blankLine && !payload.endsWith('\n\n')) payload += '\n';
    await appendFile(target, this.config.redactSecrets ? redactSecrets(payload) : payload, 'utf8');
  }

  async #write(relativePath, text) {
    const target = join(this.folder, ...relativePath.split('/'));
    await writeFile(target, text, 'utf8');
  }

  async #writeRootIndexIfMissing() {
    const target = join(this.root, LAYOUT.index);
    try {
      await readFile(target, 'utf8');
    } catch {
      await writeFile(target, this.#indexHeader(), 'utf8');
    }
  }

  async #appendIndex() {
    const line = `[${localStamp(this.createdAt)}] ${this.sessionId}`
      + `${this.origin === 'subagent' ? ` · subagent(depth=${this.depth ?? '?'})` : ''}`
      + ` · ${this.folderName}\n`;
    await appendFile(join(this.root, LAYOUT.index), line, 'utf8');
  }

  #overviewText() {
    const created = localStamp(this.createdAt);
    const title = this.state.title !== '' ? this.state.title : '(未命名)';
    const model = [this.state.provider, this.state.model].filter(Boolean).join('/') || '(未知)';
    const last = this.state.lastSeq >= 0 ? `seq ${this.state.lastSeq}` : '(尚无事件)';
    return [
      '='.repeat(64),
      ' dsh-better-output · 会话归档',
      '='.repeat(64),
      `会话 ID    : ${this.sessionId}`,
      `会话标题   : ${title}`,
      `工作区     : ${this.cwd}`,
      `创建时间   : ${created}`,
      `最后记录   : ${this.state.updatedAt ? localStamp(this.state.updatedAt) : '(尚无)'} · ${last}`,
      `模型       : ${model}`,
      ...(this.origin === 'subagent'
        ? [`子代理来源 : ${this.parentSession || '(未知父会话)'} · depth ${this.depth ?? '?'}`]
        : []),
      '='.repeat(64),
      '',
      '目录结构',
      '  projects/   本会话产出的项目（新会话的工作目录）',
      '  inputs/     用户输入',
      '  outputs/    助手输出（turns/ 按轮拆分）',
      '  prompts/    完成任务时下发的指令与 Skill',
      '  logs/       事件、文件、网页、工具、错误',
      '  artifacts/  交付物清单',
      '',
      '统计',
      `  用户输入条数 : ${this.counts.inputs ?? 0}`,
      `  助手输出段数 : ${this.counts.outputs ?? 0}`,
      `  工具调用次数 : ${this.counts.tools ?? 0}`,
      `  文件访问次数 : ${this.counts.files ?? 0}`,
      `  网页访问次数 : ${this.counts.web ?? 0}`,
      '',
      '='.repeat(64),
      '本目录由 dsh-better-output 自动维护；删除不会影响会话本身。',
      '='.repeat(64),
      '',
    ].join('\n');
  }

  async #writeOverview() {
    await this.#write(LAYOUT.overview, this.#overviewText());
  }

  async #saveState() {
    const payload = JSON.stringify({
      version: STATE_VERSION,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      lastSeq: this.state.lastSeq,
      title: this.state.title,
      provider: this.state.provider,
      model: this.state.model,
      counts: this.counts,
      updatedAt: Date.now(),
    }, null, 2);
    const target = join(this.folder, LAYOUT.state);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, target);
  }

  async #ingest(events) {
    await this.#ensure();
    const list = events
      .filter(event => event && typeof event.seq === 'number' && Number.isFinite(event.seq))
      .sort((left, right) => left.seq - right.seq);
    let changed = false;
    for (const event of list) {
      try {
        if (await this.#apply(event)) changed = true;
      } catch (error) {
        this.#warn(`failed on ${event?.type ?? 'event'} #${event?.seq ?? '?'}`, error);
      }
    }
    if (changed) {
      this.state.updatedAt = Date.now();
      await this.#writeOverview();
      await this.#saveState();
    }
  }

  #isOwn(event) {
    if (typeof this.session?.isOwnSeq !== 'function') return true;
    try {
      return this.session.isOwnSeq(event.seq) !== false;
    } catch {
      return true;
    }
  }

  async #apply(event) {
    if (!this.#isOwn(event)) return false;
    if (event.seq <= this.state.lastSeq) return false;

    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const time = Number.isFinite(event.time) ? event.time : Date.now();
    const stamp = localStamp(time);
    const turn = Number.isFinite(data.turn) ? data.turn : this.turn;
    const step = Number.isFinite(data.step) ? data.step : this.step;

    if (event.type === 'turn/start') {
      this.turn = Number.isFinite(data.turn) ? data.turn : this.turn;
      this.step = null;
      if (Number.isFinite(this.turn)) this.turnStart.set(this.turn, time);
    } else if (event.type === 'step/start') {
      this.turn = Number.isFinite(data.turn) ? data.turn : this.turn;
      this.step = Number.isFinite(data.step) ? data.step : this.step;
    }

    if (event.type === 'turn/start' || event.type === 'user/message') {
      // 服务可能比首个事件晚就绪；在真正开始干活前再试一次。
      await this.#maybeAdoptWorkingDirectory();
    }

    if (this.config.eventLog) {
      const { type, detail } = summarizeEventForLog(event, this.config.includeReasoning);
      await this.#appendLine(
        LAYOUT.events,
        `[${stamp}] seq=${event.seq}`
        + `${Number.isFinite(turn) ? ` turn=${turn}` : ''}`
        + `${Number.isFinite(step) ? ` step=${step}` : ''}`
        + ` ${type}${detail !== '' ? ` · ${detail}` : ''}`,
      );
    }

    switch (event.type) {
      case 'user/message':
        await this.#onUserMessage(event, data, stamp, turn, step);
        break;
      case 'assistant/message':
        await this.#onAssistantMessage(event, data, stamp, turn, step);
        break;
      case 'tool/call':
        await this.#onToolCall(event, data, stamp, turn, step, time);
        break;
      case 'tool/result':
        await this.#onToolResult(event, data, stamp, turn, step, time);
        break;
      case 'turn/end':
        await this.#onTurnEnd(event, data, stamp, time);
        break;
      case 'request/context':
        await this.#onModel(data);
        break;
      case 'session/title':
        await this.#onTitle(data);
        break;
      case 'deliverables/presented':
        await this.#onPresented(data, stamp);
        break;
      default:
        break;
    }

    this.state.lastSeq = event.seq;
    return true;
  }

  async #onUserMessage(event, data, stamp, turn, step) {
    const message = data.message && typeof data.message === 'object' ? data.message : data;
    const text = textOfContent(message?.content, { includeReasoning: false });
    if (text === '') return;

    // DSH 会把运行时上下文、时间快照、Skill 目录也以 user/message 追加；
    // 它们不是用户输入，单独放进 prompts/context-injections.txt。
    const sourceKind = typeof data.source?.kind === 'string' ? data.source.kind : '';
    if (sourceKind !== '' && sourceKind !== 'user') {
      const form = typeof data.source?.form === 'string' ? `/${data.source.form}` : '';
      await this.#append(LAYOUT.contextInjections, [
        `[${stamp}] seq=${event.seq} · ${sourceKind}${form}`,
        '-'.repeat(56),
        clip(text, this.config.maxEntryChars),
        '',
      ].join('\n'));
      return;
    }

    const body = [
      `[${stamp}] seq=${event.seq}`
      + `${Number.isFinite(turn) ? ` · 第 ${turn} 轮` : ''}`
      + `${Number.isFinite(step) ? ` · 第 ${step} 步` : ''}`,
      '-'.repeat(56),
      text,
      '',
    ].join('\n');
    await this.#append(LAYOUT.inputs, body);
    this.counts.inputs = (this.counts.inputs ?? 0) + 1;
  }

  async #onAssistantMessage(event, data, stamp, turn, step) {
    const message = data.message && typeof data.message === 'object' ? data.message : data;
    const text = textOfContent(message?.content, { includeReasoning: this.config.includeReasoning });
    if (text === '') return;
    const clipped = clip(text, this.config.maxEntryChars);
    const header = `[${stamp}] seq=${event.seq}`
      + `${Number.isFinite(turn) ? ` · 第 ${turn} 轮` : ''}`
      + `${Number.isFinite(step) ? ` · 第 ${step} 步` : ''}`
      + `${data.interrupted === true ? ' · 被中断' : ''}`;
    await this.#append(LAYOUT.outputs, [header, '-'.repeat(56), clipped, ''].join('\n'));
    this.counts.outputs = (this.counts.outputs ?? 0) + 1;
    if (Number.isFinite(turn)) {
      if (!this.turnStart.has(turn)) {
        this.turnStart.set(turn, Number.isFinite(event.time) ? event.time : Date.now());
      }
      // 逐段追加到本轮文件：热重载/崩溃后不会丢掉之前的段落。
      await this.#appendTurnChunk(turn, stamp, clipped, event.time);
    }
  }

  async #onToolCall(event, data, stamp, turn, step, time) {
    const desc = describeCall(data.name, data.arguments);
    const callId = typeof data.callId === 'string' ? data.callId : '';
    this.counts.tools = (this.counts.tools ?? 0) + 1;

    const header = `[${stamp}] seq=${event.seq}`
      + `${Number.isFinite(turn) ? ` · 第 ${turn} 轮` : ''}`
      + `${Number.isFinite(step) ? ` · 第 ${step} 步` : ''}`
      + ` · ${desc.tool}${callId !== '' ? ` · ${callId}` : ''}`;
    await this.#append(LAYOUT.toolCalls, [header, formatCallDetail(desc), ''].join('\n'));

    if (isDirectoryKind(desc.kind)) {
      const lines = formatFileEntries(stamp, desc);
      if (lines.length > 0) {
        await this.#append(LAYOUT.files, `${lines.join('\n')}\n\n`);
        this.counts.files = (this.counts.files ?? 0) + lines.length;
      }
    }

    if (desc.kind === 'web') {
      const lines = formatWebCall(stamp, desc);
      if (lines.length > 0) {
        await this.#append(LAYOUT.web, `${lines.join('\n')}\n\n`);
        this.counts.web = (this.counts.web ?? 0) + 1;
      }
    }

    if (desc.kind === 'skill') {
      const name = typeof desc.args.name === 'string' ? desc.args.name : '(未命名)';
      await this.#append(LAYOUT.skills, `[${stamp}] seq=${event.seq} · ${name}\n`);
    }

    if (callId !== '') {
      this.pendingTools.set(callId, { desc, time, turn, step, seq: event.seq });
      while (this.pendingTools.size > MAX_PENDING_TOOLS) {
        const oldest = this.pendingTools.keys().next().value;
        this.pendingTools.delete(oldest);
      }
    }
  }

  async #onToolResult(event, data, stamp, turn, step, time) {
    const message = data.message && typeof data.message === 'object' ? data.message : {};
    const callId = typeof message.toolCallId === 'string'
      ? message.toolCallId
      : typeof message.source?.callId === 'string'
        ? message.source.callId
        : '';
    const pending = callId !== '' ? this.pendingTools.get(callId) : undefined;
    if (callId !== '') this.pendingTools.delete(callId);

    const toolName = pending?.desc.tool ?? 'tool';
    const failed = data.error != null || message.isError === true;
    const resultText = textOfContent(message.content, { includeReasoning: false });
    const clippedResult = clip(resultText, this.config.maxToolResultChars);
    const started = pending?.time;
    const duration = Number.isFinite(started) && Number.isFinite(time) ? Math.max(0, time - started) : undefined;
    const durationText = duration === undefined ? '' : duration < 1000 ? ` · ${duration}ms` : ` · ${(duration / 1000).toFixed(1)}s`;

    const block = [
      `[${stamp}] seq=${event.seq}`
      + `${Number.isFinite(turn) ? ` · 第 ${turn} 轮` : ''}`
      + `${Number.isFinite(step) ? ` · 第 ${step} 步` : ''}`
      + ` · ${failed ? '失败' : '完成'} · ${toolName}${durationText}`,
      `  指令: ${pending?.desc.label ?? '(未匹配到 call，可能来自其他会话)'}`,
      '  结果:',
      clippedResult === '' ? '    (空)' : indent(clippedResult),
      '',
    ].join('\n');
    await this.#append(LAYOUT.tools, block);

    if (pending?.desc.kind === 'web') {
      const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
      const sources = Array.isArray(meta.sources) ? meta.sources : [];
      const lines = formatWebSources(stamp, sources);
      if (lines.length > 0) await this.#append(LAYOUT.web, `${lines.join('\n')}\n\n`);
      if (typeof meta.url === 'string' && meta.url !== '') {
        const status = Number.isFinite(meta.statusCode) ? ` HTTP ${meta.statusCode}` : '';
        const truncated = meta.truncated === true ? ' (截断)' : '';
        await this.#append(LAYOUT.web, `[${stamp}] 结果  ${meta.url}${status}${truncated}\n\n`);
      } else if (pending?.desc.urls.length === 0) {
        // 自定义 web 工具可能不返回 meta.url，从结果文本兜底提取链接。
        const discovered = extractUrls(clippedResult, 10);
        if (discovered.length > 0) {
          await this.#append(LAYOUT.web, `${discovered.map(url => `[${stamp}] 结果  ${url}`).join('\n')}\n\n`);
        }
      }
    }

    if (failed) {
      const error = data.error && typeof data.error === 'object' ? data.error : {};
      const detail = [
        `[${stamp}] seq=${event.seq} · ${toolName}${Number.isFinite(turn) ? ` · 第 ${turn} 轮` : ''}`,
        `  错误: ${[error.code, error.name, error.reason].filter(Boolean).join(' · ') || '(未知错误)'}`,
        clippedResult === '' ? '  结果: (空)' : `  结果:\n${indent(clippedResult)}`,
        '',
      ].join('\n');
      await this.#append(LAYOUT.errors, detail);
    }
  }

  #turnFileName(turn) {
    return `outputs/turns/${String(turn).padStart(4, '0')}.txt`;
  }

  async #appendTurnChunk(turn, stamp, text, time) {
    const name = this.#turnFileName(turn);
    const target = join(this.folder, ...name.split('/'));
    if (!this.turnFiles.has(turn)) {
      let exists = false;
      try {
        await readFile(target, 'utf8');
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        const start = this.turnStart.get(turn) ?? (Number.isFinite(time) ? time : Date.now());
        await this.#write(name, [
          `# 第 ${turn} 轮`,
          `# 开始: ${localStamp(start)}`,
          `# 会话: ${this.sessionId}`,
          '-'.repeat(64),
          '',
        ].join('\n'));
      }
      this.turnFiles.add(turn);
    }
    await appendFile(target, `${text}\n\n`, 'utf8');
  }

  async #finishTurn(turn, stamp, reason) {
    if (!this.turnFiles.has(turn)) return;
    const target = join(this.folder, ...this.#turnFileName(turn).split('/'));
    await appendFile(target, [
      '',
      `# ${'-'.repeat(63)}`,
      `# 结束: ${stamp}`,
      `# 原因: ${reason}`,
      '',
    ].join('\n'), 'utf8');
    this.turnFiles.delete(turn);
    this.turnStart.delete(turn);
  }

  async #onTurnEnd(event, data, stamp, time) {
    const turn = Number.isFinite(data.turn) ? data.turn : this.turn;
    const reason = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown';
    if (Number.isFinite(turn)) await this.#finishTurn(turn, stamp, reason);
    if (Number.isFinite(turn) && this.turn === turn) {
      this.turn = null;
      this.step = null;
    }
  }

  async #onModel(data) {
    const provider = typeof data.provider === 'string' ? data.provider : '';
    const model = typeof data.model === 'string' ? data.model : '';
    if (provider === '' && model === '') return;
    if (this.state.provider === provider && this.state.model === model) return;
    this.state.provider = provider;
    this.state.model = model;
  }

  async #onTitle(data) {
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (title === '' || title === this.state.title) return;
    this.state.title = title;
    await this.#appendIndexNote(title);
  }

  async #appendIndexNote(title) {
    try {
      const target = join(this.root, LAYOUT.index);
      await appendFile(target, `    标题: ${oneLine(title, 120)}\n`, 'utf8');
    } catch {
      /* 索引只是便利，失败无所谓 */
    }
  }

  async #onPresented(data, stamp) {
    const files = Array.isArray(data.files) ? data.files : [];
    if (files.length === 0) return;
    const lines = [`[${stamp}] 交付物 ${files.length} 个`];
    for (const file of files) {
      if (typeof file === 'string') {
        lines.push(`  - ${file}`);
        continue;
      }
      if (file == null || typeof file !== 'object') continue;
      const path = file.path ?? file.filePath ?? file.name;
      if (typeof path !== 'string' || path === '') continue;
      const description = typeof file.description === 'string' ? oneLine(file.description, 100) : '';
      lines.push(`  - ${path}${description !== '' ? `  ${description}` : ''}`);
    }
    if (lines.length > 1) await this.#append(LAYOUT.artifacts, `${lines.join('\n')}\n\n`);
  }

  async #flushOpenTurns(reason) {
    for (const turn of [...this.turnFiles]) {
      try {
        await this.#finishTurn(turn, localStamp(Date.now()), reason);
      } catch (error) {
        this.#warn(`flushing turn ${turn} failed`, error);
      }
    }
    await this.#writeOverview();
  }
}

/** 事件流摘要单独导出，format.js 不引用 archive 的目录常量。 */
function summarizeEventForLog(event, includeReasoning) {
  const type = typeof event?.type === 'string' ? event.type : 'unknown';
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  switch (type) {
    case 'user/message':
      return { type, detail: `输入 ${textOfContent(data.content, { includeReasoning }).length} 字符` };
    case 'assistant/message': {
      const text = textOfContent(data.message?.content ?? data.content, { includeReasoning });
      return { type, detail: `输出 ${text.length} 字符` };
    }
    case 'tool/call':
      return { type, detail: `${data.name ?? '?'} ${oneLine(data.arguments ?? '', 100)}` };
    case 'tool/result':
      return { type, detail: data.error ? `失败: ${data.error.code ?? data.error.name ?? 'error'}` : '完成' };
    case 'turn/end':
      return { type, detail: `turn ${data.turn ?? '?'}${data.reason?.kind ? ` · ${data.reason.kind}` : ''}` };
    case 'session/title':
      return { type, detail: oneLine(data.title ?? '', 120) };
    case 'request/context':
      return { type, detail: `${data.provider ?? '?'}/${data.model ?? '?'}` };
    case 'approval/asked':
      return { type, detail: oneLine(data.toolName ?? '', 80) };
    default:
      return { type, detail: '' };
  }
}
