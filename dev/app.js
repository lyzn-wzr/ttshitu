// @ts-check

/** 浏览器会话中的图片 Data URL，不持久化凭证或上传内容。 @type {Map<string, string>} */
const images = new Map();
/** 明细窗口的临时图片地址，关闭时释放。 @type {string[]} */
const detailUrls = [];
/** 当前操作的存储警告。 @type {string[]} */
let warnings = [];
let offset = 0;
let total = 0;
let busy = false;
const PAGE_SIZE = 10;

/**
 * 提前发现页面与脚本的 ID 不匹配。
 * @param {string} id 页面元素 ID。
 * @returns {HTMLElement} 已存在的元素。
 */
const element = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少元素：${id}`);
  return node;
};

/**
 * 收窄表单控件，避免通过类型断言读取 value。
 * @param {string} id 控件 ID。
 * @returns {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} 表单控件。
 */
const field = (id) => {
  const node = element(id);
  if (
    !(
      node instanceof HTMLInputElement ||
      node instanceof HTMLSelectElement ||
      node instanceof HTMLTextAreaElement
    )
  )
    throw new Error(`无效表单控件：${id}`);
  return node;
};

/**
 * 仅接受对象响应，后续所有数据以文本方式呈现。
 * @param {unknown} value JSON 值。
 * @returns {Record<string, unknown>} JSON 对象。
 */
const object = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("本地服务响应格式无效。");
  return Object.fromEntries(Object.entries(value));
};

/**
 * 创建节点时只写入文本，平台返回内容不会作为 HTML 执行。
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag 标签。
 * @param {unknown} [value] 显示值。
 * @param {string} [className] 样式类。
 * @returns {HTMLElementTagNameMap[K]} 新节点。
 */
const node = (tag, value, className = "") => {
  const result = document.createElement(tag);
  result.textContent = value === undefined || value === null ? "—" : String(value);
  result.className = className;
  return result;
};

/**
 * 每次操作读取当前配置，不向本地存储写入账号密码。
 * @returns {Record<string, unknown>} 本次操作的配置。
 */
const config = () => {
  /** @type {unknown} */
  const prices = JSON.parse(field("prices").value || "{}");
  return {
    mode: field("mode").value,
    endpoint: field("endpoint").value,
    username: field("username").value,
    password: field("password").value,
    scenario: field("scenario").value,
    result: field("mock-result").value,
    baseUrl: field("base-url").value.trim(),
    timeoutMs: Number(field("timeout").value),
    prices: object(prices),
    ...(field("retention").value ? { retentionDays: Number(field("retention").value) } : {}),
  };
};

/**
 * 仅向同源本地服务发请求，真实平台调用由服务端 SDK 执行。
 * @param {string} path API 路径。
 * @param {Record<string, unknown>} [body] 操作参数。
 * @returns {Promise<Record<string, unknown>>} 操作结果。
 */
const api = async (path, body = {}) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-acceptance": "1" },
    body: JSON.stringify({ config: config(), ...body }),
    signal: AbortSignal.timeout(130_000),
  });
  /** @type {unknown} */
  const raw = await response.json();
  const payload = object(raw);
  if (!response.ok)
    throw new Error(
      typeof payload.error === "string" ? payload.error : `本地 HTTP ${response.status}`,
    );
  if (Array.isArray(payload.warnings))
    warnings.push(...payload.warnings.filter((item) => typeof item === "string"));
  return object(payload.data);
};

/**
 * 保持分页按钮与实际结果范围一致。
 * @returns {void} 无返回值。
 */
const pagination = () => {
  const previous = element("previous");
  const next = element("next");
  if (previous instanceof HTMLButtonElement) previous.disabled = busy || offset === 0;
  if (next instanceof HTMLButtonElement) next.disabled = busy || offset + PAGE_SIZE >= total;
  element("page-label").textContent = total
    ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / 共 ${total} 条`
    : "共 0 条 · 每页 10 条";
};

