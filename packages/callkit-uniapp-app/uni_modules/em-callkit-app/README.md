# em-callkit-app

环信 CallKit 的 UniApp Android/iOS 适配插件，基于 `easemob-websdk 5.x` 和 `agora-rtc`。

## 平台

- Android / iOS App
- Vue 3
- 必须使用 HBuilderX 自定义基座或正式包
- 不支持 H5、微信小程序和 HarmonyOS NEXT

## 依赖

**插件本身不带任何 npm 包**，下面这些全部由宿主自己安装（`uni_modules` 的 `dependencies`
只负责其它 uni_modules 插件，涉及 npm 包一律不管）：

| 依赖 | 形态 | 谁装 |
|---|---|---|
| `em-callkit-app` | uni_modules 插件 | 复制/插件市场导入 |
| `agora-rtc` | uni_modules 插件（UTS 原生） | 见下方说明 |
| `easemob-websdk@^5` | npm | **宿主** `npm i` |
| `@easemob-community/callkit-core-v5` | npm | **宿主** `npm i` |

两个 npm 包已写进 `package.json` 的 `peerDependencies`，只是契约声明，**不会被自动安装**；
宿主漏装会在编译期直接报 `Cannot find module`。

> 为什么 websdk 必须宿主装：它在运行时被 `createCallKitHost` 直接调用
> （`ChatClient.init` + `ChatManager` / `UserInfoManager` / `GroupManager`），
> 由宿主控制版本才能和它自己的 IM 逻辑保持一致。

## 快速接入（推荐）

一个函数搞定「建 IM 连接 → 登录 → 创建 CallKit → 挂通话页中继 → 来电导航」：

```ts
import { createCallKitHost } from '@/uni_modules/em-callkit-app'

const host = await createCallKitHost({
  appKey: 'org#app',
  userId: 'user001',
  token,                       // SDK 5.x 只支持 token 登录
  callPageUrl: '/pages/call/call'
})

// 单聊
await host.inviteCall({ calleeUserId: 'user002', callType: 1 })
// 群聊（不传 participantIds 就自动拉全群，排除自己）
await host.inviteGroupCall({ groupId: 'group_001', callType: 2 })

// 退出时
await host.dispose()
```

内部固定 `rtcOwnership: 'component'`，宿主不需要创建 `RtcCallSession`，也不用自己写导航。

| 选项 | 说明 |
|---|---|
| `appKey` / `userId` / `token` | 必填 |
| `nickname` | 可选，通话页显示用 |
| `defaultRtcAppId` | `getRTCToken` 未返回 appId 时兜底 |
| `callPageUrl` | 通话页路径，默认 `/pages/call/call` |
| `onNavigate` | 自定义导航（不用 `uni.navigateTo` 时传） |
| `onEvent` | 通话事件回调，可做日志/埋点 |

`host` 上还暴露 `core`、`callUi`、`imAdapter`、`fetchGroupMemberIds()`、`primeUserProfiles()`、`markCallPageClosed()`。

## 自己管 IM 连接（进阶）

如果你已经在别处初始化了 `ChatClient`，直接用底层 API：

```ts
import { ChatClient } from 'easemob-websdk'
import { ChatManager } from 'easemob-websdk/managers/chat'
import { UserInfoManager } from 'easemob-websdk/managers/user-info'
import { GroupManager } from 'easemob-websdk/managers/group'
import { createUniappAppCallKit } from '@/uni_modules/em-callkit-app'

const client = ChatClient.init({
  appKey: 'org#app',
  managers: [ChatManager, UserInfoManager, GroupManager]
})

await client.login({ userId, token })

const callkit = createUniappAppCallKit({
  client,
  rtcOwnership: 'component',
  userProfile: { userId, nickname }
})
```

此时通话页中继（`attachCallStageHost`）和导航需要你自己挂，参考 `createCallKitHost` 的实现。

## RTC 所有权：两种模式二选一

插件支持两种 RTC 归属，**不可同时使用**（组件内部会 `new RtcCallSession()`，与 `AgoraAppRtcAdapter` 各持一个会话，同时 join 同一频道属未定义行为）。

