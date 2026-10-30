import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ZkCaptchaEndpoints,
  ZkCaptchaApiError,
  ZkCaptchaClient,
  imageToBase64,
  unwrap,
} from "../src/index";
import type {
  AccountInfoData,
  FetchLike,
  ZkCaptchaClientOptions,
  ZkCaptchaResponse,
} from "../src/index";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

function mockFetch(impl: FetchLike) {
  return vi.fn<FetchLike>(impl);
}

/**
 * 隔离本地存储，允许用例覆盖请求保护配置。
 * @param fetchImpl 模拟的网络边界。
 * @param options 当前用例的客户端配置。
 * @returns 不写入识别记录的客户端。
 */
const createClient = (
  fetchImpl: FetchLike,
  options: Partial<ZkCaptchaClientOptions> = {},
): ZkCaptchaClient => {
  return new ZkCaptchaClient({
    history: false,
    fetch: fetchImpl,
    password: "pass",
    username: "user",
    ...options,
  });
};

describe("ZkCaptchaClient endpoints", () => {
  it("uses the default zk-captcha endpoint and strips data URL prefixes", async () => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse({
        code: "0",
        data: {
          id: "captcha-id",
          result: "abcd",
        },
        message: "success",
        success: true,
      }),
    );
    const client = createClient(fetchImpl);

    const response = await client.recognize({
      image: "data:image/png;base64,YWJjZA==",
      typeid: 3,
    });

    expect(response.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.ttshitu.com/predict");
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/json;charset=UTF-8",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      image: "YWJjZA==",
      password: "pass",
      typeid: "3",
      username: "user",
    });
  });

  it("supports all built-in endpoint aliases", async () => {
    const aliases = Object.keys(ZkCaptchaEndpoints) as Array<keyof typeof ZkCaptchaEndpoints>;

    for (const endpoint of aliases) {
      const fetchImpl = mockFetch(async (_url, _init) =>
        jsonResponse({
          code: "0",
          data: {
            balance: "1",
            consumed: "2",
            failNum: "0",
            successNum: "3",
          },
          message: "success",
          success: true,
        }),
      );
      const client = new ZkCaptchaClient({
        history: false,
        endpoint,
        fetch: fetchImpl,
        password: "p",
        username: "u",
      });

      await client.queryAccountInfo();

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe(
        `${ZkCaptchaEndpoints[endpoint]}/queryAccountInfo.json?username=u&password=p`,
      );
      expect(init?.method).toBe("GET");
      expect(String(url).startsWith("https://")).toBe(true);
      expect(init?.redirect).toBe("manual");
      expect(init?.body).toBeUndefined();
    }
  });

  it("lets custom baseUrl override endpoint and defaults missing protocols to HTTPS", async () => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse({
        code: "0",
        data: {
          id: "id",
          result: "ok",
        },
        message: "success",
        success: true,
      }),
    );
    const client = new ZkCaptchaClient({
      history: false,
      baseUrl: "api.zhunkuai.cn/",
      endpoint: "kuaishibie",
      fetch: fetchImpl,
      password: "p",
      username: "u",
    });

    await client.recognize({
      image: "abc",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.zhunkuai.cn/predict");
  });

  it.each(["http", "https"])("preserves explicit %s and path prefixes", async (protocol) => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse({
        code: "0",
        data: {
          id: "id",
          result: "ok",
        },
        message: "success",
        success: true,
      }),
    );
    const client = new ZkCaptchaClient({
      history: false,
      baseUrl: `${protocol}://proxy.example.com/zk-captcha/?ignored=true#hash`,
      fetch: fetchImpl,
      password: "p",
      username: "u",
    });

    await client.recognize({
      image: "abc",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${protocol}://proxy.example.com/zk-captcha/predict`);
  });

  it.each(["ftp://example.com", "file:///tmp/captcha", "https://user:pass@example.com"])(
    "rejects unsupported protocols or embedded credentials: %s",
    (baseUrl) => {
      const fetchImpl = mockFetch(async () => new Response());
      expect(() => createClient(fetchImpl, { baseUrl })).toThrow(TypeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe("ZkCaptchaClient request methods", () => {
  it("normalizes optional recognition fields and extra fields", async () => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse({
        code: "0",
        data: {
          id: "id",
          result: "ok",
        },
        message: "success",
        success: true,
      }),
    );
    const client = createClient(fetchImpl);

    await client.recognize({
      angle: 90,
      content: "click",
      extra: {
        custom: true,
        omitted: undefined,
      },
      image: "abc",
      imageback: new Uint8Array([1, 2, 3]),
      modelid: 12,
      remark: "hint",
      step: 10,
      title_image: new Uint8Array([4, 5, 6]),
      typename: "learn",
      typeid: 1033,
    });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      angle: "90",
      content: "click",
      custom: "true",
      image: "abc",
      imageback: "AQID",
      modelid: "12",
      password: "pass",
      remark: "hint",
      step: "10",
      title_image: "BAUG",
      typename: "learn",
      typeid: "1033",
      username: "user",
    });
  });

  it("posts report error requests", async () => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse({
        code: "0",
        data: {
          result: "reported",
        },
        message: "success",
        success: true,
      }),
    );
    const client = createClient(fetchImpl);

    const response = await client.reportError({
      id: "captcha-id",
    });

    expect(response.success).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.ttshitu.com/reporterror.json");
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      id: "captcha-id",
    });
  });

  it("returns failed API responses without throwing", async () => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse({
        code: "-1",
        data: "",
        message: "bad credentials",
        success: false,
      }),
    );
    const client = createClient(fetchImpl);

    const response = await client.recognize({
      image: "abc",
    });

    expect(response).toEqual({
      code: "-1",
      data: "",
      message: "bad credentials",
      success: false,
    });
  });

  it("turns HTTP errors into failed responses", async () => {
    const fetchImpl = mockFetch(async (_url, _init) =>
      jsonResponse(
        {
          message: "server down",
        },
        {
          status: 503,
          statusText: "Service Unavailable",
        },
      ),
    );
    const client = createClient(fetchImpl);

    await expect(
      client.recognize({
        image: "abc",
      }),
    ).resolves.toMatchObject({
      code: "HTTP_503",
      message: "server down",
      success: false,
    });
  });

  it("turns invalid JSON into failed responses", async () => {
    const fetchImpl = mockFetch(async (_url, _init) => new Response("not json"));
    const client = createClient(fetchImpl);

    await expect(
      client.recognize({
        image: "abc",
      }),
    ).resolves.toMatchObject({
      code: "INVALID_JSON",
      success: false,
    });
  });

  it("turns request timeout into failed responses", async () => {
    vi.useFakeTimers();
    const fetchImpl = mockFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const client = createClient(fetchImpl);

    const promise = client.recognize(
      {
        image: "abc",
      },
      {
        timeoutMs: 10,
      },
    );

    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).resolves.toMatchObject({
      code: "TIMEOUT",
      success: false,
    });
    vi.useRealTimers();
  });
});

