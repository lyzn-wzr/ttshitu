# zk-captcha

面向图鉴/准快/快识别平台验证码识别的SDK。

仅支持 **Node 22.13+ / Bun 1.4.4+**，使用原生 `fetch` 和内置 `node:sqlite`，没有第三方运行时依赖。
发布 ESM、CommonJS 和 TypeScript 类型，默认在使用此 SDK 的项目中保存识别记录。

包的条件导出拒绝浏览器入口，不提供浏览器构建或兼容兜底。此限制作用于导入和运行；包管理器安装时无法判断项目最终面向的环境。

Bun 1.4.4 修复了 `node:sqlite` 关闭后仍保留文件锁的问题，因此不支持更早的 Bun 版本。

## 从 0.1.0 升级到 1.0.0

这是包含不兼容行为变更的主版本，完整变更见 [CHANGELOG.md](./CHANGELOG.md)。升级前请检查：

- 将运行环境升级到 Node 22.13+ 或 Bun 1.4.4+，将浏览器中的 SDK 调用迁到自己的服务端。
- 默认使用 HTTPS；必须走 HTTP 的兼容服务请显式填写 `baseUrl: "http://..."`。所有请求均不再自动跟随重定向；成功响应也会校验对应接口的 `data` 结构。
- 默认保存识别明细与原始图片。在使用 SDK 的项目中忽略并保护 `.zk-captcha/`；不需要持久化时传入 `history: false`，限制保留期时配置 `history.retentionDays`。
- 接口地址按协议隔离记录，旧 HTTP 地址下的明细不会自动迁入 HTTPS 地址。参考费用不代表平台账单。
- 退出前调用并等待 `client.close()`；关闭后创建新客户端再发起请求。需要接收超过 64 KiB 响应时显式调整 `maxResponseBytes`。

```bash
pnpm add @lyzn/zk-captcha@^1.0.0
# 或
bun add @lyzn/zk-captcha@^1.0.0
```

## 安装

```bash
pnpm add @lyzn/zk-captcha
# 或
bun add @lyzn/zk-captcha
```

## 快速开始

```ts
import { ZkCaptchaClient } from "@lyzn/zk-captcha";

const client = new ZkCaptchaClient({
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

await client.close();
```

长驻服务可以复用同一个客户端；退出前调用 `close()`，等待已接收的请求和记录完成并释放数据库连接。
关闭后不能继续调用该客户端，重复关闭安全。

## 接口域名

SDK 内置域名默认使用 HTTPS。

```ts
import { ZkCaptchaEndpoints, ZkCaptchaClient } from "@lyzn/zk-captcha";

console.log(ZkCaptchaEndpoints.ttshitu); // https://api.ttshitu.com
console.log(ZkCaptchaEndpoints.zhunkuai); // https://api.zhunkuai.cn
console.log(ZkCaptchaEndpoints.kuaishibie); // https://api.kuaishibie.cn

const client = new ZkCaptchaClient({
  username: "你的账号",
  password: "你的密码",
  endpoint: "zhunkuai",
});
```

如果要接入自己的后端代理或兼容服务，可以使用 `baseUrl`。`baseUrl` 优先级高于
`endpoint`；没有写协议时默认补全为 `https://`，显式指定的 `http://` 或 `https://` 会保留。
其他协议或在 URL 中内嵌用户名、密码会在创建客户端时抛错。路径前缀会保留，查询参数和片段会移除。

```ts
const client = new ZkCaptchaClient({
  username: "你的账号",
  password: "你的密码",
  baseUrl: "api.kuaishibie.cn",
});
```

## 请求保护

所有接口均禁止自动跟随重定向，收到 3xx 时返回 `success: false`、`code: "REDIRECT_BLOCKED"`，避免账号、密码和图片被转发到其他地址。
显式配置 HTTP 时会按原协议发送，不会自动降级 HTTPS 或重试识别请求。

```ts
const client = new ZkCaptchaClient({
  username: "你的账号",
  password: "你的密码",
  maxResponseBytes: 128 * 1024, // 可选：响应上限改为 128 KiB，默认 64 KiB
});
```

`maxResponseBytes` 须为正安全整数，以字节为单位，仅限制响应体，不限制上传图片。
声明的 `Content-Length` 超限时提前拒绝；无论是否存在该头，都会按流检查解压后的实际字节数，恰好等于上限允许通过。
超限会停止读取并取消响应流，返回 `success: false`、`code: "RESPONSE_TOO_LARGE"`；`OrThrow` 方法会抛出带该错误码的 `ZkCaptchaApiError`。
两类失败均沿用现有记录规则：识别失败记录一次，估算价格未知。

