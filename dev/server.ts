import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { ZkCaptchaClient } from "../src/index";
import type { FetchLike, HistoryListFilter, ZkCaptchaClientOptions } from "../src/index";

/** 三张 5 MiB 图片编码为 base64 后的请求上限。 */
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const scenarios = ["success", "failure", "http", "json", "timeout", "redirect", "large"];

/** 验收 API 的输入错误，避免将请求问题报告成服务故障。 */
class InputError extends Error {
  /**
   * 携带可直接显示给验收者的错误。
   * @param message 输入问题。
   * @param status HTTP 状态码。
   */
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * 拒绝数组和空值，保留 JSON 对象中的未知值以逐项校验。
 * @param value 未信任的 JSON 值。
 * @returns 可按键读取的对象。
 */
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("请求参数必须是 JSON 对象。");
  }
  return Object.fromEntries(Object.entries(value));
};

/**
 * 限制表单文本，避免将任意结构传给 SDK。
 * @param value 待校验的字段。
 * @param name 用于错误提示的字段名。
 * @param fallback 缺省值；不传则要求非空。
 * @returns 校验后的原始字符串。
 */
const text = (value: unknown, name: string, fallback?: string): string => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.length > 4096 || value.trim() === "") {
    throw new InputError(`${name}须为非空文本，最多 4096 个字符。`);
  }
  return value;
};

/**
 * 校验有上下限的整数，拒绝隐式字符串转换。
 * @param value JSON 数字。
 * @param name 字段名。
 * @param max 允许的最大值。
 * @returns 正整数。
 */
const positiveInteger = (value: unknown, name: string, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InputError(`${name}须为 1～${max} 的整数。`);
  }
  return value;
};

/**
 * 只在 SDK 的网络边界模拟；转换、错误归一化、SQLite 和计价使用真实代码。
 * @param config 已校验的模拟场景。
 * @returns 不发出任何外部请求的 fetch 实现。
 */
const mockFetch =
  (config: {
    /** 模拟的识别结果。 */ result: string;
    /** 模拟响应类型。 */ scenario: string;
    /** SDK 超时时间。 */ timeoutMs: number;
  }): FetchLike =>
  async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const predict = url.pathname.endsWith("/predict");
    await delay(
      predict && config.scenario === "timeout" ? config.timeoutMs + 100 : 100,
      undefined,
      init?.signal ? { signal: init.signal } : {},
    );
    if (predict) {
      switch (config.scenario) {
        case "failure":
          return Response.json({
            success: false,
            code: "1004",
            message: "模拟：验证码识别失败",
            data: {},
          });
        case "http":
          return Response.json({ message: "模拟 HTTP 500" }, { status: 500 });
        case "json":
          return new Response("{invalid-json");
        case "redirect":
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.invalid" },
          });
        case "large":
          return new Response("x".repeat(65_537));
      }
    }
    const data = predict
      ? { id: `mock-${randomUUID()}`, result: config.result }
      : url.pathname.endsWith("/reporterror.json")
        ? { result: "模拟报错成功（无真实退款）" }
        : { balance: "100.000000", consumed: "0.000000", successNum: "0", failNum: "0" };
    return Response.json({ success: true, code: "0", message: "本地模拟成功", data });
  };

/**
 * 每次调用独立创建并关闭 SDK，凭证只在请求内存中使用。
 * @param value 浏览器配置。
 * @param directory 验收专用记录根目录。
 * @param warnings 收集 SDK 保存失败信息，防止界面误报已落库。
 * @returns 按模拟/真实模式隔离数据的 SDK 客户端。
 */
