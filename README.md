# zk-captcha

面向图鉴/准快/快识别平台验证码识别的SDK，支持本地函数与 HTTP 自定义算法。

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

`typeid` 未匹配已注册的自定义算法时，`recognize` 调用平台的 `POST /predict`，使用 JSON 请求体和 base64 图片字段；省略 `typeid` 时使用线上默认类型 `3`。

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

## 自定义算法

创建客户端时通过 `algorithms` 注册多个算法，键就是每个算法的专属 `typeid`，`name` 是独立的类型名称。
调用时只需传入该 `typeid`，支持数字或字符串，数字与对应字符串等价；仍使用 `recognize`、`recognizeOrThrow` 或文件辅助方法。
只使用自定义算法时，无需配置平台账号密码，也无需为 SDK 安装图片处理依赖。

```ts
import { randomUUID } from "node:crypto";
import { ZkCaptchaClient } from "@lyzn/zk-captcha";
import { recognizeImage } from "./my-recognizer"; // 业务提供的识别实现，返回结果字符串

const client = new ZkCaptchaClient({
  algorithms: {
    9001: {
      name: "本地算术识别",
      kind: "local",
      recognize: async (request, { signal }) => {
        signal.throwIfAborted();
        const result = await recognizeImage(request, signal);
        return {
          success: true,
          code: "0",
          message: "success",
          data: { id: randomUUID(), result },
        };
      },
    },
    "remote-math": {
      name: "远程算术识别",
      kind: "http",
      url: "http://127.0.0.1:8000/recognize",
      headers: { authorization: "Bearer your-algorithm-token" },
    },
  },
});

try {
  const data = await client.recognizeOrThrow({
    typeid: 9001, // 改为 "remote-math" 即调用 HTTP 算法
    image: "图片纯base64",
  });
  console.log(data.result);
} finally {
  await client.close();
}
```

本地回调接收 `ZkCaptchaAlgorithmRequest` 和 `ZkCaptchaAlgorithmContext`。
HTTP 算法向配置的完整 URL 发送相同输入的 JSON POST，不自动追加 `/predict`；可保留 URL 查询参数。
两者的请求约定一致：

- `image`、可选 `imageback/title_image` 转为纯 base64；`typeid` 是命中注册键的专属编号，统一为字符串。
- `angle/step/typename/remark/content/modelid` 保留原值，`extra` 保持嵌套对象，省略值为 `undefined` 的扩展项。
- 不注入平台 `username/password`。远程鉴权仅通过算法自己的 `headers` 配置，媒体类型固定为 JSON。
- `context.signal` 合并客户端/单次超时与外部取消；HTTP 使用同一套超时、取消、禁止重定向和响应大小保护。

算法实现返回 `ZkCaptchaResponse<RecognizeData>`（无需生成本地 ID），例如：

```json
{
  "success": true,
  "code": "0",
  "message": "success",
  "data": { "id": "algorithm-generated-id", "result": "12" }
}
```

无法确定时返回标准失败响应，例如 `{ success: false, code: "REJECTED", message: "无法确定", data: "" }`。
成功的 `data.id` 和 `data.result` 都必须是字符串；编号由算法生成，SDK 不自动补齐。
本地函数可同步或异步返回；抛错转为 `ALGORITHM_ERROR`，无效响应转为 `INVALID_RESPONSE`。
超时或取消后 SDK 停止等待、忽略晚到结果并只记录一次；同步计算无法被强制中断，算法需要配合信号释放资源。

专属 `typeid` 和非空名称在构造时验证，不允许占用 SDK 已知线上类型编号（如 `3`、`11`、`1005`）。
名称、识别函数及 HTTP 请求头、地址均保存快照，后续修改原配置不会改变客户端。
命中自定义类型后只执行该算法，识别失败、异常或超时均直接返回，不切换到其他算法或付费平台。
未注册的 `typeid` 沿用线上请求规则，不会自动寻找其他自定义算法。旧 `typeids` 配置及识别请求的 `algorithm` 参数已删除。

错误反馈统一使用 `reportError` / `reportErrorOrThrow`，SDK 根据本地明细的 `algorithm` 自动分流。
自定义算法只更新本地 `recognitionError`；平台记录调用配置平台的 `POST /reporterror.json`。
自定义 HTTP 算法也只标记本地，不向算法服务或验证码平台发送反馈。余额查询仍使用 `queryAccountInfo`。

## 错误反馈

参数统一为 `{ recordId: 本地明细UUID }`，不能传识别响应中的 `data.id`。
两种来源均返回 `ZkCaptchaResponse<ReportErrorData>`；成功数据固定包含 `recordId`、`destination`（`local` 或 `platform`）、`result` 和处理后的本地标记 `recognitionError`。
`reportErrorOrThrow` 返回同一份成功数据，失败时抛出 `ZkCaptchaApiError`。

```ts
const response = await client.recognize({ image: "图片纯base64", typeid: 3 });
// 自定义算法只需将 typeid 改为已注册的专属编号，其余调用完全相同。
if (response.success && response.data.recordId !== null) {
  const feedback = await client.reportError({ recordId: response.data.recordId });
  if (feedback.success) console.log(feedback.data.destination, feedback.data.result);
}
```

