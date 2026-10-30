import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { estimatePrice, formatPrice, getTypeName, parsePrices } from "./pricing";
import type {
  HistoryFilter,
  HistoryListFilter,
  HistoryOptions,
  RecognitionDetail,
  RecognitionPage,
  RecognitionRecord,
  RecognitionStats,
  RecognitionSummary,
  RecognizeData,
  ZkCaptchaResponse,
} from "./types";

const recordColumns = `id, captcha_id, typeid, type_name, started_at, duration_ms,
  success, result, code, message, price_micros, pricing_source`;
const summaryColumns = `COUNT(*) AS total, COALESCE(SUM(success), 0) AS success_count,
  COALESCE(AVG(duration_ms), 0) AS average_duration_ms,
  COALESCE(SUM(price_micros), 0) AS estimated_cost,
  COUNT(*) - COUNT(price_micros) AS unknown_price_count`;

/** 一个客户端的本地存储；只保留账号与接口的哈希，连接在首次读写时创建。 */
export class HistoryStore {
  private readonly workingDirectory = process.cwd();
  private readonly scopeKey: string;
  private readonly prices: ReadonlyMap<string, bigint>;
  private database: DatabaseSync | undefined;

  /**
   * 固定客户端创建时的工作目录和价格配置，不立即访问文件系统。
   * @param username 当前账号，用于隔离查询。
   * @param baseUrl 规范化的接口地址。
   * @param official 是否为内置官方接口。
   * @param options 目录、保留天数、价格和错误回调。
   * @returns 按需打开连接的存储实例。
   */
  constructor(
    username: string,
    private readonly baseUrl: string,
    private readonly official: boolean,
    private readonly options: HistoryOptions,
  ) {
    this.options = { ...options };
    const days = this.options.retentionDays;
    if (
      days !== undefined &&
      (!Number.isSafeInteger(days) ||
        days <= 0 ||
        !Number.isFinite(new Date(Date.now() - days * 86_400_000).getTime()))
    ) {
      throw new RangeError("history.retentionDays 必须是有效的正整数天数。");
    }
    this.scopeKey = scopeKey(username, baseUrl);
    this.prices = parsePrices(this.options.prices);
  }

