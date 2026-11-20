# @easemob-community/callkit-uniapp-app

Headless UniApp Android/iOS adapter for Easemob CallKit SDK 5.

This package provides the SDK 5 IM adapter, the Agora `RtcCallSession` bridge and a Core factory. It is intentionally headless: host applications own navigation, permission UI and call screens.

## Scope

Supported:

- `easemob-websdk >=5.0.0 <6.0.0` (verified with 5.2.0)
- Android/iOS App with the `agora-rtc` UTS plugin
- One active RTC channel
- Numeric RTC UIDs
- Audio always published; video published according to the current CallKit call type
- Automatic remote media subscription
- `.nvue` video rendering supplied by the host

Not included:

- H5, WeChat mini program, HarmonyOS NEXT
- Background call service, iOS CallKit/PushKit, killed-process wake-up
- Dynamic per-user/per-track subscribe/unsubscribe
- RTC token renewal
- Call pages of its own — `component` mode mounts `agora-rtc`'s default UI through the bundled `em-call-stage` component; `adapter` mode ships no UI at all

Unsupported RTC capabilities reject explicitly instead of pretending success.

## Required uni_modules

Install both plugins in the host App:

```text
uni_modules/
├── agora-rtc
└── em-callkit-app
```

Do not copy `agora-rtc` into CallKit Core.

## Usage

```ts
import type { ChatClient } from 'easemob-websdk'
import { createUniappAppCallKit } from '@/uni_modules/em-callkit-app'
import { RtcCallSession } from '@/uni_modules/agora-rtc/rtc-call-session.js'

export function setupCallKit(client: ChatClient) {
  return createUniappAppCallKit({
    client,
    createRtcSession: () => new RtcCallSession(),
    userProfile: {
      userId: client.getCurrentUserId() || '',
      nickname: '当前用户'
    },
    knownParticipants: [],
    onEvent: (event) => {
      console.log('[CallKit]', event.type, event.payload)
    }
  })
}
```

Call the factory after SDK 5 login, and call `dispose()` when the host account/session is destroyed.

## Account switching

```ts
const callkit = setupCallKit(clientA)

callkit.updateClient(clientB)
```

`updateClient` updates the SDK 5 adapter and calls `core.updateImClient()` without losing the current CallKit state.

## RTC command ownership

`rtcOwnership` chooses who drives Agora. The two modes are mutually exclusive.

### `adapter` (default)

`CallKitCore` is the only owner of `shouldJoinRtc`, `shouldPublishTracks` and `shouldLeaveRtc`. Do not call `rtcAdapter.joinChannel()` or manually process those Core events in a page/component; doing so will duplicate joins and leaves.

### `component`

```ts
const callkit = createUniappAppCallKit({
  client,
  rtcOwnership: 'component',
  defaultRtcAppId: 'your-agora-app-id'
})
```

No `AgoraAppRtcAdapter` is created (`callkit.rtcAdapter` is `undefined`). Core keeps doing signaling only, while `callkit.callUi` — a framework-agnostic reducer — turns Core events into props and commands for `agora-call-one-to-one` / `agora-call-group`:

- `incomingCall` → `view.visible = true` with `callDirection: 'incoming'`, `ringing: true`, and all four required RTC params already filled in.
- `shouldJoinRtc` → `ringing: false`, then `join()`.
- `callEnded` and friends → `view.visible = false`.
- `localAudioChanged` / `localVideoChanged` → forwarded to the component's `setAudioMuted` / `setVideoMuted`, with state-machine rollback on failure.

Join timing needs no `nextTick`: `visible` flips first, the page renders, `callUi.attach(ref)` is called from the component's mounted hook, and the bridge joins then. `autoJoin` stays `false` in every case.

Never mount both the adapter and the UI component: the component creates its own `RtcCallSession`, and two sessions joining the same channel is undefined behavior.

## Video view

Use `agora-rtc`'s native `agora-video-view` only inside `.nvue`. Bind local UID `0` and remote numeric UIDs explicitly. On leave, unbind before disposing the Session.

In `adapter` mode this package ships no call pages or video UI: hosts must provide `.nvue` views and bind them to the numeric UIDs exposed by `rtcJoined`/`userJoined` (or use the bundled `em-call-video-view`). In `component` mode use the bundled `em-call-stage`, which mounts `agora-call-one-to-one` / `agora-call-group`, drives `callUi.attach()`, and owns the accept/reject bar:

```vue
<em-call-stage :bridge="callkit.callUi" :core="callkit.core" @closed="goBack" @error="onError" />
```

## Runnable demo project

This folder is also a HBuilderX project (`App.vue`, `main.js`, `pages.json`, `pages/index/index.vue`, `pages/call/call.nvue`). It demonstrates login → outgoing call → incoming call auto-navigation → hangup, and `common/callkit.ts` is the reference integration.

Requirements:

- `uni_modules/agora-rtc` (from the Agora UTS plugin) and `uni_modules/em-callkit-app` in the same project.
- `node_modules` must contain `easemob-websdk@5.x` and `@easemob-community/callkit-core-v5`; the plugin imports the Core package by its published name.
- HBuilderX custom base (自定义基座) or a real build. The standard base has no Agora native module.
- Run on Android/iOS only. H5 and mini programs are unsupported.

## Development

```bash
pnpm --filter @easemob-community/callkit-uniapp-app typecheck   # tsc --noEmit
pnpm --filter @easemob-community/callkit-uniapp-app test        # vitest run
```

Both `tsconfig.json` (`paths`) and `vitest.config.ts` (`resolve.alias`) map `@easemob-community/callkit-core-v5` to `../callkit-core-v5/src`, so local checks never depend on a prior Core build.

## Verification status

- TypeScript and unit tests cover IM normalization and RTC command/event mapping.
- Android/iOS end-to-end calls still require a custom HBuilderX base and physical devices.
- Background calls and system incoming-call integration are not implemented.
