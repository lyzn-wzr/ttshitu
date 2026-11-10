import { Buffer } from "node:buffer";
import process from "node:process";
import { prepareAlgorithms } from "./algorithms";
import type { PreparedAlgorithm } from "./algorithms";
import { unwrap } from "./errors";
import { HistoryStore } from "./history";
import type {
  AccountInfoData,
  FetchLike,
  ImageInput,
  HistoryFilter,
  HistoryListFilter,
  RecognitionDetail,
  RecognitionPage,
  RecognitionStats,
  RecognizeData,
  RecognizeRequest,
  ReportErrorData,
  ReportErrorRequest,
  RequestPrimitive,
  ZkCaptchaAlgorithmRequest,
  ZkCaptchaClientOptions,
  ZkCaptchaEndpoint,
  ZkCaptchaFailureResponse,
  ZkCaptchaRequestOptions,
  ZkCaptchaResponse,
} from "./types";

export * from "./errors";
export * from "./types";
export { fileToBase64, recognizeFromFile, recognizeFromFileOrThrow } from "./node";

/**
 * SDK 内置的图鉴兼容接口基础地址，默认使用 HTTPS 传输账号与图片。
 */
export const ZkCaptchaEndpoints = {
  ttshitu: "https://api.ttshitu.com",
  zhunkuai: "https://api.zhunkuai.cn",
  kuaishibie: "https://api.kuaishibie.cn",
} satisfies Record<ZkCaptchaEndpoint, string>;

const DEFAULT_ENDPOINT: ZkCaptchaEndpoint = "ttshitu";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
type MaybeObject = Record<PropertyKey, unknown>;

/**
 * Node 22.13+/Bun 1.4.4+ 客户端，默认通过内置 SQLite 保存识别记录。
 */
export class ZkCaptchaClient {
  private readonly username: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly history: HistoryStore | undefined;
  private readonly algorithms: ReadonlyMap<string, PreparedAlgorithm>;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  /**
   * 固定服务地址和本地记录配置，数据库在首次读写时初始化。
   * @param options 账号、请求及本地记录配置。
   * @returns 客户端实例。
   */
  constructor(options: ZkCaptchaClientOptions) {
    assertSupportedRuntime();
    const fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof fetchImpl !== "function") {
      throw new TypeError(
        "当前运行时没有可用的 fetch 实现，请在 ZkCaptchaClientOptions 中传入 fetch。",
      );
    }

    this.username = options.username ?? "";
    this.password = options.password ?? "";
    this.algorithms = prepareAlgorithms(options.algorithms);
    this.baseUrl = resolveBaseUrl(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new TypeError("maxResponseBytes 必须为正安全整数，单位为字节。");
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.history =
      options.history === false
        ? undefined
        : new HistoryStore(
            this.username,
            this.baseUrl,
            Object.values(ZkCaptchaEndpoints).includes(this.baseUrl.replace(/^http:/, "https:")),
            options.history ?? {},
          );
  }

  /**
   * 通过指定算法或平台 `/predict` 识别验证码图片。
   *
   * 该方法不会因为接口失败、HTTP 错误、超时、JSON 解析失败或网络错误而抛出异常。
   * 调用方可以通过 `response.success` 判断并获得类型缩窄后的响应数据。
   * @param request 图片与类型等识别参数。
   * @param options 单次请求控制。
   * @returns 原始识别响应，本地写入失败不改变该响应。
   */
  async recognize(
    request: RecognizeRequest,
    options?: ZkCaptchaRequestOptions,
  ): Promise<ZkCaptchaResponse<RecognizeData>> {
    return this.track(async () => {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const algorithmId = request.algorithm;
      const algorithmRequest =
        algorithmId === undefined ? undefined : await normalizeAlgorithmRequest(request);
      const body =
        algorithmRequest === undefined
          ? await this.createRecognizeBody(request)
          : { ...algorithmRequest };
      const response =
        algorithmRequest === undefined
          ? await this.requestJson(
              "/predict",
              {
                body,
                method: "POST",
                options,
              },
              isRecognizeData,
            )
          : await this.recognizeAlgorithm(algorithmId ?? "", algorithmRequest, options);
      const durationMs = performance.now() - started;
      this.history?.record(body, response, startedAt, durationMs, algorithmId ?? null);
      return response;
    });
  }

