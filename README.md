# Tavern Gateway Memory Bridge

这是一个可远程安装的 SillyTavern / Luker 第三方扩展。它不在浏览器里另建记忆库，而是在主对话生成请求发出前，把酒馆掌握的真实聊天坐标交给 Tavern Gateway：

- 当前真实 `chatId` 与 Luker `resolveChatStateTarget()`；
- `chat[]` 的真实 0-based floor；
- 每层当前 `swipe_id`，以及覆盖角色、隐藏标记和完整正文的固定 FNV-1a 32-bit 指纹；
- 有上限的原始正文窗口；
- `generationType`、`lastInContextMessageId`、`targetFloor`、`targetSwipeId` 和预测的 assistant seq。

这些信息使网关能够像 Luker Memory Graph 的 floor-state 一样校验提交：楼层删除、正文编辑、隐藏状态或 active swipe 改变后，旧提交不再参与物化；重 roll 同一楼层时则能够复用同一轮召回。扩展为每次生成登记一次 `requestNonce`，并在 `MESSAGE_RECEIVED` 后用实际 messageId 和酒馆最终保存的正文结算事件边界；`MESSAGE_UPDATED` 可能只是流式半截正文，只记 mutation 而不触发对账。扩展还会把消息编辑/删除/swipe 等 mutation 暂存在当前标签页，并随下一次主生成一并提交；即使没有 Dashboard token，生成前也能先做完整 manifest 对账。

## 安装

仓库推送到 GitHub、Gitee 或其它酒馆服务器可访问的 Git 服务后，在扩展管理器中选择“从 Git URL 安装”，粘贴仓库 clone URL，然后刷新页面。手机只是访问同一个酒馆服务，不需要在手机文件系统重复安装；在手机界面的扩展管理器安装也会落到酒馆服务器上。

本地开发时，可把本目录作为第三方扩展安装，或放入：

```text
<Luker 数据目录>/extensions/third-party/tavern-gateway-memory-bridge/
```

加载成功后，在“扩展”设置中打开“Tavern Gateway 记忆桥”。扩展默认启用。

旧的 Luker `Memory Graph` 必须关闭；两套扩展同时启用时，本扩展会显示警告，网关也会防御性隔离旧世界书表格，但不会替两套图做双写同步。

## 安全边界

默认仅当请求中的 `endpoint`、`reverse_proxy`、`base_url` 或 `custom_url` 指向以下地址之一时才注入：

```text
http(s)://127.0.0.1:3080/...
http(s)://127.0.0.1:3180/...
http(s)://localhost:3080/...
http(s)://localhost:3180/...
http(s)://[::1]:3080/...
http(s)://[::1]:3180/...
```

局域网或域名部署需要在设置里显式填写额外允许的正则。该正则就是数据授权范围，请不要写成 `.*`。扩展不会读取或发送 API 密钥，不会把正文写入浏览器持久存储，调试日志也只包含数量、楼层和 endpoint。

桥接消息中的 Base64URL 只是传输编码，不是加密。匹配的网关会收到设置所覆盖的正文窗口。

### 可选实时对账

如需在没有新生成时也让 Dashboard 及时反映删除和 swipe，可启用“聊天变更后立即向 Dashboard 对账”，填写浏览器可访问的网关地址和 Bearer token。扩展会监听：

- `MESSAGE_RECEIVED` / `MESSAGE_UPDATED` / `MESSAGE_EDITED`；
- `MESSAGE_DELETED`；
- `MESSAGE_SWIPED` / `MESSAGE_SWIPE_DELETED`；
- `CHAT_CHANGED` / `CHAT_BRANCH_CREATED`。

它向 `<gatewayBaseUrl>/gateway/memory/reconcile` POST 当前完整桥接 payload，并以 `mutationKind` / `mutations` 说明触发原因。只有 `MESSAGE_RECEIVED` 会额外携带 `finalizeRequestNonce` 与 `finalizedTargetFloor`，把酒馆实际落盘的 assistant 层与生成请求一一对应；`MESSAGE_UPDATED` 不发 sideband。token 只保存在 `sessionStorage`，不会进入 `extension_settings`、Git 文件或调试日志；关闭标签页后由浏览器清除。未配置 token、CORS 阻止、网关离线、90 秒超时或接口失败时，扩展显示“最终一致性降级”，不抛错、不阻断生成，下一次生成的内嵌 payload 仍会对账。

## 双通道传输

扩展在 `CHAT_COMPLETION_SETTINGS_READY` 中写入完全相同的一份 payload：

1. 请求顶层 `gateway_memory`；
2. 一条保留的 system 消息：

   ```text
   <!-- tavern_gateway_memory_bridge_v1:<base64url(JSON)> -->
   ```

Luker/OpenAI-compatible 的部分服务端发送器会重建上游 body，并丢弃未知的顶层字段，因此 system 标记是无需修改酒馆核心的可靠通道。CUSTOM provider 还会在仅限本次请求的 `custom_include_body` 中镜像 `gateway_memory`，并通过 `context.lib.yaml` 保留已有配置的有效键。

网关必须在任何路由、日志提示组装或模型调用之前解析该标记，并把整条标记消息（若与其它 system 内容合并，则只移除标记子串）彻底删除。桥接 payload 只供楼层校验、记忆总结和召回使用，绝不能继续发送给主模型、预生成器、格式化器、生成器或校验器。

## 协议 v1

