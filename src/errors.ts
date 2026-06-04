import type { TtshituFailureResponse, TtshituResponse } from "./types";

/**
 * `unwrap` 和 `*OrThrow` 辅助方法在图鉴请求失败时抛出的异常类型。
 *
 * 该异常会保留原始失败响应，业务代码可以通过 `error.response` 读取 `code`、
 * `message` 和 `data`，用于日志记录、错误提示或分支处理。
 */
export class TtshituApiError<TErrorData = unknown> extends Error {
  /**
   * 非抛错 API 返回的原始失败响应。
   */
  readonly response: TtshituFailureResponse<TErrorData>;

  /**
   * 服务端或 SDK 生成的错误码。
   */
  readonly code: string;

  constructor(response: TtshituFailureResponse<TErrorData>) {
    super(response.message || `图鉴请求失败，错误码：${response.code}`);
    this.name = "TtshituApiError";
    this.response = response;
    this.code = response.code;
  }
}

/**
 * 返回成功响应中的 `data`，或在失败时抛出 {@link TtshituApiError}。
 *
 * 当业务边界使用非抛错方法接收完整响应，而内部逻辑更适合使用异常流程时，可以用该函数
 * 将判别联合响应转换成普通成功数据。
 */
export function unwrap<TData, TErrorData = unknown>(
  response: TtshituResponse<TData, TErrorData>,
): TData {
  if (response.success) {
    return response.data;
  }

  throw new TtshituApiError(response);
}
