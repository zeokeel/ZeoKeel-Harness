package serverstore

// F-04 + F-01 的 DAO 级回归(能力中心审计 2026-10-26)。
//
// F-04:目录投影(apps.title/description)此前用 `ORDER BY id DESC` 选"生效版本",
// 而交付面(GetSkill / CurrentMarketReleaseFor → currentRelease)用"semver 最大的
// approved"。两者分叉的现场:先批准 v2.0.0、后补发批准 v1.9.0(旧版本走审批补录),
// 于是 id 更大的是 v1.9.0 ⇒ 目录标题/描述显示 v1.9.0,员工下载到的是 v2.0.0。
// 修法:投影复用 PickCurrentRelease(与交付同一个判定函数),不再自己写一条 SQL。
//
// F-01:DeleteReleaseUnlessApproved 是产品「删除版本」入口的唯一判定 ——
// approved ⇒ ErrReleaseApprovedNotDeletable(调用方 409),pending/rejected ⇒ 删除。
// SoftDeleteRelease(通用原语)刻意保持原语义,不在此判据里。

import (
	"errors"
	"testing"
)

func approvedRelease(kind, appID, version, title string) *Release {
	return &Release{Kind: kind, AppID: appID, Version: version, Title: title,
		Description: title + " 描述", Author: "alice", Publisher: "alice",
		Checksum: "sum-" + version, Archive: []byte("archive-" + version),
		Status: ReleaseStatusApproved}
}

func TestRecomputeProjectionPicksSemverHighestApproved(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	const appID = "out-of-order"
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: appID, Title: appID,
		Channel: AppChannelMarket, Owner: "alice", Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	// 乱序入库:先 approved v2.0.0(id 小),再补发 approved v1.9.0(id 大)。
	if _, err := CreateRelease(db, approvedRelease(AppKindSkill, appID, "2.0.0", "v2 标题")); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateRelease(db, approvedRelease(AppKindSkill, appID, "1.9.0", "v1.9 标题")); err != nil {
		t.Fatal(err)
	}

	version, err := RecomputeAppProjection(db, AppKindSkill, appID)
	if err != nil {
		t.Fatal(err)
	}
	if version != "2.0.0" {
		t.Fatalf("投影生效版本 = %q, want semver 最大的 2.0.0(修前按 id DESC 得到 1.9.0)", version)
	}
	app, err := GetApp(db, AppKindSkill, appID)
	if err != nil {
		t.Fatal(err)
	}
	if app.Title != "v2 标题" || app.Description != "v2 标题 描述" {
		t.Fatalf("投影 = %q/%q, want v2 标题/v2 标题 描述(投影与交付必须同口径)",
			app.Title, app.Description)
	}
	// 与交付面同口径:下载/详情走的就是这个版本。
	cur, err := CurrentMarketReleaseFor(db, AppKindSkill, appID, false)
	if err != nil {
		t.Fatal(err)
	}
	if cur == nil || cur.Version != version {
		t.Fatalf("交付版本 = %+v, 投影版本 = %q —— 两口径必须一致", cur, version)
	}

	// 更高版本的 pending 不参与投影(待审不生效)。
	pending := approvedRelease(AppKindSkill, appID, "3.0.0", "v3 待审标题")
	pending.Status = ReleaseStatusPending
	if _, err := CreateRelease(db, pending); err != nil {
		t.Fatal(err)
	}
	version, err = RecomputeAppProjection(db, AppKindSkill, appID)
	if err != nil {
		t.Fatal(err)
	}
	if version != "2.0.0" {
		t.Fatalf("pending 版本参与了投影: %q", version)
	}
	if app, _ = GetApp(db, AppKindSkill, appID); app.Title != "v2 标题" {
		t.Fatalf("pending 版本改动了投影: %q", app.Title)
	}

	// 没有任何 approved 版本(全部被拒/软删)⇒ 回落 app_id 占位。
	if err := SetReleaseStatus(db, AppKindSkill, appID, "2.0.0", ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatal(err)
	}
	if err := SetReleaseStatus(db, AppKindSkill, appID, "1.9.0", ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatal(err)
	}
	version, err = RecomputeAppProjection(db, AppKindSkill, appID)
	if err != nil {
		t.Fatal(err)
	}
	if version != "" {
		t.Fatalf("没有 approved 版本时应返回空版本号, got %q", version)
	}
	if app, _ = GetApp(db, AppKindSkill, appID); app.Title != appID {
		t.Fatalf("无 approved 版本时投影应回落 app_id 占位, got %q", app.Title)
	}
}

func TestDeleteReleaseUnlessApproved(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	const appID = "delete-guard"
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: appID, Title: appID,
		Channel: AppChannelOrg, Owner: "alice", Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateRelease(db, approvedRelease(AppKindSkill, appID, "1.0.0", "已通过")); err != nil {
		t.Fatal(err)
	}
	pending := approvedRelease(AppKindSkill, appID, "1.1.0", "待审")
	pending.Status = ReleaseStatusPending
	if _, err := CreateRelease(db, pending); err != nil {
		t.Fatal(err)
	}

	// approved ⇒ sentinel(调用方 409),行与归档必须原样保留。
	err := DeleteReleaseUnlessApproved(db, AppKindSkill, appID, "1.0.0")
	if !errors.Is(err, ErrReleaseApprovedNotDeletable) {
		t.Fatalf("删除 approved = %v, want ErrReleaseApprovedNotDeletable", err)
	}
	r, gerr := GetRelease(db, AppKindSkill, appID, "1.0.0")
	if gerr != nil {
		t.Fatalf("approved 版本被删了: %v", gerr)
	}
	if r.DeletedAt != nil || len(r.Archive) == 0 || r.Status != ReleaseStatusApproved {
		t.Fatalf("approved 版本被破坏: %+v", r)
	}

	// pending ⇒ 允许删除,归档随 deleted_at 一起清空。
	if err := DeleteReleaseUnlessApproved(db, AppKindSkill, appID, "1.1.0"); err != nil {
		t.Fatalf("删除 pending = %v, want nil", err)
	}
	if r, gerr := GetRelease(db, AppKindSkill, appID, "1.1.0"); gerr != nil || r.DeletedAt == nil {
		t.Fatalf("pending 未被软删: %+v err=%v", r, gerr)
	}

	// 不存在 ⇒ ErrNotFound(与 approved 的 409 区分开)。
	if err := DeleteReleaseUnlessApproved(db, AppKindSkill, appID, "9.9.9"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除不存在版本 = %v, want ErrNotFound", err)
	}
}
