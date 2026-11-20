<template>
	<view class="page" :style="pageStyle">
		<view class="header">
			<view class="brand">
				<text class="brand-text">C</text>
			</view>
			<view class="header-text">
				<text class="title">环信 CallKit</text>
				<text class="subtitle">UniApp · agora-rtc 原生 UI</text>
			</view>
		</view>

		<!-- 登录 -->
		<view v-if="!loggedIn" class="card">
			<view class="field">
				<text class="label">App Key</text>
				<input class="input" v-model="appKey" placeholder="org#app" placeholder-style="color:#b3b8c6" />
			</view>
			<view class="field">
				<text class="label">用户 ID</text>
				<input class="input" v-model="userId" placeholder="user001" placeholder-style="color:#b3b8c6" />
			</view>
			<view class="field">
				<text class="label">Token</text>
				<!-- 环信 token 普遍超过 input 默认的 140 字符上限，必须放开 -->
				<input class="input" v-model="token" :maxlength="-1" placeholder="IM 登录 token（由服务端换取）"
					placeholder-style="color:#b3b8c6" />
			</view>
			<view class="field field-last">
				<text class="label">Agora AppId（兜底）</text>
				<input class="input" v-model="rtcAppId" placeholder="getRTCToken 未返回 appId 时使用"
					placeholder-style="color:#b3b8c6" />
			</view>

			<view class="btn btn-primary" hover-class="btn-pressed" @click="handleLogin">
				<text class="btn-text">{{ submitting ? '登录中…' : '登录' }}</text>
			</view>

			<view v-if="message" class="message" :class="messageType === 'info' ? 'message-info' : 'message-error'">
				<text class="message-text">{{ message }}</text>
			</view>
		</view>

		<!-- 呼叫 -->
		<view v-else class="card">
			<view class="user-row">
				<view class="avatar">
					<text class="avatar-text">{{ userInitial }}</text>
				</view>
				<view class="user-info">
					<text class="user-name">{{ userId }}</text>
					<text class="user-state">已登录 · 等待呼叫</text>
				</view>
			</view>

			<view class="divider" />

			<view class="field field-last">
				<text class="label">对方用户 ID</text>
				<input class="input" v-model="targetId" placeholder="user002" placeholder-style="color:#b3b8c6" />
			</view>

			<view class="btn-row">
				<view class="btn btn-row-item btn-row-first" hover-class="btn-pressed" @click="call(0)">
					<text class="btn-text">语音呼叫</text>
				</view>
				<view class="btn btn-row-item btn-row-last" hover-class="btn-pressed" @click="call(1)">
					<text class="btn-text">视频呼叫</text>
				</view>
			</view>

			<view class="divider divider-gap" />

			<view class="field field-last">
				<text class="label">群 ID（群聊音视频）</text>
				<input class="input" v-model="groupId" placeholder="groupId" placeholder-style="color:#b3b8c6" />
			</view>

			<view class="btn-row">
				<view class="btn btn-row-item btn-row-first btn-soft" hover-class="btn-pressed" @click="groupCall(0)">
					<text class="btn-text btn-text-soft">群语音</text>
				</view>
				<view class="btn btn-row-item btn-row-last btn-soft" hover-class="btn-pressed" @click="groupCall(1)">
					<text class="btn-text btn-text-soft">群视频</text>
				</view>
			</view>

			<view class="btn btn-ghost" hover-class="btn-ghost-pressed" @click="handleLogout">
				<text class="btn-text btn-text-ghost">退出登录</text>
			</view>

			<view v-if="message" class="message" :class="messageType === 'info' ? 'message-info' : 'message-error'">
				<text class="message-text">{{ message }}</text>
			</view>
		</view>

		<text class="tip">单聊直接输对方 ID；群聊输群 ID，会自动邀请全部群成员。</text>
	</view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { CALL_TYPE, getCallKit, inviteGroupCall, loginAndCreateCallKit, primeUserProfiles, logout } from '@/common/callkit'

const appKey = ref('1199260706209798#yueying')
const userId = ref('0003')
const token = ref('YWMtNhl0kOI1EfG18f2B8W0M7ZxwaMVuWUM6q8NEpfPAn3cWmPoghLQR8aYIK21s9YVSAwMAAAGh54EXJQAJOoCRW3lQiDNQg26H0Kr1sQr1LV0D2Zvf3xRyYBYkz9OKhA')
const rtcAppId = ref('')
const loggedIn = ref(false)
const targetId = ref('')
const groupId = ref('321298533253122')
const message = ref('')
const messageType = ref('error')
const submitting = ref(false)