### 模式 A：`adapter`（默认，既有行为不变）

Core 通过 `AgoraAppRtcAdapter` 自动完成 join / publish / leave，宿主自己写通话页，媒体层用 `em-call-video-view`。

```ts
const callkit = createUniappAppCallKit({
  client,
  createRtcSession: () => new RtcCallSession()
})
```

### 模式 B：`component`（复用 agora-rtc 自带通话 UI）

不创建 `AgoraAppRtcAdapter`，Core 只走信令；`callkit.callUi` 桥接层把 `shouldJoinRtc` 等事件翻译成 `agora-call-one-to-one` / `agora-call-group` 的 props 与命令。

```ts
const callkit = createUniappAppCallKit({
  client,
  rtcOwnership: 'component',
  defaultRtcAppId: 'your-agora-app-id', // getRTCToken 未返回 appId 时兜底
  resolveProfile: (userId) => userCache[userId] // 可选：补全昵称头像
})
```

页面接入只有一种方式：**宿主推数据、页面发动作**。

原因：nvue 页面跑在原生渲染引擎的独立 JS 上下文里，**与 vue 页面的模块单例不共享**——
在 `index.vue` 里创建的 `callkit`，到 `call.nvue` 里 `getCallKit()` 一定是 `null`，
`globalData` / `vuex` 也只能过 JSON 可序列化的数据（函数、类实例过不去）。
视频又必须用 nvue 渲染，所以只能走事件总线。

```ts
// 登录成功后执行一次，logout 时调用返回的函数
const off = attachCallStageHost({
  callUi: callkit.callUi,
  core: callkit.core,
  onClosed: () => markCallPageClosed() // 复位「已经在通话页」的标记
})
```

页面侧：

```vue
<em-call-stage :view="view" :theme="theme"
  @accept="send('accept')" @refuse="send('refuse')" @hangup="send('hangup')" />
```

```js
onLoad() {
  uni.$on('em-callkit:view', this.handleView)
  uni.$emit('em-callkit:action', { type: 'ready' }) // 页面可能晚于事件创建，主动要一次快照
},
onUnload() {
  uni.$off('em-callkit:view', this.handleView)
  uni.$emit('em-callkit:action', { type: 'closed' })
},
send(type) {
  uni.$emit('em-callkit:action', { type })
}
```

动作协议：`ready`、`accept`、`refuse`、`hangup`、`audio-muted`、`video-muted`、`closed`。
事件名常量在 `src/ui/callStageHost.ts`（nvue 不支持 TS，页面里直接写字符串，保持一致即可）。

要点：

- `autoJoin` 恒为 `false`，入房由 `view.shouldJoin` 驱动，组件内部调 `ref.join()`。
- 被叫 `incomingCall` 时四个必填参数（`appId/channelName/token/uid`）已就绪，可以直接渲染并振铃。
- 主叫 `singleCallInvited` 时还没有 RTC 参数，先显示「正在呼叫」遮罩，等 `shouldJoinRtc` 再渲染组件。
- 静音/摄像头仍可调 `core.toggleAudio()` / `core.toggleVideo()`，桥接层会同步到组件，失败时回滚状态机。
- 群聊时 `view.groupMode` 为 `true`，组件自动切到 `agora-call-group`。

## 一屏通话组件：`em-call-stage`

`components/em-call-stage/em-call-stage.nvue` 已经处理好：

- 单聊 / 群聊组件的切换与入房时机（`view.shouldJoin` → `ref.join()`）；
- 来电的**接听 / 拒绝**与呼出的**取消**（插件 UI 只管媒体，不管信令）；
- **铃音**：呼出播 `outgoing.mp3`、来电播 `incoming.mp3`，单聊和群聊走同一套判断；点接听后立刻停；
  插件的 `ringtone-enabled` 恒为 false，避免双响；
- 组件控制栏改静音后回传动作，由宿主回写 Core 状态机；
- 挂断 → `core.hangup()`，结束态由 Core 事件卸载组件；
- 群聊来电遮罩（`agora-call-group` 没有呼叫页）。

