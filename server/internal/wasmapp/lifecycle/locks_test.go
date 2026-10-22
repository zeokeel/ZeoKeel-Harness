package lifecycle_test

// 应用数据目录互斥（2026-10-22 反证 P2：导出/快照与真删无文件级互斥）。
//
// 判据不是"锁对象存在"，而是**删目录真的会等**：先手动持有同一把锁，RemoveAppData
// 必须阻塞；解锁后才能完成。变异：去掉 RemoveAppData 里的 LockAppData ⇒ 本用例红。

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/lifecycle"
)

func TestRemoveAppDataWaitsForAppDataLock(t *testing.T) {
	root := t.TempDir()
	appID := "locked-app"
	dir := filepath.Join(root, "apps", appID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.db"), []byte("x"), 0o600); err != nil {
		t.Fatalf("写文件: %v", err)
	}

	unlock := lifecycle.LockAppData(root, appID)
	done := make(chan error, 1)
	go func() {
		_, err := lifecycle.RemoveAppData(root, appID)
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("持锁期间 RemoveAppData 不应完成（err=%v）", err)
	case <-time.After(100 * time.Millisecond):
		// 正期望：被锁挡住。
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("解锁后 RemoveAppData: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("解锁后 RemoveAppData 仍未完成（锁未释放/未使用同一把锁）")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("解锁后目录应被删除，stat err=%v", err)
	}
}

// TestAppDataLockIsPerApp：不同应用不互相阻塞（否则一个慢导出会卡住所有应用）。
func TestAppDataLockIsPerApp(t *testing.T) {
	root := t.TempDir()
	unlockA := lifecycle.LockAppData(root, "app-a")
	defer unlockA()
	unlockB := lifecycle.LockAppData(root, "app-b")
	unlockB() // 不阻塞即通过
}
