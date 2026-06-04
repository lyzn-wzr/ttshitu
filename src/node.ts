import { readFile } from "node:fs/promises";
import { TtshituClient, unwrap } from "./index";
import type {
  RecognizeData,
  RecognizeRequest,
  TtshituRequestOptions,
  TtshituResponse,
} from "./types";

/**
 * 读取本地图片文件，并返回不带 Data URL 前缀的纯 base64 字符串。
 *
 * 该函数只从 `ttshitu/node` 子入口导出，主入口 `ttshitu` 不依赖 Node 文件系统模块，
 * 因而仍然可以安全用于浏览器打包。
 */
export async function fileToBase64(path: string | URL): Promise<string> {
  return (await readFile(path)).toString("base64");
}

/**
 * 从本地文件路径读取验证码图片并调用 `/predict` 识别。
 *
 * Node 应用可以从 `ttshitu/node` 导入该辅助函数：
 *
 * ```ts
 * import { recognizeFromFile } from "ttshitu/node";
 * ```
 */
export async function recognizeFromFile(
  client: TtshituClient,
  path: string | URL,
  request: Omit<RecognizeRequest, "image"> = {},
  options?: TtshituRequestOptions,
): Promise<TtshituResponse<RecognizeData>> {
  return client.recognize(
    {
      ...request,
      image: await fileToBase64(path),
    },
    options,
  );
}

/**
 * 从本地文件路径读取验证码图片并识别，只返回成功响应中的 `data`。
 *
 * 当请求失败时抛出 `TtshituApiError`。
 */
export async function recognizeFromFileOrThrow(
  client: TtshituClient,
  path: string | URL,
  request: Omit<RecognizeRequest, "image"> = {},
  options?: TtshituRequestOptions,
): Promise<RecognizeData> {
  return unwrap(await recognizeFromFile(client, path, request, options));
}
