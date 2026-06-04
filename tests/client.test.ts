import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  TTshituEndpoints,
  TtshituApiError,
  TtshituClient,
  imageToBase64,
  unwrap,
} from "../src/index";
import type { AccountInfoData, FetchLike, TtshituResponse } from "../src/index";

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
  return vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(impl);
}

function createClient(fetchImpl: FetchLike): TtshituClient {
  return new TtshituClient({
    fetch: fetchImpl,
    password: "pass",
    username: "user",
  });
}

describe("TtshituClient endpoints", () => {
  it("uses the default ttshitu endpoint and strips data URL prefixes", async () => {
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
    expect(url).toBe("http://api.ttshitu.com/predict");
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
    const aliases = Object.keys(TTshituEndpoints) as Array<keyof typeof TTshituEndpoints>;

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
      const client = new TtshituClient({
        endpoint,
        fetch: fetchImpl,
        password: "p",
        username: "u",
      });

      await client.queryAccountInfo();

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe(
        `${TTshituEndpoints[endpoint]}/queryAccountInfo.json?username=u&password=p`,
      );
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });

  it("lets custom baseUrl override endpoint and normalizes missing protocols to HTTP", async () => {
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
    const client = new TtshituClient({
      baseUrl: "api.zhunkuai.cn/",
      endpoint: "kuaishibie",
      fetch: fetchImpl,
      password: "p",
      username: "u",
    });

    await client.recognize({
      image: "abc",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://api.zhunkuai.cn/predict");
  });

  it("preserves path prefixes in custom baseUrl values", async () => {
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
    const client = new TtshituClient({
      baseUrl: "http://proxy.example.com/ttshitu/?ignored=true#hash",
      fetch: fetchImpl,
      password: "p",
      username: "u",
    });

    await client.recognize({
      image: "abc",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://proxy.example.com/ttshitu/predict");
  });
});

describe("TtshituClient request methods", () => {
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
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://api.ttshitu.com/reporterror.json");
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

describe("throwing helpers and types", () => {
  it("unwrap returns data for success and throws TtshituApiError for failure", () => {
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
    ).toThrow(TtshituApiError);
  });

  it("narrows response data by success", () => {
    function assertNarrowing(response: TtshituResponse<AccountInfoData>): void {
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
