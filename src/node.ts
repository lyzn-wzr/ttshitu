import { readFile } from "node:fs/promises";
import { unwrap } from "./errors";
import type { ZkCaptchaClient } from "./index";
import type {
  RecognizeData,
  RecognizeRequest,
  ZkCaptchaRequestOptions,
  ZkCaptchaResponse,
} from "./types";

/**
 * 读取本地图片文件，并返回不带 Data URL 前缀的纯 base64 字符串。
 *
 * @param path 文件路径或 file URL。
 * @returns 纯 base64 字符串，读取失败时抛出文件系统错误。
 */
export const fileToBase64 = async (path: string | URL): Promise<string> =>
  (await readFile(path)).toString("base64");

/**
 * 从本地文件路径读取验证码图片并调用 `/predict` 识别。
 *
 * @param client 已创建的客户端。
 * @param path 文件路径或 file URL。
 * @param request 除主图外的识别参数。
 * @param options 单次请求控制。
 * @returns 识别响应，仅由客户端记录一次；文件读取失败不发起请求。
 */
export const recognizeFromFile = async (
  client: ZkCaptchaClient,
  path: string | URL,
  request: Omit<RecognizeRequest, "image"> = {},
  options?: ZkCaptchaRequestOptions,
): Promise<ZkCaptchaResponse<RecognizeData>> => {
  return client.recognize(
    {
      ...request,
      image: await fileToBase64(path),
    },
    options,
  );
};

/**
 * 从本地文件路径读取验证码图片并识别，只返回成功响应中的 `data`。
 *
 * 当请求失败时抛出 `ZkCaptchaApiError`。
 * @param client 已创建的客户端。
 * @param path 文件路径或 file URL。
 * @param request 除主图外的识别参数。
 * @param options 单次请求控制。
 * @returns 成功的识别数据，与非抛错辅助方法共用记录流程。
 */
export const recognizeFromFileOrThrow = async (
  client: ZkCaptchaClient,
  path: string | URL,
  request: Omit<RecognizeRequest, "image"> = {},
  options?: ZkCaptchaRequestOptions,
): Promise<RecognizeData> => {
  return unwrap(await recognizeFromFile(client, path, request, options));
};
