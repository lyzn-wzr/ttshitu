import { getTypeName } from "./pricing";
import type { ZkCaptchaAlgorithm, ZkCaptchaAlgorithmHandler } from "./types";

/** 客户端私有配置快照，类型编号已统一为字符串。 */
export type PreparedAlgorithm = {
  /** 写入历史记录的独立类型名称。 */
  name: string;
} & (
  | {
      /** 本地算法。 */
      kind: "local";
      /** 识别回调。 */
      recognize: ZkCaptchaAlgorithmHandler;
    }
  | {
      /** HTTP 算法。 */
      kind: "http";
      /** 完整地址。 */
      url: string;
      /** 请求头快照。 */
      headers: Readonly<Record<string, string>>;
    }
);

/**
 * 在构造时校验并复制算法配置，调用方后续修改配置不会改变客户端。
 * @param algorithms 按专属类型编号注册的算法。
 * @returns 不继承对象原型键的算法映射。
 */
export const prepareAlgorithms = (
  algorithms: Readonly<Record<string, ZkCaptchaAlgorithm>> = {},
): ReadonlyMap<string, PreparedAlgorithm> => {
  if (typeof algorithms !== "object" || algorithms === null || Array.isArray(algorithms)) {
    throw new TypeError("algorithms 必须是按专属 typeid 注册的算法对象。");
  }
  const result = new Map<string, PreparedAlgorithm>();
  for (const [id, algorithm] of Object.entries(algorithms)) {
    if (
      id.trim() === "" ||
      typeof algorithm !== "object" ||
      algorithm === null ||
      Array.isArray(algorithm)
    ) {
      throw new TypeError("算法 typeid 不能为空，配置必须是对象。");
    }
    if (getTypeName(id) !== null) {
      throw new TypeError(`算法 typeid ${id} 已被线上类型占用。`);
    }
    if (typeof algorithm.name !== "string" || algorithm.name.trim() === "") {
      throw new TypeError(`算法 ${id} 的 name 必须是非空字符串。`);
    }
    const name = algorithm.name;
    if (algorithm.kind === "local" && typeof algorithm.recognize === "function") {
      result.set(id, { kind: "local", name, recognize: algorithm.recognize });
    } else if (algorithm.kind === "http" && typeof algorithm.url === "string") {
      const url = new URL(algorithm.url);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new TypeError(`算法 ${id} 的 url 必须为不含 URL 凭证的完整 HTTP/HTTPS 地址。`);
      }
      const headers = algorithm.headers === undefined ? {} : algorithm.headers;
      if (
        typeof headers !== "object" ||
        headers === null ||
        Array.isArray(headers) ||
        Object.values(headers).some((value) => typeof value !== "string")
      ) {
        throw new TypeError(`算法 ${id} 的 headers 必须是字符串键值对象。`);
      }
      // 使用平台校验头名称和值，并在复制后固定 JSON 媒体类型。
      const normalizedHeaders = new Headers(headers);
      normalizedHeaders.set("content-type", "application/json;charset=UTF-8");
      result.set(id, {
        kind: "http",
        name,
        url: url.toString(),
        headers: Object.fromEntries(normalizedHeaders),
      });
    } else {
      throw new TypeError(`算法 ${id} 必须配置 local 识别函数或 http 接口。`);
    }
  }
  return result;
};
