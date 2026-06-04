/**
 * SDK 内置的接口域名别名。
 *
 * 当业务需要走自己的后端代理、灰度域名，或者兼容图鉴接口协议的私有服务时，
 * 可以通过 {@link ZkCaptchaClientOptions.baseUrl} 传入完整基础地址覆盖这里的别名。
 */
export type ZkCaptchaEndpoint = "ttshitu" | "zhunkuai" | "kuaishibie";

/**
 * 图鉴 HTTP 文档中列出的验证码类型编号。
 *
 * 官方接口最终接收字符串形式的 `typeid`。为了让调用更自然，SDK 同时接受数字和字符串，
 * 并在发送 JSON 请求前统一转换为字符串。
 */
export type KnownCaptchaTypeId =
  | 1
  | 1001
  | 2
  | 1002
  | 3
  | 1003
  | 4
  | 7
  | 66
  | 11
  | 1005
  | 5
  | 16
  | 32
  | 29
  | 1029
  | 2029
  | 19
  | 20
  | 21
  | 22
  | 27
  | 48
  | 18
  | 33
  | 34
  | 3400
  | 1033
  | 53;

/**
 * `/predict` 识别接口接受的验证码类型编号。
 *
 * 已知枚举值见 {@link KnownCaptchaTypeId}。如果官方后续新增类型，或者你的兼容服务
 * 暴露了自定义模型编号，也可以继续传入任意字符串或数字。
 */
export type CaptchaTypeId =
  | KnownCaptchaTypeId
  | (number & Record<never, never>)
  | (string & Record<never, never>);

/**
 * 浏览器安全入口接受的图片输入类型。
 *
 * 字符串可以是纯 base64，也可以是 `data:image/png;base64,...` 这样的 Data URL。
 * 二进制输入会在发送 JSON 请求前自动转换为官方要求的纯 base64 字符串。
 */
export type ImageInput = string | ArrayBuffer | Uint8Array | Blob;

/**
 * 额外请求字段支持的基础值类型。
 */
export type RequestPrimitive = string | number | boolean | null;

/**
 * 单次请求的控制参数。
 */
export interface ZkCaptchaRequestOptions {
  /**
   * 外部传入的中断信号，用于从业务代码主动取消当前请求。
   */
  signal?: AbortSignal;

  /**
   * 当前请求的超时时间，单位为毫秒。
   *
   * 不传时使用客户端默认值。传入 `0` 或负数会关闭本次请求的超时控制。
   */
  timeoutMs?: number;
}

/**
 * SDK 接受的最小 `fetch` 兼容函数签名。
 *
 * 测试、代理、监控封装，或者非标准运行时都可以通过该函数替换默认的
 * `globalThis.fetch`。
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * {@link ZkCaptchaClient} 构造参数。
 */
export interface ZkCaptchaClientOptions {
  /**
   * 图鉴账号用户名。
   */
  username: string;

  /**
   * 图鉴账号密码。
   */
  password: string;

  /**
   * 内置接口域名别名，默认值为 `"ttshitu"`。
   */
  endpoint?: ZkCaptchaEndpoint;

  /**
   * 自定义 API 基础地址。
   *
   * 该值优先级高于 {@link endpoint}。如果没有写协议，SDK 会按官方文档默认补全为
   * `http://`，例如 `api.zhunkuai.cn` 会被规范化为 `http://api.zhunkuai.cn`。
   * 如果传入的地址已经包含其他协议，SDK 也会统一改写为官方文档使用的 HTTP。
   */
  baseUrl?: string;

  /**
   * 默认请求超时时间，单位为毫秒。
   *
   * 默认值为 `60000`，与官方文档建议的 60 秒 HTTP 超时时间保持一致。
   */
  timeoutMs?: number;

  /**
   * 可选的 `fetch` 实现，默认使用当前运行时的 `globalThis.fetch`。
   */
  fetch?: FetchLike;
}

/**
 * 通用图片识别接口 `/predict` 的请求参数。
 */
export interface RecognizeRequest {
  /**
   * 主验证码图片，官方接口必填。
   */
  image: ImageInput;

  /**
   * 验证码类型编号。不传时官方服务端按默认类型 `3` 处理。
   */
  typeid?: CaptchaTypeId;

  /**
   * 背景图。部分双图识别类型需要传入，例如 `1029`、`2029` 或部分滑块拼图类型。
   */
  imageback?: ImageInput;

  /**
   * 标题图片，快速点选等类型需要时传入。
   */
  title_image?: ImageInput;

  /**
   * 旋转类型的旋转角度。
   */
  angle?: string | number;

  /**
   * 旋转类型每次尝试的步进角度。
   */
  step?: string | number;

  /**
   * 无感学习类型 `7` 使用的自定义子类型名称。
   */
  typename?: string;

  /**
   * 备注或识别提示，例如计算题结果、点选顺序或其他辅助说明。
   */
  remark?: string;

  /**
   * 快速点选类型的标题文本内容。
   */
  content?: string;

  /**
   * 自定义模型编号。兼容图鉴协议的定制模型服务可以使用该字段。
   */
  modelid?: string | number;

  /**
   * 额外 JSON 字段，用于兼容官方后续新增参数或私有扩展参数。
   */
  extra?: Record<string, RequestPrimitive | undefined>;
}

/**
 * `/predict` 成功响应中的 `data` 数据。
 */
export interface RecognizeData {
  /**
   * 识别结果，可能是文本、坐标、滑块偏移量或其他由识别类型决定的字符串。
   */
  result: string;

  /**
   * 本次识别记录编号。识别结果错误时，将该编号传给 `reportError` 进行报错。
   */
  id: string;
}

/**
 * 报错接口 `/reporterror.json` 的请求参数。
 */
export interface ReportErrorRequest {
  /**
   * 成功识别响应返回的 `id`。
   */
  id: string;
}

/**
 * `/reporterror.json` 成功响应中的 `data` 数据。
 */
export interface ReportErrorData {
  /**
   * 服务端返回的报错结果文本，通常是“报错成功”或兼容域名返回的等价文案。
   */
  result?: string;
}

/**
 * `/queryAccountInfo.json` 成功响应中的 `data` 数据。
 */
export interface AccountInfoData {
  /**
   * 实时账号余额。
   */
  balance: string;

  /**
   * 实时累计消费金额。
   */
  consumed: string;

  /**
   * 累计识别成功次数。
   */
  successNum: string;

  /**
   * 累计识别失败次数。
   */
  failNum: string;
}

/**
 * 图鉴成功响应包装结构。
 */
export interface ZkCaptchaSuccessResponse<TData> {
  success: true;
  code: string;
  message: string;
  data: TData;
}

/**
 * 图鉴失败响应包装结构。
 *
 * 非抛错方法会把接口失败、HTTP 错误、JSON 解析错误、超时和网络错误统一表示为该结构。
 */
export interface ZkCaptchaFailureResponse<TErrorData = unknown> {
  success: false;
  code: string;
  message: string;
  data: TErrorData;
}

/**
 * 非抛错方法返回的判别联合类型。
 *
 * 通过判断 `response.success`，TypeScript 可以自动把 `response.data` 缩窄为成功或失败数据。
 */
export type ZkCaptchaResponse<TData, TErrorData = unknown> =
  | ZkCaptchaSuccessResponse<TData>
  | ZkCaptchaFailureResponse<TErrorData>;