const createClient = (value: unknown, directory: string, warnings: string[]): ZkCaptchaClient => {
  const config = object(value);
  const mode = config.mode;
  if (mode !== "mock" && mode !== "live") throw new InputError("请选择模拟或真实接口模式。");
  const endpoint = config.endpoint;
  if (endpoint !== "ttshitu" && endpoint !== "zhunkuai" && endpoint !== "kuaishibie") {
    throw new InputError("接口平台无效。");
  }
  const prices: Record<string, string> = {};
  for (const [key, price] of Object.entries(object(config.prices ?? {}))) {
    if (typeof price !== "string") throw new InputError("自定义价格须使用字符串金额。");
    Object.defineProperty(prices, key, { value: price, enumerable: true });
  }
  const timeoutMs = positiveInteger(config.timeoutMs ?? 1000, "超时毫秒", 120_000);
  const options: ZkCaptchaClientOptions = {
    username: text(config.username, "账号", mode === "mock" ? "demo" : undefined),
    password: mode === "mock" ? "demo" : text(config.password, "密码"),
    endpoint,
    timeoutMs,
    history: {
      directory: resolve(directory, mode),
      prices,
      onError: (error) => {
        warnings.push(error.message);
      },
      ...(config.retentionDays === undefined
        ? {}
        : {
            retentionDays: positiveInteger(config.retentionDays, "保留天数", 36500),
          }),
    },
    ...(config.baseUrl ? { baseUrl: text(config.baseUrl, "自定义接口") } : {}),
  };
  if (mode === "mock") {
    const scenario = text(config.scenario, "模拟场景", "success");
    if (!scenarios.includes(scenario)) throw new InputError("模拟场景无效。");
    options.fetch = mockFetch({
      scenario,
      timeoutMs,
      result: text(config.result, "模拟结果", "a7K9"),
    });
  }
  return new ZkCaptchaClient(options);
};

/**
 * 只保留 SDK 支持的筛选字段，日期格式与分页边界交由 SDK 校验。
 * @param value JSON 筛选条件。
 * @returns 明细和统计共用的筛选条件。
 */
const filterFrom = (value: unknown): HistoryListFilter => {
  const raw = object(value ?? {});
  const filter: HistoryListFilter = {};
  for (const key of ["from", "to", "typeid"] satisfies Array<keyof HistoryListFilter>) {
    if (raw[key] !== undefined) filter[key] = text(raw[key], key);
  }
  if (raw.success !== undefined) {
    if (typeof raw.success !== "boolean") throw new InputError("success 须为布尔值。");
    filter.success = raw.success;
  }
  if (raw.limit !== undefined) filter.limit = positiveInteger(raw.limit, "每页条数", 100);
  if (raw.offset !== undefined) {
    if (typeof raw.offset !== "number" || !Number.isSafeInteger(raw.offset) || raw.offset < 0) {
      throw new InputError("分页偏移须为非负整数。");
    }
    filter.offset = raw.offset;
  }
  return filter;
};

/**
 * 限制图片体积并拒绝无效 base64，空的可选图片由调用方省略。
 * @param value Data URL 或纯 base64。
 * @returns SDK 可直接转换的图片文本。
 */
const imageFrom = (value: unknown): string => {
  if (typeof value !== "string") throw new InputError("请先上传主图或载入示例。");
  const base64 = value.replace(/^data:image\/[\w.+-]+;base64,/, "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new InputError("图片须为有效的 base64 或图片 Data URL。");
  }
  if (Buffer.byteLength(base64, "base64") > 5 * 1024 * 1024) {
    throw new InputError("每张图片最多 5 MiB。", 413);
  }
  return value;
};

/**
 * 限流读取 JSON，请求过大时停止累积并继续排空连接。
 * @param request 本地 HTTP 请求。
 * @returns 未信任的 JSON 对象。
 */
const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  const content = await new Promise<Buffer>((resolveBody, rejectBody) => {
    request.on("data", (bytes: unknown) => {
      if (size > MAX_BODY_BYTES) return;
      if (!(bytes instanceof Uint8Array)) {
        rejectBody(new InputError("请求体编码无效。"));
        return;
      }
      size += bytes.byteLength;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        rejectBody(new InputError("请求体超过 24 MiB。", 413));
        return;
      }
      chunks.push(Buffer.from(bytes));
    });
    request.once("end", () => resolveBody(Buffer.concat(chunks)));
    request.once("error", rejectBody);
    request.once("aborted", () => rejectBody(new InputError("请求已中断。")));
  });
  try {
    const body: unknown = JSON.parse(content.toString("utf8"));
    return object(body);
  } catch {
    throw new InputError("请求体必须是有效的 JSON 对象。");
  }
};