  /**
   * 原子保存图片与结果后清理过期数据；保存或清理失败只通知错误回调。
   * @param body 最终发送的请求体，仅提取白名单字段。
   * @param response 已完成的识别响应。
   * @param startedAt 识别开始时间，UTC ISO 字符串。
   * @param durationMs 不含本地写入的耗时。
   * @returns 无返回值，不改变识别结果。
   */
  record(
    body: Record<string, unknown>,
    response: ZkCaptchaResponse<RecognizeData>,
    startedAt: string,
    durationMs: number,
  ): void {
    try {
      const typeid = body.typeid === undefined ? "3" : String(body.typeid);
      const result = response.success ? response.data.result : null;
      const price = estimatePrice(
        typeid,
        result,
        this.official &&
          (body.modelid === undefined || body.modelid === null || body.modelid === ""),
        this.prices,
      );
      const account =
        typeof body.username === "string" ? scopeKey(body.username, this.baseUrl) : this.scopeKey;
      const database = this.getDatabase();
      database
        .prepare(`INSERT INTO recognition_records (
          ${recordColumns}, scope_key, image, imageback, title_image
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          randomUUID(),
          response.success ? response.data.id : null,
          typeid,
          getTypeName(typeid),
          startedAt,
          durationMs,
          response.success ? 1 : 0,
          result,
          response.code,
          response.message,
          price.micros,
          price.source,
          account,
          imageBytes(body.image),
          imageBytes(body.imageback),
          imageBytes(body.title_image),
        );
      this.cleanupExpired(database);
    } catch (error) {
      const issue = error instanceof Error ? error : new Error(String(error));
      if (this.options.onError === undefined) {
        warn(issue);
        return;
      }
      try {
        void Promise.resolve(this.options.onError(issue)).catch(warn);
      } catch (callbackError) {
        warn(issue);
        warn(callbackError);
      }
    }
  }

  /**
   * 在同一读取快照中获取总数与当前页，查询错误直接抛出。
   * @param filter 时间、类型、状态及分页条件。
   * @returns 不加载图片的明细分页。
   */
  getRecords(filter: HistoryListFilter = {}): RecognitionPage {
    const { where, params } = this.buildFilter(filter);
    const limit = filter.limit ?? 20;
    const offset = filter.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit 必须是 1～100 的整数。");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("offset 必须是非负安全整数。");
    }
    return this.readSnapshot((database) => {
      const count = database
        .prepare(`SELECT COUNT(*) AS total FROM recognition_records ${where}`)
        .get(...params);
      const statement = database.prepare(`SELECT ${recordColumns} FROM recognition_records ${where}
        ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`);
      statement.setReadBigInts(true);
      return {
        total: numberValue(count?.total),
        items: statement.all(...params, limit, offset).map(readRecord),
      };
    });
  }

  /**
   * 按本地 ID 读取当前账号的明细，图片不会在其他查询中加载。
   * @param id 本地 UUID。
   * @returns 带图片的记录，不存在或属于其他账号时返回 `null`。
   */
  getRecord(id: string): RecognitionDetail | null {
    const database = this.getDatabase();
    this.cleanupExpired(database);
    const statement = database.prepare(`SELECT ${recordColumns}, image, imageback, title_image
      FROM recognition_records WHERE scope_key = ? AND id = ?`);
    statement.setReadBigInts(true);
    const row = statement.get(this.scopeKey, id);
    return row === undefined
      ? null
      : {
          ...readRecord(row),
          image: bytesValue(row.image),
          imageback: bytesValue(row.imageback),
          title_image: bytesValue(row.title_image),
        };
  }

  /**
   * 以同一读取快照汇总总体、UTC 日期和类型，整数微元避免累计误差。
   * @param filter 与明细一致的筛选条件。
   * @returns 仅针对本地已保存记录的统计。
   */
  getStats(filter: HistoryFilter = {}): RecognitionStats {
    const { where, params } = this.buildFilter(filter);
    return this.readSnapshot((database) => {
      const overall = database.prepare(
        `SELECT ${summaryColumns} FROM recognition_records ${where}`,
      );
      const days = database.prepare(`SELECT substr(started_at, 1, 10) AS day, ${summaryColumns}
        FROM recognition_records ${where} GROUP BY day ORDER BY day`);
      const types = database.prepare(`SELECT typeid, type_name, ${summaryColumns}
        FROM recognition_records ${where} GROUP BY typeid, type_name ORDER BY typeid`);
      for (const statement of [overall, days, types]) {
        statement.setReadBigInts(true);
      }
      return {
        summary: readSummary(overall.get(...params) ?? {}),
        byDay: days
          .all(...params)
          .map((row) => ({ day: stringValue(row.day), ...readSummary(row) })),
        byType: types.all(...params).map((row) => ({
          typeid: stringValue(row.typeid),
          typeName: nullableString(row.type_name),
          ...readSummary(row),
        })),
      };
    });
  }

  /**
   * 释放已打开的 SQLite 连接，不删除本地数据。
   * @returns 无返回值，未打开连接或重复关闭均安全。
   */
  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  /**
   * 先设置锁等待再初始化 WAL 和表结构，失败后保留后续重试机会。
   * @returns 当前存储的连接；文件系统或 SQLite 错误原样抛出。
   */
  private getDatabase(): DatabaseSync {
    if (this.database !== undefined) {
      return this.database;
    }
    const configured = this.options.directory ?? ".zk-captcha";
    const directory = isAbsolute(configured)
      ? configured
      : resolve(projectRoot(this.workingDirectory), configured);
    mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(join(directory, "history.sqlite"));
    try {
      database.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS recognition_records (
          id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          captcha_id TEXT,
          typeid TEXT NOT NULL,
          type_name TEXT,
          started_at TEXT NOT NULL,
          duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
          success INTEGER NOT NULL CHECK(success IN (0, 1)),
          result TEXT,
          code TEXT NOT NULL,
          message TEXT NOT NULL,
          price_micros INTEGER CHECK(price_micros >= 0),
          pricing_source TEXT NOT NULL CHECK(pricing_source IN ('official', 'custom', 'unknown')),
          image BLOB,
          imageback BLOB,
          title_image BLOB
        ) STRICT;
        CREATE INDEX IF NOT EXISTS recognition_scope_time ON recognition_records(scope_key, started_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS recognition_scope_type_time ON recognition_records(scope_key, typeid, started_at DESC);`);
      this.database = database;
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /**
   * 为多条查询建立一致的读取快照，避免并发写入导致列表总数或分组统计不一致。
   * @param read 同步执行的读取操作。
   * @returns 操作结果；失败时回滚后抛出原错误。
   */
  private readSnapshot<T>(read: (database: DatabaseSync) => T): T {
    const database = this.getDatabase();
    this.cleanupExpired(database);
    database.exec("BEGIN");
    try {
      const result = read(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 仅删除当前账号和接口的过期行，同一行的三类图片随之删除；边界时间保留。
   * @param database 当前存储连接，调用前须确保未处于读取事务中。
   * @returns 无返回值；未配置保留天数时不执行删除，失败由调用入口处理。
   */
  private cleanupExpired(database: DatabaseSync): void {
    const days = this.options.retentionDays;
    if (days === undefined) return;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    database
      .prepare("DELETE FROM recognition_records WHERE scope_key = ? AND started_at < ?")
      .run(this.scopeKey, cutoff);
  }

  /**
   * 仅通过绑定参数构建筛选，时间统一转换到 UTC 后比较。
   * @param filter 公开查询条件。
   * @returns WHERE 子句与独立绑定值。
   */
  private buildFilter(filter: HistoryFilter): { where: string; params: SQLInputValue[] } {
    const clauses = ["scope_key = ?"];
    const params: SQLInputValue[] = [this.scopeKey];
    const from = filter.from === undefined ? undefined : utcTime(filter.from);
    const to = filter.to === undefined ? undefined : utcTime(filter.to);
    if (from !== undefined && to !== undefined && from > to) {
      throw new RangeError("from 不能晚于 to。");
    }
    if (from !== undefined) {
      clauses.push("started_at >= ?");
      params.push(from);
    }
    if (to !== undefined) {
      clauses.push("started_at < ?");
      params.push(to);
    }
    if (filter.typeid !== undefined) {
      clauses.push("typeid = ?");
      params.push(String(filter.typeid));
    }
    if (filter.success !== undefined) {
      if (typeof filter.success !== "boolean") {
        throw new TypeError("success 必须是布尔值。");
      }
      clauses.push("success = ?");
      params.push(filter.success ? 1 : 0);
    }
    return { where: `WHERE ${clauses.join(" AND ")}`, params };
  }
}

/**
 * 从固定的启动目录查找最近的项目清单；无清单时使用原启动目录。
 * @param directory 客户端创建时的工作目录。
 * @returns 调用方项目根目录。
 */
const projectRoot = (directory: string): string => {
  let current = directory;
  while (true) {
    if (statSync(join(current, "package.json"), { throwIfNoEntry: false })?.isFile()) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return directory;
    }
    current = parent;
  }
};

/**
 * 隔离不同账号与服务地址，避免明文保存登录信息。
 * @param username 实际请求账号。
 * @param baseUrl 规范化的服务地址。
 * @returns 不可逆的作用域标识。
 */
const scopeKey = (username: string, baseUrl: string): string =>
  createHash("sha256")
    .update(JSON.stringify([baseUrl, username]))
    .digest("hex");

/**
 * 仅解码实际发送的图片字符串，不保存整个请求体。
 * @param value 最终请求中的图片值。
 * @returns 原始图片字节，无有效字符串时为 `null`。
 */
const imageBytes = (value: unknown): Buffer | null =>
  typeof value === "string" ? Buffer.from(value, "base64") : null;

/**
 * 严格校验筛选时间，避免受服务器本地时区影响。
 * @param value 含时区的时间字符串。
 * @returns 规范化的 UTC ISO 时间。
 */
const utcTime = (value: string): string => {
  const time = Date.parse(value);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(time)) {
    throw new TypeError("筛选时间必须是有效且带时区的 ISO 时间字符串。");
  }
  return new Date(time).toISOString();
};

/**
 * 将 SQLite 值缩窄为字符串，损坏或不兼容的本地数据不能伪装成有效记录。
 * @param value SQLite 列值。
 * @returns 字符串，否则抛出类型错误。
 */
const stringValue = (value: SQLOutputValue | undefined): string => {
  if (typeof value !== "string") throw new TypeError("本地记录的文本字段类型错误。");
  return value;
};

/**
 * 保留可空文本的未知状态。
 * @param value SQLite 列值。
 * @returns 字符串或 `null`。
 */
const nullableString = (value: SQLOutputValue | undefined): string | null =>
  value === null ? null : stringValue(value);

/**
 * 金额与整数统计使用 bigint 读取，避免数据库返回值的精度损失。
 * @param value SQLite 整数列值。
 * @returns 精确整数，否则抛出类型错误。
 */
const integerValue = (value: SQLOutputValue | undefined): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError("本地记录的整数字段类型错误。");
};

/**
 * 仅将安全整数统计与有限浮点耗时返回给调用方。
 * @param value SQLite 数值列值。
 * @returns 可安全表示的数值。
 */
const numberValue = (value: SQLOutputValue | undefined): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "bigint" &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  )
    return Number(value);
  throw new TypeError("本地记录的数值超出安全范围或类型错误。");
};

