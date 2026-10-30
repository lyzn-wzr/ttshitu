import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZkCaptchaApiError,
  ZkCaptchaClient,
  recognizeFromFile,
  recognizeFromFileOrThrow,
} from "../src/index";
import type {
  FetchLike,
  HistoryListFilter,
  RecognizeRequest,
  ZkCaptchaClientOptions,
} from "../src/index";

// 复制导出以允许模拟清单缺失；文件读写及 SQLite 始终使用真实实现。
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const clients = new Set<ZkCaptchaClient>();
const directories: string[] = [];

/**
 * 以真实 Response 驱动 SDK，测试不调用付费服务。
 * @param body 模拟的平台响应。
 * @returns JSON 响应。
 */
const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body));

/**
 * 构造有效识别结果，允许测试改变返回文本。
 * @param result 平台返回的识别内容。
 * @returns 成功响应载荷。
 */
const successBody = (result = "abcd") => ({
  success: true,
  code: "0",
  message: "success",
  data: { id: "platform-id", result },
});

/**
 * 每个用例隔离到新目录，同一用例可创建共享数据库的多个客户端。
 * @returns 临时目录和自动登记关闭的客户端工厂。
 */
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "zk-captcha-history-"));
  directories.push(directory);
  /**
   * 保留 SDK 默认行为，仅替换账号、目录与网络边界。
   * @param options 当前用例需要覆盖的配置。
   * @returns 用例结束时自动关闭的客户端。
   */
  const createClient = (options: Partial<ZkCaptchaClientOptions> = {}): ZkCaptchaClient => {
    const client = new ZkCaptchaClient({
      username: "history-private-user",
      password: "history-private-password",
      fetch: async () => jsonResponse(successBody()),
      history: { directory },
      ...options,
    });
    clients.add(client);
    return client;
  };
  return { directory, createClient };
};

afterEach(async () => {
  await Promise.all(Array.from(clients, (client) => client.close()));
  clients.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (
      !absolute.startsWith(resolve(tmpdir()) + sep) ||
      !basename(absolute).startsWith("zk-captcha-history-")
    ) {
      throw new Error(`拒绝清理测试目录之外的路径：${absolute}`);
    }
    await rm(absolute, { recursive: true, force: true });
  }
});