  /**
   * 识别验证码图片，并只返回成功响应中的 `data`。
   *
   * 当请求失败时抛出 {@link ZkCaptchaApiError}，适合偏好异常流程的业务代码。
   * @param request 图片与类型等识别参数。
   * @param options 单次请求控制。
   * @returns 成功识别的数据，记录流程与 `recognize` 共用。
   */
  async recognizeOrThrow(
    request: RecognizeRequest,
    options?: ZkCaptchaRequestOptions,
  ): Promise<RecognizeData> {
    return unwrap(await this.recognize(request, options));
  }

  /**
   * 按本地明细来源反馈错误：自定义算法只标记本地，平台记录才发送线上报错。
   * @param request 当前账号与接口下的本地记录 UUID。
   * @param options 单次平台请求控制；已取消的反馈不执行本地更新。
   * @returns 统一反馈响应；记录关闭、不存在或存储失败均返回失败，不发送平台请求。
   */
  async reportError(
    request: ReportErrorRequest,
    options?: ZkCaptchaRequestOptions,
  ): Promise<ZkCaptchaResponse<ReportErrorData>> {
    return this.track(async () => {
      if (typeof request?.recordId !== "string" || !request.recordId.trim()) {
        return failure("INVALID_REPORT_REQUEST", "错误反馈需要本地记录 UUID（recordId）。", "");
      }
      if (options?.signal?.aborted) return failure("ABORTED", "错误反馈已取消。", "");
      if (this.history === undefined)
        return failure("HISTORY_DISABLED", "错误反馈需要开启本地记录。", "");
      let record: RecognitionDetail | null;
      try {
        record = this.history.getRecord(request.recordId);
        if (record === null)
          return failure("RECORD_NOT_FOUND", "记录不存在、已过期或不属于当前账号及接口。", "");
        if (record.algorithm !== null) {
          if (!this.history.markRecognitionError(record.id))
            return failure("RECORD_NOT_FOUND", "本地记录已失效。", "");
          return {
            success: true,
            code: "0",
            message: "本地识别错误已标记。",
            data: { recordId: record.id, destination: "local", result: "本地识别错误已标记。" },
          };
        }
      } catch (error) {
        return failure("HISTORY_ERROR", errorMessage(error), "");
      }
      if (!record.success || !record.captchaId)
        return failure("INVALID_CAPTCHA_ID", "该记录没有可上报的平台识别编号。", "");
      const response = await this.requestJson(
        "/reporterror.json",
        { body: { id: record.captchaId }, method: "POST", options },
        isReportErrorData,
      );
      return response.success
        ? {
            ...response,
            data: {
              recordId: record.id,
              destination: "platform",
              result: response.data.result ?? "平台报错成功。",
            },
          }
        : response;
    });
  }

  /**
   * 上报错误识别结果，并只返回成功响应中的 `data`。
   *
   * 当请求失败时抛出 {@link ZkCaptchaApiError}。
   * @param request 本地记录 UUID，分流规则与 reportError 相同。
   * @param options 单次请求控制。
   * @returns 成功的报错数据。
   */
  async reportErrorOrThrow(
    request: ReportErrorRequest,
    options?: ZkCaptchaRequestOptions,
  ): Promise<ReportErrorData> {
    return unwrap(await this.reportError(request, options));
  }

  /**
   * 调用 `/queryAccountInfo.json` 查询账号余额和识别统计。
   * @param options 单次请求控制。
   * @returns 平台实际账号信息，与本地估算独立。
   */
  async queryAccountInfo(
    options?: ZkCaptchaRequestOptions,
  ): Promise<ZkCaptchaResponse<AccountInfoData>> {
    const searchParams = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    return this.track(() =>
      this.requestJson(
        `/queryAccountInfo.json?${searchParams.toString()}`,
        {
          method: "GET",
          options,
        },
        isAccountInfoData,
      ),
    );
  }

  /**
   * 查询账号信息，并只返回成功响应中的 `data`。
   *
   * 当请求失败时抛出 {@link ZkCaptchaApiError}。
   * @param options 单次请求控制。
   * @returns 成功的账号信息。
   */
  async queryAccountInfoOrThrow(options?: ZkCaptchaRequestOptions): Promise<AccountInfoData> {
    return unwrap(await this.queryAccountInfo(options));
  }

