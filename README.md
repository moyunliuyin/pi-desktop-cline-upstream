# Cline 上游 (Cline Upstream)

ClinePass 的同一个模型背后挂着二十多个上游（DeepSeek 官方、Fireworks、Baseten、DigitalOcean…），
但客户端看不见这一次到底落在谁身上。这个插件把这件事变成可见、可选、可验证。

> 数据来源：Cline 网关自己在每个响应里返回的 `routing` 对象 —— 不是猜测，也不是统计推测。

## 它做什么

1. **检测**：插件在本机 `127.0.0.1:41891` 起一个 OpenAI 兼容端点，把你的请求转发到
   `api.cline.bot`，同时在响应里读出网关的路由元数据：

   | 字段 | 含义 |
   |---|---|
   | `finalProvider` | 这次实际服务的上游 |
   | `pinnedProvider` | 网关当前会话钉住的上游 |
   | `fallbacksAvailable` | 还有多少个备选（以及都是谁） |
   | `promptCacheHitTokens` | 本次命中 prompt cache 的 token 数 |
   | `cost` | 本次实际成本 |

2. **选择**：填一个「目标上游」并打开「写入 routing 字段」，插件会在请求体里加入
   `provider: { only: ["<目标>"] }`；勾上「强制不降级」再加 `allow_fallbacks: false`。

3. **验证**：下一次响应回来时，插件拿 `finalProvider` 和目标比对，面板上直接显示
   **已生效 / 未生效**。

## 为什么需要「验证」这一步

Cline 的公开 API 文档里 `POST /chat/completions` 只列出 5 个 body 参数
（`model` / `messages` / `stream` / `tools` / `temperature`），**没有** provider 路由字段。
也就是说 `provider.only` 属于未公开行为，是否被接受取决于网关实现。

所以这个插件不承诺「一定钉住」，而是把结果摊开：能钉住就显示「已生效」，钉不住就显示「未生效」。
无论哪种结果，你都拿到了真相 —— 这比一个说不出所以然的开关有用。

## 安装

1. 插件页 → 安装 `cline-upstream-0.1.0.piplug`
2. 设置 → **AI 服务** → 「Cline Upstream」→ 填入你的 **ClinePass API Key**
   （在 [app.cline.bot](https://app.cline.bot) → Settings → API Keys 生成）
3. 把模型切到该服务商下的 `cline-pass/deepseek-v4.1-flash` 等模型，随便发一句话
4. 命令面板运行 **Cline Upstream: 打开面板**，或者从插件卡片打开

## 面板怎么读

| 列 | 说明 |
|---|---|
| 实际落点 | 本次真正服务的上游；绿色边框表示与你的目标一致 |
| 钉住 | 网关自己报告的会话钉选上游 |
| 备选 | `fallbacksAvailable` 的数量 —— 大于 0 意味着上游不可用时仍会降级 |
| 缓存命中 | `promptCacheHitTokens`。钉住同一上游才会连续命中，这是省钱的关键指标 |
| 成本 | 本次 `cost`（已计入缓存折扣） |
| 校验 | 仅观察 / 已生效 / 未生效 / 无元数据 |

## 权限与隐私

- 声明的权限：`ui.panel`、`background.service`、`provider.register`、`net.fetch`（仅 `127.0.0.1`）
- **API Key 只在内存里透传，插件不落盘、不外发**
- 出站流量只有一处：`api.cline.bot`（转发你的模型请求）
- 落盘内容只有一份：插件数据目录下的 `routing-state.json`，记录每个模型最近一次
  的路由结果（不含请求内容、不含凭据）

## 已知限制

- 只接管通过「Cline Upstream」这个服务商发起的请求；PI 里原有的 `cline` 服务商不受影响
- 必须保留流式响应：插件会把 `accept-encoding` 去掉，以便读取响应里的 `routing` 块（体积换可观测性）
- 写死的上游清单来自实测；网关新增上游后，面板会自动把它们补进下拉框
- 「未生效」不等于插件出错 —— 它表示网关没有接受那个字段

## 开发

```
main.js            常驻服务 + loopback 转发 + routing 解析
renderer/          面板（index.html / panel.css / panel.js）
manifest.json      服务商声明（18 个 cline-pass 模型，参数取自 models.dev）
```

本机自测（不依赖 PI 宿主）：

```powershell
node scratch/plugin-smoke.js   # 见仓库内的冒烟脚本
```

## 许可

MIT
