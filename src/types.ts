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
 * Node/Bun 原生图片输入类型，`Buffer` 和 `File` 分别兼容 `Uint8Array` 和 `Blob`。
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
 * 测试、代理或监控封装可以通过该函数替换默认的
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
   * 该值优先级高于 {@link endpoint}。没有写协议时默认补全为 `https://`，
   * 显式指定的 HTTP/HTTPS 协议会保留；不支持其他协议或 URL 内嵌用户名、密码。
   */
  baseUrl?: string;

  /**
   * 默认请求超时时间，单位为毫秒。
   *
   * 默认值为 `60000`，与官方文档建议的 60 秒 HTTP 超时时间保持一致。
   */
  timeoutMs?: number;

  /** 响应体最大字节数，默认 65536（64 KiB），须为正安全整数；限制解压后的实际字节，不限制上传图片。 */
  maxResponseBytes?: number;

  /**
   * 可选的 `fetch` 实现，默认使用当前运行时的 `globalThis.fetch`。
   * 自定义实现须遵守 `redirect: "manual"`、中断信号，并返回未预读的响应流。
   */
  fetch?: FetchLike;

  /** 本地记录默认开启；设为 `false` 时不访问文件系统。 */
  history?: false | HistoryOptions;
}

/** 本地 SQLite 记录配置；相对目录从调用方项目根目录解析。 */
export interface HistoryOptions {
  /** 保存目录，默认 `.zk-captcha`，数据库文件名固定为 `history.sqlite`。 */
  directory?: string;
  /** 保留最近 N×24 小时的记录及图片，须为正整数；未设置则永久保留，写入和查询时自动清理。 */
  retentionDays?: number;
  /** 按类型覆盖每次识别的固定价格，单位元，接受非负且最多六位小数的字符串。 */
  prices?: Readonly<Record<string, string>>;
  /** 识别时保存或清理失败的回调，默认输出警告；不影响识别结果，查询失败则直接抛错。 */
  onError?: (error: Error) => void;
}

/** 明细与统计共用筛选条件，时间按识别开始时间计算。 */
export interface HistoryFilter {
  /** 起始时间，包含边界，传入带时区的 ISO 时间字符串。 */
  from?: string;
  /** 结束时间，不包含边界，传入带时区的 ISO 时间字符串。 */
  to?: string;
  /** 识别类型，数字与对应字符串等价。 */
  typeid?: CaptchaTypeId;
  /** 仅查询成功或失败记录，省略时包含两者。 */
  success?: boolean;
}

/** 时间倒序分页；同一时间按本地 ID 倒序，保证排序稳定。 */
export interface HistoryListFilter extends HistoryFilter {
  /** 单页条数，默认 20，允许 1～100 的整数。 */
  limit?: number;
  /** 跳过条数，默认 0，允许非负安全整数。 */
  offset?: number;
}

/** 价格已在写入时确定；未知费用不能作为免费识别。 */
export type PricingSource = "official" | "custom" | "unknown";

/** 不含图片的识别记录，列表查询不会加载 BLOB。 */
export interface RecognitionRecord {
  /** 本地 UUID，用于读取单条明细。 */
  id: string;
  /** 平台返回的识别编号，失败时为 `null`。 */
  captchaId: string | null;
  /** 实际发送的类型编号，未传时记录官方默认类型 `3`。 */
  typeid: string;
  /** 已知类型的中文名称，自定义类型为 `null`。 */
  typeName: string | null;
  /** 识别开始时间，UTC ISO 字符串。 */
  startedAt: string;
  /** 图片转换与请求耗时，单位毫秒，不含本地写入。 */
  durationMs: number;
  /** 平台或 SDK 请求结果，不能代表业务验证结果。 */
  success: boolean;
  /** 成功识别的文本、坐标或偏移量，失败时为 `null`。 */
  result: string | null;
  /** 平台或 SDK 返回的状态码。 */
  code: string;
  /** 平台或 SDK 返回的状态说明。 */
  message: string;
  /** 本次估算费用，单位元、固定六位小数；无法估算时为 `null`。 */
  price: string | null;
  /** 本次费用使用的规则来源，历史记录不会随配置变更重算。 */
  pricingSource: PricingSource;
}

/** 完整明细中的图片为原始二进制，可写入文件或由业务后端返回。 */
export interface RecognitionDetail extends RecognitionRecord {
  /** 实际发送的主图；扩展字段将图片覆盖为无效值时为 `null`。 */
  image: Uint8Array | null;
  /** 实际发送的背景图，未提供时为 `null`。 */
  imageback: Uint8Array | null;
  /** 实际发送的标题图，未提供时为 `null`。 */
  title_image: Uint8Array | null;
}

/** 同一 SQLite 读取快照内的明细分页。 */
export interface RecognitionPage {
  /** 当前页的记录，不含图片。 */
  items: RecognitionRecord[];
  /** 符合筛选条件的总记录数，与分页偏移无关。 */
  total: number;
}

/** 本地已保存记录的统计，不代表平台实际账单。 */
export interface RecognitionSummary {
  /** 保存的识别请求总数。 */
  total: number;
  /** 请求成功次数。 */
  successCount: number;
  /** 请求失败次数。 */
  failureCount: number;
  /** 成功比例，范围 0～1；无记录时为 0。 */
  successRate: number;
  /** 所有匹配请求的平均耗时，单位毫秒；无记录时为 0。 */
  averageDurationMs: number;
  /** 仅累加价格已知的费用，单位元、固定六位小数。 */
  estimatedCost: string;
  /** 费用未知的记录数，包含失败请求。 */
  unknownPriceCount: number;
}

/** 总体、UTC 日期和类型统计使用相同筛选条件与读取快照。 */
export interface RecognitionStats {
  /** 全部匹配记录的汇总。 */
  summary: RecognitionSummary;
  /** 按 UTC 日期升序排列的汇总，日期格式 `YYYY-MM-DD`。 */
  byDay: Array<RecognitionSummary & { /** UTC 日期。 */ day: string }>;
  /** 按类型编号字典序排列的汇总。 */
  byType: Array<
    RecognitionSummary & {
      /** 识别类型编号。 */
      typeid: string;
      /** 已知类型名称。 */
      typeName: string | null;
    }
  >;
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
