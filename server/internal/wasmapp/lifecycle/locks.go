package lifecycle

// 应用数据目录的**进程内互斥**（2026-10-22 反证 P2：导出/快照与真删无文件级互斥）。
//
// 为什么需要：`Snapshot` 往 `<apps>/<app_id>/snapshots/...` 写文件、`ExportZip` 读
// `app.db`/资源、`RemoveAppData` 整目录删除 —— 三者都直接碰同一棵目录。DB 层的
// `purged_at` 只保证"终态"在 restore 侧可见，**不**阻止一个已经在途的导出/快照在
// 删除发生时读到半截文件。单实例部署（R20）下，进程内 keyed mutex 就能把这三条路径
// 串起来；多实例前需要换成分布式锁/租约（已在生产化文档记录）。
//
// 键 = dataRoot + app_id：测试会为每个用例建独立数据根，只按 app_id 会让不同根的
// 同名应用互相阻塞（不影响正确性，但会让并发用例假死/变慢）。
//
// 不做的清理：条目数 ≤ 历史上出现过的应用数（有界），与 queue 的 rejectedByApp 同
// 口径；不为几 KB 的 map 引入引用计数（那会让"持锁期间崩溃"变成泄漏）。

import "sync"

var exportAppLocks sync.Map // map[string]*sync.Mutex

// appDataLockKey 返回某应用数据目录的锁键。
func appDataLockKey(dataRoot, appID string) string { return dataRoot + "\x00" + appID }

// LockAppData 获取某应用数据目录的进程内锁，返回解锁函数。
//
// 导出给 api 层与测试：zip 导出在 lifecycle 内部已经加锁；外部若需要在"读目录"的
// 自定义路径上串行，可复用同一把锁（同键）。
func LockAppData(dataRoot, appID string) func() {
	key := appDataLockKey(dataRoot, appID)
	actual, _ := exportAppLocks.LoadOrStore(key, &sync.Mutex{})
	mu := actual.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}