  /**
   * 读取当前账号与接口的本地分页，查询不会访问识别平台。
   * @param filter 时间、类型、状态及分页条件。
   * @returns 不含图片的列表与总数，存储未开启或查询失败时抛错。
   */
  async getRecords(filter?: HistoryListFilter): Promise<RecognitionPage> {
    return this.track(() => this.getHistory().getRecords(filter));
  }

  /**
   * 读取当前账号的一条记录及图片。
   * @param id 本地 UUID，不是平台识别编号。
   * @returns 带图片的明细，记录不存在时返回 `null`。
   */
  async getRecord(id: string): Promise<RecognitionDetail | null> {
    return this.track(() => this.getHistory().getRecord(id));
  }

  /**
   * 读取总体、UTC 日期和类型统计，未知价格不作为零费用。
   * @param filter 与明细一致的时间、类型及状态条件。
   * @returns 本地记录统计，不包含平台套餐优惠和退款调整。
   */
  async getStats(filter?: HistoryFilter): Promise<RecognitionStats> {
    return this.track(() => this.getHistory().getStats(filter));
  }

  /**
   * 停止接收新调用，等待已接收的请求和记录完成后释放数据库连接。
   * @returns 关闭完成的 Promise，可重复调用，不删除本地数据。
   */
  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= (async () => {
      await Promise.allSettled(this.pending);
      this.history?.close();
    })();
    return this.closePromise;
  }

  /**
   * 统一登记正在处理的调用，使关闭不会抢先释放记录连接。
   * @param operation 关闭前已接收的同步或异步操作。
   * @returns 原操作结果，关闭后拒绝新调用。
   */
  private track<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("客户端已关闭，不能发起新调用。"));
    }
    const pending = Promise.resolve().then(operation);
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }

  /**
   * 显式拒绝关闭记录后的查询，避免把未记录误报为零记录。
   * @returns 已启用的本地存储。
   */
  private getHistory(): HistoryStore {
    if (this.history === undefined) {
      throw new Error("记录功能未开启，请移除 history: false 后重试。");
    }
    return this.history;
  }

  /**
   * 显式分发算法，不匹配或失败时不会触发平台回退。
   * @param id 调用方选择的算法标识。
   * @param request 已转换图片的标准算法请求。
   * @param options 单次取消和超时配置。
   * @returns 与平台识别相同的标准响应。
   */
  private async recognizeAlgorithm(
    id: string,
    request: ZkCaptchaAlgorithmRequest,
    options?: ZkCaptchaRequestOptions,
  ): Promise<ZkCaptchaResponse<RecognizeData>> {
    const algorithm = this.algorithms.get(id);
    if (algorithm === undefined) {
      return failure("ALGORITHM_NOT_FOUND", `未注册算法：${id}。`, "");
    }
    if (!algorithm.typeids.has(request.typeid)) {
      return failure("UNSUPPORTED_TYPE", `算法 ${id} 不支持类型 ${request.typeid}。`, "");
    }
    if (algorithm.kind === "http") {
      return this.requestJson(
        "",
        {
          url: algorithm.url,
          headers: algorithm.headers,
          body: request,
          method: "POST",
          options,
        },
        isRecognizeData,
      );
    }

    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const abort = createRequestAbort(timeoutMs, options?.signal);
    let onAbort: (() => void) | undefined;
    try {
      abort.signal.throwIfAborted();
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abort.signal.reason);
        abort.signal.addEventListener("abort", onAbort, { once: true });
      });
      // race 持有回调的拒绝处理，超时后的晚到结果不会再次写入或成为未处理异常。
      const operation = Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        return algorithm.recognize(request, { signal: abort.signal });
      });
      const payload = await Promise.race([operation, interrupted]);
      abort.signal.throwIfAborted();
      return normalizeZkCaptchaResponse(payload, isRecognizeData);
    } catch (error) {
      if (abort.timedOut()) {
        return failure("TIMEOUT", `算法 ${id} 超过 ${timeoutMs}ms 未完成，已自动中断。`, "");
      }
      if (abort.signal.aborted) {
        return failure("ABORTED", `算法 ${id} 已被外部信号中断。`, "");
      }
      return failure("ALGORITHM_ERROR", errorMessage(error), "");
    } finally {
      if (onAbort !== undefined) abort.signal.removeEventListener("abort", onAbort);
      abort.cleanup();
    }
  }

  /**
   * 只转换一次图片，记录复用实际发送的请求体。
   * @param request 调用方提供的识别参数。
   * @returns 官方 JSON 请求体。
   */
  private async createRecognizeBody(request: RecognizeRequest): Promise<JsonObject> {
    const body: JsonObject = {
      username: this.username,
      password: this.password,
      image: await imageToBase64(request.image),
    };

    copyStringValue(body, "typeid", request.typeid);
    copyStringValue(body, "angle", request.angle);
    copyStringValue(body, "step", request.step);
    copyStringValue(body, "typename", request.typename);
    copyStringValue(body, "remark", request.remark);
    copyStringValue(body, "content", request.content);
    copyStringValue(body, "modelid", request.modelid);

    if (request.imageback !== undefined) {
      body.imageback = await imageToBase64(request.imageback);
    }

    if (request.title_image !== undefined) {
      body.title_image = await imageToBase64(request.title_image);
    }

    if (request.extra !== undefined) {
      for (const [key, value] of Object.entries(request.extra)) {
        if (value !== undefined) {
          body[key] = value === null ? null : String(value);
        }
      }
    }

    return body;
  }

  /**
   * 将传输异常转换为判别联合，并校验成功载荷，避免未经验证的数据进入记录。
   * @param path 平台 API 路径；显式 url 覆盖此路径。
   * @param request 请求体、方法与中断配置。
   * @param isData 对应接口的成功数据校验器。
   * @returns 类型安全的成功或失败响应。
   */
  private async requestJson<TData>(
    path: string,
    request: {
      body?: object | undefined;
      method: "GET" | "POST";
      options?: ZkCaptchaRequestOptions | undefined;
      url?: string;
      headers?: Readonly<Record<string, string>>;
    },
    isData: (value: unknown) => value is TData,
  ): Promise<ZkCaptchaResponse<TData>> {
    if (request.url === undefined && (!this.username || !this.password)) {
      return failure("MISSING_CREDENTIALS", "调用平台接口需要配置 username 和 password。", "");
    }
    const timeoutMs = request.options?.timeoutMs ?? this.timeoutMs;
    const abort = createRequestAbort(timeoutMs, request.options?.signal);
    const init: RequestInit = {
      method: request.method,
      signal: abort.signal,
      redirect: "manual",
    };

    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
      init.headers = {
        "content-type": "application/json;charset=UTF-8",
        ...request.headers,
      };
    }

    try {
      abort.signal.throwIfAborted();
      const response = await this.fetchImpl(request.url ?? this.createUrl(path), init);

      if ((response.status >= 300 && response.status < 400) || response.redirected) {
        void response.body?.cancel().catch(() => {});
        return failure("REDIRECT_BLOCKED", "接口请求不允许重定向。", "");
      }

      const text = await this.readResponseText(response);
      if (text === null) {
        return failure(
          "RESPONSE_TOO_LARGE",
          `接口响应体超过 ${this.maxResponseBytes} 字节限制。`,
          "",
        );
      }
      const payload = parseJson(text);

      if (!payload.ok) {
        return failure("INVALID_JSON", payload.message, text);
      }

      if (!response.ok) {
        return httpFailure(response, payload.value);
      }

      return normalizeZkCaptchaResponse(payload.value, isData);
    } catch (error) {
      if (abort.timedOut()) {
        return failure("TIMEOUT", `接口请求超过 ${timeoutMs}ms 未完成，已自动中断。`, "");
      }

      if (abort.signal.aborted || isAbortError(error)) {
        return failure("ABORTED", "接口请求已被外部信号中断。", "");
      }

      return failure("NETWORK_ERROR", errorMessage(error), "");
    } finally {
      abort.cleanup();
    }
  }

  /**
   * 逐块限制解压后的响应字节，保留跨块 UTF-8 解码和 BOM 处理。
   * @param response 尚未读取的响应。
   * @returns 完整文本，声明或实际大小超限时返回 null；读取失败由请求层处理。
   */
  private async readResponseText(response: Response): Promise<string | null> {
    if (Number(response.headers.get("content-length")) > this.maxResponseBytes) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return "";

    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        size += value.byteLength;
        if (size > this.maxResponseBytes) return null;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      // 取消失败不能覆盖超限或原始读取错误，也不等待自定义流的取消回调。
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  /**
   * 保留自定义基础地址中的路径前缀。
   * @param path API 相对路径。
   * @returns 完整请求地址。
   */
  private createUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return `${this.baseUrl}${normalizedPath}`;
  }
}

