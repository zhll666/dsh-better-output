/**
 * 插件配置：全部字段可选，缺省值就是推荐配置。
 *
 * 配置写在 profile 的插件行里（cordis.yml / cordis.patch.yml 的 config），
 * 例如：
 *
 *   - id: dsh-better-output
 *     name: dsh-better-output
 *     config:
 *       rootDir: .
 *       includeReasoning: false
 */

/**
 * 归档根目录（相对会话工作区）。
 * `.` 表示直接在工作区根目录下建立会话文件夹。
 */
export const DEFAULT_ROOT_DIR = '.';

/** 缺省配置。数值都做过上限/下限保护，避免误配置把磁盘写爆。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 工作区内的归档根目录；只能是相对路径，且不能含 `..`。 */
  rootDir: DEFAULT_ROOT_DIR,
  /** 是否把助手的 reasoning（思考）写进输出记录。默认关闭，避免把半成品思路当成答案。 */
  includeReasoning: false,
  /** 是否归档子代理（subagent / fork）会话。默认开启，子会话会单独成夹并在总览里标注。 */
  includeSubagents: true,
  /** 首次看到某个会话时，是否用 session.snapshotEvents() 回填插件装载前的历史。 */
  backfill: true,
  /** 是否写 logs/events.txt（事件流水）。关闭后其余业务记录仍然工作。 */
  eventLog: true,
  /** 是否对疑似密钥做脱敏（sk-… / Bearer … / api_key=…）。 */
  redactSecrets: true,
  /** 单条记录正文的最大字符数，超出截断并标注原长。 */
  maxEntryChars: 200_000,
  /** 单条工具结果写入日志的最大字符数。 */
  maxToolResultChars: 8_000,
  /** 会话归档对象的内存上限；超过后关闭最久未用归档（不影响磁盘文件）。 */
  maxLiveArchives: 32,
});

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 把 rootDir 收敛成工作区内的相对路径：
 * - 反斜杠统一成正斜杠；
 * - 去掉盘符、前导斜杠与 `..`，拒绝逃出工作区；
 * - 清洗 Windows 不允许的字符。
 */
export function sanitizeRootDir(value) {
  if (typeof value !== 'string') return DEFAULT_ROOT_DIR;
  const raw = value.trim().replace(/\\/g, '/');
  if (raw === '' || raw === '.' || raw === './') return '.';
  const segments = raw
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    // Windows 文件名非法字符，顺带避开冒号盘符。
    .map(segment => segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_'))
    .filter(segment => segment !== '');
  if (segments.length === 0) return DEFAULT_ROOT_DIR;
  return segments.join('/');
}

/** 合并用户配置与缺省值；任何非法字段都退回缺省，不因配置错误阻止插件装载。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    rootDir: sanitizeRootDir(input.rootDir),
    includeReasoning: asBoolean(input.includeReasoning, DEFAULT_CONFIG.includeReasoning),
    includeSubagents: asBoolean(input.includeSubagents, DEFAULT_CONFIG.includeSubagents),
    backfill: asBoolean(input.backfill, DEFAULT_CONFIG.backfill),
    eventLog: asBoolean(input.eventLog, DEFAULT_CONFIG.eventLog),
    redactSecrets: asBoolean(input.redactSecrets, DEFAULT_CONFIG.redactSecrets),
    maxEntryChars: asInt(input.maxEntryChars, DEFAULT_CONFIG.maxEntryChars, 1_000, 2_000_000),
    maxToolResultChars: asInt(input.maxToolResultChars, DEFAULT_CONFIG.maxToolResultChars, 200, 200_000),
    maxLiveArchives: asInt(input.maxLiveArchives, DEFAULT_CONFIG.maxLiveArchives, 1, 512),
  };
}
