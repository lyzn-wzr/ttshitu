import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ZkCaptchaAlgorithm } from "../../src/index";
import { GLYPHS, recognize } from "./recognizer";
import type { Template, Threshold } from "./recognizer";

/** 多次识别复用同一份模板，避免每次请求重复加载与转换。 */
let modelPromise: Promise<{ templates: Template[]; threshold: Threshold }> | undefined;

/**
 * 校验冻结的模型资产并缓存到进程内，不读取来源项目的数据库。
 * @returns 120 个字符模板与原调研固定阈值。
 */
const loadModel = () =>
  (modelPromise ??= (async () => {
    const model: unknown = JSON.parse(
      await readFile(new URL("./model.json", import.meta.url), "utf8"),
    );
    assert(
      isObject(model) && isObject(model.threshold) && Array.isArray(model.templates),
      "模板模型格式无效",
    );
    const { score, margin } = model.threshold;
    assert(typeof score === "number" && score >= 0 && score <= 1);
    assert(typeof margin === "number" && margin >= 0 && margin <= 1);
    const templates = model.templates.map((value: unknown): Template => {
      assert(
        isObject(value) && typeof value.source === "string" && typeof value.pixels === "number",
      );
      const glyph = GLYPHS.find((item) => item === value.glyph);
      assert(glyph !== undefined && Number.isSafeInteger(value.pixels) && value.pixels > 0);
      assert(
        Array.isArray(value.rows) &&
          value.rows.length === 32 &&
          value.rows.every(
            (row: unknown) =>
              typeof row === "number" && Number.isSafeInteger(row) && row >= 0 && row < 2 ** 24,
          ),
      );
      return {
        source: value.source,
        glyph,
        mask: { pixels: value.pixels, rows: Uint32Array.from(value.rows) },
      };
    });
    assert.equal(templates.length, 120, "字符模板数量与原调研不一致");
    return { templates, threshold: { score, margin } };
  })());

/**
 * 收窄模型中的对象，拒绝空值和数组。
 * @param value 从本地 JSON 读取的未知值。
 * @returns 是否允许读取具名字段。
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** shortcut: 仅适配原调研 130×48 彩色粗体算术图，换字体或上线前需重新校准负样本。 */
export const templateMathAlgorithm: ZkCaptchaAlgorithm = {
  kind: "local",
  name: "本地算术模板识别",
  /**
   * 将原调研识别结果适配为 SDK 响应，低分与异常图片明确拒识。
   * @param request SDK 已转换的图片与识别类型。
   * @param context 单次调用的超时和取消信号。
   * @returns 答案、算式、匹配得分和算法耗时；拒识保留诊断数据。
   */
  recognize: async (request, context) => {
    context.signal.throwIfAborted();
    const model = await loadModel();
    context.signal.throwIfAborted();
    const result = await recognize(
      Buffer.from(request.image, "base64"),
      model.templates,
      model.threshold,
    );
    context.signal.throwIfAborted();
    if (result.answer === null) {
      return {
        success: false,
        code: "TEMPLATE_REJECTED",
        message: result.reason ?? "无法确定",
        data: result,
      };
    }
    const data = {
      id: `template-${randomUUID()}`,
      result: result.answer,
      expression: result.expression,
      score: result.score,
      margin: result.margin,
      durationMs: result.durationMs,
    };
    return { success: true, code: "0", message: "本地模板识别成功", data };
  },
};
