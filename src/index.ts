import { unwrap } from "./errors";
import type {
  AccountInfoData,
  FetchLike,
  ImageInput,
  RecognizeData,
  RecognizeRequest,
  ReportErrorData,
  ReportErrorRequest,
  RequestPrimitive,
  TtshituClientOptions,
  TtshituEndpoint,
  TtshituFailureResponse,
  TtshituRequestOptions,
  TtshituResponse,
} from "./types";

export * from "./errors";
export * from "./types";

/**
 * SDK 内置的图鉴兼容接口基础地址。
 *
 * 官方 HTTP 文档使用 `http://`，因此内置域名和自定义基础地址都会按 HTTP 规范化。
 */
export const TTshituEndpoints = {
  ttshitu: "http://api.ttshitu.com",
  zhunkuai: "http://api.zhunkuai.cn",
  kuaishibie: "http://api.kuaishibie.cn",
} as const satisfies Record<TtshituEndpoint, string>;

/**
 * 使用常规 PascalCase 拼写的内置地址别名。
 */
export const TtshituEndpoints = TTshituEndpoints;

const DEFAULT_ENDPOINT: TtshituEndpoint = "ttshitu";
const DEFAULT_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;
type MaybeObject = Record<PropertyKey, unknown>;

/**
 * 浏览器安全的图鉴接口客户端。
 *
 * 客户端使用 JSON 请求和 base64 图片字段访问官方接口，因此可以在现代浏览器和 Node 18+
 * 中直接运行，不需要额外运行时依赖。
 */
export class TtshituClient {
  private readonly username: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: TtshituClientOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof fetchImpl !== "function") {
      throw new TypeError(
        "当前运行时没有可用的 fetch 实现。请使用 Node 18+、现代浏览器，或在 TtshituClientOptions 中传入 fetch。",
      );
    }

    this.username = options.username;
    this.password = options.password;
    this.baseUrl = resolveBaseUrl(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl.bind(globalThis) as FetchLike;
  }

  /**
   * 调用 `/predict` 识别验证码图片。
   *
   * 该方法不会因为接口失败、HTTP 错误、超时、JSON 解析失败或网络错误而抛出异常。
   * 调用方可以通过 `response.success` 判断并获得类型缩窄后的响应数据。
   */
  async recognize(
    request: RecognizeRequest,
    options?: TtshituRequestOptions,
  ): Promise<TtshituResponse<RecognizeData>> {
    const body = await this.createRecognizeBody(request);

    return this.requestJson<RecognizeData>("/predict", {
      body,
      method: "POST",
      options,
    });
  }

  /**
   * 调用 `/predict` 识别验证码图片，并只返回成功响应中的 `data`。
   *
   * 当请求失败时抛出 {@link TtshituApiError}，适合偏好异常流程的业务代码。
   */
  async recognizeOrThrow(
    request: RecognizeRequest,
    options?: TtshituRequestOptions,
  ): Promise<RecognizeData> {
    return unwrap(await this.recognize(request, options));
  }

  /**
   * 调用 `/reporterror.json` 上报错误识别结果。
   *
   * 官方服务会在约 5 分钟后批量处理报错返还，因此报错成功后余额不一定立刻变化。
   */
  async reportError(
    request: ReportErrorRequest,
    options?: TtshituRequestOptions,
  ): Promise<TtshituResponse<ReportErrorData>> {
    return this.requestJson<ReportErrorData>("/reporterror.json", {
      body: {
        id: request.id,
      },
      method: "POST",
      options,
    });
  }

  /**
   * 上报错误识别结果，并只返回成功响应中的 `data`。
   *
   * 当请求失败时抛出 {@link TtshituApiError}。
   */
  async reportErrorOrThrow(
    request: ReportErrorRequest,
    options?: TtshituRequestOptions,
  ): Promise<ReportErrorData> {
    return unwrap(await this.reportError(request, options));
  }

  /**
   * 调用 `/queryAccountInfo.json` 查询账号余额和识别统计。
   */
  async queryAccountInfo(
    options?: TtshituRequestOptions,
  ): Promise<TtshituResponse<AccountInfoData>> {
    const searchParams = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    return this.requestJson<AccountInfoData>(`/queryAccountInfo.json?${searchParams.toString()}`, {
      method: "GET",
      options,
    });
  }

  /**
   * 查询账号信息，并只返回成功响应中的 `data`。
   *
   * 当请求失败时抛出 {@link TtshituApiError}。
   */
  async queryAccountInfoOrThrow(options?: TtshituRequestOptions): Promise<AccountInfoData> {
    return unwrap(await this.queryAccountInfo(options));
  }

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

  private async requestJson<TData>(
    path: string,
    request: {
      body?: JsonObject | undefined;
      method: "GET" | "POST";
      options?: TtshituRequestOptions | undefined;
    },
  ): Promise<TtshituResponse<TData>> {
    const timeoutMs = request.options?.timeoutMs ?? this.timeoutMs;
    const abort = createRequestAbort(timeoutMs, request.options?.signal);
    const init: RequestInit = {
      method: request.method,
      signal: abort.signal,
    };

    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
      init.headers = {
        "content-type": "application/json;charset=UTF-8",
      };
    }

    try {
      const response = await this.fetchImpl(this.createUrl(path), init);

      const text = await response.text();
      const payload = parseJson(text);

      if (!payload.ok) {
        return failure("INVALID_JSON", payload.message, text);
      }

      if (!response.ok) {
        return httpFailure(response, payload.value);
      }

      return normalizeTtshituResponse<TData>(payload.value);
    } catch (error) {
      if (abort.timedOut()) {
        return failure("TIMEOUT", `图鉴请求超过 ${timeoutMs}ms 未完成，已自动中断。`, "");
      }

      if (isAbortError(error)) {
        return failure("ABORTED", "图鉴请求已被外部信号中断。", "");
      }

      return failure("NETWORK_ERROR", errorMessage(error), "");
    } finally {
      abort.cleanup();
    }
  }

  private createUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return `${this.baseUrl}${normalizedPath}`;
  }
}