| prop | 说明 |
|---|---|
| `view` | 通话快照（`CallViewProps`），必须 |
| `theme` | 透传 `AgoraCallTheme` |
| `groupColumns` | 群聊网格列数，默认 3 |
| `acceptText` / `rejectText` | 操作条文案 |

事件：`accept`、`refuse`、`hangup`、`audio-changed`、`video-changed`、`error`、`closed`。

> 组件内部对 `agora-call-one-to-one` / `agora-call-group` 采用**显式 import**，
> 不依赖 easycom 对 `uni_modules` 下 `.nvue` 的自动扫描——后者在部分 HBuilderX
> 版本或编译缓存下会漏，表现为 `Failed to resolve component`。

已知限制：`agora-call-group` 的成员卡片标题写死为数字 UID，插件未提供 label 插槽，昵称需要宿主自建皮肤。

## 群聊音视频

组件层已经支持：`view.groupMode` 为 true 时自动切到 `agora-call-group`，宿主只管发起和收尾。

```ts
import { CALL_TYPE } from '@easemob-community/callkit-core-v5'

await callkit.core.inviteGroupCall({
  groupId: 'group_001',
  // 必须显式给出，Core 不会自己去查群成员
  participantIds: ['user_b', 'user_c'],
  // 2 = VIDEO_MULTI，3 = AUDIO_MULTI；误传单聊枚举会被当成单聊处理
  callType: CALL_TYPE.VIDEO_MULTI
})
```

链路说明：

- **主叫**：`inviteGroupCall` 同步走完 token → 建群会话 → 发群邀请，随后立刻 `singleCallInvited`（呼出中遮罩）→ `shouldJoinRtc` 入房，中途不用等别人接听。
- **被叫**：收到 `incomingCall`，`callType` 为 2/3，payload 额外带 `groupId` / `groupName` / `invitedMembers`；接听后 `answerCall(accept)`，主叫回 token 再 `shouldJoinRtc`。
- **群名显示**：`view.groupName` 优先，没有则退到主叫昵称，再退到「群聊通话」。
- **成员昵称**：依赖 `resolveProfile` 同步查缓存，异步来源请先 `fetchUserInfoById` 预热。

示例工程 `pages/index` 有现成入口：填群 ID 点「群语音 / 群视频」，会自动 `groupManager.getGroup(id).getMembers()` 拉全部成员（排除自己）后邀请。

> 群聊铃音与单聊一致：`em-call-stage` 自己播 `incoming.mp3` / `outgoing.mp3`，
> 因为 `agora-call-group` 没有振铃实现，主叫阶段 `agora-call-one-to-one` 也还没渲染。

## 可运行示例

`packages/callkit-uniapp-app` 本身就是可运行的 HBuilderX 工程（`App.vue` / `pages.json` / `pages/index` / `pages/call`），演示「登录 → 单聊外呼 / 群聊外呼 → 来电自动进通话页 → 挂断返回」全流程，可直接对照抄 `common/callkit.ts` 的接入方式。

`uni_modules/agora-rtc` 是 UTS 原生插件，**必须打自定义调试基座**；标准基座会报 `Agora RTC 4.x not found` 并导致通话页白屏。

## 约束

- 一个 RTC Engine、一个活动频道。
- UID 必须是 0～2147483647 的整数。
- 视频必须使用 `.nvue` 原生视图。
- 不提供内置通话页面、后台保活、系统来电或 RTC Token 续期。
- 动态按用户/轨道订阅不支持，会显式 reject。
- 平台层不得手工处理 `shouldJoinRtc`、`shouldPublishTracks`、`shouldLeaveRtc`。

## 视频组件

`components/em-call-video-view/em-call-video-view.nvue` 封装 `agora-video-view`，提供：

- `uid`：本地为 0，远端为数字 UID
- `active`：离开通话时解绑原生视图
- `bind-error`：原生绑定失败事件

离开通话前必须解绑本地和远端视频，再销毁 RTC Session。
