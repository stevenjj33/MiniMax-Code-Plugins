# deepseek-search

在你的编程 Agent 里，直接用 **DeepSeek 自家的 Search 与 Fetch API** 联网搜索和读网页。
一个零依赖的 stdio MCP server 暴露两个工具，一个 Skill 讲清搜索算子和「先搜后读」的工作流。

## 要解决的问题

Agent 里的联网搜索通常只有两种做法：要么用一个需要 API key、还要额外 SDK 的厂商接口，要么用一个页面一旦是 JS 渲染就崩的抓取器。
DeepSeek 把 Search 和 Fetch 作为普通 JSON 端点发布，用的是和它其余 API 一样的 Bearer 认证。
这个插件把它们包装成两个常规 MCP 工具，Agent 不需要任何额外依赖就能查资料、读网页。

## 试一试

装好这个目录、配好 API key，然后问：

```text
搜索一下 DeepSeek 最新的 API 发布说明
```

**预期结果**：一份排序结果列表，含标题、链接、相关性评分、发布日期、站点名称和一段文字摘要；
Agent 需要时再附上最有用几条的页面正文。

直接调用工具：

```text
deepseek_search  {"query": "DeepSeek site:github.com OR site:huggingface.co lang:zh after:2025", "count": 5}
deepseek_fetch   {"url": "https://example.com/article"}
```

## 环境要求

- **Node.js 18 或更高版本** —— server 用内置的 `fetch`。不需要 `npm install`，没有任何依赖。
- 能访问 `https://api.deepseek.com` 的网络。
- **一把 DeepSeek API key。** 这个包里不含任何 key。
- server 本身支持 macOS、Linux 或 Windows。下面的钥匙串方式仅限 macOS。

## 安装

**MiniMax Code。** 把这个目录复制到 `~/.minimax/plugins/deepseek-search`，或者从 `/plugins` → **Local** 导入。
MiniMax Code 会自行重扫插件目录，清单生效不需要重启。

**Claude Code 等其他宿主。** 本仓库 `main` 分支发布了同一个插件的 portable Agent Plugins 布局，请让它们指向那一份。

然后用下面任意一种方式配置一次 API key。

## 配置凭据

key 永远不会被存进这个包。三种放法，从最容易的开始。

### 1. 改文件 —— 完全不需要终端

```bash
node server.mjs --setup
```

它会创建 `~/.config/agents/deepseek.json`，并用你的文本编辑器打开，里面带一个占位符。
把占位符替换成你的 key，保存文件，下一次工具调用就会用上。
不需要再做别的，MiniMax Code 也不用重启。

### 2. 一条命令，掩码输入

```bash
# 在提示符处粘贴 key，然后按回车
node server.mjs --set-key
```

key 从终端读取且不回显，因此不会进入 shell 历史、进程列表或屏幕。
它也永远不会被当作命令行参数接受。

要清除它：

```bash
node server.mjs --unset-key
```

### 3. 一条命令，key 放环境变量

```bash
node server.mjs --env
```

它会以明文往你的 shell 配置文件（macOS 上是 `~/.zshenv`）追加一行
`export DEEPSEEK_API_KEY='...'`。可以传一个路径来指定别的文件。

用这一种之前要知道两件事：

- **图形界面应用**（比如 MiniMax Code 桌面版）**不会**继承 shell 环境，所以这一种只覆盖终端场景。
  桌面版请用第 1、2 或 4 种；
- key 会以明文留在 profile 文件里。在个人机器上没问题，但别把含它的 dotfiles 仓库提交上去。

### 4. macOS 钥匙串

往你的登录钥匙串里加一个通用密码：

- 名称：`deepseek-search`
- 账户：`api`
- 密码：你的 DeepSeek API key

没有其他来源时它会被自动读取，且磁盘上不会明文留下任何东西。

### server 的读取顺序

server 按以下顺序解析 key，并且绝不把它写进 stdout、stderr 或工具返回结果：