/**
 * 将图片输入转换为官方接口要求的纯 base64 字符串。
 *
 * 字符串输入去掉 Data URL 前缀，二进制使用 Node/Bun 的 Buffer 编码。
 * @param image 原生图片输入。
 * @returns 不含 Data URL 前缀的 base64 字符串。
 */
export const imageToBase64 = async (image: ImageInput): Promise<string> => {
  if (typeof image === "string") {
    return stripDataUrlPrefix(image.trim());
  }

  if (isBlobLike(image)) {
    return bytesToBase64(new Uint8Array(await image.arrayBuffer()));
  }

  if (image instanceof ArrayBuffer) {
    return bytesToBase64(new Uint8Array(image));
  }

  if (ArrayBuffer.isView(image)) {
    return bytesToBase64(new Uint8Array(image.buffer, image.byteOffset, image.byteLength));
  }

  throw new TypeError(
    "不支持的图片输入类型。请传入 base64、ArrayBuffer、Uint8Array、Blob 或 File。",
  );
};

/**
 * 为本地和 HTTP 算法构造同一请求，不注入平台凭证，也不展开 extra。
 * @param request 原始识别参数。
 * @returns 图片转换后的独立请求对象。
 */
const normalizeAlgorithmRequest = async (
  request: RecognizeRequest,
): Promise<ZkCaptchaAlgorithmRequest> => {
  const normalized: ZkCaptchaAlgorithmRequest = {
    image: await imageToBase64(request.image),
    typeid: String(request.typeid ?? 3),
  };
  if (request.imageback !== undefined)
    normalized.imageback = await imageToBase64(request.imageback);
  if (request.title_image !== undefined)
    normalized.title_image = await imageToBase64(request.title_image);
  if (request.angle !== undefined) normalized.angle = request.angle;
  if (request.step !== undefined) normalized.step = request.step;
  if (request.typename !== undefined) normalized.typename = request.typename;
  if (request.remark !== undefined) normalized.remark = request.remark;
  if (request.content !== undefined) normalized.content = request.content;
  if (request.modelid !== undefined) normalized.modelid = request.modelid;
  if (request.extra !== undefined) {
    normalized.extra = Object.fromEntries(
      Object.entries(request.extra).filter(([, value]) => value !== undefined),
    );
  }
  return normalized;
};