function setMessage(text, type = 'error') {
	message.value = text
	messageType.value = type
}

/**
 * 自定义导航（pages.json 里 navigationStyle: custom）后页面会顶到状态栏下面，必须自己避让。
 * 不用 CSS 变量 --status-bar-height：它在部分基座/平台上取不到值，会让整条
 * `padding-top: calc(var(--status-bar-height) + 22px)` 失效，结果就是我之前遇到的被状态栏压住。
 * 这里直接问运行时：小程序优先用胶囊按钮位置（bottom 就是安全起点），其余平台用 statusBarHeight。
 */
function resolveTopInset() {
	try {
		if (typeof uni.getMenuButtonBoundingClientRect === 'function') {
			const menu = uni.getMenuButtonBoundingClientRect()
			if (menu && menu.bottom) return menu.bottom + 8
		}
	} catch (error) {
		// H5 / App 上没有胶囊，忽略
	}
	try {
		const info = uni.getSystemInfoSync()
		const statusBarHeight = Number(info && info.statusBarHeight) || 0
		// 状态栏高度之上再留 12px 呼吸位；H5 取不到时用 22px
		return statusBarHeight > 0 ? statusBarHeight + 12 : 22
	} catch (error) {
		return 22
	}
}

const pageStyle = { paddingTop: `${resolveTopInset()}px` }

const userInitial = computed(() => {
	const value = String(userId.value || '').trim()
	return value ? value.slice(-1).toUpperCase() : '?'
})

async function handleLogin() {
	if (submitting.value) return
	if (!appKey.value || !userId.value || !token.value) {
		setMessage('App Key、用户 ID、Token 都要填')
		return
	}
	submitting.value = true
	message.value = ''
	try {
		await loginAndCreateCallKit({
			appKey: appKey.value,
			userId: userId.value,
			token: token.value,
			defaultRtcAppId: rtcAppId.value || undefined
		})
		loggedIn.value = true
	} catch (error) {
		setMessage(String((error && error.message) || error))
	} finally {
		submitting.value = false
	}
}

async function call(callType) {
	const callkit = getCallKit()
	if (!callkit) return
	if (!targetId.value) {
		setMessage('请输入对方用户 ID')
		return
	}
	message.value = ''
	try {
		await primeUserProfiles([targetId.value])
		await callkit.core.inviteCall({
			calleeUserId: targetId.value,
			callType: callType === CALL_TYPE.VIDEO_1V1 ? CALL_TYPE.VIDEO_1V1 : CALL_TYPE.AUDIO_1V1
		})
	} catch (error) {
		setMessage(String((error && error.message) || error))
	}
}

async function handleLogout() {
	await logout()
	loggedIn.value = false
	message.value = ''
}

/**
 * 群聊呼叫：先拉群成员（排除自己），再交给 core.inviteGroupCall。
 * callType 只能传 VIDEO_MULTI(2) / AUDIO_MULTI(3)，传单聊枚举 core 会当成单聊处理。
 */
async function groupCall(callType) {
	const callkit = getCallKit()
	if (!callkit) return
	if (!groupId.value) {
		setMessage('请输入群 ID')
		return
	}
	setMessage('正在拉取群成员…', 'info')
	try {
		const count = await inviteGroupCall({
			groupId: groupId.value,
			callType: callType === 1 ? CALL_TYPE.VIDEO_MULTI : CALL_TYPE.AUDIO_MULTI
		})
		setMessage(`已邀请 ${count} 人`, 'info')
	} catch (error) {
		setMessage(String((error && error.message) || error))
	}
}
</script>

<style>
/*
 * 说明：App-vue / H5 下 `view` 默认是 block，`align-items` / `justify-content` 不生效，
 * 这正是之前按钮文字贴左上角的根因。下面所有容器都显式声明 flex。
 * 同时 text 只有作为 flex item 时 margin 才生效，所以 label / tip 都放在 flex 容器里。
 */
.page {
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	/* 用 min-height 而不是 flex:1：小屏（如 SE）上内容超高时页面仍可滚动，不会被裁掉 */
	min-height: 100vh;
	background-color: #f5f6fa;
	/* 自绘导航：真实顶部内边距由 :style 绑定（JS 读状态栏高度），这里只是兜底 */
	padding-top: 22px;
	padding-left: 20px;
	padding-right: 20px;
	padding-bottom: 28px;
	/* iPhone 底部 home indicator 别压住说明文字 */
	padding-bottom: calc(28px + env(safe-area-inset-bottom));
}

