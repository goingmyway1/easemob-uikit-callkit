# @easemob-community/callkit-core-v5

Framework-agnostic CallKit signaling core for **easemob-websdk 5.x**.

This package is intentionally independent from `@easemob-community/callkit-core` (SDK 4). It keeps the same call signaling and state-machine contract, while SDK 5 compatibility is provided by a platform IM adapter.

## Requirements

- `easemob-websdk >=5.0.0 <6.0.0`
- The SDK 5 IM adapter must normalize `ChatClient` into the `EasemobConnection` contract.

Verified during initial implementation against `easemob-websdk@5.2.0`.

## Install

```bash
pnpm add @easemob-community/callkit-core-v5 easemob-websdk@5.2.0
```

## Integration outline

```ts
import { CallKitCore } from '@easemob-community/callkit-core-v5'
import { createUniappAppCallKit } from '@easemob-community/callkit-uniapp-app'
```

For UniApp Android/iOS, create the instance through `callkit-uniapp-app`. Do not pass a raw SDK 5 `ChatClient` directly to `CallKitCore`; SDK 5 uses `onMessage`, `chatManager.createTextMessage`, `chatManager.createCmdMessage`, `getRTCTokenInfo` and `getUserIdsWithRTCUids`, which must be adapted first.

## Package boundaries

- No runtime dependency on the SDK 4 Core.
- No UniApp, Agora, UTS, Vue or DOM dependency.
- RTC remains behind `RtcAdapter`.
- SDK 5 message and token differences stay in the platform IM adapter.

## Build and test

```bash
pnpm --filter @easemob-community/callkit-core-v5 typecheck   # tsc --noEmit
pnpm --filter @easemob-community/callkit-core-v5 test        # vitest run
pnpm --filter @easemob-community/callkit-core-v5 build       # vite build + tsc 声明
```

`vite build` emits `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.umd.js` and `dist/index.iife.js`; type declarations come from `tsc -p tsconfig.build.json` instead of a bundler plugin, so the build only needs `vite`.
