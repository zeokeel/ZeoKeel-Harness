package appstore

// F-46（能力中心审计 2026-10-26，P3）：60s 事务预算超时**不能**再被说成
// 「同名内容正在发布，排队超时」。
//
// 修前两种超时共用一个码 PUBLISH_BUSY：
//   · 抢锁失败（同名发布排队）⇒ 503 PUBLISH_BUSY —— 文案正确；
//   · 已进入落库事务、整体超出 publishTxBudget ⇒ 也回 503 PUBLISH_BUSY ——
//     文案指向**另一个原因**（排队），管理员会去等队列，而真正的问题是本次
//     发布的归档落库/DB 抖动。
//
// 现在 enter 落库事务之后的超时统一映射成 503 PUBLISH_TIMEOUT，并在消息里
// 明确「与同名排队无关」。本文件是这条映射的判据（不依赖 DB：分类函数只读 ctx）。

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestClassifyTxErrMapsBudgetTimeoutToPublishTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 模拟事务期间 ctx 到期（publishTxBudget 用尽）

	perr := asPublishErr(t, classifyTxErr(ctx, context.DeadlineExceeded))
	if perr.Status != http.StatusServiceUnavailable {
		t.Fatalf("超时状态码 = %d, want 503", perr.Status)
	}
	if perr.Code != CodePublishTimeout {
		t.Fatalf("超时错误码 = %q, want %q（F-46：不能与 PUBLISH_BUSY 混用）",
			perr.Code, CodePublishTimeout)
	}
	if perr.Code == CodePublishBusy {
		t.Fatal("超时仍映射到 PUBLISH_BUSY —— 文案会把管理员引向「排队」这个错因")
	}
	if perr.Message == "" || !containsAll(perr.Message, "超时", "同名") {
		t.Fatalf("超时消息必须点明「超时」且澄清与同名排队无关, 实际 = %q", perr.Message)
	}

	// 真·服务器错误仍是 500 INTERNAL（不能被超时映射吞掉）。
	other := asPublishErr(t, classifyTxErr(context.Background(), errors.New("connection reset by peer")))
	if other.Status != http.StatusInternalServerError || other.Code != "INTERNAL" {
		t.Fatalf("非超时错误 = %+v, want 500 INTERNAL", other)
	}
}

// asPublishErr 把 classifyTxErr 的返回值还原成结构化错误（返回类型是 error）。
func asPublishErr(t *testing.T, err error) *Error {
	t.Helper()
	if err == nil {
		t.Fatal("classifyTxErr 返回 nil")
	}
	var perr *Error
	if !errors.As(err, &perr) {
		t.Fatalf("classifyTxErr 返回的不是 *Error: %T %v", err, err)
	}
	return perr
}

// containsAll 是 strings.Contains 的"全部命中"版本（本文件只用于消息断言）。
func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		found := false
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
