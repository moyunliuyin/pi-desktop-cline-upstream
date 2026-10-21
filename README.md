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

2. **选模型**：面板的可选清单来自插件内置的 18 个 `cline-pass/*`（含上下文与思考档位）；
   上游 `/api/v1/models` 在 2026-10-21 起只返回 OpenRouter 风格目录，已不含 `cline-pass/*`。
3. **探测上游**：勾选目标上游并打开「写入 routing（实验）」，插件会加
   `provider: { only: ["<目标>"] }`（可选 `allow_fallbacks: false`），再拿响应的 `finalProvider` 比对。
   实测网关忽略该字段，面板会显示 **网关忽略** —— 这是当前的预期结果，不是配置错误。

## 配置（三步）

1. 插件页 → 安装 `.piplug`
2. **设置 → 插件 → Cline 上游** → 填 **ClinePass API Key**
   （[app.cline.bot](https://app.cline.bot) → Settings → API Keys）
3. **设置 → AI 服务 → Cline Upstream** → 点 **「获取列表」** → 勾选要用的 `cline-pass/*` 模型 → 保存

之后把模型切到该服务商的任意 `cline-pass/*` 模型即可。面板用命令 **Cline Upstream: 打开面板** 打开。

## 面板怎么读

| 列 | 说明 |
|---|---|
| 时间 | 这条请求落地的时刻（本地时间） |
| 模型 | 请求里的完整模型 id，不截断 |
| 实际落点 | 本次真正服务的上游；绿色表示与你的目标一致 |
| 钉住 | 网关自己报告的会话钉选上游 |
| 备选 | `fallbacksAvailable` 数量 —— 大于 0 表示上游不可用时仍会降级 |
| 缓存命中 | `promptCacheHitTokens`。粘在同一上游才会连续命中，这是省钱的关键指标 |
| 成本 | 本次 `cost`（已计入缓存折扣） |
| 校验 | 仅观察 / 落点一致 / 网关忽略 / 无元数据 |

面板是只读的：目标上游与开关在 **设置 → 插件 → Cline 上游** 里改。日志按请求逐条记录，只保留最近 60 条（服务端保留 200 条），不含请求内容。

## 上游能不能被钉住（实测：不能）

Cline 公开文档的 `POST /chat/completions` 只列 5 个 body 参数，没有 provider 路由字段。

| 写入 | allow_fallbacks | 实际落点 |
|---|---|---|
| `provider.only: [fireworks]` / `[gmicloud]` / `[baseten]` | 默认或 false | 始终 deepseek |

结论：网关按**会话亲和**分配上游，客户端路由字段被忽略。插件因此定位为**观察器**：把落点、备选数与成本摊开给你看。

## 权限与隐私

- 权限：`ui.panel`、`background.service`、`provider.register`
- 出站只有一处：`api.cline.bot`（转发你的模型请求、拉取模型目录）
- **API Key 存在插件设置里（明文，`plugins/data/<id>/settings.json`）**，仅用于转发。
  PI 自身的服务商 key 是加密存储的，而平台的凭据隔离规定插件拿不到宿主凭据，
  因此走插件路径就必然由插件自持 key —— 这是取舍，不是疏漏。
- 落盘还有一份 `routing-state.json`：每个模型最近一次的路由结果（不含请求内容与凭据）

## 模型列表是怎么来的（宿主持有的数据）

宿主有两条规则，都已实测：

1. **插件声明的服务商行是只读的。** 宿主源码注释原文：`a plugin-declared row refuses a
   generic update`。所以 PI 的服务商编辑界面改不了里面的模型，也没有删除入口。
2. **模型在每次启动时按清单重建，运行期间不刷新。** 两条实测：
   - 清单声明 1 个 → 重启后库里就是 1 条（`models` 表与 `config_json.models` 同步变化）
   - 运行中改写 `manifest.json` → 等 18 秒，库里纹丝不动（热重载不触发同步）

所以：**清单 = 下次启动后的下拉框。** 改完保存，重启 PI 才看得见。

| 层 | 谁控制 | 什么时候生效 |
|---|---|---|
| 列表显示 | PI —— 启动时按 `manifest.json` 写入 `providers.config_json.models` | **重启 PI 之后** |
| 是否可用 | 本插件（白名单） | 保存即生效，未勾选的模型一律 `404 model_not_enabled` |

- **目录只增不减。** 拉取失败时退回「已知的全部模型」加出厂清单，不会因为声明被缩过就跟着缩水；
  否则面板会把自己锁死，只剩声明里那几个，用户再也勾不回来。
- **不依赖上游目录接口。** `/api/v1/models` 在 2026-10-21 起只返回 468 个 OpenRouter 风格 id
  （`vendor/model`），不再列 `cline-pass/*`；可选清单因此内置在代码里（18 个，含上下文与思考档位）。

默认清单只放 8 个常用模型，就是为了让新装用户不必先面对一屏模型再想办法删。

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
manifest.json     服务商声明（默认 8 个常用 cline-pass 模型，参数取自 models.dev）
dist/             打包产物（store-only zip，扩展名 .piplug）
```

## 许可

MIT