describe("ZkCaptchaClient request protection", () => {
  /** 含多字节字符的合法响应，用于区分字节数与字符数限制。 */
  const text = JSON.stringify({ success: true, data: { id: "id", result: "汉𠮷" } });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxResponseBytes: %s",
    (maxResponseBytes) => {
      const fetchImpl = mockFetch(async () => new Response());
      expect(() => createClient(fetchImpl, { maxResponseBytes })).toThrow("maxResponseBytes");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([301, 302, 303, 307, 308])("rejects HTTP %i before reading JSON", async (status) => {
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const client = createClient(
      mockFetch(
        async () => new Response(body, { status, headers: { location: "https://other.test" } }),
      ),
    );
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      success: false,
      code: "REDIRECT_BLOCKED",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an already-followed response from a custom fetch", async () => {
    const response = new Response(text);
    Object.defineProperty(response, "redirected", { value: true });
    const client = createClient(mockFetch(async () => response));
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      code: "REDIRECT_BLOCKED",
    });
  });

  it.each(["recognize", "reportError", "queryAccountInfo"])(
    "does not forward credentials via real fetch redirects for %s",
    async (method) => {
      const paths: string[] = [];
      const server = createServer((request, response) => {
        paths.push(new URL(request.url ?? "/", "http://localhost").pathname);
        response.writeHead(307, { location: "/forwarded" });
        response.end("redirect");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing server port");
      const client = createClient(globalThis.fetch, {
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      try {
        const result =
          method === "recognize"
            ? await client.recognize({ image: "AQID" })
            : method === "reportError"
              ? await client.reportError({ id: "id" })
              : await client.queryAccountInfo();
        expect(result).toMatchObject({ success: false, code: "REDIRECT_BLOCKED" });
        expect(paths).toHaveLength(1);
        expect(paths).not.toContain("/forwarded");
      } finally {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("enforces the default 64 KiB limit and supports a larger configured limit", async () => {
    const padded = text + " ".repeat(64 * 1024 + 1 - new TextEncoder().encode(text).byteLength);
    const fetchImpl = mockFetch(async () => new Response(padded));
    const client = createClient(fetchImpl);
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      success: false,
    });
    const larger = createClient(fetchImpl, { maxResponseBytes: 64 * 1024 + 1 });
    await expect(larger.recognize({ image: "AQID" })).resolves.toMatchObject({ success: true });
  });

  it("rejects an oversized Content-Length before consuming and ignores cancellation errors", async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {
      throw new Error("cancel failed");
    });
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { "content-length": "65" } });
    const client = createClient(
      mockFetch(async () => response),
      { maxResponseBytes: 64 },
    );
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, "1", "invalid"])(
    "checks streamed bytes when Content-Length is %s and cancels on overflow",
    async (contentLength) => {
      const cancel = vi.fn<() => void>();
      const bytes = new TextEncoder().encode(text);
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(bytes.subarray(0, 10));
          controller.enqueue(bytes.subarray(10));
        },
        cancel,
      });
      const headers = new Headers();
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      const response = new Response(body, { headers });
      const client = createClient(
        mockFetch(async () => response),
        { maxResponseBytes: text.length },
      );
      await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
        code: "RESPONSE_TOO_LARGE",
        success: false,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    },
  );

  it("allows exactly the byte limit and decodes a split BOM and multibyte characters", async () => {
    const bytes = new TextEncoder().encode(`\uFEFF${text}`);
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const client = createClient(
      mockFetch(async () => new Response(body)),
      {
        maxResponseBytes: bytes.byteLength,
      },
    );
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      success: true,
      data: { result: "汉𠮷" },
    });
  });

  it("preserves network errors while releasing an errored response stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.error(new Error("stream failed")),
    });
    const client = createClient(mockFetch(async () => new Response(body)));
    await expect(client.recognize({ image: "AQID" })).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      message: "stream failed",
    });
    expect(body.locked).toBe(false);
  });

  it("keeps timeout protection active while reading the body", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            init?.signal?.addEventListener("abort", () => {
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          },
        });
        return new Response(body);
      });
      const client = createClient(fetchImpl);
      const result = client.recognize({ image: "AQID" }, { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toMatchObject({ code: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports empty response bodies without throwing and exposes protection codes to OrThrow", async () => {
    const empty = createClient(mockFetch(async () => new Response(null)));
    await expect(empty.recognize({ image: "AQID" })).resolves.toMatchObject({
      code: "INVALID_JSON",
    });
    const large = createClient(
      mockFetch(async () => new Response(text)),
      { maxResponseBytes: 1 },
    );
    await expect(large.recognizeOrThrow({ image: "AQID" })).rejects.toMatchObject({
      response: { code: "RESPONSE_TOO_LARGE" },
    });
    const redirect = createClient(mockFetch(async () => new Response(null, { status: 302 })));
    await expect(redirect.recognizeOrThrow({ image: "AQID" })).rejects.toMatchObject({
      response: { code: "REDIRECT_BLOCKED" },
    });
  });
});