`recognize` 成功数据为 `RecognizeResult`：保留原始 `id`、`result` 和算法扩展字段，新增 `recordId`。
`recordId` 是 SDK 保存的本地 UUID，可直接反馈，无需查询明细；原始 `id` 仍是平台或算法编号。
`recognizeOrThrow`、`recognizeFromFile` 和 `recognizeFromFileOrThrow` 使用同一结构。
算法实现只需返回原始 `RecognizeData`，SDK 会覆盖上游同名字段，避免把外部编号当成本地 ID。
历史关闭、写入或清理失败、立即过期，或请求覆盖账号导致记录不属于当前客户端时，`recordId` 为 `null`；识别成功状态和原结果不受影响。

自定义算法反馈无需平台账号密码，可重复调用，不改变原识别结果、费用和统计。
误标时调用 `client.reportError({ recordId, recognitionError: false })` 撤回本地标记；省略此字段或传 `true` 仍为反馈错误。
撤回同样支持 `reportErrorOrThrow`，只修改当前账号与接口下的自定义算法记录，不联网；重复撤回安全，成功数据的 `result` 为“本地识别错误标记已撤回。”。
平台记录不支持撤回，传 `recognitionError: false` 返回 `PLATFORM_REVOKE_UNSUPPORTED`，不向平台发送请求。
平台反馈仅使用明细保存的平台编号，保留平台的失败、超时和取消行为。成功后保存本地 `recognitionError: true`，已保存的重复反馈直接返回该状态，不再调用平台；失败不标记，退款不会回改历史费用。平台已接受但本地写入失败时仍返回成功，成功数据的 `recognitionError` 为 `false`，并通过 `history.onError` 通知存储问题，请勿因此重复上报。
3.2 复用原有本地字段，不新增表或迁移；旧版没有保存的平台反馈无法可靠追溯，不自动补标或重新调用平台。
平台反馈成功以成功的 HTTP 状态和布尔 `success: true` 为准，`data` 是可选回执载荷，其形态不影响反馈状态。SDK仅提取非空字符串载荷或字符串 `data.result` 作为说明，其余情况使用“平台报错成功。”；识别和余额接口仍严格校验各自的数据结构。
官方服务通常约 5 分钟后批量处理退款。

错误反馈依赖本地历史：`history: false` 返回 `HISTORY_DISABLED`；明细不存在、过期或不属于当前账号及接口时返回 `RECORD_NOT_FOUND`；
读取或更新数据库失败返回 `HISTORY_ERROR`；平台记录没有成功识别编号返回 `INVALID_CAPTCHA_ID`。
上述失败均不请求平台。平台反馈缺少凭证返回 `MISSING_CREDENTIALS`，自定义算法反馈不受影响。

从 1.x 升级时，将 `reportError({ id: 平台编号 })` 改为 `reportError({ recordId: 本地明细UUID })`，并保持本地历史开启；
旧版调用返回 `INVALID_REPORT_REQUEST`。跨客户端反馈需共享同账号、同接口的本地历史。

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

原平台与自定义算法均保存记录，自定义明细的 `typeid` 和 `algorithm` 为专属编号，`typeName` 为识别时配置的名称；原平台的 `algorithm` 为 `null`。
旧数据库在首次读写时自动增量添加该字段，已有记录与图片保留，旧记录的算法来源为 `null`。
明细和统计支持 `algorithm` 筛选：省略查询全部，字符串仅查询指定算法，`null` 仅查询原平台。
不增加新的算法分组统计，现有 `byType` 仍按类型汇总筛选后的记录。

```ts
await client.getRecords({ typeid: 9001 });
await client.getStats({ typeid: "remote-math" });
await client.getRecords({ algorithm: null }); // 仅原平台
await client.getRecords({ recognitionError: true }); // 本地已标错或平台已反馈
await client.getStats({ recognitionError: false }); // 未标记记录的统计；省略查询全部
```

自定义算法不使用官方参考价；`history.prices` 按专属编号配置，例如 `{ "9001": "0", "remote-math": "0.01" }`，未配置时费用未知。
省略账号的客户端沿用同一接口地址下的空账号记录范围；需要隔离时可设置不同 `username` 或记录目录。
远程算法 URL 和鉴权头不会写入明细，查询范围仍按客户端账号及 `baseUrl/endpoint` 隔离。

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
- `32`、`66`、自定义类型、自定义算法、私有接口及定制模型默认未知，可通过 `history.prices` 按类型指定固定价格。
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
- **本地模板识别（测试示例）**：打开 [模板模式](http://127.0.0.1:3210/?mode=template)，载入算术示例或上传原样式的 130×48 图片，实际识别加减乘和负数。响应包含算式、答案、相似度和耗时；不确定时拒识，不调用外部平台。此算法仅作为 `dev/` 下的自定义算法接入示例，不属于 SDK 内置能力或公开导出；成功默认零费用，`sharp` 仅为开发依赖，算法和模板资源不进入发布包。
- **真实接口**：选择平台并填写自己的账号密码，上传图片后点击“调用真实接口”。识别可能产生平台费用；余额查询和报错也会调用真实平台。自定义接口地址可在“更多配置”中填写。
- **记录与统计**：核对成功/失败明细、原始图片、参考费用和未知费用次数，按类型、状态和本地时间筛选，分页查看；展开分组统计可查看 SDK 返回的类型与 UTC 日期汇总。
- **配置验证**：可修改模拟结果测试汉字等按字计价，也可设置自定义价格与保留天数，点击“应用并刷新记录”。保留天数会在读写时清理当前验收账号的过期明细和图片。

验收数据分别保存在 `.zk-captcha/acceptance/` 下 `mock`、`live`、`template` 目录的 `history.sqlite`，与常规 SDK 记录分开，重启后仍保留。账号与接口地址继续由 SDK 隔离；凭证不保存到浏览器存储或配置文件。
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