1. `DEEPSEEK_API_KEY` 环境变量；
2. `~/.config/agents/deepseek.json` 里的 `api_key_env`，指定从另一个环境变量读 key；
3. 同一个文件里的 `api_key` —— 明文兜底。请把这个文件设为仅本人可读（`chmod 600`）；
4. macOS 钥匙串条目 `deepseek-search` / `api`。

想检查配置而不想消耗一次请求：

```bash
node server.mjs --check
```

它会打印 key 的来源和长度（掩码后）。

### 如果你是从 Claude Code 或 Cursor 的配置抄过来的

那些客户端会展开 MCP server `env` 块里的 `${VAR}` 引用，所以在那边能用的配置会写成
`"env": { "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}" }`。
**MiniMax Code 会原样透传这样的值**，于是 server 收到的会是字面量 `${DEEPSEEK_API_KEY}`。
这个 server 会忽略任何形似未展开引用的值，不会把它当凭据发给 API，而是继续往下一个来源找。
请直接导出环境变量，而不是引用它。

## 包结构

| 路径 | 谁在读 | 用途 |
| --- | --- | --- |
| `.minimax-plugin/plugin.json` | MiniMax Code、插件市场 | 包入口。 |
| `deepseek-search.mcp.json` | 同上 | MCP server 定义（`node ./server.mjs`）。 |
| `icon.png` | 支持图标的宿主 | DeepSeek 标识，512×512，透明背景。 |
| `skills/deepseek-search/SKILL.md` | 同上 | Skill，放在与其 `name` 同名的目录下。 |
| `server.mjs` | MCP server | 全部实现，无任何依赖。 |

这个包只提供 MiniMax Plugin 布局。同一个插件在本仓库的 `main` 分支上还有 portable
Agent Plugins 布局，给偏好那种格式的宿主使用。

## 读网页

`deepseek_fetch` 能读大多数网页，但不是全部。JS 渲染的页面和部分 `.gov` 端点会被抽取服务拒绝，
此时工具会返回一个明确的错误而不是瞎猜。对这类页面，请先用 `deepseek_search` 定位，
再用第二个抽取器读原文。

## 数据与网络

这个插件只有**一个**对外目的地。

### 直接目的地（server 自己）

server 每次工具调用只发一次 POST 到配置的 DeepSeek base URL：
`POST /v1/tools/search` 或 `POST /v1/tools/fetch`。`Authorization` 头携带你的 DeepSeek API key，
只去那一个主机。**不跟随重定向** —— 跟随一次可能把 key 转发到你没有配置的源站。

### 下游目的地（DeepSeek，不是这个 server）

- **Search** 由 DeepSeek 自家的搜索引擎提供。你的查询串，以及你传入的原始问题（`ori_question`），
  会被送到 DeepSeek 去和索引匹配。查询里有敏感文本，它就会到 DeepSeek 手里。
- **Fetch** 由 DeepSeek 执行，不是这个 server。server 把 URL 交给 DeepSeek，由 DeepSeek 取回页面并以 Markdown 返回。
  这个插件自己从不下载结果 URL，所以一个恶意 URL 无法借它摸到你的机器。

### 凭据与数据

- API key 从环境变量、本地配置文件或 macOS 钥匙串读取，只发给 DeepSeek。
- 没有遥测、没有分析统计、除 DeepSeek 外不接任何第三方服务。
- Search 和 Fetch 都是只读的。这个插件从不改动 DeepSeek 侧的任何东西。

## 费用

Search 和 Fetch 按**成功请求次数**计费，不按 token、不按结果条数：
每个 API 均为每 1000 次成功请求 5 元。`count` 不影响单次请求的价格。
失败的请求、没有结果的搜索和超时都不计费。

## 速率限制

账号级限制，两个 API 各自独立：Search 100 QPS，Fetch 25 QPS。
server 会对 HTTP 408、429 和 5xx 做退避重试，其他 4xx 不重试 ——
因为同样的请求再发一次还是会以同样方式失败。

## 许可

Apache-2.0

附带的 `icon.png` 是 DeepSeek 标识（`File:DeepSeek-icon.svg`，来自 Wikimedia Commons，MIT 许可，© DeepSeek）。
