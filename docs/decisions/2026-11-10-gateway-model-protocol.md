# 按服务端模型能力选择网关协议

服务端可配置 OpenAI、Anthropic 或双协议上游。客户端此前固定使用 Messages，
即使模型名存在，选中仅支持 OpenAI 的模型仍会在网关协议匹配阶段得到 404。

模型目录新增可选 `protocols` 数组，取值为 `openai`、`anthropic`。
同名模型只展示一次，协议取并集，输入模态取交集；没有公共输入能力时不展示。
其余目录元数据沿用首行，不改变服务端按实际命中 Provider 的计费。
目录不包含上游地址或密钥。

客户端保留 `deepseek-official` 路由和 `zeokeel-gateway-llm` 设置命名空间，
将模型目录与 `modelProtocols` 同次写入设置。每次请求按所选模型委托完整适配器：
Anthropic 使用 DeepSeek Messages，OpenAI 使用 pi-ai Chat Completions。
两个协议同时可用时优先 Anthropic；旧服务端缺字段时同样沿用 Anthropic。
显式空或未知协议不自动回退，不在请求失败后切换协议重试。
不恢复上游已删除的顶层 `protocol` 配置。

已准备的调用固定其适配器和配置快照；下一次调用才使用新的模型设置。
两种适配器都在读取凭据前验证当前会话端点，每请求读取网关 Bearer，拒绝 HTTP 重定向，
不使用环境中的其他供应商密钥。上游子模块保持不变。

仅知道 OpenAI 协议无法推断模型是否支持思考强度。客户端不向这类模型注入
Anthropic 的全局思考默认值，也不发送臆测的 `reasoning_effort` 或供应商专用开关。
Agent 请求在最终模型路由确定后，将存量会话保存的非兼容思考强度投影为模型默认，
不改会话历史或其他 Provider 的选择。直接调用低层 LLM API 指定不支持的强度仍明确拒绝。
输出上限仅在调用者显式设置或服务端模型目录声明时发送；没有配置时移除 SDK 的自动补值，
由网关与上游应用其默认参数，避免把 Messages 的默认上限套给 OpenAI 模型。

原生网页搜索是独立的 Anthropic Messages 功能。默认对话模型不支持 Anthropic 时，
选择目录中首个兼容模型；没有兼容模型时关闭该搜索 Provider 的可用性。
这不意味着 OpenAI 上游具备 Anthropic 原生搜索工具。

回归覆盖真实 Cordis Runtime 与本机 HTTP 网关、真实 PostgreSQL 模型目录；
外部供应商端到端验证与发布部署属于后续交付步骤。