/**
 * 统一返回 JSON，禁止浏览器缓存账号相关响应。
 * @param response 本地 HTTP 响应。
 * @param status 状态码。
 * @param body 响应数据。
 * @returns 无返回值。
 */
const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

/**
 * 创建仅供本机验收的页面与 API；测试可传入临时目录和随机端口。
 * @param directory 验收记录目录，与常规 SDK 数据分开。
 * @returns 尚未监听的 HTTP 服务。
 */
export const createAcceptanceServer = (directory = resolve(".zk-captcha/acceptance")) => {
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    let client: ZkCaptchaClient | undefined;
    try {
      const address = server.address();
      const host = request.headers.host;
      if (
        address === null ||
        typeof address === "string" ||
        (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`)
      ) {
        throw new InputError("仅允许通过本机地址访问。", 403);
      }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        throw new InputError("拒绝跨站请求。", 403);
      }
      const path = new URL(request.url ?? "/", `http://${host}`).pathname;
      if (path === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      const asset = assets.get(path);
      if (request.method === "GET" && asset) {
        const [file, type] = asset;
        if (!file || !type) throw new Error("静态资源配置无效。");
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { "content-type": type });
        response.end(content);
        return;
      }
      if (
        !["/api/recognize", "/api/account", "/api/report", "/api/history", "/api/record"].includes(
          path,
        )
      ) {
        throw new InputError("路径不存在。", 404);
      }
      if (request.method !== "POST") throw new InputError("接口仅接受 POST。", 405);
      if (
        request.headers["x-acceptance"] !== "1" ||
        request.headers["content-type"]?.split(";")[0] !== "application/json"
      ) {
        throw new InputError("请通过本地验收页面提交 JSON 请求。", 403);
      }
      const body = await readBody(request);
      const warnings: string[] = [];
      client = createClient(body.config, directory, warnings);
      let data: unknown;
      switch (path) {
        case "/api/recognize": {
          const input = object(body.request);
          data = await client.recognize({
            image: imageFrom(input.image),
            typeid: text(input.typeid, "类型 ID", "3"),
            ...(input.imageback ? { imageback: imageFrom(input.imageback) } : {}),
            ...(input.title_image ? { title_image: imageFrom(input.title_image) } : {}),
            ...(input.remark ? { remark: text(input.remark, "识别提示") } : {}),
          });
          break;
        }
        case "/api/account":
          data = await client.queryAccountInfo();
          break;
        case "/api/report":
          data = await client.reportError({ id: text(body.id, "平台识别编号") });
          break;
        case "/api/history": {
          const filter = filterFrom(body.filter);
          data = { page: await client.getRecords(filter), stats: await client.getStats(filter) };
          break;
        }
        case "/api/record": {
          const detail = await client.getRecord(text(body.id, "本地记录编号"));
          if (detail === null) throw new InputError("记录不存在或不属于当前账号及接口。", 404);
          data = {
            ...detail,
            image: detail.image ? Buffer.from(detail.image).toString("base64") : null,
            imageback: detail.imageback ? Buffer.from(detail.imageback).toString("base64") : null,
            title_image: detail.title_image
              ? Buffer.from(detail.title_image).toString("base64")
              : null,
          };
          break;
        }
      }
      json(response, 200, { data, warnings });
    } catch (error) {
      const status =
        error instanceof InputError
          ? error.status
          : error instanceof TypeError || error instanceof RangeError
            ? 400
            : 500;
      json(response, status, {
        error: error instanceof Error ? error.message : "本地服务处理失败。",
      });
    } finally {
      await client?.close();
    }
  });
  server.requestTimeout = 130_000;
  return server;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = positiveInteger(Number(process.env.PORT ?? 3210), "PORT", 65535);
  const server = createAcceptanceServer();
  server.on("error", (error) => {
    console.error(`验收服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`本地验收：http://127.0.0.1:${port}（默认模拟，不调用付费接口）`);
  });
}
