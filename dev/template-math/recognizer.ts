import sharp from "sharp";

/** 此试验只支持历史样本的固定版式 */
const IMAGE_WIDTH = 130;
const IMAGE_HEIGHT = 48;
const MASK_WIDTH = 24;
const MASK_HEIGHT = 32;
/** 三个字符的位置；等号和问号不参与识别 */
const REGIONS = [
  [0, 31],
  [30, 53],
  [51, 83],
] as const;
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const OPERATORS = ["+", "-", "×"] as const;
export const GLYPHS = [...DIGITS, ...OPERATORS] as const;
type Digit = (typeof DIGITS)[number];
type Operator = (typeof OPERATORS)[number];
type Glyph = (typeof GLYPHS)[number];

/** 归一化二值字符，每行使用一个24位整数保存 */
export interface GlyphMask {
  /** 逐行前景位 */
  rows: Uint32Array;
  /** 前景像素总数 */
  pixels: number;
}

/** 由人工标注的建模图片生成 */
export interface Template {
  /** 原图SHA-256，用于校准时排除同图模板 */
  source: string;
  /** 字符标签 */
  glyph: Glyph;
  /** 处理后的字符形状 */
  mask: GlyphMask;
}

/** 匹配分数是形状相似度，不表示统计概率 */
export interface Recognition {
  /** 三字符算式；切分失败时为空 */
  expression: string | null;
  /** 仅通过阈值且结构有效时返回整数答案 */
  answer: string | null;
  /** 三个字符中最低的Dice相似度 */
  score: number;
  /** 三个字符中最小的首选与次选类别分差 */
  margin: number;
  /** 无法确定时的原因 */
  reason: string | null;
  /** 解码、预处理和匹配耗时，不含模板加载 */
  durationMs: number;
}

/** 校准集选出的拒识边界 */
export interface Threshold {
  /** 最低形状相似度 */
  score: number;
  /** 最小类别分差 */
  margin: number;
}

/**
 * 统计32位整数的置位数量
 * @param value 前景位
 * @returns 前景像素数
 */
const bitCount = (value: number): number => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * 以3×3开运算清除细圆圈，同时保留粗笔画的加减乘号
 * @param input 白色前景的二值图
 * @returns 去掉细笔画后的二值图
 */
const removeThinNoise = (input: Uint8Array): Uint8Array => {
  const eroded = new Uint8Array(input.length);
  const opened = new Uint8Array(input.length);
  for (let y = 1; y < IMAGE_HEIGHT - 1; y++) {
    for (let x = 1; x < IMAGE_WIDTH - 1; x++) {
      let filled = true;
      for (let dy = -1; dy <= 1 && filled; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!input[(y + dy) * IMAGE_WIDTH + x + dx]) {
            filled = false;
            break;
          }
        }
      }
      if (filled) eroded[y * IMAGE_WIDTH + x] = 1;
    }
  }
  for (let y = 1; y < IMAGE_HEIGHT - 1; y++) {
    for (let x = 1; x < IMAGE_WIDTH - 1; x++) {
      if (!eroded[y * IMAGE_WIDTH + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          opened[(y + dy) * IMAGE_WIDTH + x + dx] = 1;
        }
      }
    }
  }
  return opened;
};

/**
 * 提取区域内最大连通字符，等比例居中到24×32位图
 * @param binary 已去噪的固定大小图像
 * @param left 区域左边界
 * @param right 区域右边界，不包含该列
 * @returns 无有效笔画时返回null
 */
const extractGlyph = (binary: Uint8Array, left: number, right: number): GlyphMask | null => {
  const visited = new Uint8Array(binary.length);
  let largest: number[] = [];
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let x = left; x < right; x++) {
      const origin = y * IMAGE_WIDTH + x;
      if (!binary[origin] || visited[origin]) continue;
      const component = [origin];
      visited[origin] = 1;
      for (let head = 0; head < component.length; head++) {
        const position = component[head]!;
        const px = position % IMAGE_WIDTH;
        const py = Math.floor(position / IMAGE_WIDTH);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if (nx < left || nx >= right || ny < 0 || ny >= IMAGE_HEIGHT) continue;
            const next = ny * IMAGE_WIDTH + nx;
            if (!binary[next] || visited[next]) continue;
            visited[next] = 1;
            component.push(next);
          }
        }
      }
      if (component.length > largest.length) largest = component;
    }
  }
  if (largest.length < 8) return null;
  const xs = largest.map((position) => position % IMAGE_WIDTH);
  const ys = largest.map((position) => Math.floor(position / IMAGE_WIDTH));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX + 1;
  const height = Math.max(...ys) - minY + 1;
  const scale = Math.min((MASK_WIDTH - 4) / width, (MASK_HEIGHT - 4) / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const offsetX = Math.floor((MASK_WIDTH - targetWidth) / 2);
  const offsetY = Math.floor((MASK_HEIGHT - targetHeight) / 2);
  const foreground = new Set(largest);
  const rows = new Uint32Array(MASK_HEIGHT);
  let pixels = 0;
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = minX + Math.floor(((x + 0.5) * width) / targetWidth);
      const sourceY = minY + Math.floor(((y + 0.5) * height) / targetHeight);
      if (!foreground.has(sourceY * IMAGE_WIDTH + sourceX)) continue;
      rows[offsetY + y] = rows[offsetY + y]! | (1 << (offsetX + x));
      pixels++;
    }
  }
  return { rows, pixels };
};

/**
 * 只解码受限尺寸的栅格图片，颜色转二值后切分前三个字符
 * @param image 原始图片字节
 * @returns 数字、运算符、数字的位图
 */