/**
 * 图片必须是 SQLite BLOB，损坏字段不能作为空图片返回。
 * @param value SQLite 图片列值。
 * @returns 图片字节或 `null`。
 */
const bytesValue = (value: SQLOutputValue | undefined): Uint8Array | null => {
  if (value === null || value instanceof Uint8Array) return value;
  throw new TypeError("本地记录的图片字段类型错误。");
};

/**
 * 将 SQLite 元数据转换为公开记录，金额保持小数字符串。
 * @param row 不含图片也可读取的元数据行。
 * @returns 公开识别记录。
 */
const readRecord = (row: Record<string, SQLOutputValue>): RecognitionRecord => {
  const source = row.pricing_source;
  const success = integerValue(row.success);
  if (
    (source !== "official" && source !== "custom" && source !== "unknown") ||
    (success !== 0n && success !== 1n)
  ) {
    throw new TypeError("本地记录的价格来源或识别状态无效。");
  }
  return {
    id: stringValue(row.id),
    captchaId: nullableString(row.captcha_id),
    typeid: stringValue(row.typeid),
    typeName: nullableString(row.type_name),
    startedAt: stringValue(row.started_at),
    durationMs: numberValue(row.duration_ms),
    success: success === 1n,
    result: nullableString(row.result),
    code: stringValue(row.code),
    message: stringValue(row.message),
    price: row.price_micros === null ? null : formatPrice(integerValue(row.price_micros)),
    pricingSource: source,
  };
};

/**
 * 将 SQL 聚合结果转换为统计，无数据时成功率为零。
 * @param row COUNT/SUM/AVG 聚合结果。
 * @returns 元金额、成功率及未知费用数量。
 */
const readSummary = (row: Record<string, SQLOutputValue>): RecognitionSummary => {
  const total = numberValue(row.total);
  const successCount = numberValue(row.success_count);
  return {
    total,
    successCount,
    failureCount: total - successCount,
    successRate: total === 0 ? 0 : successCount / total,
    averageDurationMs: numberValue(row.average_duration_ms),
    estimatedCost: formatPrice(integerValue(row.estimated_cost)),
    unknownPriceCount: numberValue(row.unknown_price_count),
  };
};

/**
 * 默认记录诊断只输出本地错误，不抛回识别流程。
 * @param error 存储或错误回调异常。
 * @returns 无返回值。
 */
const warn = (error: unknown): void => {
  console.warn("[zk-captcha] 本地识别记录保存或清理失败：", error);
};
