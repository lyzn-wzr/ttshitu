import type { PricingSource } from "./types";

/** 官方分类参考价，单位微元；按字计价及未公开价格的类型在计算时单独处理。 */
const captchaTypes = new Map<string, { name: string; micros: bigint | null }>([
  ["1", { name: "纯数字", micros: 2_000n }],
  ["1001", { name: "纯数字2", micros: 2_000n }],
  ["2", { name: "纯英文", micros: 2_000n }],
  ["1002", { name: "纯英文2", micros: 2_000n }],
  ["3", { name: "数英混合", micros: 2_000n }],
  ["1003", { name: "数英混合2", micros: 2_000n }],
  ["4", { name: "闪动GIF", micros: 4_000n }],
  ["7", { name: "无感学习", micros: null }],
  ["66", { name: "问答题", micros: null }],
  ["11", { name: "计算题", micros: 8_000n }],
  ["1005", { name: "快速计算题", micros: 8_000n }],
  ["5", { name: "快速计算题2", micros: 8_000n }],
  ["16", { name: "汉字", micros: null }],
  ["32", { name: "通用文字识别", micros: null }],
  ["29", { name: "旋转", micros: 16_000n }],
  ["1029", { name: "背景匹配旋转", micros: 16_000n }],
  ["2029", { name: "背景匹配双旋转", micros: 20_000n }],
  ["19", { name: "点选1个坐标", micros: 10_000n }],
  ["20", { name: "点选3个坐标", micros: 16_000n }],
  ["21", { name: "点选3～5个坐标", micros: 20_000n }],
  ["22", { name: "点选5～8个坐标", micros: 25_000n }],
  ["27", { name: "点选1～4个坐标", micros: 16_000n }],
  ["48", { name: "轨迹", micros: 30_000n }],
  ["18", { name: "缺口识别", micros: 10_000n }],
  ["33", { name: "单缺口识别", micros: 10_000n }],
  ["34", { name: "缺口识别2", micros: 10_000n }],
  ["3400", { name: "缺口坐标识别", micros: 10_000n }],
  ["1033", { name: "拖动拼图", micros: 16_000n }],
  ["53", { name: "拼图识别", micros: 16_000n }],
]);

/**
 * 获取已知类型名称，自定义类型不猜测名称。
 * @param typeid 实际发送的类型编号。
 * @returns 已知中文名称或 `null`。
 */
export const getTypeName = (typeid: string): string | null =>
  captchaTypes.get(typeid)?.name ?? null;

/**
 * 将配置价格转换为整数微元，提前拒绝精度丢失或 SQLite 整数溢出。
 * @param prices 每次识别的固定价格，单位元。
 * @returns 独立的价格快照，不受调用方后续修改影响。
 */
export const parsePrices = (
  prices: Readonly<Record<string, string>> = {},
): ReadonlyMap<string, bigint> =>
  new Map(
    Object.entries(prices).map(([typeid, price]) => {
      if (typeof price !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(price)) {
        throw new TypeError(`类型 ${typeid} 的价格必须是非负且最多六位小数的字符串。`);
      }
      const [whole = "0", fraction = ""] = price.split(".");
      const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
      if (micros > 9_223_372_036_854_775_807n) {
        throw new RangeError(`类型 ${typeid} 的价格超过 SQLite 整数范围。`);
      }
      return [typeid, micros];
    }),
  );

/**
 * 按成功结果估算费用，失败、私有接口或不明确的计费规则保留未知状态。
 * @param typeid 实际发送的类型编号。
 * @param result 成功结果，失败时为 `null`。
 * @param official 是否为内置官方接口且未指定定制模型。
 * @param prices 调用方配置的固定价格快照。
 * @returns 整数微元及其来源，不代表平台实际扣费。
 */
export const estimatePrice = (
  typeid: string,
  result: string | null,
  official: boolean,
  prices: ReadonlyMap<string, bigint>,
): {
  /** 估算微元，未知时为 null。 */ micros: bigint | null;
  /** 价格来源。 */ source: PricingSource;
} => {
  if (result === null) {
    return { micros: null, source: "unknown" };
  }
  const custom = prices.get(typeid);
  if (custom !== undefined) {
    return { micros: custom, source: "custom" };
  }
  if (!official) {
    return { micros: null, source: "unknown" };
  }

  let micros = captchaTypes.get(typeid)?.micros ?? null;
  const length = BigInt(Array.from(result).length);
  if (typeid === "16" && length > 0n) {
    micros = length * 8_000n;
  } else if (typeid === "7") {
    if (/^[a-z\d]+$/i.test(result)) {
      micros = 8_000n + (length > 4n ? (length - 4n) * 2_000n : 0n);
    } else if (/^\p{Script=Han}+$/u.test(result)) {
      micros = length * 8_000n;
    }
  }
  return { micros, source: micros === null ? "unknown" : "official" };
};

/**
 * 将整数微元格式化为元，整个计算不经过浮点金额。
 * @param micros 非负整数微元。
 * @returns 固定六位小数的人民币金额。
 */
export const formatPrice = (micros: bigint): string =>
  `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