/**
 * 自定义地址优先于内置别名。
 * @param options 客户端配置。
 * @returns 保留协议和路径前缀的基础地址。
 */
const resolveBaseUrl = (options: ZkCaptchaClientOptions): string => {
  if (options.baseUrl !== undefined) {
    return normalizeBaseUrl(options.baseUrl);
  }

  return ZkCaptchaEndpoints[options.endpoint ?? DEFAULT_ENDPOINT];
};

/**
 * 为无协议地址补全 HTTPS，保留显式 HTTP/HTTPS 并移除查询和片段。
 * @param baseUrl 用户配置的服务地址。
 * @returns 不以斜线结尾且不包含 URL 凭据的基础地址。
 */
const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();

  if (trimmed.length === 0) {
    throw new TypeError("baseUrl 不能为空。");
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const url = new URL(withProtocol);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl 仅支持 HTTP 或 HTTPS 协议。");
  }
  if (url.username || url.password) {
    throw new TypeError("baseUrl 不能包含 URL 用户名或密码。");
  }

  url.hash = "";
  url.search = "";

  return url.toString().replace(/\/+$/, "");
};

function copyStringValue(body: JsonObject, key: string, value: RequestPrimitive | undefined): void {
  if (value !== undefined) {
    body[key] = value === null ? null : String(value);
  }
}

function stripDataUrlPrefix(value: string): string {
  const commaIndex = value.indexOf(",");

  if (/^data:/i.test(value) && commaIndex !== -1) {
    return value.slice(commaIndex + 1);
  }

  return value;
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof Blob !== "undefined" && value instanceof Blob && typeof value.arrayBuffer === "function"
  );
}