export const prepareImage = async (image: Uint8Array): Promise<GlyphMask[]> => {
  const decoder = sharp(image, {
    limitInputPixels: IMAGE_WIDTH * IMAGE_HEIGHT,
    failOn: "warning",
  });
  const metadata = await decoder.metadata();
  if (
    metadata.width !== IMAGE_WIDTH ||
    metadata.height !== IMAGE_HEIGHT ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error("只支持130×48的单帧图片");
  const { data, info } = await decoder
    .flatten({ background: "#fff" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const binary = new Uint8Array(IMAGE_WIDTH * IMAGE_HEIGHT);
  for (let i = 0; i < binary.length; i++) {
    const r = data[i * info.channels]!;
    const g = data[i * info.channels + 1]!;
    const b = data[i * info.channels + 2]!;
    if (Math.min(r, g, b) < 210 && Math.max(r, g, b) - Math.min(r, g, b) >= 40) binary[i] = 1;
  }
  const clean = removeThinNoise(binary);
  return REGIONS.map(([left, right]) => {
    const mask = extractGlyph(clean, left, right);
    if (!mask) throw new Error("字符笔画不足，无法确定");
    return mask;
  });
};

/**
 * 比较二值形状，容许归一化后上下左右两像素偏移
 * @param a 待识别字符
 * @param b 已标注模板
 * @returns 0至1的最高Dice相似度
 */
const similarity = (a: GlyphMask, b: GlyphMask): number => {
  let best = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      let intersection = 0;
      for (let y = 0; y < MASK_HEIGHT; y++) {
        const other = b.rows[y + dy] ?? 0;
        intersection += bitCount(a.rows[y]! & (dx < 0 ? other >>> -dx : other << dx));
      }
      best = Math.max(best, (2 * intersection) / (a.pixels + b.pixels));
    }
  }
  return best;
};

/**
 * 解析严格的单数字算式，避免将任意文本当代码执行
 * @param expression 人工标签或匹配产生的算式
 * @returns 通过字符和位置校验的三元组
 */
export const parseExpression = (expression: string): [Digit, Operator, Digit] => {
  const [left, operator, right, extra] = [...expression];
  if (
    !DIGITS.some((digit) => digit === left) ||
    !OPERATORS.some((op) => op === operator) ||
    !DIGITS.some((digit) => digit === right) ||
    extra !== undefined
  )
    throw new Error(`不支持的算式：${expression}`);
  const digitA = DIGITS.find((digit) => digit === left)!;
  const digitB = DIGITS.find((digit) => digit === right)!;
  const operation = OPERATORS.find((op) => op === operator)!;
  return [digitA, operation, digitB];
};

/**
 * 计算已验证的加减乘算式
 * @param expression 三字符算式
 * @returns 支持零与负数的十进制整数
 */
export const calculate = (expression: string): string => {
  const [left, operation, right] = parseExpression(expression);
  const a = Number(left);
  const b = Number(right);
  if (operation === "+") return String(a + b);
  if (operation === "-") return String(a - b);
  return String(a * b);
};

/**
 * 同类别多个模板先取最高分，再比较首选与次选类别
 * @param masks 预处理后的三个字符
 * @param templates 人工标注模板
 * @returns 未应用拒识阈值的候选结果
 */
export const matchMasks = (masks: GlyphMask[], templates: Template[]): Recognition => {
  const choices = masks.map((mask, index) => {
    const allowed: readonly Glyph[] = index === 1 ? OPERATORS : DIGITS;
    const ranked = allowed
      .map((glyph) => ({
        glyph,
        score: Math.max(
          0,
          ...templates
            .filter((template) => template.glyph === glyph)
            .map((template) => similarity(mask, template.mask)),
        ),
      }))
      .sort((a, b) => b.score - a.score);
    return {
      glyph: ranked[0]!.glyph,
      score: ranked[0]!.score,
      margin: ranked[0]!.score - ranked[1]!.score,
    };
  });
  const expression = choices.map((choice) => choice.glyph).join("");
  return {
    expression,
    answer: calculate(expression),
    score: Math.min(...choices.map((choice) => choice.score)),
    margin: Math.min(...choices.map((choice) => choice.margin)),
    reason: null,
    durationMs: 0,
  };
};

/**
 * 低分或类别接近时拒识，保留候选算式供离线诊断
 * @param candidate 未过滤的候选结果
 * @param threshold 仅由建模集校准的边界
 * @returns 可接受答案或明确的拒识结果
 */
export const applyThreshold = (candidate: Recognition, threshold: Threshold): Recognition => {
  if (
    candidate.reason ||
    (candidate.score >= threshold.score && candidate.margin >= threshold.margin)
  )
    return candidate;
  return {
    ...candidate,
    answer: null,
    reason: "匹配分数或类别分差不足，无法确定",
  };
};

/**
 * 执行本地识别，不访问业务服务或外部渠道
 * @param image 原始图片字节
 * @param templates 已加载模板
 * @param threshold 建模集确定的拒识边界
 * @returns 包含纯识别耗时的结果；损坏或不支持的图片明确拒识
 */
export const recognize = async (
  image: Uint8Array,
  templates: Template[],
  threshold: Threshold,
): Promise<Recognition> => {
  const start = performance.now();
  try {
    const result = applyThreshold(matchMasks(await prepareImage(image), templates), threshold);
    return { ...result, durationMs: performance.now() - start };
  } catch (error) {
    return {
      expression: null,
      answer: null,
      score: 0,
      margin: 0,
      reason: error instanceof Error ? error.message : "图片无法识别",
      durationMs: performance.now() - start,
    };
  }
};