/**
 * 将图片输入转换为官方接口要求的纯 base64 字符串。
 *
 * 字符串输入会自动去掉 Data URL 前缀；二进制输入会根据当前运行时能力使用
 * `Buffer` 或 `btoa` 编码。
 */
export async function imageToBase64(image: ImageInput): Promise<string> {
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
}

function resolveBaseUrl(options: TtshituClientOptions): string {
  if (options.baseUrl !== undefined) {
    return normalizeBaseUrl(options.baseUrl);
  }

  return TTshituEndpoints[options.endpoint ?? DEFAULT_ENDPOINT];
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();

  if (trimmed.length === 0) {
    throw new TypeError("baseUrl 不能为空。");
  }

  const withoutProtocol = trimmed.replace(/^[a-z][a-z\d+\-.]*:\/\//i, "");
  const withProtocol = `http://${withoutProtocol}`;

  const url = new URL(withProtocol);

  if (url.protocol !== "http:") {
    throw new TypeError("baseUrl 必须能规范化为 http 地址。");
  }

  url.hash = "";
  url.search = "";

  return url.toString().replace(/\/+$/, "");
}

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

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  if (typeof btoa !== "function") {
    throw new TypeError("当前运行时没有可用的 base64 编码能力。");
  }

  return btoa(binary);
}

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
      message: "图鉴响应体为空，无法解析 JSON。",
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(text) as unknown,
    };
  } catch (error) {
    return {
      ok: false,
      message: `图鉴响应不是合法 JSON：${errorMessage(error)}`,
    };
  }
}

function normalizeTtshituResponse<TData>(payload: unknown): TtshituResponse<TData> {
  if (!isObject(payload) || typeof payload.success !== "boolean") {
    return failure("INVALID_RESPONSE", "图鉴响应缺少布尔类型的 success 字段。", payload);
  }

  if (payload.success) {
    return {
      success: true,
      code: stringOrDefault(payload.code, "0"),
      message: stringOrDefault(payload.message, "success"),
      data: payload.data as TData,
    };
  }

  return {
    success: false,
    code: stringOrDefault(payload.code, "-1"),
    message: stringOrDefault(payload.message, "图鉴请求失败。"),
    data: "data" in payload ? payload.data : "",
  };
}

function httpFailure<TData>(
  response: Response,
  payload: unknown,
): TtshituFailureResponse<TData | unknown> {
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
): TtshituFailureResponse<TErrorData> {
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
