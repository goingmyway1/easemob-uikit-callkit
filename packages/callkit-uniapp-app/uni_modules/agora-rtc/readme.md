# agora-rtc

声网 RTC 4.x 的 UniApp UTS 插件，提供 Android/iOS 原生 RTC 桥接、Promise JS Facade、无头通话控制器，以及可选的一对一/一对多 `.nvue` 默认通话 UI。

当前原生 SDK 版本：**Agora RTC 4.5.2**。

> 本插件包含原生代码和第三方 SDK，只能运行在包含该插件的 App 自定义基座或正式 App 中。标准基座、H5 和小程序不能运行当前原生 RTC 实现。

## 目录

- [1. 能力与边界](#1-能力与边界)
- [2. 架构与目录](#2-架构与目录)
- [3. 环境与安装](#3-环境与安装)
- [4. 最快接入：默认通话 UI](#4-最快接入默认通话-ui)
- [5. 默认 UI 公开契约](#5-默认-ui-公开契约)
- [6. 无头接入：RtcCallSession](#6-无头接入rtccallsession)
- [7. 底层接入：JS Facade](#7-底层接入js-facade)
- [8. 权限与错误处理](#8-权限与错误处理)
- [9. 事件与状态常量](#9-事件与状态常量)
- [10. 原生视频组件](#10-原生视频组件)
- [11. 生命周期与并发规则](#11-生命周期与并发规则)
- [12. 定制与升级策略](#12-定制与升级策略)
- [13. 原生依赖与构建](#13-原生依赖与构建)
- [14. 类型声明](#14-类型声明)
- [15. 真机验收建议](#15-真机验收建议)
- [16. 常见问题](#16-常见问题)
- [17. 安全要求](#17-安全要求)

## 1. 能力与边界

### 已提供

- Android/iOS 单频道音频、视频通话。
- 本地音视频发布与远端音视频自动订阅。
- 麦克风静音、摄像头开关、前后摄像头切换、扬声器/听筒切换、本地预览暂停/恢复。
- 插件 API 调用、成功、失败和原生事件的本地诊断日志。
- 内置默认控制图标，并支持通过插槽替换。
- 入房成功、离房、远端用户上下线、连接状态、远端媒体状态和错误事件。
- Promise 参数校验、原生返回码检查、入房结果等待、超时和取消语义。
- `RtcCallSession` 无头控制器。
- 一对一、一对多默认 `.nvue` UI，可通过 props、slots、events 和 theme 定制。
- Android `SurfaceView`/可选 `TextureView`，iOS 原生 `UIView` 视频渲染。
- TypeScript 声明文件。

### 当前不包含

- 多 Engine、多频道同时在线。
- 屏幕共享、美颜、CDN/RTMP 推流、跨频道媒体流转发。
- HarmonyOS NEXT、H5、小程序原生 RTC 实现。
- 业务账号体系、Token 签发服务、路由和来电邀请流程。
- 大房间分页、主讲人布局、手动订阅和弱网降级策略。

默认一对多网格不是“无限人数方案”。`maxRemoteUsers` 只控制默认 UI 的展示数量，不改变订阅行为，也不代表声网 SDK 的房间人数上限。

## 2. 架构与目录

插件采用“无头核心 + 可选默认 UI”：

```text
业务宿主 .nvue 页面
  ├─ 路由、凭据获取、业务埋点、权限设置弹窗
  └─ 可选默认 UI
      ├─ agora-call-one-to-one
      └─ agora-call-group
          └─ RtcCallSession
              └─ JS Facade
                  └─ UTS Android/iOS 桥
                      └─ Agora RTC SDK
```

也可以跳过默认 UI，直接在自定义页面中使用 `RtcCallSession`；需要更底层控制时才直接使用 JS Facade。

```text
uni_modules/agora-rtc/
├── index.js                         # 公共 JS Facade，推荐底层入口
├── index.d.ts                       # Facade、事件、错误和常量类型
├── rtc-call-session.js              # 无头单频道控制器
├── rtc-call-session.d.ts            # Session 类型
├── rtc-logger.js                    # easemob-rtc.log 本地诊断日志
├── rtc-constants.js                 # 事件、连接、媒体和错误常量
├── rtc-errors.js                    # RtcError 与原生错误分类
├── ui.d.ts                          # 默认 UI 契约类型
├── mixins/
│   └── call-component.js            # 默认 UI 共享通话行为
├── static/icons/                    # 默认控制图标：白色描边、透明背景、96×96 PNG
├── components/
│   ├── agora-call-icon/             # 默认图标渲染组件
│   ├── agora-call-one-to-one/
│   │   └── agora-call-one-to-one.nvue
│   └── agora-call-group/
│       └── agora-call-group.nvue
└── utssdk/
    ├── index.uts                    # 平台条件导出，供 UTS 代理生成
    ├── interface.uts                # 原生桥公共类型
    ├── app-android/
    │   ├── index.uts                # Android RTC 桥
    │   ├── index.vue                # Android agora-video-view
    │   └── config.json              # Maven、minSdk、ABI
    └── app-ios/
        ├── index.uts                # iOS RTC 桥
        ├── index.vue                # iOS agora-video-view
        ├── Info.plist               # 权限文案兜底
        └── config.json              # CocoaPods、deployment target
```

### 各层职责

| 层              | 负责                          | 不负责                      |
| -------------- | --------------------------- | ------------------------ |
| UTS 原生桥        | SDK 调用、权限、原生返回码、原生视图        | Vue 页面状态、路由、Toast        |
| JS Facade      | Promise、参数校验、事件分发、串行化、超时与取消 | 组件 refs、业务 UI            |
| RtcCallSession | 一次通话的权限、初始化、入退房、销毁、设备操作     | DOM/native view、Token 签发 |
| 默认 UI          | 布局、远端用户展示、原生视图绑定、默认控制栏      | 业务导航、凭据服务                |
| 宿主页面           | 参数、凭据、路由、业务提示与埋点            | 重复实现 Engine 生命周期         |

## 3. 环境与安装

### 平台要求

| 项目        | 要求                                    |
| --------- | ------------------------------------- |
| HBuilderX | 按 `package.json` 为 `^4.0.0`；建议使用当前稳定版 |
| Android   | minSdk 21；当前配置仅 `arm64-v8a`           |
| iOS       | deployment target iOS 13.0            |
| 页面        | 原生视频组件所在宿主必须使用 `.nvue`                |
| 运行环境      | 包含本插件的自定义基座或正式 App                    |

### 安装

1. 将 `uni_modules/agora-rtc` 放入项目的 `uni_modules` 目录。
2. 在 `manifest.json` 中配置 App 模块、权限与平台参数。Android 宿主需声明 `INTERNET`、`ACCESS_NETWORK_STATE`、`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`；视频场景还需 `CAMERA`，使用蓝牙耳机时需 `BLUETOOTH` 和 `BLUETOOTH_CONNECT`。插件会在 Android 12+ 请求蓝牙运行时权限，拒绝蓝牙授权不会阻塞已获基础权限的普通通话。
3. 配置自己的声网 App ID；启用 App Certificate 的项目还需要合法 Token。
4. 制作 Android/iOS 自定义基座，或构建正式 App。
5. 使用真机运行并验证音频、视频、权限和生命周期。

不要把 Demo 的 `utils/agora-rtc.js` 复制到新项目。其他项目应直接引用插件正式入口：

```js
import * as rtc from '@/uni_modules/agora-rtc/index.js'
import { RtcCallSession } from '@/uni_modules/agora-rtc/rtc-call-session.js'
```

Demo 中的旧路径只是兼容转发，不是插件对外依赖。

## 4. 最快接入：默认通话 UI

### 4.1 一对一视频

宿主页面必须是 `.nvue`：

```vue
<template>
  <view class="page">
    <agora-call-one-to-one
      v-if="active"
      ref="call"
      :app-id="appId"
      :channel-name="channelName"
      :token="token"
      :uid="0"
      media-type="video"
      title="一对一视频通话"
      :auto-join="true"
      @joined="onJoined"
      @error="onError"
      @hangup="onHangup"
    />
  </view>
</template>

<script>
import AgoraCallOneToOne from '@/uni_modules/agora-rtc/components/agora-call-one-to-one/agora-call-one-to-one.nvue'

export default {
  components: { AgoraCallOneToOne },
  data() {
    return {
      active: true,
      appId: 'YOUR_APP_ID',
      channelName: 'demo-room',
      // 仅演示字段。生产环境应由宿主向服务端获取，不能硬编码长期 Token。
      token: ''
    }
  },
  methods: {
    onJoined({ uid }) {
      console.log('joined, uid =', uid)
    },
    onError(error) {
      console.error(error.category, error.code, error.message)
    },
    onHangup() {
      // 路由由宿主决定，组件不会自行 navigateBack。
      this.active = false
    }
  }
}
</script>

<style>
.page { flex: 1; }
</style>
```

一对一组件只跟踪第一个远端用户，适用于严格的一对一场景，不应当作多人网格使用。**当前版本通过 `SMALL_WINDOW_DRAGGABLE = false` 暂停小窗拖动，小窗固定在默认位置，仅保留点击交换主/小窗；恢复拖动时把该常量改回 `true`。** 视频模式采用全屏远端主画面和 `100px × 140px` 悬浮小窗；拖动恢复后使用 nvue 绝对定位（`left`/`top`）和触摸事件实现全屏拖动，自动限制在可视区域内，点击仍可交换主/小窗，不依赖 `movable-view`。拖动时 JS 只负责触摸坐标、边界限制和点击判定，`touchmove` 按 `requestAnimationFrame` 合并；Android 原生组件用 `setTranslationX/Y`、iOS 用 `UIView.transform` 移动同尺寸小窗父容器，不触发布局；`touchend` 提交最终 `left`/`top` 并清零 translation。原生拖动不可用时自动回退到布局拖动。修改原生拖动接口后必须重新制作自定义基座。小窗容器不要加边框：原生圆角裁剪会按父容器尺寸匹配，1px 边框会造成尺寸不一致而失效；圆角通过原生 `cornerRadius` 交给父容器 outline 裁剪，不能只依赖外层 view 的 `overflow: hidden`。远端尚未加入时不显示悬浮小窗。

### 4.2 一对一纯语音

```vue
<agora-call-one-to-one
  :app-id="appId"
  :channel-name="channelName"
  :token="token"
  :uid="0"
  media-type="audio"
  title="语音通话"
  @error="onError"
  @hangup="active = false"
/>
```

`media-type="audio"` 会同时保证：

- 只申请 `{ audio: true, video: false }`。
- 不发布本地视频。
- 不自动订阅远端视频。
- 不初始化本地视频预览。

### 4.3 一对多视频或语音

```vue
<template>
  <agora-call-group
    ref="call"
    :app-id="appId"
    :channel-name="channelName"
    :token="token"
    :uid="0"
    media-type="video"
    :columns="3"
    :max-remote-users="8"
    title="多人通话"
    @remote-user-click="onRemoteUserClick"
    @error="onError"
    @hangup="active = false"
  />
</template>

<script>
import AgoraCallGroup from '@/uni_modules/agora-rtc/components/agora-call-group/agora-call-group.nvue'
export default {
  components: { AgoraCallGroup },
  methods: {
    onRemoteUserClick({ uid }) {
      console.log('remote user:', uid)
    }
  }
}
</script>
```

纯语音时改为 `media-type="audio"`，组件会展示音频卡片，不创建 RTC 视频采集流程。

### 4.4 手动入房

```vue
<agora-call-one-to-one
  ref="call"
  v-bind="credentials"
  :auto-join="false"
  media-type="video"
/>
```

```js
// 等用户点击、服务端返回 Token 或前置业务校验完成后调用。
try {
  const result = await this.$refs.call.join()
  if (result) console.log('真正入房成功', result.uid)
} catch (error) {
  // 同时会收到组件 error 事件；这里可执行宿主级恢复逻辑。
}
```

当 `autoJoin=false` 时，默认控制区提供“加入通话”按钮；失败后默认提供“重试”入口。也可以通过 ref 自行调用。

### 4.5 后台与前台预览

默认组件不会替业务页面决定路由和后台策略。视频宿主可按需调用：

```js
export default {
  onHide() {
    const call = this.$refs.call
    if (call) call.suspendPreview().catch(() => {})
  },
  onShow() {
    const call = this.$refs.call
    if (call) call.resumePreview().catch(() => {})
  }
}
```

这两个方法只管理本地预览，不等同于离开频道或停止远端音频。一对一组件会在 App 退后台时暂停呼叫铃音与 loading 动画，回前台后按当前呼叫状态恢复；销毁时移除对应监听。

## 5. 默认 UI 公开契约

### 5.1 公共 Props

| Prop                | 类型                   | 默认值       | 说明                              |
| ------------------- | -------------------- | --------- | ------------------------------- |
| `appId`             | String               | `''`      | 声网项目 App ID，入房前必填               |
| `channelName`       | String               | `''`      | 频道名，入房前必填                       |
| `token`             | String               | `''`      | 测试模式可空；启用证书时传匹配频道与 UID 的 Token  |
| `uid`               | Number/String        | `0`       | 会转成 Number；0 由 SDK 分配，合法范围见入房参数 |
| `mediaType`         | `'audio' \| 'video'` | `'video'` | 决定权限、发布/订阅视频和默认布局               |
| `autoJoin`          | Boolean              | `true`    | 挂载后自动入房；false 时手动调用 `join()`    |
| `title`             | String               | `''`      | 默认标题；空值使用场景标题                   |
| `showHeader`        | Boolean              | `true`    | 是否显示默认头部区域                      |
| `showControls`      | Boolean              | `true`    | 是否显示默认控制栏；不影响 `control-extra`   |
| `initialAudioMuted` | Boolean              | `false`   | 原生入房前静音本地音频推流，避免短暂发布            |
| `initialVideoMuted` | Boolean              | `false`   | 原生入房前关闭本地视频采集并静音视频推流            |
| `videoEncoderWidth` | Number               | `960`     | 视频编码宽度，入房前生效                    |
| `videoEncoderHeight` | Number              | `540`     | 视频编码高度，入房前生效                    |
| `videoEncoderFrameRate` | Number          | `24`      | 支持 1/7/10/15/24/30/60 fps；Adaptive 方向和标准码率 |
| `theme`             | Object               | `{}`      | 受约束的运行时主题，字段见下表                 |

**视频编码配置：** Android/iOS 均在 `enableVideo()` 前调用 `setVideoEncoderConfiguration()`。一对一和一对多默认均为 960×540@24；Adaptive 模式下输出方向跟随采集方向，竖屏采集时按 540×960 的竖屏方向输出，配置中的宽高不表示固定横屏。

**参数变更规则：** 入房参数应在组件创建或 `join()` 前确定。不要在通话中直接修改 `appId`、`channelName`、`token`、`uid` 并期待组件自动重建 Engine。需要切换频道时，先结束并销毁当前组件，再创建新通话。

### 5.2 一对多额外 Props

| Prop              | 类型     | 默认值   | 说明                                        |
| ----------------- | ------ | ----- | ----------------------------------------- |
| `columns`         | Number | `3`   | 网格列数上限，运行时归一到 1～4；默认皮肤最多按一行三个排列           |
| `maxRemoteUsers`  | Number | `0`   | 默认 UI 最多展示多少个远端用户；0 不限制                   |
| `cardAspectRatio` | Number | `3/4` | 网格卡片宽高比（宽 / 高）；展开主窗口优先跟随视频流比例，拿不到尺寸时回退该比例 |

默认所有成员都在网格中：两个用户一行两个，超过两个一行三个。点击任意网格视频会把它展开到顶部主窗口：宽度占满全屏，高度按该成员实际视频流的宽高比计算（本地预览为 uid=0 的流）；拿不到尺寸时回退 `cardAspectRatio`。其余成员在底部一行三个；点击底部卡片可与主窗口切换，点击主窗口则收回网格。`remote-user-click` 事件在远端卡片被点击时发出，宿主可据此做业务埋点。

展开主窗口的宽高比来自原生 `videoSizeChanged` 事件（Android `onVideoSizeChanged`、iOS `videoSizeChangedOf`，已按 rotation 归一）；流比例算出的高度如果会超出“头部 + 控制栏 + 底部一行网格”的可视空间，会以该空间为上限截断，避免把底部网格顶出屏幕。主窗口和网格卡片都使用 `hidden` 铺满。

`maxRemoteUsers` 不包含本地用户。被隐藏的用户仍可能按照入房配置被订阅，默认 UI 会显示“另有 N 人未显示”；大房间需要自行设计订阅与分页策略。

### 5.2.1 一对一呼叫页

一对一组件在“开始入房 / 已入房但远端尚未加入”时展示微信式呼叫页：背景（视频模式为本地预览，音频模式为深色或自定义背景图）、被叫头像、姓名和三点 loading。远端加入后自动隐藏；它只消费展示数据，不参与邀请、振铃、接听/拒接等业务信令。

| Prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `remoteName` | String | `''` | 被叫显示名；为空时显示“对方”。RTC 不提供昵称，必须由业务传入 |
| `remoteAvatar` | String | `''` | 被叫头像 URL；为空或加载失败时显示内置用户图标 |
| `showCalling` | Boolean | `true` | 是否展示呼叫页；false 时回退到原等待状态 |
| `showCallingLoading` | Boolean | `true` | 是否显示三点 loading |
| `callingText` | String | `''` | 姓名下方的可选文案，支持 `{name}` 占位，例如 `正在呼叫 {name}` |
| `callingBackground` | String | `''` | 呼叫页背景图；音频建议传预模糊图 |
| `callingHangupText` | String | `'取消'` | 呼叫页挂断按钮文案 |

显示时机：`joining`（含权限申请/初始化）、`joined && !remoteUid`，或 `callDirection='incoming' && ringing=true`（未入房的来电邀请），且 `showCalling=true`、无错误、不在重连。远端首次加入后不再展示；远端离线后回到普通等待状态，不会重新弹出呼叫页。错误和重连提示优先于呼叫页。

| Slot | 作用域 | 说明 |
| --- | --- | --- |
| `calling` | `{ name, avatar, state }` | 替换整个呼叫页内容（含背景） |
| `calling-background` | `{ avatar }` | 替换背景层 |
| `calling-avatar` | `{ name, avatar }` | 替换被叫头像 |
| `calling-name` | `{ name }` | 替换被叫姓名 |
| `calling-loading` | `{ phase }` | 替换 loading；phase 0～2 |

```vue
<agora-call-one-to-one
  v-bind="credentials"
  media-type="video"
  :remote-name="callee.name"
  :remote-avatar="callee.avatar"
  calling-text="正在呼叫…"
  @user-joined="onAnswered"
  @hangup="active = false"
/>
```

`remoteName` 只影响展示；真正的呼叫邀请、振铃时机、接听/拒接和呼叫超时由宿主信令层负责。nvue 不支持可靠的 CSS 模糊，音频背景请传入预模糊图；视频模式默认直接使用本地预览，并叠加可配置遮罩。

### 5.2.2 一对一振铃

插件内置两支铃音，位于 `static/ringtones/`：

| 文件 | 用途 |
| --- | --- |
| `outgoing.mp3` | 主叫等待对方接听 |
| `incoming.mp3` | 被叫来电振铃 |

| Prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `outgoingRingtone` | String | 内置 `outgoing.mp3` | 主叫铃音；支持本地路径或远程 URL，外部可替换 |
| `incomingRingtone` | String | 内置 `incoming.mp3` | 被叫铃音；支持本地路径或远程 URL，外部可替换 |
| `ringtoneEnabled` | Boolean | `true` | 铃音总开关 |
| `ringtoneVolume` | Number | `1` | 音量，0～1 |
| `ringtoneLoop` | Boolean | `true` | 是否循环播放 |
| `ringtoneObeyMuteSwitch` | Boolean | `true` | iOS 是否遵循静音开关 |
| `callDirection` | `'outgoing' \| 'incoming'` | `'outgoing'` | 决定使用哪支默认铃音 |
| `ringing` | Boolean | `false` | 入局振铃状态，由宿主信令控制 |

行为规则：

- 出局：进入 `joining` 或已入房但远端未加入时播放；即使 `showCalling=false` 也会响铃。远端加入、离房、错误、重连或销毁时立即停止。
- 入局：仅当 `callDirection='incoming'` 且宿主设置 `ringing=true` 时播放；此时即使尚未入房也会展示呼叫页。开始接听/入房、拒接、超时、挂断或销毁时停止；开始 `join()` 后即使 `ringing` 仍为 true 也会自动停铃。插件不自行推断来电。
- 单组件只使用一个 `uni.createInnerAudioContext()`；切换曲目先 `stop()`，禁止两支铃音叠加。
- 铃音只做本地播放，不进入 RTC 采集/发布链路；接通前先停铃，避免被麦克风采集。
- 自定义资源加载失败会记录 `RINGTONE ERROR` 并回退到内置铃音；仍失败则静默降级，不阻塞通话。

外部替换：

```vue
<agora-call-one-to-one
  v-bind="credentials"
  outgoing-ringtone="https://cdn.example.com/ring/outgoing.mp3"
  incoming-ringtone="/static/ringtones/custom-incoming.mp3"
/>
```

- 当前内置文件为 320kbps 立体声，约 0.5 MB/支；正式发布建议压到 96～128kbps 单声道。
- iOS 默认遵循静音开关；产品需要在静音下也响铃时设置 `:ringtone-obey-mute-switch="false"`。
- 远程资源需业务保证可访问，并明确缓存和失败回退策略。

### 5.2.3 通话时长、视频 chrome 与常亮

| Prop | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `showDuration` | Boolean | `true` | 是否显示通话时长 |
| `durationPlacement` | `'top' \| 'center'` | `'top'` | 默认顶部居中 |
| `durationStart` | `'remote-joined' \| 'local-joined'` | `'remote-joined'` | 计时起点 |
| `chromeAutoHide` | Boolean | `true` | 仅视频通话生效；音频始终显示 |
| `chromeAutoHideDelay` | Number | `10000` | 视频通话自动隐藏延迟，毫秒 |
| `keepScreenOn` | Boolean | `true` | 音频、视频通话都保持常亮 |

行为：

- 时长默认在第一个远端用户加入后开始；等待阶段显示呼叫页。
- 格式为 `MM:SS`，超过 1 小时为 `H:MM:SS`；重连不重置。
- 视频通话点击画面中央切换顶部/底部 chrome；默认 10 秒无操作自动隐藏；操作控件、错误、重连会重置或强制显示。
- 音频通话顶部和底部始终显示，不响应点击隐藏和自动隐藏。
- 音视频通话都保持屏幕常亮；离房、错误、销毁时恢复，回到前台重新应用。
- 事件 `chrome-visibility-change` 返回 `{ visible, reason }`，`reason` 为 `auto` / `tap` / `force` / `api`。

> 当前版本先实现全屏通话的时长、视频 chrome 和常亮；全局缩小浮窗与缩小态属于后续 Phase 2，尚未在本组件中实现。

### 5.3 Theme

| 字段                           | 作用                      |
| ---------------------------- | ----------------------- |
| `backgroundColor`            | 通话根容器背景                 |
| `headerBackgroundColor`      | 头部背景                    |
| `cardBackgroundColor`        | 一对多视频卡片背景               |
| `textColor`                  | 标题、控制按钮文字等主要文字颜色        |
| `mutedTextColor`             | 占位、控制按钮状态、时长、副标题等次要文字颜色 |
| `statusTextColor`            | 状态文案颜色                  |
| `errorTextColor`             | 错误文案颜色                  |
| `placeholderBackgroundColor` | 无视频占位背景                 |
| `controlBackgroundColor`     | 控制按钮默认背景                |
| `controlMutedColor`          | 控制按钮关闭态背景               |
| `accentColor`                | 强调色：加入/重试按钮、占位头像等       |
| `dangerColor`                | 结束通话按钮                  |
| `callingBackgroundColor`     | 呼叫页背景（音频无背景图时）           |
| `callingScrimColor`          | 呼叫页遮罩色（视频叠在预览上、音频叠在背景图上） |
| `callingNameColor`           | 呼叫页姓名颜色                 |
| `callingLoadingColor`        | 呼叫页 loading 点颜色          |
| `callingAvatarBackgroundColor` | 呼叫页头像占位背景               |

```vue
<agora-call-one-to-one
  v-bind="credentials"
  :theme="{
    backgroundColor: '#111827',
    headerBackgroundColor: '#1f2937',
    textColor: '#f9fafb',
    accentColor: '#6366f1',
    dangerColor: '#dc2626'
  }"
/>
```

nvue 不支持完整 Web CSS。主题不承诺 CSS 变量、复杂选择器、Web 样式穿透或任意布局修改；复杂视觉差异请使用插槽、复制皮肤或自建 UI。

### 5.4 Slots

| Slot                 | 一对一 | 一对多 | 用途                                          |
| -------------------- | --- | --- | ------------------------------------------- |
| `header`             | ✓   | ✓   | 替换头部                                        |
| `status`             | ✓   | ✓   | 普通状态区域                                      |
| `waiting`            | ✓   | —   | 已入房、等待对方                                    |
| `calling`            | ✓   | —   | 一对一呼叫页整体内容（含背景）                             |
| `calling-background` | ✓   | —   | 呼叫页背景层（音频建议传预模糊图）                           |
| `calling-avatar`     | ✓   | —   | 呼叫页被叫头像                                     |
| `calling-name`       | ✓   | —   | 呼叫页被叫姓名                                     |
| `calling-loading`    | ✓   | —   | 呼叫页 loading（作用域含 `phase`）                     |
| `empty`              | —   | ✓   | 多人房间暂无远端成员                                  |
| `loading`            | ✓   | ✓   | 入房中                                         |
| `error`              | ✓   | ✓   | 普通错误状态                                      |
| `permission-denied`  | ✓   | ✓   | 权限错误状态                                      |
| `local-placeholder`  | ✓   | ✓   | 本地无视频/音频占位                                  |
| `remote-placeholder` | ✓   | ✓   | 远端无视频/音频占位                                  |
| `local-overlay`      | ✓   | ✓   | 本地画面上的业务信息层                                 |
| `remote-overlay`     | ✓   | ✓   | 远端画面上的业务信息层                                 |
| `controls`           | ✓   | ✓   | 整体替换默认控制按钮                                  |
| `audio-icon`         | ✓   | ✓   | 替换麦克风图标；作用域含 `muted`                        |
| `speaker-icon`       | ✓   | ✓   | 替换扬声器/听筒图标；开关同一个按钮，图标随当前路由变化，作用域含 `enabled` |
| `video-icon`         | ✓   | ✓   | 替换摄像头图标；作用域含 `muted`                        |
| `camera-icon`        | ✓   | ✓   | 替换前后摄像头切换图标                                 |
| `hangup-icon`        | ✓   | ✓   | 替换挂断图标                                      |
| `control-extra`      | ✓   | ✓   | 在控制区追加业务按钮                                  |
| `footer`             | ✓   | ✓   | 根容器尾部内容                                     |


示例：

```vue
<agora-call-group v-bind="credentials">
  <template #control-extra>
    <button @click="openMembers">成员列表</button>
  </template>
  <template #error>
    <text>通话异常，请检查网络后重试</text>
  </template>
</agora-call-group>
```

未提供图标插槽时显示插件内置的控制图标：白色描边、透明背景、96×96 PNG。图标使用开源图标库（[Lucide](https://lucide.dev)，ISC License；挂断图标取自 Material Icons `call_end`，Apache License 2.0），仅做白色描边渲染和 4 倍栅格导出，不在工程内用脚本绘制。默认控制栏把扬声器和听筒合并为一个开关：开启即扬声器、关闭即听筒，图标与文案随当前路由变化，不再单独提供听筒按钮；布局上挂断按钮居中，视频模式的翻转摄像头在挂断右侧，语音模式的麦克风与扬声器分别在挂断左右两侧。顶部默认只显示标题（一对一）和人数角标（一对多），收起、邀请等业务动作请用 `header` 插槽接入。需要替换风格时直接覆盖 `static/icons/` 下的同名 PNG（建议 96×96、白色、透明背景），或只在业务侧替换个别图标而不用接管整个控制栏：

```vue
<agora-call-one-to-one v-bind="credentials">
  <template #hangup-icon>
    <image src="/static/my-hangup.png" style="width: 32px; height: 32px" />
  </template>
  <template #audio-icon="{ muted }">
    <image :src="muted ? '/static/mic-off.png' : '/static/mic-on.png'"
      style="width: 28px; height: 28px" />
  </template>
</agora-call-one-to-one>
```

默认组件始终管理原生视图、ref 和 Canvas。插槽主要用于覆盖层及周边 UI，不要求业务方接管内部视频绑定。

### 5.5 Events

| 事件                   | 参数                          | 触发时机                                     |
| -------------------- | --------------------------- | ---------------------------------------- |
| `ready`              | 无                           | Engine 初始化完成                             |
| `joining`            | 无                           | 开始一次入房流程                                 |
| `joined`             | `{ channel, uid, elapsed }` | 收到真正的入房成功事件                              |
| `left`               | `{ duration }`              | 收到离开频道事件                                 |
| `user-joined`        | `{ uid, elapsed }`          | 远端用户加入                                   |
| `user-offline`       | `{ uid, reason }`           | 远端用户离线                                   |
| `audio-changed`      | `{ muted }`                 | 本地音频推流状态通过组件方法改变                         |
| `video-changed`      | `{ muted }`                 | 本地视频通过组件方法改变                             |
| `camera-changed`     | 无                           | 切换摄像头成功                                  |
| `speaker-changed`    | `{ enabled }`               | 原生扬声器/听筒路由设置成功后                          |
| `connection-changed` | `{ state, reason }`         | 连接状态变化；`state=4` 表示重连中                   |
| `error`              | `RtcError` 或带类别的 Error      | 权限、入房、连接或设备操作失败                          |
| `hangup`             | `{ uid }`                   | 用户通过组件结束流程后发出；uid 为入房成功的 UID             |
| `state-change`       | `{ state, sessionState }`   | 默认 UI 状态改变；`sessionState` 为 Session 原始状态 |
| `remote-user-click`  | `{ uid }`                   | 点击一对多远端卡片（展开到主窗口或与主窗口切换）或一对一切换窗口         |
| `window-switch`      | `{ primaryView, uid }`      | 一对一主/小窗交换完成                              |
| `chrome-visibility-change` | `{ visible, reason }` | 视频通话顶部/底部 chrome 显隐；reason 为 `auto` / `tap` / `force` / `api` |

默认 UI 的 `state` 是展示状态：`idle`、`requesting-permission`、`initializing`、`joining`、`joined`、`leaving`、`failed`、`disposed`。它由 `RtcCallSession` 状态派生，`requesting-permission` / `initializing` 可用于区分权限弹窗和入房阶段。

`hangup` 只通知宿主，不自动调用 `uni.navigateBack()`。组件卸载时会执行自身资源释放。

### 5.6 命令式方法

通过组件 ref 调用：

| 方法                                | 返回值                                        | 说明                                     |
| --------------------------------- | ------------------------------------------ | -------------------------------------- |
| `join()`                          | `Promise<joinChannelSuccess \| undefined>` | 入房；重复调用且不可入房时返回 undefined              |
| `leave()`                         | `Promise<boolean>`                         | 离开频道但保留组件，可再次入房；resolve 值表示是否真正执行了离开流程 |
| `hangUp()`                        | `Promise<void>`                            | 默认结束操作，发出 `hangup` 事件                  |
| `dispose()`                       | `Promise<void>`                            | 永久释放 Session 与 Engine，可重复调用            |
| `setAudioMuted(muted)`            | `Promise<void>`                            | 静音/恢复本地音频推流                            |
| `setVideoMuted(muted)`            | `Promise<void>`                            | 关闭/恢复本地视频，仅视频模式有效                      |
| `switchCamera()`                  | `Promise<void>`                            | 视频已开启且已入房时切换前后摄像头                      |
| `setSpeakerphoneEnabled(enabled)` | `Promise<void>`                            | `true` 请求扬声器，`false` 请求听筒；原生成功后才更新组件状态 |
| `suspendPreview()`                | `Promise<void>`                            | 暂停本地预览并记录待恢复状态                         |
| `resumePreview()`                 | `Promise<void>`                            | 恢复由 `suspendPreview()` 暂停的预览           |

设备方法在未初始化、模式不匹配或已销毁时可能直接返回，不表示执行了原生操作。需要严格状态时请同时跟踪组件事件。

### 5.7 内置图标组件

默认控制栏通过内部组件 `agora-call-icon` 渲染图标。业务用 `controls` 插槽接管控制栏时，也可以直接复用它，保持与默认皮肤一致的视觉：

```vue
<agora-call-icon name="hangup" :size="34" />
```

| Prop   | 类型     | 默认值  | 说明                           |
| ------ | ------ | ---- | ---------------------------- |
| `name` | String | 必填   | 图标名，见下方列表                    |
| `size` | Number | `28` | 宽高（px）；运行时最小按 12 处理，非法值回退 28 |

可用 `name`：`microphone`、`microphone-off`、`video`、`video-off`、`camera-switch`、`speaker`、`earpiece`、`hangup`、`collapse`、`user-plus`、`user`。传入未知名称会静默回退为 `microphone`，不会报错，也不会在控制台提示。

图标资源为透明 PNG，开启状态使用深色图形并搭配默认浅色按钮，关闭状态使用白色图形；`user` 使用圆形默认头像。需要整体换肤时覆盖 `static/icons/` 下的同名文件，并同步检查按钮底色；只替换个别按钮时优先使用 §5.4 的具名图标插槽，不要为此接管整个控制栏。

## 6. 无头接入：RtcCallSession

当默认 UI 不满足交互或布局时，推荐保留 Session，自建 `.nvue` 页面。这样可以复用权限、生命周期和错误语义，而不需要直接操作 Engine。

### 6.1 完整示例

```js
import {
  RtcCallSession,
  RTC_EVENT,
  RTC_ERROR_CATEGORY
} from '@/uni_modules/agora-rtc/rtc-call-session.js'

const session = new RtcCallSession()

const offJoined = session.on(RTC_EVENT.JOIN_CHANNEL_SUCCESS, ({ uid }) => {
  console.log('joined', uid)
})
const offRemote = session.on(RTC_EVENT.USER_JOINED, ({ uid }) => {
  // 在 .nvue 页面中创建远端视图，并在 $nextTick 后 bindVideo(uid)。
  console.log('remote joined', uid)
})

try {
  const result = await session.join({
    appId: 'YOUR_APP_ID',
    channelName: 'demo',
    token: '',
    uid: 0,

    publishAudio: true,
    publishVideo: true,
    autoSubscribeAudio: true,
    autoSubscribeVideo: true,

    // 视频场景；纯语音请改为 { audio: true, video: false }。
    permissionOptions: { audio: true, video: true }
  })
  console.log('真正入房成功', result)
} catch (error) {
  if (error.category === RTC_ERROR_CATEGORY.CANCELLED) {
    // 页面主动退出或销毁，不应显示“网络失败”。
  } else {
    console.error(error.category, error.message)
  }
}

// 仅离开频道，可在同一 Session 中再次 join。
await session.leave()

// 永久销毁。dispose 会退订本 Session 的监听器；手动 off 也可提前执行。
offJoined()
offRemote()
await session.dispose()
```

### 6.2 纯语音配置

```js
await session.join({
  appId,
  channelName,
  token,
  uid: 0,
  publishAudio: true,
  publishVideo: false,
  autoSubscribeAudio: true,
  autoSubscribeVideo: false,
  permissionOptions: { audio: true, video: false }
})
```

三个视频相关配置必须保持一致，避免语音场景仍开启预览或申请摄像头权限。

### 6.3 SessionJoinOptions

| 字段                   | 类型      | 必填 | 默认值                            | 说明                      |
| -------------------- | ------- | -- | ------------------------------ | ----------------------- |
| `appId`              | string  | 是  | —                              | 声网 App ID               |
| `channelName`        | string  | 是  | —                              | 频道名，会 trim              |
| `token`              | string  | 否  | `''`                           | 与频道和 UID 匹配             |
| `uid`                | number  | 是  | —                              | 0～2147483647 的整数；0 自动分配 |
| `publishAudio`       | boolean | 否  | `true`                         | 是否发布本地音频                |
| `publishVideo`       | boolean | 否  | `true`                         | 是否发布本地视频                |
| `autoSubscribeAudio` | boolean | 否  | `true`                         | 是否自动订阅远端音频              |
| `autoSubscribeVideo` | boolean | 否  | `true`                         | 是否自动订阅远端视频              |
| `videoEncoderWidth` | number | 否  | `960`                           | 编码宽度，正整数                   |
| `videoEncoderHeight` | number | 否 | `540`                           | 编码高度，正整数                   |
| `videoEncoderFrameRate` | number | 否 | `24`                          | 支持 1、7、10、15、24、30、60 fps |
| `permissionOptions`  | object  | 否  | `{ audio: true, video: true }` | 按实际场景申请权限               |
| `initialAudioMuted`  | boolean | 否  | `false`                        | 原生入房前静音音频推流             |
| `initialVideoMuted`  | boolean | 否  | `false`                        | 原生入房前关闭视频采集并静音视频推流      |

### 6.4 Session 方法与属性

| 成员                                      | 说明                                                  |
| --------------------------------------- | --------------------------------------------------- |
| `state`                                 | 当前 Session 状态                                       |
| `error`                                 | 最近一次初始化/入房错误，成功初始化时清空                               |
| `disposed`                              | 是否已永久销毁                                             |
| `engineReady`                           | Engine 是否初始化完成                                      |
| `joining` / `joined`                    | 是否正在入房/已经入房                                         |
| `appId`                                 | 当前 Session 使用的 App ID                               |
| `onStateChange(callback)`               | 订阅状态变化，返回退订函数；UI 应从这里派生展示状态                         |
| `cancelPendingOperations()`             | 作废当前权限/初始化/入房流程但不销毁 Engine                          |
| `initialize(appId, permissionOptions?)` | 只申请权限并初始化 Engine；已初始化后切换 App ID 会抛错                 |
| `join(options)`                         | 完整入房，成功表示已经收到入房成功事件                                 |
| `leave()`                               | 离开频道，保留 Engine                                      |
| `dispose()`                             | 退订、取消旧流程并销毁 Engine；幂等                               |
| `on(event, callback)`                   | 订阅事件，返回退订函数                                         |
| `off(event, callback?)`                 | 移除订阅                                                |
| `setSpeakerphoneEnabled(enabled)`       | 设置音频路由；入房成功后视频默认请求扬声器、纯语音默认请求听筒；默认路由失败只记录诊断日志，不打断通话 |
| 其他设备方法                                  | 与 Facade 同名设备方法一一对应                                 |

每个 Session 持有 Engine 所有权令牌：初始化、入房、设备操作、退房和销毁都会校验所有权；旧页面的延迟操作不会破坏新页面刚创建的通话。`off()` 只移除当前 Session 的订阅。

### 6.5 Session 状态

```text
idle → requestingPermission → initializing → ready
ready → joining → joined
joining/joined → leaving → ready
初始化或入房失败 → failed
任意状态 → disposed
```

常量：`CALL_STATE`，与上述状态字符串一一对应：

| 常量                      | 值                      |
| ----------------------- | ---------------------- |
| `IDLE`                  | `idle`                 |
| `REQUESTING_PERMISSION` | `requestingPermission` |
| `INITIALIZING`          | `initializing`         |
| `READY`                 | `ready`                |
| `JOINING`               | `joining`              |
| `JOINED`                | `joined`               |
| `LEAVING`               | `leaving`              |
| `FAILED`                | `failed`               |
| `DISPOSED`              | `disposed`             |

`joining/joined/leaving` 状态拒绝重复入房。失败后可以在未销毁的实例上重试；若连接失败时旧频道仍活跃，重试会先等待退房再入房。`disposed` 后不能复用，必须创建新实例。

## 7. 底层接入：JS Facade

只有在 Session 无法满足需求时才直接管理 Facade。调用方需要自行处理权限、事件订阅、页面销毁、原生视图绑定和设备顺序。

```js
import {
  initialize,
  enableLocalAudio,
  enableLocalVideo,
  startPreview,
  requestPermissionsOrThrow,
  joinChannelAndWait,
  leaveChannel,
  destroy,
  on,
  RTC_EVENT
} from '@/uni_modules/agora-rtc/index.js'

const offJoin = on(RTC_EVENT.JOIN_CHANNEL_SUCCESS, ({ uid }) => {
  console.log('joined', uid)
})

await requestPermissionsOrThrow({ audio: true, video: true })
await initialize('YOUR_APP_ID')
await enableLocalAudio(true)
await enableLocalVideo(true)
await startPreview()

const result = await joinChannelAndWait({
  channelName: 'demo',
  token: '',
  uid: 0,
  publishAudio: true,
  publishVideo: true,
  autoSubscribeAudio: true,
  autoSubscribeVideo: true
})

await leaveChannel()
offJoin()
await destroy()
```

### 7.1 初始化与销毁

#### `initialize(appId, owner?): Promise<void>`

- 校验 App ID 非空。
- 检查原生 `createRtcEngine` 返回码。
- 相同 App ID 可复用 Engine。
- 切换 App ID 前必须 `await destroy()`。
- Session 会传入 owner；设备与频道操作在入队前和执行原生调用前都会检查所有权。

#### `destroy(): Promise<void>`

- 取消等待中的入房 Promise 和超时计时器。
- 在 Engine 操作队列中销毁原生 Engine。
- 清空 Facade 的初始化标记。
- **不会全局清空 JS 事件订阅**，避免旧页面的异步销毁误删新 Session 的监听器。

因此直接 Facade 调用方仍必须执行自己的 `off()` 或退订函数。

### 7.2 入房语义

#### `joinChannel(options, owner?): Promise<void>`

Promise resolve **只表示原生方法返回 0，即入房请求已提交**，不表示用户已进入频道。它还会启动 15 秒计时器，未收到成功/离房/连接失败时发出 `joinChannelTimeout`。

#### `joinChannelAndWait(options, owner?): Promise<joinChannelSuccess>`

推荐用于一次完整入房：

| 结果                      | Promise 行为                              |
| ----------------------- | --------------------------------------- |
| 收到 `joinChannelSuccess` | resolve 事件数据                            |
| Token/App ID 等鉴权失败      | reject `RtcError(category='auth')`      |
| 连接失败                    | reject 分类后的连接错误                         |
| 15 秒超时                  | reject `RtcError(category='timeout')`   |
| 主动 `leaveChannel()`     | reject `RtcError(category='cancelled')` |
| `destroy()`             | reject `RtcError(category='cancelled')` |

鉴权/连接失败和超时会主动清理残留连接；主动离开和销毁取消不会重复执行额外离开。等待结束时会移除本次临时监听器。

同时只允许一个等待中的 `joinChannelAndWait()`。重复调用会得到 `state` 类错误。Session 在 `joining/joined/leaving` 状态也拒绝重入；连接失败后的重试会先等待旧频道 `leave`，再重新入房。

### 7.3 设备 API

| 方法                                 | 说明                                           |
| ---------------------------------- | -------------------------------------------- |
| `startPreview()` / `stopPreview()` | 开始/停止本地预览                                    |
| `enableLocalAudio(enabled)`        | 开启/关闭本地音频采集与发送能力                             |
| `enableLocalVideo(enabled)`        | 开启/关闭本地视频采集与发送能力                             |
| `muteLocalAudio(muted)`            | 静音/恢复本地音频推流，不等于关闭采集设备                        |
| `muteLocalVideo(muted)`            | 停止/恢复本地视频推流，不等于销毁视频视图                        |
| `switchCamera()`                   | 切换前后摄像头                                      |
| `setSpeakerphoneEnabled(enabled)`  | `true` 请求扬声器，`false` 请求听筒；连接外部音频设备时以系统最终路由为准 |

除权限与事件订阅外，Engine 方法统一检查原生返回码并返回 Promise。操作进入同一队列，避免快速点击产生原生调用交错。设备方法最后可传可选 owner；旧式不传 owner 的调用保持兼容，Session 始终传入自己的 owner。

### 7.4 本地诊断日志

插件默认把公共 Facade API 的调用开始、成功返回、失败、原生事件和 Session 状态变化写入：

```text
_doc/easemob-rtc.log
```

这是 App 私有文档目录下的逻辑路径，不是项目源码目录。实际路径可通过 `getRtcLogFilePath()` 获取。每次 API 调用都有 `callId`，其 `START` 行 ID 与后续 `SUCCESS` / `ERROR` 中的 `callId` 相同，可用该 ID 检索一次完整调用；同时记录耗时、原生错误分类、code/reason 和操作名。默认 UI 的 `bindVideo` / `unbindVideo` 同步结果和 UI 错误也会记录。


```js
import {
  getRtcLogFilePath,
  flushRtcLogs,
  clearRtcLogs,
  setRtcLoggingEnabled
} from '@/uni_modules/agora-rtc/index.js'

console.log(getRtcLogFilePath())
await flushRtcLogs() // 导出或读取日志前等待当前队列落盘
// await clearRtcLogs() // 按业务保留策略清空
// setRtcLoggingEnabled(false) // 显式关闭后续日志
```

日志写入串行且失败只降级到 console，不应阻断 RTC。页面销毁或运行环境重建时，iOS 的 `plus.weexBridge` 可能瞬间不可用（典型报错 `plus.weexBridge.exec is not a function`）；这种情况会自动暂停文件写入 5 秒后重试，只保留 console 输出，也不会产生未处理异常或反复刷屏。Token、证书、密码等字段脱敏，App ID 只保留前后少量字符；频道名、UID 等业务标识仍可能出现，导出日志前应按隐私政策处理。单文件最大 **2 MiB**（`RTC_LOG_MAX_BYTES`），下一次写入将导致超限时先清空旧日志再从头写入，因此只保留最新一段日志且不会无限增长。文件不会自动上传，也可按业务保留策略调用 `clearRtcLogs()`。这里记录的是插件桥接层诊断信息，不等同于 Agora SDK 的全部内部日志。

### 7.5 事件订阅

```js
const unsubscribe = on(RTC_EVENT.REMOTE_VIDEO_STATE_CHANGED, (data) => {
  console.log(data.uid, data.state)
})

// 页面或 Session 销毁时调用。
unsubscribe()

// 也可以显式 off；不传 callback 会清除该事件的所有当前订阅，谨慎使用。
off(RTC_EVENT.REMOTE_VIDEO_STATE_CHANGED, callback)
```

单个监听器抛出异常不会阻断其他监听器。不要在每次渲染或点击时重复注册而不退订。

### 7.6 其余公共导出

除上文列出的 Facade 方法外，`index.js` 还会导出以下成员，供诊断和高级场景使用：

| API                                                                   | 说明                                                |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `isEngineOwner(owner?)`                                               | 查询调用方是否仍持有 Engine；省略 owner 时按旧语义返回 `true`         |
| `rtcLogger`                                                           | 向同一日志文件写入业务日志：`debug` / `info` / `warn` / `error` |
| `traceRtcApi(operation, details, invoke)`                             | 记录一次 API 调用并生成 `callId`；业务通常不需要直接调用               |
| `RTC_LOG_FILE_NAME` / `RTC_LOG_MAX_BYTES`                             | 日志文件名与单文件大小上限常量                                   |
| `nativeErrorHint(code)` / `rtcErrorMessage(code)`                     | 原生返回码对应的简短提示与错误文案                                 |
| `connectionErrorMessage(reason)`                                      | 连接失败 reason 对应的错误文案                               |
| `categorizeNativeError(code, operation?)`                             | 把原生返回码归类为 `RtcErrorCategory`                      |
| `createConnectionError(data?)` / `createNativeError(code, operation)` | 按统一规则构造 `RtcError`                                |

`traceRtcApi`、错误文案/分类函数和 `rtcLogger` 主要服务于插件内部与诊断工具，升级时签名可能调整；业务错误处理应优先依赖 `RtcError` 的 `category`、`code`、`reason` 和 `userMessage` 字段，而不是自己解析原生数字码。

## 8. 权限与错误处理

### 8.1 权限 API

```js
const granted = await requestPermissions({ audio: true, video: false })
if (!granted) {
  // 展示业务 UI，由用户确认是否进入系统设置。
}

await requestPermissionsOrThrow({ audio: true, video: true })
await openPermissionSettings()
```

| 方法                                    | 行为                                                 |
| ------------------------------------- | -------------------------------------------------- |
| `requestPermissions(options?)`        | 返回 `Promise<boolean>`；audio/video 都 false 时直接 true |
| `requestPermissionsOrThrow(options?)` | 拒绝时抛 `RtcError(category='permission')`             |
| `openPermissionSettings()`            | 打开 App 系统权限设置；平台不支持时 reject                        |

语音场景不要申请摄像头权限。权限拒绝后不应循环弹窗；是否进入设置由用户主动确认。

### 8.2 RtcError 字段

| 字段            | 类型               | 说明                                  |
| ------------- | ---------------- | ----------------------------------- |
| `message`     | string           | 可展示或诊断的信息                           |
| `category`    | RtcErrorCategory | 稳定的业务错误类别                           |
| `code`        | number?          | 原生返回码/错误码                           |
| `reason`      | number?          | 原生连接失败原因                            |
| `operation`   | string?          | 失败操作，如 `joinChannel`、`startPreview` |
| `userMessage` | string           | 可直接展示给终端用户的文案                       |
| `cause`       | unknown?         | 可选原始异常                              |

### 8.3 错误类别

| category     | 含义                  | 建议处理                        |
| ------------ | ------------------- | --------------------------- |
| `parameter`  | 参数或前置状态不合法          | 检查 App ID、频道名、UID、Engine 状态 |
| `permission` | 摄像头/麦克风权限未授权        | 引导用户授权或进入设置                 |
| `device`     | 音频、视频、预览或摄像头操作失败    | 检查设备占用、权限和原生返回码             |
| `auth`       | App ID、Token、频道鉴权失败 | 刷新 Token，核对频道与 UID          |
| `network`    | 连接失败或网络相关异常         | 检查网络并重试                     |
| `service`    | RTC 服务或原生调用失败       | 保留 code/operation 诊断        |
| `state`      | 当前状态不允许该操作          | 停止重复操作，先退出或销毁               |
| `timeout`    | 入房等待超时              | 检查网络、Token 和服务状态后重试         |
| `cancelled`  | 主动离开或销毁导致取消         | 通常不提示错误                     |
| `native`     | 未进一步分类的原生错误         | 保留原始信息诊断                    |

对应常量 `RTC_ERROR_CATEGORY`：`PARAMETER`、`PERMISSION`、`DEVICE`、`AUTH`、`NETWORK`、`SERVICE`、`STATE`、`TIMEOUT`、`CANCELLED`、`NATIVE`，值即上表的 category 字符串。业务分支应比较常量，不要手写字符串。

### 8.4 统一处理示例

```js
import {
  RTC_ERROR_CATEGORY,
  openPermissionSettings
} from '@/uni_modules/agora-rtc/index.js'

function handleRtcError(error) {
  if (!error || error.category === RTC_ERROR_CATEGORY.CANCELLED) return

  if (error.category === RTC_ERROR_CATEGORY.PERMISSION) {
    uni.showModal({
      title: '需要音视频权限',
      content: error.userMessage || error.message,
      confirmText: '去设置',
      success: ({ confirm }) => {
        if (confirm) openPermissionSettings().catch(() => {})
      }
    })
    return
  }

  uni.showToast({ title: error.userMessage || error.message || '通话失败', icon: 'none' })
}
```

日志可以保留 `category`、`code`、`reason` 和 `operation`，不要输出完整 Token。

## 9. 事件与状态常量

推荐始终使用常量，不在业务代码中重复书写事件字符串或媒体状态魔法数字：

```js
import {
  RTC_EVENT,
  RTC_CONNECTION_STATE,
  REMOTE_MEDIA_STATE
} from '@/uni_modules/agora-rtc/index.js'
```

### 9.1 RTC_EVENT 与数据字段

| 常量                           | 事件字符串                     | data                                                                     |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `ENGINE_INITIALIZED`         | `engineInitialized`       | `{ appId }`                                                              |
| `JOIN_CHANNEL_SUCCESS`       | `joinChannelSuccess`      | `{ channel, uid, elapsed }`                                              |
| `JOIN_CHANNEL_TIMEOUT`       | `joinChannelTimeout`      | `{ timeout }`，毫秒                                                         |
| `LEAVE_CHANNEL`              | `leaveChannel`            | `{ duration }`，秒                                                         |
| `USER_JOINED`                | `userJoined`              | `{ uid, elapsed }`                                                       |
| `USER_OFFLINE`               | `userOffline`             | `{ uid, reason }`                                                        |
| `CONNECTION_STATE_CHANGED`   | `connectionStateChanged`  | `{ state, reason }`                                                      |
| `REMOTE_VIDEO_STATE_CHANGED` | `remoteVideoStateChanged` | `{ uid, state, reason, elapsed }`                                        |
| `REMOTE_AUDIO_STATE_CHANGED` | `remoteAudioStateChanged` | `{ uid, state, reason, elapsed }`                                        |
| `VIDEO_SIZE_CHANGED`         | `videoSizeChanged`        | `{ uid, width, height, rotation }`；rotation 为原始值，默认 UI 使用前会按 rotation 归一 |
| `ERROR`                      | `error`                   | `{ code, message? }`                                                     |

### 9.2 RTC_CONNECTION_STATE

| 常量             | 值 |
| -------------- | - |
| `DISCONNECTED` | 1 |
| `CONNECTING`   | 2 |
| `CONNECTED`    | 3 |
| `RECONNECTING` | 4 |
| `FAILED`       | 5 |

### 9.3 REMOTE_MEDIA_STATE

| 常量         | 值 | 默认 UI 处理                      |
| ---------- | - | ----------------------------- |
| `STOPPED`  | 0 | 叠加占位层覆盖最后一帧，保留原生视图与 Canvas 绑定 |
| `STARTING` | 1 | 尝试恢复视频绑定                      |
| `DECODING` | 2 | 尝试恢复视频绑定                      |
| `FROZEN`   | 3 | 保留当前状态                        |
| `FAILED`   | 4 | 保留当前状态，可结合错误事件处理              |

枚举与声网 RTC 4.x 对齐；不要假设 Android/iOS 所有 `reason` 数值和出现顺序完全一致。

## 10. 原生视频组件

插件双端提供同名 `agora-video-view`，由 easycom 识别。**传统 UniApp 的 UTS 兼容模式原生组件必须放在 `.nvue` 页面/组件中，不能直接在普通 `.vue` WebView 页面使用。**

### 10.1 Props

| Prop           | 类型     | 默认值         | 说明                                                                                                                      |
| -------------- | ------ | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `uid`          | Number | `0`         | 0 本地预览，大于 0 为远端 UID                                                                                                     |
| `renderMode`   | String | `'hidden'`  | `hidden` 等比裁满；`fit` 完整显示、可能留黑边                                                                                          |
| `renderType`   | String | `'surface'` | Android 可选 `surface`/`texture`；iOS 保留兼容属性但使用 UIView                                                                     |
| `cornerRadius` | Number | `0`         | 原生视频圆角；Android 开启后自动使用 TextureView，并把圆角 outline 下发给与视频视图同尺寸的父容器裁剪（仅给 TextureView 自身设置 outline 裁不到纹理）。修改该原生实现后需重新制作自定义基座 |

模板中使用驼峰属性名（nvue 的 UTS 原生组件不会把 kebab-case 转成驼峰，写成 `render-mode` 会静默回退到默认值）：

```vue
<agora-video-view
  ref="localVideo"
  :uid="0"
  renderMode="hidden"
  style="width: 360px; height: 240px"
/>
```

### 10.2 显式绑定 API

当前组件**不会因为挂载或 `uid` prop 改变而自动完成业务绑定**。必须在 Engine 初始化且视图挂载后显式调用：

| 方法               | 返回值                     | 说明                                         |
| ---------------- | ----------------------- | ------------------------------------------ |
| `bindVideo(uid)` | number（JS 桥接也可能返回 null） | 原生 0 成功或布局前请求已排队；真实错误统一通过 `bind-error` 上报  |
| `unbindVideo()`  | number（JS 桥接也可能返回 null） | 清理该组件实际绑定的 Canvas；真实错误统一通过 `bind-error` 上报 |

```js
this.$nextTick(() => {
  const local = this.$refs.localVideo
  if (!local) return

  const result = local.bindVideo(0)
  // iOS nvue 可能返回 null；不要转成 Number 或据此判断失败。
  if (typeof result === 'number' && result !== 0) {
    console.error('bindVideo failed', result)
  }
})
```

在 `v-for` 中，动态 ref 可能返回数组：

```js
const value = this.$refs['remoteVideo' + uid]
const view = Array.isArray(value) ? value[0] : value
if (view) {
  const result = view.bindVideo(Number(uid))
  if (typeof result === 'number' && result !== 0) console.error('bindVideo failed', result)
}
```

如果布局尚未完成，组件会保存绑定请求，并在 `NVLayouted`/`NVLoaded` 后重放。相同 UID 和渲染模式的重复绑定是幂等操作。所有原生绑定/解绑失败都会发出 `bind-error`，payload 为 `{ code, uid, operation }`；默认通话 UI 已监听并转换为分类错误，自建 UI 必须处理该事件，不能只检查同步返回值。UID 必须是 0～2147483647 的整数，解绑失败会保留绑定状态以便重试。

### 10.3 一对一窗口交换顺序

同一 UID 同时绑定多个原生窗口可能互相覆盖 Canvas。交换主窗/小窗时必须：

```text
主窗 unbindVideo()
小窗 unbindVideo()
主窗 bindVideo(newMainUid)
小窗 bindVideo(newSmallUid)
```

不要逐窗执行“主窗解绑→主窗绑定→小窗解绑→小窗绑定”，否则小窗解绑旧 UID 时可能清掉主窗刚设置的新 Canvas。

### 10.4 视频停止与恢复

原生视频视图在停止视频后可能保留最后一帧。推荐做法是**让原生视图常驻，用占位层覆盖最后一帧**：

1. 不要因为本地关闭摄像头或远端 `STOPPED` 而 `v-if` 卸载常驻窗口的原生视图。
   Android 上卸载再重建 View，可能让 Canvas 绑定丢失，恢复后只剩控件边框、没有画面。
2. 用一个绝对定位的占位层覆盖视频区域，只在“无视频”时显示即可（默认 UI 的 `local-placeholder`/`remote-placeholder` 即为此层）。
3. 本地关闭/恢复只切换采集与预览：`enableLocalVideo(false)` → 恢复时 `enableLocalVideo(true)` + `startPreview()`，
   并在 `startPreview()` 之后对本地窗口重新 `bindVideo(0)`。
4. 如果业务确实需要卸载视图（例如 `v-for` 中的卡片被删除），恢复时必须先 `unbindVideo()`，
   等 `$nextTick` 后再 `bindVideo(uid)`；`$refs` 或原生布局可能晚于 `$nextTick` 就绪，应做有限次重试。

### 10.5 nvue 尺寸与布局

- 给原生组件设置明确的 `px` 或 `rpx` 宽高。
- 不要只依赖 `height: 100%`，否则原生视图可能回落到默认尺寸。
- 卡片、原生组件和占位视图使用一致的明确尺寸。
- 使用 Flex 和 nvue 支持的 CSS，不依赖复杂 Web 布局。
- 圆角与拖动注意：当前 `SMALL_WINDOW_DRAGGABLE=false` 暂停拖动。恢复拖动后，不要在 nvue 层用 `transform` 移动包含原生视频视图的容器；小窗拖动由原生组件移动同尺寸父容器（Android translation / iOS UIView transform），JS 只处理触摸和边界，`touchend` 提交 `left`/`top` 并清零 translation。圆角需交给原生容器裁剪：仅设置 TextureView 自身的 outline 裁不到视频纹理。
- 组件卸载会自动清理，但业务方在窗口交换、远端离线和页面销毁时仍应主动解绑，避免回调时序造成残影。

## 11. 生命周期与并发规则

### 推荐入房顺序

```text
申请场景所需权限
  → 初始化 Engine
  → 启用音频/视频
  → 视频场景启动本地预览
  → joinChannelAndWait / session.join
  → 收到 joinChannelSuccess
  → $nextTick 后绑定本地/远端视频
```

### 推荐退出顺序

```text
禁止旧异步流程继续更新
  → 解绑本地与远端视频
  → 离开频道
  → 退订事件
  → 销毁 Engine
```

默认 UI 和 Session 已封装主要顺序；自建 UI 不应再在多个页面重复实现一套互相冲突的状态机。

### 必须遵守

1. 一个活动通话使用一个 Session；当前 Engine/Facade 是单例。
2. 每个异步阶段结束后都检查操作是否仍有效，Session 使用 generation 防止销毁后回写。
3. 页面销毁必须 `dispose()`；仅 `leave()` 不会销毁 Engine。
4. 重复 `dispose()` 是安全的；销毁后的 Session 不可复用。
5. 不把 `joinChannel()` 的提交成功当作入房成功。
6. 不在多个组件之间共享可变 Session，或同时发起多个入房等待。
7. 不在旧页面销毁时全局 `off()` 新页面的监听器。
8. 原生 `bindVideo`/`unbindVideo` 非零结果不能被静默吞掉；iOS 的 JS 调用可能返回 `null`，因此同步和布局后的真实错误都通过 `bind-error` 上报。
9. 入房参数变化不应隐式触发 Engine 重建；切换通话应明确销毁旧实例。
10. 设备操作失败应保留 Promise reject，不用固定延时或吞错掩盖竞态。
11. 旧页面的 `dispose()` 不得误毁新页面 Engine；Session 通过 owner 令牌约束销毁范围。
12. 权限/初始化阶段点结束应先 `cancelPendingOperations()`，再按需 `leave()`，避免“已挂断又入房”。
13. 收到 `RECONNECTING` 时给出明确提示；回前台恢复预览后应重新 `bindVideo()`。

## 12. 定制与升级策略

按以下优先级选择：

1. **Props / Theme**：标题、显示开关、媒体模式、列数和基础颜色。
2. **Slots / Events**：替换局部 UI、追加按钮、业务埋点和路由。
3. **复制默认皮肤到业务目录**：布局变化很大，但仍希望复用默认控制逻辑。
4. **只使用 RtcCallSession 自建 UI**：交互、状态或布局完全不同。
5. **直接使用 JS Facade**：需要自行控制更底层的 Engine 调用顺序。

### 12.1 默认 UI 皮肤扩展钩子

复制默认皮肤或自建皮肤时，可按需实现以下钩子；mixin 在对应时机调用，未实现则跳过：

| 钩子                                                              | 时机                                           |
| --------------------------------------------------------------- | -------------------------------------------- |
| `onCallJoined(data)` / `onCallLeft(data)`                       | 入房成功 / 离开频道                                  |
| `onRemoteUserJoined(data)` / `onRemoteUserOffline(data)`        | 远端上下线                                        |
| `onRemoteVideoState(data)` / `onRemoteAudioState(data)`         | 远端媒体状态变化                                     |
| `onVideoSizeChanged(data)`                                      | 本地（uid=0）或远端视频尺寸变化；默认皮肤用它计算展开主窗口的高度          |
| `onConnectionStateChanged(data)` / `onConnectionFailure(error)` | 连接状态变化 / 连接失败                                |
| `onLocalVideoChanged(muted)`                                    | 本地视频开关完成后；默认皮肤只在 `muted === false` 时强制重绑本地窗口 |
| `beforeLocalVideoDisabled()`                                    | 关闭本地视频前；默认皮肤不再解绑，保留视图由占位层覆盖                  |
| `onPreviewResumed()`                                            | App 回前台恢复预览后                                 |
| `beforeCallDispose()`                                           | 组件销毁前解绑原生视图                                  |


这些钩子目前未纳入稳定语义版本承诺；升级插件时请对照 `ui.d.ts` 的 `AgoraCallHooks`。

不建议把直接修改 `uni_modules/agora-rtc` 源码作为默认业务定制方式，因为插件升级可能覆盖修改。

无论选择哪种方式，插件都不应包含：

- 固定业务路由或 `pages.json` 修改。
- 写死的业务 App ID、Token 或用户资料。
- App Certificate 或 Token 签发密钥。
- 特定业务服务器地址和账号体系。

## 13. 原生依赖与构建

### Android

`utssdk/app-android/config.json`：

- Maven：`io.agora.rtc:full-sdk:4.5.2`
- minSdk：21
- ABI：当前仅 `arm64-v8a`

首次构建需要访问 Maven Central 下载依赖。如果需要其他 ABI，必须重新评估声网 SDK 支持、包体积和原生构建配置，不能只修改文档。

### iOS

`utssdk/app-ios/config.json`：

- CocoaPods：`AgoraRtcEngine_iOS/RtcBasic`
- 版本：4.5.2
- deployment target：iOS 13.0

需要可用的 CocoaPods 环境和有效开发签名。权限文案优先在项目 `manifest.json` 的 iOS 隐私配置中维护，`utssdk/app-ios/Info.plist` 作为插件兜底。

### 自定义基座

任何 UTS 原生代码、原生配置或 SDK 依赖变化后，都需要重新制作自定义基座。仅更新 JS 资源不能替换已安装基座里的原生实现。

标准基座不包含本插件，出现“方法不存在”“仅支持自定义基座”或原生组件无法渲染时，先检查基座类型和构建日志。

## 14. 类型声明

| 文件                      | 内容                                                                             |
| ----------------------- | ------------------------------------------------------------------------------ |
| `index.d.ts`            | `JoinChannelOptions`、`PermissionOptions`、`RtcEventMap`、`RtcError`、Facade 方法与常量 |
| `rtc-call-session.d.ts` | `SessionJoinOptions`、`RtcCallSession`                                          |
| `ui.d.ts`               | `AgoraCallProps`、`AgoraCallOneToOneProps`、`AgoraCallGroupProps`、`AgoraCallTheme`、方法和事件名 |

```ts
import type {
  JoinChannelOptions,
  RtcEventMap,
  RtcError
} from '@/uni_modules/agora-rtc/index'
import type {
  AgoraCallProps,
  AgoraCallOneToOneProps,
  AgoraCallMethods
} from '@/uni_modules/agora-rtc/ui'
```

`.nvue` 组件的运行时导入仍使用实际 `.nvue` 路径；类型文件用于契约检查和业务 TypeScript 代码，不改变 UniApp 的组件编译规则。

## 15. 真机验收建议

可重复执行核心生命周期回归测试：

```bash
node --experimental-vm-modules --test tests/rtc-core.test.mjs
```

当前 12 项测试覆盖 owner 隔离、跨 Session 退订、入房前初始静音、入房后的默认音频路由及其失败降级、日志文件名与脱敏、入房重入、断线重试、初始化取消和销毁异常恢复。JS 语法检查或桌面 Mock 通过不代表原生 RTC 已验证。Android/iOS 应分别覆盖：

### 权限

- 首次允许、首次拒绝、永久拒绝。
- 去系统设置授权后返回并重试。
- 纯语音只申请麦克风，不因摄像头权限阻塞。

### 入房与错误

- 正常入房、退出、重新入房。
- 错误/过期 Token、错误 App ID、重复 UID。
- 断网、恢复网络、连接失败和入房超时。
- 入房中快速退出页面，不出现迟到的成功提示或重复错误。

### 一对一

- 本地预览、远端加入/离线。
- 主窗/小窗反复交换；恢复拖动后，小窗拖到四角、边缘和不同屏幕尺寸下不越界。
- 扬声器/听筒反复切换，并分别验证无耳机、有线耳机和蓝牙设备场景。
- 本地与远端摄像头关闭/恢复，无黑屏和最后一帧残留。
- 前后摄像头切换、后台/前台预览恢复。

### 一对多

- 多人按顺序加入和离开。
- 视频停止/恢复后 UID 与窗口不串线。
- 超过一屏滚动，以及 `maxRemoteUsers` 限制后的离席补位。
- 不同屏幕尺寸、安全区和列数。

### 生命周期

- 反复进入/退出页面。
- 连续点击加入、结束和重拨。
- 组件销毁后无残留声音、事件或原生视图。
- 新旧页面切换时事件不会互相误投递。

## 16. 常见问题

### 为什么 `joinChannel()` 已经 resolve，但还没有收到远端用户？

它只表示原生入房请求提交成功。请使用 `joinChannelAndWait()` 或 `session.join()` 等待真正的 `joinChannelSuccess`。

### 为什么标准基座无法运行？

本插件包含 UTS 原生桥和声网原生 SDK，标准基座没有这些代码。请重新制作包含本插件的自定义基座。

### 为什么普通 `.vue` 页面不能显示视频？

当前原生视频组件使用传统 UniApp 的 UTS 兼容模式，要求 `.nvue` 宿主。无头 Session 可以在其他逻辑层复用，但原生视图必须遵循该限制。

### 为什么视频黑屏或显示上一用户画面？

逐项检查：

1. Engine 是否初始化完成。
2. 是否在 `$nextTick` 后调用 `bindVideo(uid)`。
3. 原生组件是否有明确宽高。
4. 本地使用 UID 0，远端使用实际远端 UID。
5. 窗口交换是否先全部解绑再全部绑定。
6. 摄像头关闭/恢复后是否误卸载了原生视图，导致 Canvas 绑定丢失（应保留视图、只用占位层覆盖）。
7. `bindVideo`/`unbindVideo` 是否返回非零值。

### 为什么语音页面也申请摄像头权限？

检查 `mediaType` 和 Session 配置。纯语音应同时设置：

```js
mediaType: 'audio'
publishVideo: false
autoSubscribeVideo: false
permissionOptions: { audio: true, video: false }
```

### 如何刷新 Token？

当前插件不内置 Token 服务。由宿主向服务端获取新 Token 后，根据产品流程重新建立通话；不要通过修改客户端 App Certificate 或硬编码长期 Token 解决。

### 能否同时进入多个房间？

当前 Facade 和原生 Engine 是单例，不支持多个并行房间。即使创建多个 Session，也不能绕过这个底层限制。

### 修改了 UTS 代码，为什么真机行为没有变化？

JS 资源更新不会修改已安装基座中的原生代码。重新制作并安装自定义基座后再验证。

## 17. 安全要求

- **App Certificate 永远放在服务端，不得进入客户端、插件或仓库。**
- 生产 Token 由服务端根据用户、频道、UID 和过期时间动态签发。
- 示例中的 `YOUR_APP_ID`、空 Token 只是占位，不代表生产配置。
- 不提交真实长期 Token、私有签发接口密钥或用户隐私数据。
- 插件日志会对 Token/证书等敏感字段和 App ID 脱敏；业务新增日志仍应避免输出完整 Token，并按需脱敏 UID、频道名等标识。
- `easemob-rtc.log` 最大 2 MiB，超限后清空旧内容并从头覆盖；不会自动上传，导出、分享和保留期限应遵循业务隐私政策。
- Demo 的 `utils/rtc-settings.js` 只把 App ID / 频道名 / UID 写入本机 storage，Token 不落盘。
- 临时测试 Token 应设置短有效期，泄露后立即轮换。
- 组件只接收凭据，不负责保存、签发或硬编码凭据。

---

默认 UI 的完整类型见 `ui.d.ts`，无头控制器见 `rtc-call-session.d.ts`，底层 API 与事件见 `index.d.ts`。如运行时行为与文档不一致，以当前源码和双端真机验证结果为准，并同步修正文档。
