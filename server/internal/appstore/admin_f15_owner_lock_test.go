package appstore

// F-15（能力中心审计 2026-10-26，P2）：归属转移必须与发布内核**串行**。
//
// 缺陷现场：`Publish` 在持发布咨询锁的事务里读 `apps.owner` 决定「谁能续传
// 新版本」；而 `transferOwner` 修前是锁外单语句 UPDATE。两者交错时，旧归属人
// 可以在转移提交前那一刻通过 owner 检查、在提交后落库 —— 「新归属人已被指定，
// 旧归属人却替新归属人发了一版」，归属语义被绕过。
//
// 修后：transferOwner 在**同一个事务**里先取与 Publish 相同的发布咨询锁
// （`publishLockKey` 的 64 位 hashtextextended 键）、锁内重读 apps 行、再写。
//
// 本用例是可判定的（不需要制造真实竞态）：测试自己先用一条事务**持住**发布锁，
// 再调 transferOwner —— 它必须阻塞到锁释放；释放后必须成功并真的改掉 owner。
// 变异验证：把 withPublishLockForOwner 里的 advisory lock 去掉 ⇒ 第一条判据
// （300ms 内返回）立即红。

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func TestTransferOwnerSerializesWithPublishLock(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	const appID = "lock-demo"
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: appID, Title: "锁演示",
		Description: "F-15 夹具", Owner: "alice", Channel: serverstore.AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("夹具 apps 行: %v", err)
	}
	for _, u := range []string{"alice", "bob"} {
		if _, err := serverstore.CreateUserWithPassword(db, u, "pw123456"); err != nil {
			t.Fatalf("夹具用户 %s: %v", u, err)
		}
	}

	// ① 测试自己持住发布锁（与 Publish 同一把键）。
	holder, err := db.Begin()
	if err != nil {
		t.Fatalf("持锁事务: %v", err)
	}
	if _, err := holder.Exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		publishLockKey(serverstore.AppKindSkill, appID)); err != nil {
		_ = holder.Rollback()
		t.Fatalf("取发布锁: %v", err)
	}

	gin.SetMode(gin.TestMode)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("POST", "/api/server/admin/apps/skill/"+appID+"/owner",
			strings.NewReader(`{"owner":"bob"}`))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = gin.Params{{Key: "kind", Value: serverstore.AppKindSkill}, {Key: "app_id", Value: appID}}
		transferOwner(db)(c)
		done <- w
	}()

	// ② 锁被占用期间，转移必须**不**完成（修前会在毫秒级完成 —— 这就是竞态窗口）。
	select {
	case w := <-done:
		_ = holder.Rollback()
		t.Fatalf("持锁期间 transferOwner 就返回了（%d %s）：归属转移没有参与发布锁，"+
			"旧归属人可在转移提交前通过 owner 检查、提交后落库（F-15）",
			w.Code, w.Body.String())
	case <-time.After(300 * time.Millisecond):
	}

	// ③ 释放锁后必须完成并真正改掉 owner。
	if err := holder.Rollback(); err != nil {
		t.Fatalf("释放持锁事务: %v", err)
	}
	select {
	case w := <-done:
		if w.Code != 200 {
			t.Fatalf("transferOwner = %d %s, want 200", w.Code, w.Body.String())
		}
		var env struct {
			Owner string `json:"owner"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
			t.Fatalf("响应不是 JSON: %v", err)
		}
		app, err := serverstore.GetApp(db, serverstore.AppKindSkill, appID)
		if err != nil {
			t.Fatalf("读回 apps 行: %v", err)
		}
		if app.Owner != "bob" {
			t.Fatalf("归属 = %q, want bob（转移没有生效）", app.Owner)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("释放发布锁后 transferOwner 仍未完成（锁泄漏？）")
	}
}