/**
 * 锁定当前操作的配置，防止慢请求返回到另一个账号的界面。
 * @param {string} label 操作说明。
 * @param {() => Promise<void>} task 需要等待的操作。
 * @returns {Promise<void>} 完成状态已显示，错误由状态栏呈现。
 */
const run = async (label, task) => {
  if (busy) return;
  busy = true;
  warnings = [];
  for (const control of document.querySelectorAll("fieldset, button")) {
    if (control instanceof HTMLFieldSetElement || control instanceof HTMLButtonElement)
      control.disabled = true;
  }
  const status = element("status");
  status.dataset.tone = "pending";
  status.textContent = `${label}…`;
  try {
    await task();
    status.dataset.tone = warnings.length ? "warning" : "success";
    status.textContent = warnings.length
      ? `本地记录警告：${warnings.join("；")}`
      : `${label}完成。`;
  } catch (error) {
    status.dataset.tone = "error";
    status.textContent = error instanceof Error ? error.message : "操作失败。";
  } finally {
    busy = false;
    for (const control of document.querySelectorAll("fieldset, button")) {
      if (control instanceof HTMLFieldSetElement || control instanceof HTMLButtonElement)
        control.disabled = false;
    }
    pagination();
  }
};

/**
 * 展示完整 SDK 响应，保留失败码便于人工核对。
 * @param {string} label 调用来源。
 * @param {Record<string, unknown>} data SDK 响应。
 * @returns {void} 无返回值。
 */
const output = (label, data) => {
  element("output-label").textContent = `${label} · ${data.success ? "成功" : "失败"}`;
  element("output").textContent = JSON.stringify(data, null, 2);
};

/**
 * 将本地时间控件转换为带时区的 ISO，沿用 SDK 的边界语义。
 * @returns {Record<string, unknown>} 统计与分页的筛选条件。
 */
const filters = () => ({
  ...(field("filter-type").value ? { typeid: field("filter-type").value } : {}),
  ...(field("filter-success").value ? { success: field("filter-success").value === "true" } : {}),
  ...(field("from").value ? { from: new Date(field("from").value).toISOString() } : {}),
  ...(field("to").value ? { to: new Date(field("to").value).toISOString() } : {}),
  limit: PAGE_SIZE,
  offset,
});

/**
 * 图片关闭后释放对象地址，避免连续查看明细占用内存。
 * @returns {void} 无返回值。
 */
const releaseDetail = () => {
  for (const url of detailUrls.splice(0)) URL.revokeObjectURL(url);
  element("detail-images").replaceChildren();
};

/**
 * 按本地 UUID 获取原图；图片 MIME 由浏览器根据字节识别。
 * @param {string} id 本地记录 UUID。
 * @returns {Promise<void>} 已打开明细窗口。
 */
const showDetail = async (id) => {
  const data = await api("/api/record", { id });
  releaseDetail();
  const metadata = { ...data };
  for (const [key, label] of [
    ["image", "主图"],
    ["imageback", "背景图"],
    ["title_image", "标题图"],
  ]) {
    if (!key || !label) continue;
    const base64 = data[key];
    const figure = node("figure", "");
    if (typeof base64 === "string") {
      const url = URL.createObjectURL(
        new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]),
      );
      detailUrls.push(url);
      const image = node("img", "");
      image.src = url;
      image.alt = `${label}原图`;
      figure.append(image);
      metadata[key] = `${base64.length} 个 base64 字符（图片见上方）`;
    } else figure.append(node("p", "未保存图片", "muted"));
    figure.append(node("figcaption", label));
    element("detail-images").append(figure);
  }
  element("detail-data").textContent = JSON.stringify(metadata, null, 2);
  const dialog = element("detail");
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
};

/**
 * 读取真实 SQLite 列表及汇总，空页因过期清理失效时回到第一页。
 * @returns {Promise<void>} 列表和统计已更新。
 */