describe("local recognition history", () => {
  it.each<{
    options: Partial<ZkCaptchaClientOptions>;
    request: Omit<RecognizeRequest, "image">;
    result: string;
    price: string | null;
  }>([
    {
      options: { endpoint: "kuaishibie" },
      request: { typeid: 3 },
      result: "ok",
      price: "0.002000",
    },
    {
      options: { baseUrl: "http://api.ttshitu.com" },
      request: { typeid: 3 },
      result: "ok",
      price: "0.002000",
    },
    {
      options: { baseUrl: "https://api.ttshitu.com" },
      request: { typeid: 3 },
      result: "ok",
      price: "0.002000",
    },
    {
      options: { baseUrl: "http://private.example/api" },
      request: { typeid: 3 },
      result: "ok",
      price: null,
    },
    { options: {}, request: { typeid: 3, modelid: 0 }, result: "ok", price: null },
    { options: {}, request: { typeid: 16 }, result: "汉𠮷", price: "0.016000" },
    { options: {}, request: { typeid: 7 }, result: "a1b2c3", price: "0.012000" },
    { options: {}, request: { typeid: 7 }, result: "汉A", price: null },
  ])(
    "persists reference pricing for $request and $options",
    async ({ options, request, result, price }) => {
      const { createClient } = await fixture();
      const client = createClient({
        ...options,
        fetch: async () => jsonResponse(successBody(result)),
      });
      await client.recognize({ ...request, image: "AQID" });
      expect((await client.getRecords()).items[0]?.price).toBe(price);
    },
  );

  it("includes image conversion and network time but excludes local storage time", async () => {
    const { createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["performance"] });
    const image = new Blob([]);
    vi.spyOn(image, "arrayBuffer").mockImplementation(async () => {
      vi.advanceTimersByTime(25);
      return new Uint8Array([1, 2, 3]).buffer;
    });
    const mkdirSync = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation((path, options) => {
      vi.advanceTimersByTime(1_000);
      return mkdirSync(path, options);
    });
    const client = createClient({
      fetch: async () => {
        vi.advanceTimersByTime(75);
        return jsonResponse(successBody());
      },
    });
    await client.recognize({ image });
    expect((await client.getRecords()).items[0]?.durationMs).toBe(100);
  });

  it("round-trips all three images without loading them in lists or persisting credentials", async () => {
    const { directory, createClient } = await fixture();
    const client = createClient();
    expect(fs.existsSync(join(directory, "history.sqlite"))).toBe(false);
    const response = await client.recognize({
      typeid: 1033,
      image: "data:image/png;base64,AQID",
      imageback: new Uint8Array([4, 5, 6]),
      title_image: new Blob([new Uint8Array([7, 8, 9])]),
      remark: "private-remark-not-stored",
      extra: { unrelated: "private-extension-not-stored" },
    });
    expect(response).toEqual(successBody());
    const { items, total } = await client.getRecords();
    expect(total).toBe(1);
    const record = items[0];
    if (record === undefined) throw new Error("缺少识别记录");
    expect(record).toMatchObject({
      captchaId: "platform-id",
      typeid: "1033",
      typeName: "拖动拼图",
      success: true,
      result: "abcd",
      price: "0.016000",
      pricingSource: "official",
    });
    expect(record.id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
    expect(record.startedAt).toMatch(/Z$/);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record).not.toHaveProperty("image");
    const detail = await client.getRecord(record.id);
    expect(detail?.image).toEqual(new Uint8Array([1, 2, 3]));
    expect(detail?.imageback).toEqual(new Uint8Array([4, 5, 6]));
    expect(detail?.title_image).toEqual(new Uint8Array([7, 8, 9]));
    expect(await client.getRecord("missing")).toBeNull();
    await client.close();
    const bytes = await readFile(join(directory, "history.sqlite"));
    for (const secret of [
      "history-private-user",
      "history-private-password",
      "private-remark-not-stored",
      "private-extension-not-stored",
    ]) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("records once across all four recognition helpers, using the final submitted type and image", async () => {
    const { directory, createClient } = await fixture();
    const client = createClient({
      fetch: async (url) => {
        if (String(url).includes("reporterror"))
          return jsonResponse({ success: true, data: { result: "reported" } });
        if (String(url).includes("queryAccountInfo"))
          return jsonResponse({
            success: true,
            data: { balance: "1", consumed: "0", successNum: "0", failNum: "0" },
          });
        return jsonResponse(successBody());
      },
    });
    const imagePath = join(directory, "captcha.bin");
    await writeFile(imagePath, new Uint8Array([1, 2, 3]));
    await client.recognize({ image: "AA==", extra: { typeid: 4, image: "AQID" } });
    await client.recognizeOrThrow({ image: "AQID" });
    await recognizeFromFile(client, imagePath);
    await recognizeFromFileOrThrow(client, imagePath);
    await client.reportError({ id: "platform-id" });
    await client.queryAccountInfo();
    const page = await client.getRecords();
    expect(page.total).toBe(4);
    expect(new Set(page.items.map((item) => item.id)).size).toBe(4);
    const gif = page.items.find((item) => item.typeid === "4");
    expect(gif?.price).toBe("0.004000");
    expect(gif === undefined ? undefined : (await client.getRecord(gif.id))?.image).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(recognizeFromFile(client, join(directory, "missing.bin"))).rejects.toThrow(
      /ENOENT/,
    );
    expect((await client.getRecords()).total).toBe(4);
  });

  it("records API failures before throwing and leaves the possible charge unknown", async () => {
    const { directory, createClient } = await fixture();
    const client = createClient({
      history: { directory, prices: { "3": "0" } },
      fetch: async () => jsonResponse({ success: false, code: "-1", message: "failure", data: "" }),
    });
    await expect(client.recognizeOrThrow({ image: "AQID" })).rejects.toBeInstanceOf(
      ZkCaptchaApiError,
    );
    expect((await client.getRecords()).items[0]).toMatchObject({
      success: false,
      typeid: "3",
      result: null,
      price: null,
      pricingSource: "unknown",
    });
    expect((await client.getStats()).summary).toMatchObject({
      total: 1,
      failureCount: 1,
      successRate: 0,
      estimatedCost: "0.000000",
      unknownPriceCount: 1,
    });
  });

  it.each<{ code: string; fetch: FetchLike }>([
    {
      code: "NETWORK_ERROR",
      fetch: async () => {
        throw new Error("offline");
      },
    },
    {
      code: "HTTP_503",
      fetch: async () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }),
    },
    { code: "INVALID_JSON", fetch: async () => new Response("invalid json") },
    {
      code: "REDIRECT_BLOCKED",
      fetch: async () => new Response(null, { status: 307 }),
    },
    {
      code: "RESPONSE_TOO_LARGE",
      fetch: async () => new Response(" ".repeat(64 * 1024 + 1)),
    },
    {
      code: "INVALID_RESPONSE",
      fetch: async () => jsonResponse({ success: true, data: { result: 1, id: "id" } }),
    },
  ])("records $code without an invented zero charge", async ({ code, fetch }) => {
    const { createClient } = await fixture();
    const client = createClient({ fetch });
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      success: false,
      code,
    });
    expect((await client.getRecords()).items[0]).toMatchObject({
      code,
      price: null,
      success: false,
    });
  });

  it("records timeouts and external cancellation as unknown charges", async () => {
    const { createClient } = await fixture();
    vi.useFakeTimers();
    const client = createClient({
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (init?.signal?.aborted) rejectAbort();
          else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
        }),
    });
    const timeout = client.recognize({ image: "AQID" }, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(timeout).resolves.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.recognize({ image: "AQID" }, { signal: controller.signal }),
    ).resolves.toMatchObject({ code: "ABORTED" });
    expect((await client.getRecords()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TIMEOUT", price: null }),
        expect.objectContaining({ code: "ABORTED", price: null }),
      ]),
    );
  });

  it("does not record requests that fail before submission", async () => {
    const { createClient } = await fixture();
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(successBody()));
    const client = createClient({ fetch });
    const image = new Blob([]);
    vi.spyOn(image, "arrayBuffer").mockRejectedValue(new Error("image read failed"));
    await expect(client.recognize({ image })).rejects.toThrow("image read failed");
    expect(fetch).not.toHaveBeenCalled();
    expect((await client.getRecords()).total).toBe(0);
  });

  it("supports stable paging, UTC boundaries and matching overall/day/type statistics", async () => {
    const { createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    let body: unknown = successBody();
    const client = createClient({ fetch: async () => jsonResponse(body) });
    vi.setSystemTime("2026-10-30T23:59:59.999Z");
    await client.recognize({ image: "AQID", typeid: 3 });
    vi.setSystemTime("2026-10-31T00:00:00.000Z");
    body = { success: false, code: "-1", message: "failure", data: "" };
    await client.recognize({ image: "AQID", typeid: 4 });
    body = successBody();
    await client.recognize({ image: "AQID", typeid: "3" });
    await client.recognize({ image: "AQID", typeid: 32 });
    const all = await client.getRecords();
    const first = await client.getRecords({ limit: 2 });
    const second = await client.getRecords({ limit: 2, offset: 2 });
    expect([...first.items, ...second.items]).toEqual(all.items);
    expect(await client.getRecords({ offset: 100 })).toEqual({ items: [], total: 4 });
    expect((await client.getRecords({ typeid: 3 })).total).toBe(2);
    expect((await client.getRecords({ typeid: "3" })).total).toBe(2);
    expect((await client.getRecords({ success: false })).total).toBe(1);
    expect((await client.getRecords({ from: "2026-10-31T08:00:00+08:00" })).total).toBe(3);
    expect(
      (await client.getRecords({ from: "2026-10-30T23:59:59.999Z", to: "2026-10-31T00:00:00Z" }))
        .total,
    ).toBe(1);
    const stats = await client.getStats();
    expect(stats.summary).toMatchObject({
      total: 4,
      successCount: 3,
      failureCount: 1,
      successRate: 0.75,
      estimatedCost: "0.004000",
      unknownPriceCount: 2,
    });
    expect(stats.byDay.map((day) => [day.day, day.total])).toEqual([
      ["2026-10-30", 1],
      ["2026-10-31", 3],
    ]);
    expect(stats.byType.find((type) => type.typeid === "3")).toMatchObject({
      total: 2,
      estimatedCost: "0.004000",
    });
    expect((await client.getStats({ success: false })).summary).toMatchObject({
      total: 1,
      successCount: 0,
    });
    expect((await client.getStats({ typeid: "missing" })).summary).toEqual({
      total: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      averageDurationMs: 0,
      estimatedCost: "0.000000",
      unknownPriceCount: 0,
    });
    expect((await client.getRecords({ typeid: "3' OR 1=1 --" })).total).toBe(0);
  });

  it.each<HistoryListFilter>([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { from: "2026-10-31" },
    { to: "not-a-date" },
    { from: "2026-11-01T00:00:00Z", to: "2026-10-31T00:00:00Z" },
  ])("rejects invalid query input %j", async (filter) => {
    const { createClient } = await fixture();
    await expect(createClient().getRecords(filter)).rejects.toThrow(/limit|offset|时间|from/);
  });

  it("isolates accounts and service addresses without using passwords as the storage key", async () => {
    const { createClient } = await fixture();
    const first = createClient();
    const otherUser = createClient({ username: "other-user" });
    const otherService = createClient({ endpoint: "zhunkuai" });
    await Promise.all(
      [first, otherUser, otherService].map((client) => client.recognize({ image: "AQID" })),
    );
    const page = await first.getRecords();
    expect(page.total).toBe(1);
    expect((await otherUser.getRecords()).total).toBe(1);
    expect((await otherService.getStats()).summary.total).toBe(1);
    expect(await otherUser.getRecord(page.items[0]?.id ?? "missing")).toBeNull();
    expect((await createClient({ password: "changed-password" }).getRecords()).total).toBe(1);
  });

  it("reopens persisted records without repricing them and accumulates tiny amounts exactly", async () => {
    const { directory, createClient } = await fixture();
    const prices = { "3": "0.000001" };
    const first = createClient({ history: { directory, prices } });
    prices["3"] = "1";
    await first.recognize({ image: "AQID" });
    await first.close();
    const reopened = createClient({ history: { directory, prices: { "3": "0.000002" } } });
    await Promise.all(Array.from({ length: 10 }, () => reopened.recognize({ image: "AQID" })));
    const page = await reopened.getRecords();
    expect(page.total).toBe(11);
    expect(page.items.filter((record) => record.price === "0.000001")).toHaveLength(1);
    expect((await reopened.getStats()).summary.estimatedCost).toBe("0.000021");
  });

  it("keeps SQLite amounts exact when a configured price exceeds safe JavaScript integers", async () => {
    const { directory, createClient } = await fixture();
    const client = createClient({ history: { directory, prices: { "3": "9007199254.740993" } } });
    await client.recognize({ image: "AQID" });
    expect((await client.getRecords()).items[0]?.price).toBe("9007199254.740993");
    expect((await client.getStats()).summary.estimatedCost).toBe("9007199254.740993");
  });

  it.each([undefined, "local-records"])(
    "uses the nearest consuming project and captures cwd for directory %s",
    async (configured) => {
      const { directory, createClient } = await fixture();
      const project = join(directory, "app");
      const nested = join(project, "src");
      await mkdir(nested, { recursive: true });
      await writeFile(join(directory, "package.json"), "{}");
      await writeFile(join(project, "package.json"), "{}");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(nested);
      const client = createClient({
        history: configured === undefined ? {} : { directory: configured },
      });
      cwd.mockReturnValue(directory);
      await client.recognize({ image: "AQID" });
      expect(fs.existsSync(join(project, configured ?? ".zk-captcha", "history.sqlite"))).toBe(
        true,
      );
      expect(fs.existsSync(join(directory, ".zk-captcha"))).toBe(false);
    },
  );

  it("falls back to the captured cwd when there is no project manifest", async () => {
    const { directory, createClient } = await fixture();
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    vi.spyOn(fs, "statSync").mockReturnValue(undefined);
    const client = createClient({ history: {} });
    await client.recognize({ image: "AQID" });
    expect(fs.existsSync(join(directory, ".zk-captcha", "history.sqlite"))).toBe(true);
  });

  it("supports multiple open connections writing to the same WAL database", async () => {
    const { directory, createClient } = await fixture();
    const connections = Array.from({ length: 4 }, () => createClient());
    await Promise.all(
      connections.flatMap((client) =>
        Array.from({ length: 3 }, () => client.recognize({ image: "AQID" })),
      ),
    );
    expect((await connections[0]?.getStats())?.summary.total).toBe(12);
    const database = new DatabaseSync(join(directory, "history.sqlite"), { readOnly: true });
    try {
      expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("surfaces storage errors without changing results, survives throwing callbacks and retries later", async () => {
    const { directory, createClient } = await fixture();
    const blocked = join(directory, "blocked");
    await writeFile(blocked, "file blocks the directory");
    const onError = vi.fn<(error: Error) => void>();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createClient({ history: { directory: blocked, onError } });
    await expect(client.recognize({ image: "AQID" })).resolves.toEqual(successBody());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    await expect(client.getRecords()).rejects.toThrow(/EEXIST|ENOTDIR/);
    await expect(client.getStats()).rejects.toThrow(/EEXIST|ENOTDIR/);
    await expect(
      createClient({ history: { directory: blocked } }).recognize({ image: "AQID" }),
    ).resolves.toEqual(successBody());
    await expect(
      createClient({
        history: {
          directory: blocked,
          onError: () => {
            throw new Error("callback failed");
          },
        },
      }).recognize({ image: "AQID" }),
    ).resolves.toEqual(successBody());
    expect(warning).toHaveBeenCalledTimes(3);
    await unlink(blocked);
    await client.recognize({ image: "AQID" });
    expect((await client.getRecords()).total).toBe(1);
  });

  it("does not hide an invalid SQLite file as an empty history", async () => {
    const { directory, createClient } = await fixture();
    await writeFile(join(directory, "history.sqlite"), "invalid sqlite database");
    await expect(createClient().getStats()).rejects.toThrow(/database/i);
  });

  it.each(["getRecords", "getRecord", "getStats", "recognize"])(
    "cleans expired rows and all images during %s while retaining the exact cutoff",
    async (action) => {
      const { directory, createClient } = await fixture();
      vi.useFakeTimers({ toFake: ["Date"] });
      const seeder = createClient();
      const expiredTime = "2026-10-30T11:59:59.999Z";
      const cutoffTime = "2026-10-30T12:00:00.000Z";
      for (const time of [expiredTime, cutoffTime, "2026-10-31T12:00:00.000Z"]) {
        vi.setSystemTime(time);
        await seeder.recognize({ image: "AQID", imageback: "BAUG", title_image: "BwgJ" });
      }
      const expired = (await seeder.getRecords()).items.find(
        (item) => item.startedAt === expiredTime,
      );
      if (expired === undefined) throw new Error("缺少过期测试记录");
      await seeder.close();

      const client = createClient({ history: { directory, retentionDays: 1 } });
      const database = new DatabaseSync(join(directory, "history.sqlite"), { readOnly: true });
      try {
        expect(
          database.prepare("SELECT COUNT(*) AS total FROM recognition_records").get()?.total,
        ).toBe(3);
        if (action === "getRecords") {
          await client.getRecords();
        } else if (action === "getRecord") {
          await client.getRecord(expired.id);
        } else if (action === "getStats") {
          await client.getStats();
        } else {
          await client.recognize({ image: "AQID" });
        }
        // 直接读取 SQLite，避免后续 SDK 查询掩盖某个入口遗漏清理的问题。
        expect(
          database
            .prepare(
              "SELECT id, image, imageback, title_image FROM recognition_records WHERE id = ?",
            )
            .get(expired.id),
        ).toBeUndefined();
        expect(
          database.prepare("SELECT COUNT(*) AS total FROM recognition_records").get()?.total,
        ).toBe(action === "recognize" ? 3 : 2);
        expect((await client.getStats()).summary).toMatchObject({
          total: action === "recognize" ? 3 : 2,
          estimatedCost: action === "recognize" ? "0.006000" : "0.004000",
        });
        const boundary = database
          .prepare(
            "SELECT image, imageback, title_image FROM recognition_records WHERE started_at = ?",
          )
          .get(cutoffTime);
        expect(boundary?.image).toEqual(new Uint8Array([1, 2, 3]));
        expect(boundary?.imageback).toEqual(new Uint8Array([4, 5, 6]));
        expect(boundary?.title_image).toEqual(new Uint8Array([7, 8, 9]));
      } finally {
        database.close();
      }
    },
  );

  it("keeps old records and images when retention is not configured", async () => {
    const { createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2020-01-01T00:00:00Z");
    const client = createClient();
    await client.recognize({ image: "AQID" });
    await client.close();
    vi.setSystemTime("2026-10-31T00:00:00Z");
    const reopened = createClient();
    const record = (await reopened.getRecords()).items[0];
    if (record === undefined) throw new Error("默认保留的记录已丢失");
    expect((await reopened.getRecord(record.id))?.image).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("limits retention deletion to the current account and API address", async () => {
    const { directory, createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-29T00:00:00Z");
    const current = createClient();
    const otherUser = createClient({ username: "another-account" });
    const otherService = createClient({ endpoint: "zhunkuai" });
    for (const client of [current, otherUser, otherService]) {
      await client.recognize({ image: "AQID", imageback: "BAUG", title_image: "BwgJ" });
    }
    vi.setSystemTime("2026-10-31T00:00:00Z");
    const collector = createClient({ history: { directory, retentionDays: 1 } });
    expect((await collector.getStats()).summary.total).toBe(0);
    expect((await otherUser.getRecords()).total).toBe(1);
    expect((await otherService.getStats()).summary.total).toBe(1);
  });

  it("snapshots a getter-based retention policy before validating or deleting records", async () => {
    const { directory, createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-20T00:00:00Z");
    const seeder = createClient();
    await seeder.recognize({ image: "AQID" });
    vi.setSystemTime("2026-10-31T00:00:00Z");
    let reads = 0;
    const client = createClient({
      history: {
        directory,
        /**
         * 第二次读取会改变策略，用于验证校验与实际清理使用同一份配置快照。
         * @returns 首次保留 30 天，后续读取返回无效零值。
         */
        get retentionDays(): number {
          reads += 1;
          return reads === 1 ? 30 : 0;
        },
      },
    });
    expect(reads).toBe(1);
    expect((await client.getRecords()).total).toBe(1);
  });

  it("also removes a newly completed recognition whose start time has already expired", async () => {
    const { directory, createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-29T00:00:00Z");
    const client = createClient({
      history: { directory, retentionDays: 1 },
      fetch: async () => {
        vi.setSystemTime("2026-10-31T00:00:00Z");
        return jsonResponse(successBody());
      },
    });
    await expect(client.recognize({ image: "AQID" })).resolves.toEqual(successBody());
    const database = new DatabaseSync(join(directory, "history.sqlite"), { readOnly: true });
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS total FROM recognition_records").get()?.total,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid retention days %s before opening storage",
    async (retentionDays) => {
      const { directory, createClient } = await fixture();
      expect(() => createClient({ history: { directory, retentionDays } })).toThrow(
        /retentionDays/,
      );
      expect(fs.existsSync(join(directory, "history.sqlite"))).toBe(false);
    },
  );

  it("preserves recognition results and rows when automatic deletion fails, then retries", async () => {
    const { directory, createClient } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-29T00:00:00Z");
    const seeder = createClient();
    await seeder.recognize({ image: "AQID", imageback: "BAUG", title_image: "BwgJ" });
    await seeder.recognize({ image: "AQID" });
    await seeder.close();
    const database = new DatabaseSync(join(directory, "history.sqlite"));
    try {
      database.exec(
        "CREATE TRIGGER prevent_cleanup BEFORE DELETE ON recognition_records BEGIN SELECT RAISE(ABORT, 'cleanup blocked'); END;",
      );
      vi.setSystemTime("2026-10-31T00:00:00Z");
      const onError = vi.fn<(error: Error) => void>();
      const client = createClient({ history: { directory, retentionDays: 1, onError } });
      await expect(client.recognize({ image: "AQID" })).resolves.toEqual(successBody());
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0].message).toContain("cleanup blocked");
      expect(
        database.prepare("SELECT COUNT(*) AS total FROM recognition_records").get()?.total,
      ).toBe(3);
      await expect(client.getStats()).rejects.toThrow("cleanup blocked");
      database.exec("DROP TRIGGER prevent_cleanup");
      expect((await client.getRecords()).total).toBe(1);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("disables persistence completely and clearly rejects history queries", async () => {
    const { directory, createClient } = await fixture();
    const client = createClient({ history: false });
    await expect(client.recognize({ image: "AQID" })).resolves.toEqual(successBody());
    await expect(client.getRecords()).rejects.toThrow("记录功能未开启");
    await expect(client.getRecord("id")).rejects.toThrow("记录功能未开启");
    await expect(client.getStats()).rejects.toThrow("记录功能未开启");
    expect(fs.existsSync(join(directory, "history.sqlite"))).toBe(false);
  });

  it("waits for accepted recognition during close and rejects all new calls", async () => {
    const { createClient } = await fixture();
    let release: (response: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolveResponse) => {
      release = resolveResponse;
    });
    const client = createClient({ fetch: async () => delayed });
    const recognition = client.recognize({ image: "AQID" });
    let finished = false;
    const closing = client.close();
    void closing.then(() => {
      finished = true;
    });
    try {
      expect(client.close()).toBe(closing);
      await expect(client.recognize({ image: "AQID" })).rejects.toThrow("已关闭");
      expect(finished).toBe(false);
    } finally {
      release(jsonResponse(successBody()));
    }
    await recognition;
    await closing;
    expect((await createClient().getRecords()).total).toBe(1);
    await expect(client.getRecords()).rejects.toThrow("已关闭");
    await expect(client.getStats()).rejects.toThrow("已关闭");
    await expect(client.getRecord("id")).rejects.toThrow("已关闭");
    await expect(client.reportError({ id: "id" })).rejects.toThrow("已关闭");
    await expect(client.queryAccountInfo()).rejects.toThrow("已关闭");
  });
});