自定义 `fetch` 须遵守传入的 `redirect: "manual"` 和中断信号，返回尚未读取的响应流；SDK 无法撤回自定义实现已自行转发的请求。
接口地址按协议隔离本地记录，改用 HTTPS 后不会自动合并或迁移旧 HTTP 地址下的记录。

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
import { unwrap } from "@lyzn/zk-captcha";

const data = await client.recognizeOrThrow({
  typeid: 3,
  image: "图片纯base64",
});

const response = await client.queryAccountInfo();
const account = unwrap(response);
```

失败时会抛出 `ZkCaptchaApiError`，错误信息为中文，并保留原始失败响应。

## 本地文件辅助

主入口直接提供文件辅助函数，原有 `@lyzn/zk-captcha/node` 子入口继续兼容。两种入口都用于 Node/Bun。

```ts
import { ZkCaptchaClient, fileToBase64, recognizeFromFile } from "@lyzn/zk-captcha";

const client = new ZkCaptchaClient({
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

await client.close();
```

## CommonJS

```js
const { ZkCaptchaClient } = require("@lyzn/zk-captcha");
const { recognizeFromFile } = require("@lyzn/zk-captcha/node");
```

## 本地识别明细

默认自动保存成功和失败请求。数据库位于**使用 SDK 的项目根目录**下的 `.zk-captcha/history.sqlite`，并非 SDK 安装目录。
从客户端创建时的工作目录向上查找最近的 `package.json`；没有项目清单则使用该工作目录。之后切换工作目录不会改变保存位置。
数据库首次读写时才创建，支持同一台机器上的多个客户端或进程共享，使用 WAL 和 5 秒锁等待。

```ts
const client = new ZkCaptchaClient({
  username: "你的账号",
  password: "你的密码",
  history: {
    directory: ".zk-captcha", // 默认值，相对目录从上述项目根目录解析，也支持绝对目录
    retentionDays: 30, // 可选：自动清理超过 30×24 小时的明细及图片，未设置则永久保留
    prices: { "3": "0.0002" }, // 可选：用自己的套餐价格覆盖，单位元、最多六位小数
    onError: (error) => console.warn("本地记录处理失败", error),
  },
});

try {
  await client.recognize({ image: "图片纯base64", typeid: 3 });

  const page = await client.getRecords({
    from: "2026-10-31T00:00:00+08:00", // 包含边界，必须带时区
    to: "2026-11-01T00:00:00+08:00", // 不包含边界
    typeid: 3,
    success: true,
    limit: 20,
    offset: 0,
  });
  console.log(page.total, page.items);

  const first = page.items[0];
  if (first) {
    const detail = await client.getRecord(first.id); // 使用本地 UUID
    console.log(detail?.image, detail?.imageback, detail?.title_image); // Uint8Array 或 null
  }
} finally {
  await client.close();
}
```

明细字段：本地 `id`、平台 `captchaId`、`typeid`、`typeName`、UTC 时间 `startedAt`、耗时 `durationMs`、
`success`、`result`、`code`、`message`、估算价格 `price` 和来源 `pricingSource`。
价格为固定六位小数的人民币字符串，未知时为 `null`。耗时包含图片转换和请求，不包含本地写入。

列表只读元数据；单条明细再加载主图、背景图和标题图的 BLOB。不存在的记录返回 `null`。
分页默认 20 条，单页允许 1～100 条，偏移为非负安全整数；按时间及本地 ID 倒序稳定排序。
`recognizeOrThrow` 和文件辅助方法共用一次记录流程；文件读取或图片转换在请求前失败时不会产生识别记录。

查询自动按账号与规范化接口地址隔离，不保存明文账号、密码、完整请求或任意扩展字段。
保存或自动清理失败会调用 `onError`，未配置则输出警告，识别返回值保持不变；主动查询及其清理失败会抛出错误。

完全关闭记录：

```ts
const client = new ZkCaptchaClient({ username: "你的账号", password: "你的密码", history: false });
```

关闭记录后，`getRecords`、`getRecord`、`getStats` 会抛出“记录功能未开启”错误。
`history.retentionDays` 接受正整数，按识别开始时间滚动保留最近 N×24 小时的数据；恰好位于保留边界的记录仍保留。
每次本地写入后、查询前自动清理当前账号与接口的过期行，主图、背景图、标题图随明细一起删除，统计仅包含仍保留的明细。
没有读写时不触发清理；未配置该选项则永久保留。清理不会删除其他账号或接口的记录，也不会重建数据库。
SQLite 删除后的空间可供后续写入复用，数据库文件不保证立即缩小。

请在使用项目的 `.gitignore` 中加入 `.zk-captcha/`，并按需备份目录；SDK 不修改宿主项目的忽略规则。

## 本地统计

```ts
const stats = await client.getStats({
  from: "2026-10-01T00:00:00Z",
  to: "2026-11-01T00:00:00Z",
  // typeid、success 与明细使用相同筛选语义
});

console.log(stats.summary); // 总体统计
console.log(stats.byDay); // 按 UTC 日期升序，各项含 day
console.log(stats.byType); // 按类型编号字典序，各项含 typeid、typeName
```

每组统计包含 `total`、`successCount`、`failureCount`、`successRate`（0～1）、`averageDurationMs`、
`estimatedCost`（已知费用合计）及 `unknownPriceCount`。没有记录时计数、成功率、平均耗时为 0，金额为 `"0.000000"`。
总体与分组使用同一 SQLite 读取快照，统计只针对本地成功保存的请求。

## 参考价格

内置价格依据[官方分类价格](https://www.ttshitu.com/price.html)与[类型说明](https://www.ttshitu.com/docs/index.html)，是非套餐参考估算。
金额使用整数微元计算，数据库保存调用时的费用，后续调整配置不重算历史。

| 每次参考价格（元） | 类型 ID                    |
| ------------------ | -------------------------- |
| 0.002              | 1、1001、2、1002、3、1003  |
| 0.004              | 4                          |
| 0.008              | 11、1005、5                |
| 0.010              | 19、18、33、34、3400       |
| 0.016              | 29、1029、20、27、1033、53 |
| 0.020              | 2029、21                   |
| 0.025              | 22                         |
| 0.030              | 48                         |

- `16`：成功结果的 Unicode 字符数 × 0.008 元；空结果记未知。
- `7`：纯数英前四位合计 0.008 元，超出每位加 0.002 元；纯汉字每字 0.008 元，混合或不明确结果记未知。
- `32`、`66`、自定义类型、私有接口及定制模型默认未知，可通过 `history.prices` 按类型指定固定价格。
- 显式覆盖价格优先于所有内置规则，`"0"` 是有效零价格；`pricingSource` 为 `official`、`custom` 或 `unknown`。
- 所有失败请求的费用均为未知，不当作免费。官方说明超时仍可能扣费，统计会单列未知费用次数。
- 本地估算不含套餐优惠和报错退款，报错接口不会回改历史费用；平台实际消费请调用 `queryAccountInfo`。

## 本地人工验收

本地验收台需要 Bun 1.4.4+，仅提供桌面布局。在项目目录运行：

```bash
pnpm install
pnpm dev
# 或 bun run dev
```

打开 [http://127.0.0.1:3210](http://127.0.0.1:3210)，默认载入示例图片和 `demo` 账号。
服务只监听 `127.0.0.1`；退出终端或按 `Ctrl+C` 停止。端口占用时可在 PowerShell 中先执行 `$env:PORT = "3211"` 再启动。

- **本地模拟**：不访问识别平台、不产生费用。仅替换 SDK 的 `fetch`，图片转换、响应校验、计价、SQLite 写入与查询均使用实际实现。可选成功、识别失败、超时、HTTP 500、无效 JSON、重定向、响应超限七种场景。
- **真实接口**：选择平台并填写自己的账号密码，上传图片后点击“调用真实接口”。识别可能产生平台费用；余额查询和报错也会调用真实平台。自定义接口地址可在“更多配置”中填写。
- **记录与统计**：核对成功/失败明细、原始图片、参考费用和未知费用次数，按类型、状态和本地时间筛选，分页查看；展开分组统计可查看 SDK 返回的类型与 UTC 日期汇总。
- **配置验证**：可修改模拟结果测试汉字等按字计价，也可设置自定义价格与保留天数，点击“应用并刷新记录”。保留天数会在读写时清理当前验收账号的过期明细和图片。

验收数据保存在 `.zk-captcha/acceptance/mock/history.sqlite` 与 `.zk-captcha/acceptance/live/history.sqlite`，与常规 SDK 记录分开，重启后仍保留。账号与接口地址继续由 SDK 隔离；凭证不保存到浏览器存储或配置文件。
模拟余额固定为 100 元、消费及次数为 0，仅用于验证响应结构；本地实际请求次数和费用看记录统计。失败费用保留为未知，报错不回改历史估算费用。

推荐顺序：默认模拟成功 → 查看明细原图 → 改为失败或超时后再识别 → 筛选记录并核对未知费用 → 查询余额与报错 → 重启验证持久化 → 按需切换真实接口。

## 开发命令

```bash
pnpm install
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run --ignore-scripts
```

一键质量检查：

```bash
pnpm check
```

## 参考文档

[图鉴官方文档](https://www.ttshitu.com/docs/index.html)
