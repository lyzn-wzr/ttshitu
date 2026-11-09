import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZkCaptchaApiError, ZkCaptchaClient } from "../src/index";
import type {
  FetchLike,
  ImageInput,
  RecognizeData,
  ZkCaptchaAlgorithmHandler,
  ZkCaptchaClientOptions,
  ZkCaptchaResponse,
} from "../src/index";

const clients: ZkCaptchaClient[] = [];
const servers: ReturnType<typeof createServer>[] = [];

/**
 * 构造所有算法共用的标准成功响应。
 * @param result 算法输出。
 * @returns 带算法自有编号的响应。
 */
const success = (result = "12"): ZkCaptchaResponse<RecognizeData> => ({
  success: true,
  code: "0",
  message: "success",
  data: { id: "algorithm-id", result },
});

/**
 * 默认隔离记录，统一关闭测试客户端。
 * @param options 测试需要的算法与请求配置。
 * @returns 无需平台凭证的客户端。
 */
const createClient = (options: ZkCaptchaClientOptions = {}): ZkCaptchaClient => {
  const client = new ZkCaptchaClient({ history: false, ...options });
  clients.push(client);
  return client;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

describe("custom algorithms", () => {
  it("selects algorithms explicitly, supports multiple types and snapshots local configuration", async () => {
    const first = vi.fn<ZkCaptchaAlgorithmHandler>(() => success("first"));
    const second = vi.fn<ZkCaptchaAlgorithmHandler>(async () => success("second"));
    const fetch = vi.fn<FetchLike>(async () => Response.json(success("platform")));
    const typeids = [3, 11];
    const algorithms = {
      first: { kind: "local", typeids, recognize: first },
      second: { kind: "local", typeids: [3], recognize: second },
    } satisfies NonNullable<ZkCaptchaClientOptions["algorithms"]>;
    const client = createClient({ username: "user", password: "pass", algorithms, fetch });
    typeids.splice(0);
    algorithms.first.recognize = second;
    for (const typeid of [3, "11"]) {
      expect(await client.recognizeOrThrow({ image: "AQID", algorithm: "first", typeid })).toEqual({
        id: "algorithm-id",
        result: "first",
      });
    }
    expect(await client.recognizeOrThrow({ image: "AQID", algorithm: "second" })).toMatchObject({
      result: "second",
    });
    expect(await client.recognizeOrThrow({ image: "AQID" })).toMatchObject({ result: "platform" });
    expect(first).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<ImageInput>([
    "AQID",
    "data:image/png;base64,AQID",
    new Uint8Array([1, 2, 3]),
    new Uint8Array([1, 2, 3]).buffer,
    new Blob([new Uint8Array([1, 2, 3])]),
    new File([new Uint8Array([1, 2, 3])], "captcha.png"),
    Buffer.from([1, 2, 3]),
  ])("normalizes all image inputs identically for local and HTTP algorithms: %s", async (image) => {
    const recognize = vi.fn<ZkCaptchaAlgorithmHandler>(() => success());
    const fetch = vi.fn<FetchLike>(async () => Response.json(success()));
    const client = createClient({
      username: "private-user",
      password: "private-password",
      fetch,
      algorithms: {
        local: { kind: "local", typeids: [3], recognize },
        http: { kind: "http", typeids: ["3"], url: "https://example.invalid/recognize" },
      },
    });
    const request = {
      image,
      imageback: new Uint8Array([4, 5, 6]),
      title_image: "data:image/png;base64,BwgJ",
      angle: 15,
      step: "2",
      typename: "math",
      remark: "hint",
      content: "question",
      modelid: 0,
      extra: { count: 2, enabled: true, value: null, omitted: undefined },
    };
    await client.recognize({ ...request, algorithm: "local" });
    await client.recognize({ ...request, algorithm: "http" });
    const normalized = recognize.mock.calls[0]?.[0];
    expect(normalized).toEqual({
      image: "AQID",
      imageback: "BAUG",
      title_image: "BwgJ",
      typeid: "3",
      angle: 15,
      step: "2",
      typename: "math",
      remark: "hint",
      content: "question",
      modelid: 0,
      extra: { count: 2, enabled: true, value: null },
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(normalized);
    expect(recognize.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("uses a real HTTP endpoint and snapshots its URL, headers and types", async () => {
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("Expected request bytes");
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ url: request.url, method: request.method, headers: request.headers, body });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(success()));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing HTTP port");
    const headers = { authorization: "Bearer algorithm-token", "Content-Type": "text/plain" };
    const algorithm = {
      kind: "http",
      typeids: [3],
      url: `http://127.0.0.1:${address.port}/solve?model=1`,
      headers,
    } satisfies NonNullable<ZkCaptchaClientOptions["algorithms"]>[string];
    const client = createClient({
      username: "platform-user",
      password: "platform-password",
      algorithms: { remote: algorithm },
    });
    algorithm.url = "https://example.invalid/changed";
    algorithm.typeids.length = 0;
    headers.authorization = "changed";
    expect(await client.recognize({ image: "AQID", algorithm: "remote" })).toEqual(success());
    expect(received).toEqual([
      expect.objectContaining({
        url: "/solve?model=1",
        method: "POST",
        body: { image: "AQID", typeid: "3" },
        headers: expect.objectContaining({
          authorization: "Bearer algorithm-token",
          "content-type": "application/json;charset=UTF-8",
        }),
      }),
    ]);
    expect(JSON.stringify(received)).not.toContain("platform-user");
    expect(JSON.stringify(received)).not.toContain("platform-password");
  });

  it.each(["missing", "toString", ""])(
    "returns failure for unregistered algorithm %s without a fallback",
    async (algorithm) => {
      const fetch = vi.fn<FetchLike>();
      const client = createClient({ fetch });
      await expect(client.recognize({ image: "AQID", algorithm })).resolves.toMatchObject({
        success: false,
        code: "ALGORITHM_NOT_FOUND",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported types without executing an algorithm or platform", async () => {
    const recognize = vi.fn<ZkCaptchaAlgorithmHandler>(() => success());
    const fetch = vi.fn<FetchLike>();
    const client = createClient({
      fetch,
      algorithms: { local: { kind: "local", typeids: [11], recognize } },
    });
    await expect(
      client.recognizeOrThrow({ image: "AQID", algorithm: "local" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TYPE" });
    expect(recognize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes local failures, exceptions and invalid payloads through OrThrow", async () => {
    const recognize = vi.fn<ZkCaptchaAlgorithmHandler>();
    recognize.mockReturnValueOnce({
      success: false,
      code: "REJECTED",
      message: "uncertain",
      data: "",
    });
    recognize.mockImplementationOnce(() => {
      throw new Error("model failed");
    });
    // @ts-expect-error 模拟未使用 TypeScript 的调用方返回无效结果。
    recognize.mockReturnValueOnce({ success: true, data: { result: 123, id: "id" } });
    const client = createClient({
      algorithms: { local: { kind: "local", typeids: [3], recognize } },
    });
    for (const code of ["REJECTED", "ALGORITHM_ERROR", "INVALID_RESPONSE"]) {
      await expect(
        client.recognizeOrThrow({ image: "AQID", algorithm: "local" }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("requires credentials only for platform operations", async () => {
    const fetch = vi.fn<FetchLike>();
    const client = createClient({ fetch });
    for (const response of [
      await client.recognize({ image: "AQID" }),
      await client.reportError({ id: "id" }),
      await client.queryAccountInfo(),
    ])
      expect(response).toMatchObject({ success: false, code: "MISSING_CREDENTIALS" });
    await expect(client.queryAccountInfoOrThrow()).rejects.toBeInstanceOf(ZkCaptchaApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { kind: "local", typeids: [], recognize: () => success() },
    { kind: "local", typeids: [" "], recognize: () => success() },
    { kind: "local", typeids: [Infinity], recognize: () => success() },
    { kind: "local", typeids: [null], recognize: () => success() },
    { kind: "local", typeids: [3], recognize: "invalid" },
    { kind: "unknown", typeids: [3] },
    { kind: "http", typeids: [3], url: "/relative" },
    { kind: "http", typeids: [3], url: "ftp://example.com" },
    { kind: "http", typeids: [3], url: "https://user:pass@example.com" },
    { kind: "http", typeids: [3], url: "https://example.com", headers: { token: 123 } },
    { kind: "http", typeids: [3], url: "https://example.com", headers: null },
    {
      kind: "http",
      typeids: [3],
      url: "https://example.com",
      headers: { "invalid header": "value" },
    },
  ])("validates invalid configuration at construction: %j", (algorithm) => {
    // @ts-expect-error 验证非 TypeScript 调用方的非法配置。
    expect(() => createClient({ algorithms: { invalid: algorithm } })).toThrow(TypeError);
  });

  it("rejects empty algorithm IDs", () => {
    expect(() =>
      createClient({
        algorithms: { " ": { kind: "local", typeids: [3], recognize: () => success() } },
      }),
    ).toThrow(TypeError);
  });

  it("does not invoke an already cancelled local algorithm", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const recognize = vi.fn<ZkCaptchaAlgorithmHandler>(() => success());
    const client = createClient({
      algorithms: { local: { kind: "local", typeids: [3], recognize } },
    });
    await expect(
      client.recognize({ image: "AQID", algorithm: "local" }, { signal: controller.signal }),
    ).resolves.toMatchObject({ code: "ABORTED" });
    expect(recognize).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancel"])(
    "stops waiting for an uncooperative local algorithm on %s",
    async (mode) => {
      let finish: ((response: ZkCaptchaResponse<RecognizeData>) => void) | undefined;
      let announce: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        announce = resolveStarted;
      });
      let contextSignal: AbortSignal | undefined;
      const recognize: ZkCaptchaAlgorithmHandler = (_request, context) =>
        new Promise((resolveResult) => {
          contextSignal = context.signal;
          finish = resolveResult;
          announce?.();
        });
      const client = createClient({
        algorithms: { local: { kind: "local", typeids: [3], recognize } },
      });
      const controller = new AbortController();
      const pending = client.recognize(
        { image: "AQID", algorithm: "local" },
        {
          timeoutMs: mode === "timeout" ? 10 : 0,
          signal: controller.signal,
        },
      );
      await started;
      if (mode === "cancel") controller.abort("custom reason");
      await expect(pending).resolves.toMatchObject({
        code: mode === "timeout" ? "TIMEOUT" : "ABORTED",
      });
      expect(contextSignal?.aborted).toBe(true);
      await client.close();
      finish?.(success("late"));
    },
  );

  it.each([
    {
      code: "REDIRECT_BLOCKED",
      respond: () =>
        new Response(null, { status: 307, headers: { location: "https://other.invalid" } }),
    },
    { code: "RESPONSE_TOO_LARGE", respond: () => new Response("x".repeat(65_537)) },
    { code: "INVALID_JSON", respond: () => new Response("invalid json") },
    {
      code: "INVALID_RESPONSE",
      respond: () => Response.json({ success: true, data: { result: 12 } }),
    },
    { code: "HTTP_500", respond: () => Response.json({ message: "failed" }, { status: 500 }) },
  ])("reuses HTTP protections for $code", async ({ code, respond }) => {
    const client = createClient({
      fetch: async () => respond(),
      algorithms: { remote: { kind: "http", typeids: [3], url: "https://example.invalid/solve" } },
    });
    await expect(client.recognize({ image: "AQID", algorithm: "remote" })).resolves.toMatchObject({
      success: false,
      code,
    });
  });

  it.each(["timeout", "cancel", "pre-cancel"])(
    "passes cancellation through the custom HTTP path: %s",
    async (mode) => {
      let announce: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        announce = resolveStarted;
      });
      const fetch = vi.fn<FetchLike>(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing request signal");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          announce?.();
        });
      });
      const client = createClient({
        fetch,
        timeoutMs: 1000,
        algorithms: {
          remote: { kind: "http", typeids: [3], url: "https://example.invalid/solve" },
        },
      });
      const controller = new AbortController();
      if (mode === "pre-cancel") controller.abort(new Error("cancelled before invocation"));
      const pending = client.recognize(
        { image: "AQID", algorithm: "remote" },
        {
          timeoutMs: mode === "timeout" ? 10 : 0,
          signal: controller.signal,
        },
      );
      if (mode !== "pre-cancel") await started;
      if (mode === "cancel") controller.abort("cancelled while fetching");
      await expect(pending).resolves.toMatchObject({
        code: mode === "timeout" ? "TIMEOUT" : "ABORTED",
      });
      expect(fetch).toHaveBeenCalledTimes(mode === "pre-cancel" ? 0 : 1);
    },
  );
});
