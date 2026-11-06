/**
 * 插件级调度：一个会话一个 SessionArchive，负责首次接管时的历史回填、
 * 事件分发与卸载时的收尾。
 */
import { SessionArchive } from './archive.js';

export class ArchiveKeeper {
  /**
   * @param {object} ctx cordis 上下文（只用到 logger）。
   * @param {object} config normalizeConfig 的结果。
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx && typeof ctx === 'object' ? ctx.logger : undefined;
    /** @type {Map<string, SessionArchive>} */
    this.archives = new Map();
  }

  get size() {
    return this.archives.size;
  }

  /**
   * 接收一个已提交的 session/event。
   * @param {object} session DSH Session
   * @param {object} event SessionEvent
   */
  observe(session, event) {
    try {
      if (session == null || typeof session !== 'object') return;
      const header = session.header && typeof session.header === 'object' ? session.header : {};
      // 子代理会话默认也归档；关掉后连目录都不建。
      if (this.config.includeSubagents === false && header.origin === 'subagent') return;

      const id = typeof session.id === 'string' && session.id !== ''
        ? session.id
        : typeof header.id === 'string' ? header.id : '';
      if (id === '') return;

      let archive = this.archives.get(id);
      if (archive === undefined) {
        archive = new SessionArchive(session, this.config, this.logger, this.ctx);
        this.archives.set(id, archive);
        this.#prune();
        if (this.config.backfill !== false && typeof session.snapshotEvents === 'function') {
          try {
            const snapshot = session.snapshotEvents();
            if (Array.isArray(snapshot) && snapshot.length > 0) archive.observeSnapshot(snapshot);
          } catch (error) {
            this.#warn('snapshot backfill unavailable', error);
          }
        }
      }
      archive.observe(event);
    } catch (error) {
      this.#warn('observe failed', error);
    }
  }

  /**
   * 只按最近使用顺序丢弃内存引用，不主动 close：每个事件都已写盘，
   * 丢弃后新事件会重新打开同一目录并接着 lastSeq 续写。
   */
  #prune() {
    const limit = this.config.maxLiveArchives;
    while (this.archives.size > limit) {
      const oldest = this.archives.keys().next().value;
      if (oldest === undefined) break;
      this.archives.delete(oldest);
    }
  }

  async flush() {
    const archives = [...this.archives.values()];
    this.archives.clear();
    await Promise.all(archives.map(archive => archive.close().catch(() => {})));
  }

  #warn(message, error) {
    try {
      this.logger?.warn?.(`dsh-better-output: ${message}`, error);
    } catch {
      /* ignore */
    }
  }
}
