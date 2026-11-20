/**
 * 示例工程的宿主壳。
 *
 * 真正的接入逻辑已经收进插件（`createCallKitHost`），这一层只保留两件事：
 * 1. 模块级单例，方便页面直接 `getCallKit()`；
 * 2. 把示例自己关心的事件打到控制台。
 *
 * 你自己的项目可以跳过这一层，直接 `await createCallKitHost({...})`。
 */
import { CALL_TYPE } from '@easemob-community/callkit-core-v5'
import { createCallKitHost } from '@/uni_modules/em-callkit-app'
import type { CallKitHost, CreateCallKitHostOptions } from '@/uni_modules/em-callkit-app'

export { CALL_TYPE }

export type DemoLoginOptions = CreateCallKitHostOptions
export type DemoGroupCallOptions = Parameters<CallKitHost['inviteGroupCall']>[0]

let host: CallKitHost | null = null

export function getCallKit(): CallKitHost | null {
  return host
}

export async function loginAndCreateCallKit(options: DemoLoginOptions): Promise<CallKitHost> {
  // 重复登录先收掉旧实例，避免两个 IM 连接抢同一个账号
  await logout()
  host = await createCallKitHost({
    ...options,
    onEvent: (event) => {
      console.log('[demo][CallKit]', event.type, event.payload)
      options.onEvent?.(event)
    }
  })
  return host
}

export function primeUserProfiles(userIds: string[]): Promise<void> {
  if (!host) return Promise.resolve()
  return host.primeUserProfiles(userIds)
}

export function inviteGroupCall(params: DemoGroupCallOptions): Promise<number> {
  if (!host) return Promise.reject(new Error('尚未登录'))
  return host.inviteGroupCall(params)
}

/** 通话页退场后由页面调用，允许下一次来电再次导航（正常情况下插件已自动处理） */
export function markCallPageClosed(): void {
  host?.markCallPageClosed()
}

export async function logout(): Promise<void> {
  const instance = host
  host = null
  if (instance) await instance.dispose()
}
