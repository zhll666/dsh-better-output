/**
 * dsh-better-output · Host 半边
 *
 * 监听 `session/event`，把每个会话的输入、输出、工具指令、文件访问、
 * 网页访问以 txt 形式归档到工作区：
 *
 *   <workspace>/dsh-better-output/<时间>_<会话短ID>/
 *
 * 设计取舍：
 * - 只读公开契约：Session（id/header/snapshotEvents）与 session/event；
 * - 全部写盘串行化、逐事件失败隔离，任何归档错误都不会影响会话；
 * - 状态文件记录 lastSeq，DSH 重启/会话恢复后从断点续写，不重复整段历史；
 * - 纯 Node 内置模块，无第三方依赖。
 */
import { normalizeConfig } from './src/config.js';
import { ArchiveKeeper } from './src/keeper.js';

/** cordis.yml 中的插件标识。 */
export const name = 'dsh-better-output';

/**
 * 等待 sessions 服务就绪再接事件；会话事件由 Session 在提交后广播，
 * 不依赖任何可选服务。
 */
export const inject = ['sessions'];

/**
 * @param {object} ctx cordis Context
 * @param {object} [config] 见 src/config.js
 */
export function apply(ctx, config) {
  const keeper = new ArchiveKeeper(ctx, normalizeConfig(config));

  ctx.on('session/event', (session, event) => {
    keeper.observe(session, event);
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => keeper.flush(), 'dsh-better-output: session archives');
  }

  try {
    ctx.logger?.info?.('dsh-better-output: 会话归档已启用（工作区内 %s/）', keeper.config.rootDir);
  } catch {
    /* 日志不可用不影响功能 */
  }
}
