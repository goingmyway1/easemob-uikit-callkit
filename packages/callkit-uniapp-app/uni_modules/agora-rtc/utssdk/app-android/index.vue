<template>
	<view class="agora-video-view"></view>
</template>

<script lang="uts">
	import View from 'android.view.View'
	import SurfaceView from 'android.view.SurfaceView'
	import TextureView from 'android.view.TextureView'
	import ViewOutlineProvider from 'android.view.ViewOutlineProvider'
	import Outline from 'android.graphics.Outline'
	import { setupVideoView, clearVideoView } from './index.uts'

	export default {
		name: 'agora-video-view',
		props: {
			uid: {
				type: Number,
				default: 0
			},
			renderMode: {
				type: String,
				default: 'hidden'
			},
			renderType: {
				type: String,
				default: 'surface'
			},
			// 逻辑像素圆角；大于 0 时强制使用 TextureView，SurfaceView 无法被父容器圆角裁剪。
			cornerRadius: {
				type: Number,
				default: 0
			}
		},
		data() {
			return {
				viewReady: false,
				hasBound: false,
				hasBindRequest: false,
				requestedUid: 0,
				boundUid: 0,
				boundRenderMode: ''
			}
		},
		expose: ['bindVideo', 'unbindVideo', 'setDragTranslation', 'clearDragTranslation'],
		// 不监听 uid/renderMode：nvue 属性更新会进入 UTS watcher，Swift 侧强转可能直接 SIGABRT。
		// 页面在所有状态变化后显式调用 bindVideo(uid)，组件只按调用时的参数绑定。
		methods: {
			/**
			 * 由 nvue 宿主显式调用。布局尚未完成时仅保存请求，NVLayouted 会重放；
			 * 重复绑定相同 UID/renderMode 是幂等操作，返回原生结果码而非抛异常。
			 */
			bindVideo(uid : number) : number {
				if (uid < 0 || uid > 2147483647 || uid % 1 != 0) return -2
				this.requestedUid = uid
				this.hasBindRequest = true
				const result = this.syncVideoView(uid)
				this.reportBindError(result, uid, 'bindVideo')
				return result
			},
			// 视图尚未布局时返回 0 表示绑定请求已排队；其余非 0 值均为原生错误码。
			syncVideoView(uid : number) : number {
				if (uid < 0 || uid > 2147483647 || uid % 1 != 0) return -2
				if (this.renderType != 'surface' && this.renderType != 'texture') return -2
				if (!this.viewReady) return 0
				if (this.hasBound && this.boundUid == uid && this.boundRenderMode == this.renderMode) return 0
				// 必须解绑此视图实际使用的 UID，不能依赖属性 watcher 的 oldValue。
				if (this.hasBound) {
					const clearResult = this.clearBoundVideoView()
					if (clearResult != 0) return clearResult
				}
				const result = setupVideoView(this.$el!, uid, this.renderMode)
				this.hasBound = result == 0
				if (this.hasBound) {
					this.boundUid = uid
					this.boundRenderMode = this.renderMode
					// 重新绑定后原生视图的 outline 可能被重置，再裁剪一次圆角。
					if (this.cornerRadius > 0) this.applyCornerClip()
				}
				return result
			},
			unbindVideo() : number {
				const uid = this.boundUid
				const result = this.clearBoundVideoView()
				this.hasBindRequest = false
				this.reportBindError(result, uid, 'unbindVideo')
				return result
			},
			// 与 iOS 保持同一事件契约，宿主无需依赖不同平台的返回值桥接行为。
			reportBindError(result : number, uid : number, operation : string) {
				if (result == 0) return
				this.$emit('bind-error', { code: result, uid: uid, operation: operation })
			},
			/** 只清理本组件实际绑定的 UID，避免误清其他窗口刚设置的新 Canvas。 */
			clearBoundVideoView() : number {
				if (!this.hasBound) return 0
				const result = clearVideoView(this.boundUid)
				// 解绑失败时保留绑定事实，后续可以重试清理，不能伪装成未绑定。
				if (result == 0) {
					this.hasBound = false
					this.boundRenderMode = ''
				}
				return result
			},
			/**
			 * 原生拖动位移：只改渲染层 translation，不触发布局。
			 * JS 在 touchmove 的 rAF 中调用，touchend 时清零并提交最终 left/top。
			 */
			setDragTranslation(dx : number, dy : number) {
				const container = this.findDragContainer()
				const density = $androidContext!.getResources().getDisplayMetrics().density
				container.setTranslationX((dx * density).toFloat())
				container.setTranslationY((dy * density).toFloat())
			},
			clearDragTranslation() {
				const container = this.findDragContainer()
				const zero = (0 * 1.0).toFloat()
				container.setTranslationX(zero)
				container.setTranslationY(zero)
			},
			/**
			 * 向上找到与小窗同尺寸的最外层容器，整体移动视频、占位层和手势层。
			 * 遇到尺寸不同的父级（例如整页根容器）立即停止。
			 */
			findDragContainer() : View {
				const videoView : View = this.$el!
				var current : View = videoView
				var level = 0
				while (level < 6) {
					const up = current.getParent()
					if (up == null) return current
					const container = up as View
					const widthDiff = Math.abs(container.getWidth() - current.getWidth())
					const heightDiff = Math.abs(container.getHeight() - current.getHeight())
					if (widthDiff > 2 || heightDiff > 2) return current
					current = container
					level += 1
				}
				return current
			},
			/**
			 * Android 上给 TextureView 自己设置 outline 裁不到视频纹理（画面仍然直角），
			 * 可靠做法是给与视频视图同尺寸的原生父容器设置圆角 outline，
			 * 由硬件层按圆角裁剪整棵子树。只修饰尺寸接近的父级，
			 * 避免误伤整页或其他窗口的圆形区域。
			 * 自定义方法必须放在 methods 中，否则 UTS 会生成错误的 override。
			 */
			applyCornerClip() {
				const videoView : View = this.$el!
				const density = $androidContext!.getResources().getDisplayMetrics().density
				const radius = (this.cornerRadius * density).toFloat()
				videoView.setOutlineProvider(new RoundedVideoOutlineProvider(radius))
				videoView.setClipToOutline(true)
				videoView.invalidateOutline()
				var current : View = videoView
				var level = 0
				while (level < 4) {
					const up = current.getParent()
					if (up == null) return
					const container = up as View
					// 允许 ±2px 误差：父容器可能带 1px 边框或内边距，尺寸不会严格相等。
					const widthDiff = Math.abs(container.getWidth() - videoView.getWidth())
					const heightDiff = Math.abs(container.getHeight() - videoView.getHeight())
					if (widthDiff <= 2 && heightDiff <= 2) {
						container.setOutlineProvider(new RoundedVideoOutlineProvider(radius))
						container.setClipToOutline(true)
						container.invalidateOutline()
						return
					}
					current = container
					level += 1
				}
			}
		},
		NVLoad() : View {
			const useTexture = this.renderType == 'texture' || this.cornerRadius > 0
			return useTexture ? new TextureView($androidContext!) : new SurfaceView($androidContext!)
		},
		NVLayouted() {
			this.viewReady = true
			// 圆角轮廓依赖最终宽高，布局完成后刷新一次。
			if (this.cornerRadius > 0) this.applyCornerClip()
			if (this.hasBindRequest) {
				const result = this.syncVideoView(this.requestedUid)
				this.reportBindError(result, this.requestedUid, 'bindVideo')
			}
		},
		NVBeforeUnload() {
			const result = this.clearBoundVideoView()
			if (result != 0) this.reportBindError(result, this.boundUid, 'unbindVideo')
			this.viewReady = false
		}
	}

	class RoundedVideoOutlineProvider extends ViewOutlineProvider {
		private radius : Float

		constructor(radius : Float) {
			super()
			this.radius = radius
		}

		override getOutline(view : View | null, outline : Outline | null) {
			if (view == null || outline == null) return
			outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), this.radius)
		}
	}
</script>

<style>
	.agora-video-view {
		width: 100%;
		height: 100%;
		background-color: #111827;
	}
</style>
