# Tavern Gateway Memory Bridge

## 1.3.0：旧聊天补建、可选楼层替换与手机镜像

配套Tavern Gateway6.14.0和已核对的Luker2.7.0接口。安装1.3.0后，记忆桥新增：选择当前聊天所属世界、分批补建历史、刷新进度、可选0–N楼替换，以及原生记忆展示镜像。配置按聊天保存；替换栏默认留空，0明确表示第0楼。只有已确认的剧情梗概完整覆盖且来源指纹一致才省略原文，否则继续发送原文。手机保存的原聊天和MVU变量不变。

旧聊天：打开聊天→选择正确世界→“补建当前聊天历史”→等完整覆盖提示→按自己需要填写N。无需先发送一轮昂贵的普通生成来绑定身份。较长历史按完整AI回复分批；再次点击暂停后续批次，页面重开后可继续。**补建有模型API用量，进度查询和手机镜像没有。**

正常事件记忆在网关后台建立，不阻塞下一次对话；桥接即时对账确认最终楼层，显示正在建立/完成/失败并在完成后同步。即时对账、补建和状态接口需要首次保存Dashboard令牌，沿用已有持久化存储，不需要新的模型令牌。

在Luker原生记忆中关闭**“启用”和“自动抽取”**，在记忆桥保留手机镜像选项。2.7.0关闭后仍能查看和通过API持久化图。网关是唯一生成与召回源，手机只保存展示副本，不重复抽取/注入。已有其它原生记忆时暂停镜像并提示，不覆盖手工内容。

原生API会按人物/设定主键自动合并，故镜像使用独立展示节点与真实关系边，可读标题区分人物/地点/剧情；真实类型和字段保留在详情。它不取代网关的语义图结构。来源/聊天变化会停止旧镜像，缺接口或不兼容schema时明确提示。

历史清理使用正则，仅作用于生成时的历史副本：plan、旧book_info、corruption_info、UpdateVariable、选项和思维链。最新用户要求、本轮新生成的规划和手机显示保留。楼层省略在历史合并前执行，不能靠最终messages数量猜测floor。

安卓用户扩展使用 `tavern-gateway-memory-bridge-1.3.0-android-user-update.zip`，在账户备份恢复中选**用户扩展／增量更新**，无需解压；全局包只给原先全局安装者。刷新确认1.3.0；不重导狐神或世界书。保留原Git远端配置、浏览器令牌和其它设置。

以下1.2.x记录描述历史版本；1.3.0的展示镜像不再适用旧版“完全不保存原生副本”的限制。当前网关完整账本上限5000楼，超出时明确停止而不虚报成功。

## 1.2.1：修正新回复的目标楼层

修复“聊天以AI开场”时，普通生成把未填写的确认楼层当成第0楼、覆盖真实目标的问题。例如第0楼是开场、第1楼是用户输入，新回复应落在第2楼。空值不代表0，只有明确的MESSAGE_RECEIVED确认才能选择第0楼；续写、swipe和空回复占位仍使用各自真实坐标。20项回归通过。

手机可用 `tavern-gateway-memory-bridge-1.2.1-android-user-update.zip`（用户扩展）或 `tavern-gateway-memory-bridge-1.2.1-android-global-update.zip`（全局扩展）手动增量导入，导入后刷新确认1.2.1。原地址、启用状态和已保存令牌沿用，不需要新token。刚生成完显示“等待楼层确认”不等于失败：手机确认最终正文后、或下次生成携带完整楼层时才提交记忆。记忆节点数也不要求每轮增长，事件边界与基线提交有不同作用。

## 1.2.0：自动连接与记住令牌

更新后刷新页面，在“扩展→Tavern Gateway记忆桥”确认版本1.2.0及启用开关。默认从当前模型连接识别本机/内网3080或3180网关，自动填写并保存网关地址及精确匹配规则；点击“自动填写”可重新识别，手动配置不会被自动覆盖。“检查配置与连接”显示未启用、地址不匹配、准备就绪或实际连接失败。生成后应显示“已注入：楼层…”，网关不再是bridge_required。

基础桥接不需要令牌。可选即时对账的Dashboard令牌首次填写后自动启用对账并保存；默认按酒馆账号和网关origin隔离在本浏览器，刷新后填回，不会向更换后的地址复用旧令牌。关闭“记住令牌”可改为仅当前标签页；清除或删空会删除保存值。不会读取模型密钥或其它插件令牌，更换设备/浏览器或清理站点数据后需重新填写。

不运行第二份记忆图。删除、swipe、重生成仍按真实楼层与完整哈希核对；未启用即时对账时，下一次生成前仍会提交完整manifest。

> [!IMPORTANT]
> 这是一个私人使用项目，不是面向公众提供的网关服务。本文所称的 Tavern Gateway 部署并运行在项目所有者的私人电脑上，只服务于其本人控制的 SillyTavern / Luker 环境。此扩展仓库之所以可以公开访问，仅是为了让同一位使用者能够在手机端通过 Git URL 安装和更新扩展；仓库公开不表示网关、电脑、令牌、模型额度或任何私人数据对外开放。

这是一个可远程安装的 SillyTavern / Luker 第三方扩展。它不在浏览器里另建记忆库，而是在主对话生成请求发出前，把酒馆掌握的真实聊天坐标交给 Tavern Gateway：

