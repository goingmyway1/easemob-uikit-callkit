/**
 * 仅用于本仓库 `tsc --noEmit` 的全局声明。
 *
 * HBuilderX / uni-app CLI 编译时会注入完整的 uni 类型（@dcloudio/types），
 * 这里不引入那份依赖，避免离线环境下为了示例工程拉一整个类型包。
 */
declare const uni: {
  navigateTo(options: { url: string; fail?: (error: unknown) => void }): void
  navigateBack(options?: Record<string, unknown>): void
  getSystemInfoSync(): {
    statusBarHeight?: number
    platform?: string
    safeAreaInsets?: { top?: number; bottom?: number }
  }
  getMenuButtonBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number }
  [key: string]: any
}