const refresh = async () => {
  let data = await api("/api/history", { filter: filters() });
  let page = object(data.page);
  total = typeof page.total === "number" ? page.total : 0;
  if (offset >= total && offset !== 0) {
    offset = 0;
    data = await api("/api/history", { filter: filters() });
    page = object(data.page);
    total = typeof page.total === "number" ? page.total : 0;
  }
  const stats = object(data.stats);
  const summary = object(stats.summary);
  element("metric-total").textContent = String(summary.total);
  element("metric-counts").textContent =
    `成功 ${summary.successCount} · 失败 ${summary.failureCount}`;
  element("metric-rate").textContent = `${(Number(summary.successRate) * 100).toFixed(1)}%`;
  element("metric-cost").textContent = `¥${summary.estimatedCost}`;
  element("metric-unknown").textContent = `${summary.unknownPriceCount} 次费用未知`;
  element("metric-duration").textContent = `${Math.round(Number(summary.averageDurationMs))} ms`;
  element("group-stats").textContent = JSON.stringify(
    { byType: stats.byType, byDay: stats.byDay },
    null,
    2,
  );
  const tbody = element("records");
  tbody.replaceChildren();
  if (!Array.isArray(page.items) || !page.items.length) {
    const row = node("tr", "");
    const cell = node("td", "当前账号与接口下，没有符合条件的记录。", "empty");
    cell.colSpan = 7;
    row.append(cell);
    tbody.append(row);
  } else {
    for (const raw of page.items) {
      const item = object(raw);
      const row = node("tr", "");
      const state = node("td", "");
      state.append(
        node("span", item.success ? "成功" : "失败", `badge${item.success ? "" : " failure"}`),
      );
      const action = node("td", "");
      const button = node("button", "查看 ↗", "text-button");
      button.type = "button";
      button.addEventListener("click", () => {
        void run("加载识别明细", () => showDetail(String(item.id)));
      });
      action.append(button);
      const result = node("td", item.result ?? item.code);
      result.title = String(item.message ?? "");
      row.append(
        node("td", new Date(String(item.startedAt)).toLocaleString("zh-CN", { hour12: false })),
        node("td", `${item.typeid} · ${item.typeName ?? "自定义"}`),
        state,
        result,
        node("td", `${Math.round(Number(item.durationMs))} ms`),
        node("td", item.price ?? "未知"),
        action,
      );
      tbody.append(row);
    }
  }
  pagination();
};

/**
 * 更新上传区域和内存中的同一份图片。
 * @param {string} id SDK 图片字段名。
 * @param {string | null} data 图片 Data URL，null 表示移除。
 * @param {string} [name] 展示文件名。
 * @returns {void} 无返回值。
 */
const setImage = (id, data, name = "未选择") => {
  if (data) images.set(id, data);
  else images.delete(id);
  const preview = element(`preview-${id}`);
  if (preview instanceof HTMLImageElement) {
    if (data) preview.src = data;
    else preview.removeAttribute("src");
    preview.hidden = !data;
  }
  element(`placeholder-${id}`).hidden = Boolean(data);
  element(`name-${id}`).textContent = name;
  const remove = document.querySelector(`[data-remove="${id}"]`);
  if (remove instanceof HTMLElement) remove.hidden = !data;
  if (!data) field(id).value = "";
};

/**
 * 生成可预览、可存储的 PNG 示例，无需网络和测试素材依赖。
 * @returns {void} 主图已设为示例。
 */
const sample = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 90;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持示例图片生成。");
  ctx.fillStyle = "#edf3e7";
  ctx.fillRect(0, 0, 240, 90);
  ctx.fillStyle = "#345a3e";
  ctx.font = "italic bold 42px Georgia";
  ctx.fillText("a7K9", 55, 61);
  ctx.strokeStyle = "#91ac78";
  ctx.beginPath();
  ctx.moveTo(15, 65);
  ctx.lineTo(220, 25);
  ctx.stroke();
  setImage("image", canvas.toDataURL("image/png"), "示例 · a7K9.png");
};

/**
 * 读取文件为 Data URL，限制单图体积并保留读取失败。
 * @param {File} file 浏览器选中的图片。
 * @returns {Promise<string>} SDK 接受的 Data URL。
 */
