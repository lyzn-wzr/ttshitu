import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcceptanceServer } from "../dev/server";

const servers: ReturnType<typeof createAcceptanceServer>[] = [];
const directories: string[] = [];
/** 有效的 1×1 PNG，所有测试均不连接付费平台。 */
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const config = { mode: "mock", endpoint: "ttshitu", username: "acceptance-user", timeoutMs: 1000 };

/**
 * 在读取未知 HTTP JSON 前收窄对象类型。
 * @param value 响应中的未知值。
 * @returns 是否允许按键读取。
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 使用真实 HTTP、SQLite 和 SDK，隔离到随机端口及临时目录。
 * @returns 本地服务地址与发送 JSON 的辅助函数。
 */
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "zk-acceptance-"));
  directories.push(directory);
  const server = createAcceptanceServer(directory);
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("缺少测试服务端口。");
  const url = `http://127.0.0.1:${address.port}`;
  /**
   * 所有请求显式使用模拟模式，允许用例覆盖单个配置。
   * @param path 本地接口路径。
   * @param body 当前操作参数。
   * @param options SDK 配置覆盖。
   * @returns 原始 HTTP 响应。
   */
  const post = (
    path: string,
    body: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acceptance": "1" },
      body: JSON.stringify({ config: { ...config, ...options }, ...body }),
    });
  return { url, post };
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (
      !absolute.startsWith(resolve(tmpdir()) + sep) ||
      !basename(absolute).startsWith("zk-acceptance-")
    )
      throw new Error("拒绝清理测试目录之外的路径。");
    await rm(absolute, { recursive: true, force: true });
  }
});

describe("local manual acceptance environment", () => {
  it("serves the desktop console and blocks cross-site and rebound-host requests", async () => {
    const { url } = await fixture();
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("本地验收台");
    for (const path of ["/app.js", "/style.css"])
      expect((await fetch(url + path)).status).toBe(200);
    const blocked = await fetch(`${url}/api/history`, {
      method: "POST",
      headers: {
        origin: "https://foreign.example",
        "content-type": "application/json",
        "x-acceptance": "1",
      },
      body: JSON.stringify({ config }),
    });
    expect(blocked.status).toBe(403);
    expect((await fetch(`${url}/api/history`, { method: "POST", body: "{}" })).status).toBe(403);
    const reboundStatus = await new Promise<number | undefined>((resolveStatus, rejectStatus) => {
      const request = httpRequest(url, { headers: { host: "foreign.example" } }, (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      });
      request.on("error", rejectStatus);
      request.end();
    });
    expect(reboundStatus).toBe(403);
    expect((await fetch(`${url}/../package.json`)).status).toBe(404);
  });

  it("persists real image bytes, prices, account isolation and history across requests", async () => {
    const { post } = await fixture();
    const response = await post("/api/recognize", {
      request: {
        image: `data:image/png;base64,${image}`,
        imageback: image,
        title_image: image,
        typeid: "3",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { success: true, data: { result: "a7K9" } },
      warnings: [],
    });
    const history = await post("/api/history");
    const body = await history.json();
    expect(body).toMatchObject({
      data: {
        page: { total: 1 },
        stats: { summary: { total: 1, successCount: 1, estimatedCost: "0.002000" } },
      },
    });
    if (
      !isObject(body) ||
      !isObject(body.data) ||
      !isObject(body.data.page) ||
      !Array.isArray(body.data.page.items)
    )
      throw new Error("缺少测试记录列表。");
    const first: unknown = body.data.page.items[0];
    if (!isObject(first) || typeof first.id !== "string") throw new Error("缺少本地记录编号。");
    const id = first.id;
    const detail = await post("/api/record", { id });
    expect(await detail.json()).toMatchObject({
      data: { image, imageback: image, title_image: image, pricingSource: "official" },
    });
    expect((await post("/api/record", { id }, { username: "other-account" })).status).toBe(404);
    const isolated = await post("/api/history", {}, { endpoint: "zhunkuai" });
    expect(await isolated.json()).toMatchObject({ data: { page: { total: 0 } } });
    expect((await post("/api/report", { id: "mock-platform-id" })).status).toBe(200);
    const account = await post("/api/account");
    expect(await account.json()).toMatchObject({
      data: { success: true, data: { balance: "100.000000" } },
    });
    expect(await (await post("/api/history")).json()).toMatchObject({
      data: { page: { total: 1 } },
    });
  });

  it.each([
    ["failure", "1004"],
    ["http", "HTTP_500"],
    ["json", "INVALID_JSON"],
    ["timeout", "TIMEOUT"],
    ["redirect", "REDIRECT_BLOCKED"],
    ["large", "RESPONSE_TOO_LARGE"],
  ])(
    "runs the SDK error path for %s and saves exactly one unknown-price failure",
    async (scenario, code) => {
      const { post } = await fixture();
      const response = await post(
        "/api/recognize",
        { request: { image } },
        { scenario, ...(scenario === "timeout" ? { timeoutMs: 50 } : {}) },
      );
      expect(await response.json()).toMatchObject({ data: { success: false, code }, warnings: [] });
      expect(await (await post("/api/history")).json()).toMatchObject({
        data: {
          page: { total: 1 },
          stats: { summary: { failureCount: 1, unknownPriceCount: 1, estimatedCost: "0.000000" } },
        },
      });
    },
  );

  it("supports price overrides, filtering and paging without repricing old records", async () => {
    const { post } = await fixture();
    await post("/api/recognize", { request: { image, typeid: "16" } }, { result: "中文" });
    await post(
      "/api/recognize",
      { request: { image, typeid: "3" } },
      { prices: { "3": "0.000001" } },
    );
    expect(await (await post("/api/history", {}, { prices: { "3": "1" } })).json()).toMatchObject({
      data: { stats: { summary: { estimatedCost: "0.016001" } } },
    });
    expect(
      await (await post("/api/history", { filter: { typeid: "3", limit: 1, offset: 1 } })).json(),
    ).toMatchObject({
      data: {
        page: { total: 1, items: [] },
        stats: { summary: { total: 1, estimatedCost: "0.000001" } },
      },
    });
    expect(await (await post("/api/history", { filter: { success: false } })).json()).toMatchObject(
      { data: { page: { total: 0 } } },
    );
  });

  it("rejects malformed configuration, images, JSON and oversized bodies before recognizing", async () => {
    const { url, post } = await fixture();
    for (const options of [
      { mode: "unexpected" },
      { endpoint: "unknown" },
      { timeoutMs: 0 },
      { retentionDays: 0 },
      { prices: { "3": 0.1 } },
      { prices: { "3": "-1" } },
      { mode: "live", password: "" },
    ]) {
      expect((await post("/api/history", {}, options)).status).toBe(400);
    }
    expect((await post("/api/recognize", { request: { image: "invalid image" } })).status).toBe(
      400,
    );
    expect(
      (
        await post("/api/recognize", {
          request: { image: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") },
        })
      ).status,
    ).toBe(413);
    const invalidJson = await fetch(`${url}/api/history`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acceptance": "1" },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    const oversized = await fetch(`${url}/api/history`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acceptance": "1" },
      body: " ".repeat(24 * 1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(await (await post("/api/history")).json()).toMatchObject({
      data: { page: { total: 0 } },
    });
  });
});
