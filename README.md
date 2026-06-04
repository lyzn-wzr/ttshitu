# ttshitu

面向图鉴兼容验证码识别接口的 TypeScript SDK。

这个包同时支持 Node 18+ 和现代浏览器，使用原生 `fetch`，发布 ESM 和 CommonJS
双格式构建，并提供详细的 TypeScript 类型和中文 JSDoc 注释。

## 安装

```bash
pnpm add ttshitu
```

## 快速开始

```ts
import { TtshituClient } from "ttshitu";

const client = new TtshituClient({
  username: "你的账号",
  password: "你的密码",
});

const response = await client.recognize({
  typeid: 3,
  image: "图片纯base64",
});

if (response.success) {
  console.log(response.data.result);
  console.log(response.data.id);
} else {
  console.error(response.code, response.message);
}
```

## 接口域名

官方文档示例使用 HTTP，因此 SDK 内置域名默认也是 HTTP。

```ts
import { TTshituEndpoints, TtshituClient } from "ttshitu";

console.log(TTshituEndpoints.ttshitu); // http://api.ttshitu.com
console.log(TTshituEndpoints.zhunkuai); // http://api.zhunkuai.cn
console.log(TTshituEndpoints.kuaishibie); // http://api.kuaishibie.cn

const client = new TtshituClient({
  username: "你的账号",
  password: "你的密码",
  endpoint: "zhunkuai",
});
```

如果要接入自己的后端代理或兼容服务，可以使用 `baseUrl`。`baseUrl` 优先级高于
`endpoint`；当没有写协议时，SDK 会按官方文档默认补全为 `http://`。

```ts
const client = new TtshituClient({
  username: "你的账号",
  password: "你的密码",
  baseUrl: "api.kuaishibie.cn",
});
```

## 图片识别

`recognize` 调用 `POST /predict`，使用 JSON 请求体和 base64 图片字段。

```ts
const response = await client.recognize({
  image: "data:image/png;base64,iVBORw0KGgo...",
  typeid: 3,
  remark: "可选识别提示",
});
```

支持的图片输入：

- 纯 base64 字符串
- `data:image/png;base64,...` 形式的 Data URL
- `ArrayBuffer`
- `Uint8Array`
- `Blob` 或 `File`

双图识别或快速点选类型可以传入 `imageback` 和 `title_image`。

```ts
await client.recognize({
  typeid: 1033,
  image: foregroundBase64,
  imageback: backgroundBase64,
});
```

## 报错

`reportError` 调用 `POST /reporterror.json`。官方说明报错结果约 5 分钟后批量更新并返还次数或金额。

```ts
const result = await client.recognize({
  typeid: 3,
  image: "图片纯base64",
});

if (result.success) {
  await client.reportError({
    id: result.data.id,
  });
}
```

## 余额查询

`queryAccountInfo` 调用 `GET /queryAccountInfo.json`。

```ts
const response = await client.queryAccountInfo();

if (response.success) {
  console.log(response.data.balance);
  console.log(response.data.consumed);
}
```

## 抛错式辅助方法

默认方法返回 `success` 判别联合，不会因为接口失败、HTTP 错误、网络错误、超时或 JSON
解析失败而抛出异常。如果业务更喜欢异常流程，可以使用 `*OrThrow` 方法或 `unwrap`。

```ts
import { unwrap } from "ttshitu";

const data = await client.recognizeOrThrow({
  typeid: 3,
  image: "图片纯base64",
});

const response = await client.queryAccountInfo();
const account = unwrap(response);
```

失败时会抛出 `TtshituApiError`，错误信息为中文，并保留原始失败响应。

## Node 文件辅助

主入口 `ttshitu` 不依赖 Node 文件系统，适合浏览器打包。Node 专用的文件读取函数从
`ttshitu/node` 导入。

```ts
import { TtshituClient } from "ttshitu";
import { fileToBase64, recognizeFromFile } from "ttshitu/node";

const client = new TtshituClient({
  username: "你的账号",
  password: "你的密码",
});

const image = await fileToBase64("./captcha.png");
await client.recognize({
  typeid: 3,
  image,
});

await recognizeFromFile(client, "./captcha.png", {
  typeid: 3,
});
```

## CommonJS

```js
const { TtshituClient } = require("ttshitu");
const { recognizeFromFile } = require("ttshitu/node");
```

## 浏览器注意事项

浏览器端可以直接传入 `Blob` 或 `File`。

```ts
const file = input.files?.[0];

if (file) {
  await client.recognize({
    typeid: 3,
    image: file,
  });
}
```

直接在浏览器请求会暴露图鉴账号和密码，也可能受接口域名 CORS 策略影响。生产环境建议通过你自己的后端代理访问，并将 `baseUrl` 指向代理地址。

## 开发命令

```bash
pnpm install
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

一键质量检查：

```bash
pnpm check
```

## 参考文档

<http://www.ttshitu.com/docs/index.html>