describe("throwing helpers and types", () => {
  it("unwrap returns data for success and throws ZkCaptchaApiError for failure", () => {
    const success = unwrap({
      code: "0",
      data: {
        id: "id",
        result: "ok",
      },
      message: "success",
      success: true,
    });

    expect(success.result).toBe("ok");
    expect(() =>
      unwrap({
        code: "-1",
        data: "",
        message: "bad",
        success: false,
      }),
    ).toThrow(ZkCaptchaApiError);
  });

  it("narrows response data by success", () => {
    function assertNarrowing(response: ZkCaptchaResponse<AccountInfoData>): void {
      if (response.success) {
        expectTypeOf(response.data.balance).toEqualTypeOf<string>();
      } else {
        expectTypeOf(response.data).toEqualTypeOf<unknown>();
      }
    }

    expect(assertNarrowing).toBeTypeOf("function");
  });
});

describe("imageToBase64", () => {
  it("supports raw base64, data URLs, ArrayBuffer, Uint8Array, and Blob", async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;

    await expect(imageToBase64("abc")).resolves.toBe("abc");
    await expect(imageToBase64("data:image/png;base64,abc")).resolves.toBe("abc");
    await expect(imageToBase64(buffer)).resolves.toBe("AQID");
    await expect(imageToBase64(new Uint8Array([1, 2, 3]))).resolves.toBe("AQID");
    await expect(imageToBase64(new Blob([new Uint8Array([1, 2, 3])]))).resolves.toBe("AQID");
  });
});
