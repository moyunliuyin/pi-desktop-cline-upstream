# Cline 上游 (Cline Upstream)

ClinePass 的同一个模型背后挂着二十多个上游（DeepSeek 官方、Fireworks、Baseten、DigitalOcean…），
客户端看不见这一次到底落在谁身上。这个插件把它变成**可见、可选、可验证**。

> 数据来源：Cline 网关自己在每个响应里返回的 `routing` 对象 —— 不是猜测，也不是统计推测。

## 它做什么

1. **检测**：插件在 `127.0.0.1:41891` 起一个 OpenAI 兼容端点，把请求转发到 `api.cline.bot`，
   并读出网关返回的路由元数据：

   | 字段 | 含义 |
   |---|---|
   | `finalProvider` | 这次实际服务的上游 |
   | `pinnedProvider` | 网关当前会话钉住的上游 |
   | `fallbacksAvailable` | 还有多少个备选 |
   | `promptCacheHitTokens` | 本次命中 prompt cache 的 token 数 |
   | `cost` | 本次实际成本 |

2. **选模型**：该服务商的 `/v1/models` 会**用你的 key 拉取上游真实目录**（只保留 `cline-pass/*`），
   所以在 PI 里点「获取列表」就能勾选要用的模型；拉不到时退回内置的 18 个。
3. **选上游 + 验证**：填一个目标上游并打开「写入 routing 字段」，插件会加
   `provider: { only: ["<目标>"] }`（可选 `allow_fallbacks: false`），
   再用下一次响应的 `finalProvider` 校验，面板直接显示 **已生效 / 未生效**。

## 配置（三步）

1. 插件页 → 安装 `.piplug`
2. **设置 → 插件 → Cline 上游** → 填 **ClinePass API Key**
   （[app.cline.bot](https://app.cline.bot) → Settings → API Keys）
3. **设置 → AI 服务 → Cline Upstream** → 点 **「获取列表」** → 勾选要用的 `cline-pass/*` 模型 → 保存

之后把模型切到该服务商的任意 `cline-pass/*` 模型即可。面板用命令 **Cline Upstream: 打开面板** 打开。

## 面板怎么读

| 列 | 说明 |
|---|---|
| 实际落点 | 本次真正服务的上游；绿色表示与你的目标一致 |
| 钉住 | 网关自己报告的会话钉选上游 |
| 备选 | `fallbacksAvailable` 数量 —— 大于 0 表示上游不可用时仍会降级 |
| 缓存命中 | `promptCacheHitTokens`。钉住同一上游才会连续命中，这是省钱的关键指标 |
| 成本 | 本次 `cost`（已计入缓存折扣） |
| 校验 | 仅观察 / 已生效 / 未生效 / 无元数据 |

面板是只读的：目标上游与开关在 **设置 → 插件 → Cline 上游** 里改。

## 为什么需要「校验」这一步

Cline 的公开 API 文档里 `POST /chat/completions` 只列出 5 个 body 参数
（`model` / `messages` / `stream` / `tools` / `temperature`），**没有** provider 路由字段。
`provider.only` 属于未公开行为，是否被接受取决于网关实现。

所以插件不承诺「一定钉住」，而是把结果摊开：能钉住就写「已生效」，钉不住就写「未生效」。

## 权限与隐私

- 权限：`ui.panel`、`background.service`、`provider.register`
- 出站只有一处：`api.cline.bot`（转发你的模型请求、拉取模型目录）
- **API Key 存在插件设置里（明文，`plugins/data/<id>/settings.json`）**，仅用于转发。
  PI 自身的服务商 key 是加密存储的，而平台的凭据隔离规定插件拿不到宿主凭据，
  因此走插件路径就必然由插件自持 key —— 这是取舍，不是疏漏。
- 落盘还有一份 `routing-state.json`：每个模型最近一次的路由结果（不含请求内容与凭据）

## 模型列表为什么改不动（宿主持有的数据）

宿主的规则有两条，都已实测：

1. **插件声明的服务商行是只读的。** 宿主源码注释原话是 "a plugin-declared row refuses a
   generic update"，所以 PI 的服务商编辑界面改不了里面的模型，也没给删除入口。
2. **模型只写一次：应用启动时按声明写进数据库。** 之后插件改写 manifest 或触发热重载，
   都不会回头更新那一行（实测：改完文件等 18 秒，库里 18 条纹丝不动）。

因此分两层：

| 层 | 谁控制 | 什么时候生效 |
|---|---|---|
| 列表显示 | PI —— 启动时按 `manifest.json` 写入 `providers.config_json.models` | **重启 PI 之后** |
| 是否可用 | 本插件（白名单） | 保存即生效，未勾选的模型一律 `404 model_not_enabled` |

**想让下拉框变短**：面板勾选 → 保存（清单改成 N 个）→ **重启 PI**，下拉框就是 N 个。
不重启的话，PI 依然按上一次启动时的清单显示 —— 这不是插件偷懒，是宿主没提供刷新入口。

## 已知限制（平台边界，非本插件缺陷）

- 插件无法复用 PI 里已有服务商的 key：宿主明文规定 "The plugin never receives it"
- 面板不能访问本机端点（`panel.egress` 一律拒绝），所以面板数据经插件设置通道传递
- PI 本身不解析 Cline 的 `routing`（`finalProvider` 在应用代码里出现 0 次），
  因此「看上游」只能由处在请求路径上的插件自己完成
- 必须保留流式响应：插件会去掉 `accept-encoding` 以便读取 `routing`（体积换可观测性）

## 开发

```
main.js           常驻服务 + loopback 转发 + routing 解析
renderer/         面板（index.html / panel.css / panel.js）
manifest.json     服务商声明（18 个内置 cline-pass 模型，参数取自 models.dev）
dist/             打包产物（store-only zip，扩展名 .piplug）
```

## 许可

MIT