请求顶层对象名称为 `gateway_memory`，完整机器可读定义见 [`protocol.schema.json`](./protocol.schema.json)，关键字段如下：

```json
{
  "protocol": "tavern-gateway-memory-bridge",
  "version": 1,
  "generatedAt": "2026-09-08T00:00:00.000Z",
  "requestNonce": "每次生成唯一值",
  "chatId": "真实聊天文件 ID",
  "stateTarget": { "chatId": "...", "characterId": 0 },
  "character": { "id": 0, "name": "当前角色", "avatar": "avatar.png" },
  "generationType": "swipe",
  "floorCount": 42,
  "lastInContextMessageId": 12,
  "rawVisibleFromFloor": 12,
  "targetFloor": 41,
  "targetSwipeId": 3,
  "targetAssistantSeq": 20,
  "ledger": [
    {
      "floor": 41,
      "role": "assistant",
      "isSystem": false,
      "swipeId": 3,
      "hash": "30ef2e61",
      "textLength": 1234,
      "assistantSeq": 20
    }
  ],
  "messages": [
    {
      "floor": 40,
      "role": "user",
      "isSystem": false,
      "swipeId": 0,
      "hash": "76daa738",
      "text": "原始正文",
      "originalLength": 4,
      "truncated": false
    }
  ],
  "coverage": {
    "ledgerStartFloor": 0,
    "ledgerEndFloor": 41,
    "ledgerComplete": true,
    "messageStartFloor": 0,
    "messageEndFloor": 41,
    "totalTextChars": 12345
  },
  "reconcileMode": "full-manifest-before-recall",
  "mutationKind": "generation-request",
  "mutations": []
}
```

楼层判定遵循 Luker 的坐标习惯：

- floor 永远是 `chat[]` 的数组索引；
- assistant seq 只计数 `is_user === false` 且正文非空的消息，故 `/hide` 改变 `is_system` 不会让坐标漂移；
- `lastInContextMessageId` 是 Luker 的历史字段名，实际含义是本轮 prompt 纳入的首个原始 `chat[]` 楼层；协议同时提供语义明确的 `rawVisibleFromFloor`；
- `swipe` / `regenerate` / `continue` 锚定最后一个 assistant 楼层；
- 普通生成通常锚定 `chat.length`，若 Luker 已建立空 assistant 占位则锚定该占位；
- 账本窗口不完整时 `coverage.ledgerComplete` 为 `false`；窗口外提交标为“待完整账本复核”并暂停注入，而不是谎报成“楼层已删除”。如果事件边界所需正文也超出窗口，网关不生成残缺摘要，而是在当前楼层建立清空旧投影的安全重置点，使后续边界可以继续工作。

### 楼层指纹

`ledger[].hash` 与 `messages[].hash` 使用同一份、与 Web Crypto 或第三方依赖无关的协议：

1. 读取该楼层当前 active swipe 的完整正文；
2. 将正文中的 CRLF（`\r\n`）换成 LF（`\n`），再对整段正文执行 `trim()`；
3. 构造 `role + NUL + isSystem(1/0) + NUL + 正文`；
4. 对该字符串的 UTF-8 字节计算 FNV-1a 32-bit（offset basis `0x811c9dc5`，prime `0x01000193`）；
5. 输出固定 8 位小写十六进制，不带算法前缀，例如 `76daa738`。

`swipeId` 不进入哈希，而是作为独立坐标一并校验。正文发送窗口即使发生截断，哈希仍始终基于截断前的完整 active 正文，因此正文编辑、角色切换、隐藏状态变化或 active swipe 变化都能使旧楼层锚点失效。

### 身份、时间、覆盖范围与变更提示

- `character` 是注入时当前单角色的轻量快照，固定含 `id`、`name`、`avatar`；群聊或无法确定单一角色时可以是 `null`。稳定聊天身份仍以 `chatId` / `stateTarget` 为准。
- `generatedAt` 是浏览器构造 payload 时生成的 ISO 8601 时间，只用于拒绝乱序到达的旧 manifest；它不能替代 floor、swipe 和 hash，也不能决定记忆 Revision 的剧情先后，Revision 仍要求锚点楼层单调前进。
- `coverage` 精确描述两个有界窗口。`ledgerStartFloor`/`ledgerEndFloor` 是轻量账本边界，空聊天为 `0/-1`；`ledgerComplete` 仅表示账本是否从 floor 0 开始。`messageStartFloor`/`messageEndFloor` 是实际携带正文的边界，无正文时均为 `null`；`totalTextChars` 是截断后实际传输的正文字符数之和。
- `mutations` 是当前浏览器标签页按聊天暂存的变更提示，最多 50 条，字段为 `id`、`kind`、`at`、`details`。它帮助解释编辑、删除、swipe 或分支操作，但完整 `ledger` 才是对账权威。队列只存于 `sessionStorage`；实时 sideband 对账成功后删除已发送项，否则后续请求可重复携带同一 `id`，网关应幂等处理。

## 数据上限

默认发送最近 5000 层的轻量账本、最近 240 条正文；每条正文最多 16000 字符，正文总计最多 240000 字符。哈希始终针对规范化后的完整 active 正文及 role/isSystem 标记计算，截断仅影响总结文本。所有上限都可在扩展设置中调整。

## 开发与测试

无需安装依赖：

```bash
npm test
```

浏览器控制台可读取不含正文的运行状态：

```js
TavernGatewayMemoryBridge.getStatus()
TavernGatewayMemoryBridge.getSettings()
```
