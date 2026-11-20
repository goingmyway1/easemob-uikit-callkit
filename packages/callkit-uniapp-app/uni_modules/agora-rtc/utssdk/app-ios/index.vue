<template>
	<view class="agora-video-view"></view>
</template>

<script lang="uts">
	import { UIView, UIColor } from 'UIKit'
	import { CGAffineTransformMakeTranslation, CGAffineTransformIdentity } from 'CoreGraphics'
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
			// Android 可选 texture；iOS 原生 UIView 无需区分渲染容器。
			renderType: {
				type: String,
				default: 'surface'
			},
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
			 * 由 nvue 宿主显式调用。NVLoaded 前仅保存请求，加载完成后重放；
			 * 相同 UID/renderMode 重复绑定直接成功，避免重复创建原生 Canvas。
			 */
			bindVideo(uid : number) : number {
				if (uid < 0 || uid > 2147483647 || uid % 1 != 0) return -2
				this.requestedUid = uid
				this.hasBindRequest = true
				const result = this.syncVideoView(uid)
				this.reportBindError(result, uid, 'bindVideo')
				return result
			},
			// 视图尚未加载时返回 0 表示绑定请求已排队；其余非 0 值均为原生错误码。
			syncVideoView(uid : number) : number {
				if (uid < 0 || uid > 2147483647 || uid % 1 != 0) return -2
				if (this.renderType != 'surface' && this.renderType != 'texture') return -2
				if (!this.viewReady) return 0
				if (this.hasBound && this.boundUid == uid && this.boundRenderMode == this.renderMode) return 0
				if (this.hasBound) {
					const clearResult = this.clearBoundVideoView()
					if (clearResult != 0) return clearResult
				}
				const result = setupVideoView(this.$el, uid, this.renderMode)
				this.hasBound = result == 0
				if (this.hasBound) {
					this.boundUid = uid
					this.boundRenderMode = this.renderMode
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
			// iOS nvue 调用组件方法时 JS 可能只收到 null，真实错误必须通过事件回传。
			reportBindError(result : number, uid : number, operation : string) {
				if (result == 0) return
				const detail = { code: result, uid: uid, operation: operation } as UTSJSONObject
				this.$emit('bind-error', detail.toMap())
			},
			/** 使用组件记录的 boundUid 解绑，不依赖可能已经变化的 uid prop。 */
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
			setDragTranslation(dx : number, dy : number) {
				const container = this.findDragContainer()
				container.transform = CGAffineTransformMakeTranslation(dx.doubleValue, dy.doubleValue)
			},
			clearDragTranslation() {
				const container = this.findDragContainer()
				container.transform = CGAffineTransformIdentity
			},
			/**
			 * 向上找到与小窗同尺寸的最外层容器，整体移动视频、占位层和手势层。
			 * 遇到尺寸不同的父级（例如整页根容器）立即停止。
			 */
			findDragContainer() : UIView {
				const videoView : UIView = this.$el
				var current : UIView = videoView
				var level = 0
				while (level < 6) {
					const parent = current.superview
					if (parent == null) return current
					const container = parent!
					const widthDiff = container.bounds.width - current.bounds.width
					const heightDiff = container.bounds.height - current.bounds.height
					if (widthDiff > 2 || widthDiff < -2 || heightDiff > 2 || heightDiff < -2) return current
					current = container
					level += 1
				}
				return current
			}
		},
		NVLoad() : UIView {
			const view = new UIView()
			view.backgroundColor = UIColor.black
			if (this.cornerRadius > 0) {
				view.layer.cornerRadius = this.cornerRadius.doubleValue
				view.layer.masksToBounds = true
			}
			return view
		},
		NVLoaded() {
			this.viewReady = true
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
</script>

<style>
	.agora-video-view {
		width: 100%;
		height: 100%;
		background-color: #111827;
	}
</style>