- 当前真实 `chatId` 与 Luker `resolveChatStateTarget()`；
- `chat[]` 的真实 0-based floor；
- 每层当前 `swipe_id`，以及覆盖角色、隐藏标记和完整正文的固定 FNV-1a 32-bit 指纹；
- 有上限的原始正文窗口；
- `generationType`、`lastInContextMessageId`、`targetFloor`、`targetSwipeId` 和预测的 assistant seq。

这些信息使网关能够像 Luker Memory Graph 的 floor-state 一样校验提交：楼层删除、正文编辑、隐藏状态或 active swipe 改变后，旧提交不再参与物化；重 roll 同一楼层时则能够复用同一轮召回。扩展为每次生成登记一次 `requestNonce`，并在 `MESSAGE_RECEIVED` 后用实际 messageId 和酒馆最终保存的正文结算事件边界；`MESSAGE_UPDATED` 可能只是流式半截正文，只记 mutation 而不触发对账。扩展还会把消息编辑/删除/swipe 等 mutation 暂存在当前标签页，并随下一次主生成一并提交；即使没有 Dashboard token，生成前也能先做完整 manifest 对账。

## 安装

### 安卓手动更新（1.2.0）

无法通过管理扩展取得更新时，可使用 `tavern-gateway-memory-bridge-1.2.0-android-user-update.zip`（用户扩展）或 `tavern-gateway-memory-bridge-1.2.0-android-global-update.zip`（全局扩展）。在「用户设置→账户→备份与恢复」只勾选原安装对应的扩展分类，选择「增量更新」并恢复ZIP，再刷新页面确认1.2.0及启用状态。包内含已发布代码与有效Git版本信息，不含远端配置、凭据、设置或聊天；无需解压。基础桥接无需令牌，下一次生成应显示“已注入”。两种包均经过实际Luker路径解析器和isomorphic-git隔离验证，重复导入幂等。

将扩展仓库公开到 GitHub、Gitee 或其它 Git 服务只用于获得手机端可访问的安装地址，不用于公开部署 Tavern Gateway。仓库推送后，在扩展管理器中选择“从 Git URL 安装”，粘贴仓库 clone URL，然后刷新页面。手机只是访问项目所有者本人控制的同一个酒馆服务，不需要在手机文件系统重复安装；在手机界面的扩展管理器安装也会落到该私人酒馆服务器上。

请勿向公开仓库提交 `gateway.json`、Bearer token、DSH 页面令牌、私人域名、聊天正文、记忆状态、运行日志或设备信息。公开仓库只应包含扩展源码和不含秘密的示例配置。

本地开发时，可把本目录作为第三方扩展安装，或放入：

```text
<Luker 数据目录>/extensions/third-party/tavern-gateway-memory-bridge/
```

加载成功后，在“扩展”设置中打开“Tavern Gateway 记忆桥”。扩展默认启用。

旧的 Luker `Memory Graph` 必须关闭；两套扩展同时启用时，本扩展会显示警告，网关也会防御性隔离旧世界书表格，但不会替两套图做双写同步。

## 安全边界

关闭自动配置且没有手动授权时，仅当请求中的 `endpoint`、`reverse_proxy`、`base_url` 或 `custom_url` 指向以下地址之一时才注入：

```text
http(s)://127.0.0.1:3080/...
http(s)://127.0.0.1:3180/...
http(s)://localhost:3080/...
http(s)://localhost:3180/...
http(s)://[::1]:3080/...
http(s)://[::1]:3180/...
```

1.2.0默认从当前活动连接自动识别本机及RFC1918内网的3080/3180端口，保存该origin的精确正则，不授权所有内网地址。域名、其他端口或手动模式可在设置里填写额外允许的正则。该正则就是数据授权范围，请不要写成 `.*`。扩展不会读取或发送 API 密钥，不会把正文写入浏览器持久存储，调试日志也只包含数量、楼层和 endpoint。

桥接消息中的 Base64URL 只是传输编码，不是加密。匹配的网关会收到设置所覆盖的正文窗口。

### 可选实时对账

如需在没有新生成时也让 Dashboard 及时反映删除和 swipe，可填写Dashboard Bearer token；新版会启用“聊天变更后立即向 Dashboard 对账”。网关地址随自动配置保存，也可手填。扩展会监听：

- `MESSAGE_RECEIVED` / `MESSAGE_UPDATED` / `MESSAGE_EDITED`；
- `MESSAGE_DELETED`；
- `MESSAGE_SWIPED` / `MESSAGE_SWIPE_DELETED`；
- `CHAT_CHANGED` / `CHAT_BRANCH_CREATED`。

它向 `<gatewayBaseUrl>/gateway/memory/reconcile` POST 当前完整桥接 payload，并以 `mutationKind` / `mutations` 说明触发原因。只有 `MESSAGE_RECEIVED` 会额外携带 `finalizeRequestNonce` 与 `finalizedTargetFloor`，把酒馆实际落盘的 assistant 层与生成请求一一对应；`MESSAGE_UPDATED` 不发 sideband。令牌默认保存在当前浏览器的 `localStorage`，键按酒馆账号与网关origin隔离；关闭“记住令牌”会删除持久值，仅在 `sessionStorage`/本页内存保留。令牌不会进入 `extension_settings`、预设、聊天、Git文件或调试日志。存储被拒绝时本次仍可使用并提示无法持久化。未配置 token、CORS 阻止、网关离线、90 秒超时或接口失败时，扩展显示“最终一致性降级”，不抛错、不阻断生成，下一次生成的内嵌 payload 仍会对账。

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
