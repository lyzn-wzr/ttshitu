import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TtshituClient } from "../src/index";
import type { FetchLike } from "../src/index";
import { fileToBase64, recognizeFromFile } from "../src/node";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function mockFetch(impl: FetchLike) {
  return vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(impl);
}

describe("node helpers", () => {
  it("reads local files as base64", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ttshitu-"));
    const imagePath = join(directory, "captcha.bin");
    await writeFile(imagePath, new Uint8Array([1, 2, 3]));

    await expect(fileToBase64(imagePath)).resolves.toBe("AQID");
  });

  it("recognizes local files through an existing client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ttshitu-"));
    const imagePath = join(directory, "captcha.bin");
    await writeFile(imagePath, new Uint8Array([1, 2, 3]));
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
      fetch: fetchImpl,
      password: "p",
      username: "u",
    });

    const response = await recognizeFromFile(client, imagePath, {
      typeid: 3,
    });

    expect(response.success).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      image: "AQID",
      password: "p",
      typeid: "3",
      username: "u",
    });
  });
});