/**
 * 复用 Node/Bun 的原生编码，不提供浏览器兜底。
 * @param bytes 图片字节。
 * @returns 纯 base64 字符串。
 */
const bytesToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

function createRequestAbort(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  cleanup: () => void;
  signal: AbortSignal;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    onExternalAbort();
  } else if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    cleanup() {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      if (externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    },
    signal: controller.signal,
    timedOut: () => timedOut,
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (text.trim().length === 0) {
    return {
      ok: false,
      message: "接口响应体为空，无法解析 JSON。",
    };
  }

  try {
    const value: unknown = JSON.parse(text);
    return {
      ok: true,
      value,
    };
  } catch (error) {
    return {
      ok: false,
      message: `接口响应不是合法 JSON：${errorMessage(error)}`,
    };
  }
}

/**
 * 在平台响应边界收窄成功数据，未知字段不参与本地存储。
 * @param payload 解析后的平台响应。
 * @param isData 对应接口的数据校验器。
 * @returns 可通过 success 缩窄的响应。
 */
const normalizeZkCaptchaResponse = <TData>(
  payload: unknown,
  isData: (value: unknown) => value is TData,
): ZkCaptchaResponse<TData> => {
  if (!isObject(payload) || typeof payload.success !== "boolean") {
    return failure("INVALID_RESPONSE", "接口响应缺少布尔类型的 success 字段。", payload);
  }

  if (payload.success) {
    if (!isData(payload.data)) {
      return failure("INVALID_RESPONSE", "接口成功响应中的 data 字段无效。", payload);
    }
    return {
      success: true,
      code: stringOrDefault(payload.code, "0"),
      message: stringOrDefault(payload.message, "success"),
      data: payload.data,
    };
  }

  return {
    success: false,
    code: stringOrDefault(payload.code, "-1"),
    message: stringOrDefault(payload.message, "接口请求失败。"),
    data: "data" in payload ? payload.data : "",
  };
};

/**
 * 校验识别数据，防止无效成功响应被计入已知费用。
 * @param value 未知成功载荷。
 * @returns 是否同时包含字符串结果和平台编号。
 */
const isRecognizeData = (value: unknown): value is RecognizeData =>
  isObject(value) && typeof value.result === "string" && typeof value.id === "string";

/**
 * 允许报错响应省略结果文本。
 * @param value 未知成功载荷。
 * @returns 是否符合报错数据类型。
 */
const isReportErrorData = (value: unknown): value is Partial<Pick<ReportErrorData, "result">> =>
  isObject(value) && (value.result === undefined || typeof value.result === "string");

/**
 * 校验平台余额和次数原始字符串，不进行金额浮点转换。
 * @param value 未知成功载荷。
 * @returns 是否符合账号信息类型。
 */
const isAccountInfoData = (value: unknown): value is AccountInfoData =>
  isObject(value) &&
  ["balance", "consumed", "successNum", "failNum"].every((key) => typeof value[key] === "string");

/**
 * 限定已验证支持内置 SQLite 的 Node/Bun 版本。
 * @returns 运行时有效则无返回值，否则抛出明确版本错误。
 */
const assertSupportedRuntime = (): void => {
  const bun = process.versions.bun;
  const [major = 0, minor = 0, patch = 0] = (bun ?? process.versions.node).split(".").map(Number);
  const supported =
    bun === undefined
      ? process.release.name === "node" && (major > 22 || (major === 22 && minor >= 13))
      : major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4)));
  if (!supported) {
    throw new Error("当前仅支持 Node 22.13+ 或 Bun 1.4.4+。");
  }
};

function httpFailure<TData>(
  response: Response,
  payload: unknown,
): ZkCaptchaFailureResponse<TData | unknown> {
  const message =
    isObject(payload) && typeof payload.message === "string"
      ? payload.message
      : response.statusText || `HTTP ${response.status}`;

  return failure(`HTTP_${response.status}`, message, payload);
}

function failure<TErrorData>(
  code: string,
  message: string,
  data: TErrorData,
): ZkCaptchaFailureResponse<TErrorData> {
  return {
    success: false,
    code,
    message,
    data,
  };
}

function isObject(value: unknown): value is MaybeObject {
  return typeof value === "object" && value !== null;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isAbortError(error: unknown): boolean {
  return isObject(error) && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