/* ---------- 头部 ---------- */
.header {
	display: flex;
	flex-direction: row;
	align-items: center;
	margin-bottom: 22px;
}

.brand {
	width: 44px;
	height: 44px;
	border-radius: 14px;
	background-color: #4d7cfe;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 12px;
}

.brand-text {
	font-size: 20px;
	font-weight: 700;
	color: #ffffff;
	line-height: 24px;
	text-align: center;
}

.header-text {
	display: flex;
	flex-direction: column;
	flex: 1;
}

.title {
	font-size: 22px;
	font-weight: 600;
	color: #171a22;
	line-height: 28px;
}

.subtitle {
	margin-top: 4px;
	font-size: 12px;
	color: #8a90a2;
	line-height: 16px;
}

/* ---------- 卡片 ---------- */
.card {
	display: flex;
	flex-direction: column;
	background-color: #ffffff;
	border-radius: 16px;
	padding: 20px 18px;
	box-shadow: 0 8px 24px rgba(23, 26, 34, 0.06);
}

/* ---------- 表单 ---------- */
.field {
	display: flex;
	flex-direction: column;
	margin-bottom: 16px;
}

.field-last {
	margin-bottom: 0;
}

.label {
	font-size: 12px;
	color: #8a90a2;
	margin-bottom: 8px;
	line-height: 16px;
}

.input {
	display: block;
	box-sizing: border-box;
	width: 100%;
	height: 44px;
	padding: 0 14px;
	border-radius: 10px;
	background-color: #f3f5f9;
	font-size: 14px;
	color: #171a22;
}

/* ---------- 按钮 ---------- */
.btn {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	width: 100%;
	height: 46px;
	border-radius: 23px;
	background-color: #4d7cfe;
}

.btn-primary {
	margin-top: 20px;
}

.btn-pressed {
	opacity: 0.86;
}

.btn-ghost {
	margin-top: 12px;
	background-color: #ffffff;
	border-width: 1px;
	border-style: solid;
	border-color: #e3e6ef;
}

/* 群聊按钮用浅色底，和单聊的实心主按钮区分开 */
.btn-soft {
	background-color: rgba(77, 124, 254, 0.12);
}

.btn-text-soft {
	color: #4d7cfe;
}

.btn-ghost-pressed {
	background-color: #f3f5f9;
}

.btn-text {
	font-size: 15px;
	font-weight: 500;
	color: #ffffff;
	line-height: 20px;
	text-align: center;
}

.btn-text-ghost {
	color: #6b7285;
}

.btn-row {
	display: flex;
	flex-direction: row;
	margin-top: 18px;
}

/* row 里的按钮不能保留 width:100%，否则会各占满一行 */
.btn-row-item {
	width: auto;
	flex: 1;
}

.btn-row-first {
	margin-right: 6px;
}

.btn-row-last {
	margin-left: 6px;
}

/* ---------- 已登录信息 ---------- */
.user-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	margin-bottom: 18px;
}

.avatar {
	width: 44px;
	height: 44px;
	border-radius: 22px;
	background-color: rgba(77, 124, 254, 0.12);
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 12px;
}

.avatar-text {
	font-size: 16px;
	font-weight: 600;
	color: #4d7cfe;
	line-height: 20px;
	text-align: center;
}

.user-info {
	display: flex;
	flex-direction: column;
	flex: 1;
}

.user-name {
	font-size: 16px;
	font-weight: 600;
	color: #171a22;
	line-height: 22px;
}

.user-state {
	margin-top: 2px;
	font-size: 12px;
	color: #8a90a2;
	line-height: 16px;
}

.divider {
	height: 1px;
	background-color: #eef0f5;
	margin-bottom: 18px;
}

/* 单聊 / 群聊两块之间的分隔线 */
.divider-gap {
	margin-top: 22px;
}

/* ---------- 提示 ---------- */
.message {
	display: flex;
	flex-direction: row;
	align-items: center;
	margin-top: 14px;
	padding: 10px 12px;
	border-radius: 10px;
	background-color: #fff1f0;
}

.message-info {
	background-color: rgba(77, 124, 254, 0.08);
}

.message-error {
	background-color: #fff1f0;
}

.message-text {
	font-size: 12px;
	color: #ff3b30;
	line-height: 18px;
}

.message-info .message-text {
	color: #4d7cfe;
}

.tip {
	/* margin-top: auto 在大屏上把说明压到底部，小屏时至少保留 20px 间距 */
	margin-top: auto;
	padding-top: 20px;
	font-size: 12px;
	color: #a2a7b5;
	line-height: 18px;
	text-align: center;
}
</style>
