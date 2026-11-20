<script>
import { logout } from '@/common/callkit'

export default {
	onLaunch() {
		console.log('[demo] launch')
	},
	onExit() {
		// 进程退出前尽量释放 RTC / IM，避免下次冷启动拿到脏会话
		logout().catch(() => {})
	}
}
</script>

<style>
page {
	background-color: #f6f7fb;
}
</style>