const readImage = (file) =>
  new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      reject(new Error("请选择不超过 5 MiB 的图片。"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("图片读取失败。"));
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });

/**
 * 清空旧账号或旧接口的可见数据，避免配置修改后误读历史结果。
 * @returns {void} 界面等待重新查询。
 */
const invalidate = () => {
  offset = 0;
  total = 0;
  for (const id of [
    "metric-total",
    "metric-counts",
    "metric-rate",
    "metric-cost",
    "metric-unknown",
    "metric-duration",
  ])
    element(id).textContent = "—";
  element("records").replaceChildren();
  element("group-stats").textContent = "配置已修改，请重新查询。";
  field("captcha-id").value = "";
  element("output-label").textContent = "等待调用";
  element("output").textContent = "配置已修改，请发起调用或应用并刷新记录。";
  element("status").textContent = "配置已修改，下一次操作将使用新配置。";
  element("status").dataset.tone = "pending";
  pagination();
};

element("settings").addEventListener("submit", (event) => {
  event.preventDefault();
  offset = 0;
  void run("应用配置并刷新记录", refresh);
});
element("settings").addEventListener("change", invalidate);
element("mode").addEventListener("change", () => {
  const live = field("mode").value === "live";
  element("live-fields").hidden = !live;
  element("mock-fields").hidden = live;
  field("username").value = live ? "" : "demo";
  field("password").value = "";
  field("timeout").value = live ? "60000" : "1000";
  element("environment").textContent = live
    ? "真实接口 · 识别可能产生费用"
    : "本地模拟 · 不产生费用";
  element("environment").classList.toggle("live", live);
  element("mode-note").textContent = live
    ? "请求将发送到所选平台，请使用自己的账号与图片。"
    : "模拟网络响应，实际执行计价与本地存储。";
  element("recognize-button").textContent = live ? "调用真实接口 →" : "开始模拟识别 →";
});
element("sample").addEventListener("click", sample);
for (const id of ["image", "imageback", "title_image"]) {
  element(id).addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const file = target.files?.[0];
    if (!file) {
      setImage(id, null);
      return;
    }
    void run("读取图片", async () => {
      try {
        setImage(id, await readImage(file), file.name);
      } catch (error) {
        setImage(id, null);
        throw error;
      }
    });
  });
  const remove = document.querySelector(`[data-remove="${id}"]`);
  remove?.addEventListener("click", () => setImage(id, null));
}
element("recognize").addEventListener("submit", (event) => {
  event.preventDefault();
  void run("调用识别并保存记录", async () => {
    field("captcha-id").value = "";
    const data = await api("/api/recognize", {
      request: {
        image: images.get("image"),
        imageback: images.get("imageback"),
        title_image: images.get("title_image"),
        typeid: field("typeid").value,
        remark: field("remark").value,
      },
    });
    output("recognize", data);
    if (data.success) field("captcha-id").value = String(object(data.data).id);
    offset = 0;
    await refresh();
  });
});
element("account").addEventListener("click", () => {
  void run("查询账号余额", async () => output("queryAccountInfo", await api("/api/account")));
});
element("report").addEventListener("submit", (event) => {
  event.preventDefault();
  void run("上报识别错误", async () =>
    output("reportError", await api("/api/report", { id: field("captcha-id").value })),
  );
});
element("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  offset = 0;
  void run("查询本地记录", refresh);
});
element("reset-filters").addEventListener("click", () => {
  for (const id of ["filter-type", "filter-success", "from", "to"]) field(id).value = "";
  offset = 0;
  void run("重置筛选并刷新", refresh);
});
element("previous").addEventListener("click", () => {
  offset = Math.max(0, offset - PAGE_SIZE);
  void run("加载上一页", refresh);
});
element("next").addEventListener("click", () => {
  offset += PAGE_SIZE;
  void run("加载下一页", refresh);
});
element("detail").addEventListener("close", releaseDetail);
sample();
void run("加载本地验收记录", refresh);
