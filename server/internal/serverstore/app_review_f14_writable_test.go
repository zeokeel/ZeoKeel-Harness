package serverstore

// F-14(能力中心审计 2026-10-26,P1):下架冻结不能再是 check-then-act。
//
// 缺陷现场:审核路径先读 Distribution.Writable()(下架?)、再调
// SetReleaseStatusForReview(只判归档与退役)。两次读之间管理员按下「下架」时,
// approve 仍然通过 —— 产出「已批准但任何人(含作者)都看不见」的版本,正是
// R5-B-1 要消除的形态。
//
// 修法:技能/智能体审核走 SetReleaseStatusForReviewIfWritable —— 下架冻结写进
// 同一条 UPDATE 的 WHERE(`AND apps.enabled = 1`),由行锁 + EPQ 串行化。
//
// 本文件钉住三件事:
//  1. 下架期间 approve ⇒ ErrAppDelisted,版本仍是 pending(没有偷偷通过);
//  2. 重新上架后同一个版本可以正常通过(冻结可逆,不是永久拒绝);
//  3. reject 在下架期间仍然允许(清理待审队列不是分发动作)—— 且基础版
//     SetReleaseStatusForReview 的语义不变(WASM 应用走它,不受 F-14 影响)。

import (
	"errors"
	"testing"
)

func TestReviewApproveIfWritableRejectsDelistedAtomically(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	const appID = "f14-delisted"
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: appID, Title: appID,
		Channel: AppChannelOrg, Owner: "alice", Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateRelease(db, &Release{Kind: AppKindSkill, AppID: appID, Version: "1.0.0",
		Title: "待审", Publisher: "alice", Checksum: "sum", Archive: []byte("zip"),
		Status: ReleaseStatusPending}); err != nil {
		t.Fatal(err)
	}
	// 管理员下架(内容冻结)。
	if err := SetAppEnabled(db, AppKindSkill, appID, false); err != nil {
		t.Fatal(err)
	}

	// 判据 1:下架期间 approve ⇒ ErrAppDelisted,版本不被偷偷通过。
	err := SetReleaseStatusForReviewIfWritable(db, AppKindSkill, appID, "1.0.0", ReleaseStatusApproved, "")
	if !errors.Is(err, ErrAppDelisted) {
		t.Fatalf("下架期间 approve = %v, want ErrAppDelisted", err)
	}
	rel, gerr := GetRelease(db, AppKindSkill, appID, "1.0.0")
	if gerr != nil {
		t.Fatal(gerr)
	}
	if rel.Status != ReleaseStatusPending {
		t.Fatalf("被冻结的版本状态被改成了 %s", rel.Status)
	}

	// 基础版语义刻意不变(WASM 应用走它,不受 F-14 影响)。
	if err := SetReleaseStatusForReview(db, AppKindSkill, appID, "1.0.0", ReleaseStatusApproved, ""); err != nil {
		t.Fatalf("基础版 SetReleaseStatusForReview 不应受下架影响(WASM 语义): %v", err)
	}

	// 判据 2:重新上架后可以正常通过(冻结可逆,不是永久拒绝)。
	if err := SetAppEnabled(db, AppKindSkill, appID, true); err != nil {
		t.Fatal(err)
	}
	if err := SetReleaseStatusForReviewIfWritable(db, AppKindSkill, appID, "1.0.0", ReleaseStatusApproved, ""); err != nil {
		t.Fatalf("重新上架后 approve = %v, want nil", err)
	}

	// 判据 3:下架期间 reject 仍然允许(清理待审队列不是分发动作)。
	const appID2 = "f14-reject-while-delisted"
	if err := UpsertApp(db, &App{Kind: AppKindAgent, AppID: appID2, Title: appID2,
		Channel: AppChannelOrg, Owner: "bob", Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateRelease(db, &Release{Kind: AppKindAgent, AppID: appID2, Version: "1.0.0",
		Publisher: "bob", Checksum: "s2", Archive: []byte("zip2"), Status: ReleaseStatusPending}); err != nil {
		t.Fatal(err)
	}
	if err := SetAppEnabled(db, AppKindAgent, appID2, false); err != nil {
		t.Fatal(err)
	}
	if err := SetReleaseStatusForReviewIfWritable(db, AppKindAgent, appID2, "1.0.0",
		ReleaseStatusRejected, "下架期间清理队列"); err != nil {
		t.Fatalf("下架期间 reject = %v, want nil", err)
	}
}
