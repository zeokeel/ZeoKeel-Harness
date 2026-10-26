package sharedskills

// F-41（能力中心审计 2026-10-26，P3）：两个上传面的 `version` 字段同口径 ——
// **只校验形状，版本以包内为准**（包内即真相）。
//
// 修前：智能体侧校验形状后忽略（包内 version 生效），技能侧**完全不校验** ——
// 同一份客户端在两个上传面得到不同待遇：`{"version":"garbage"}` 在技能侧静默
// 成功、在智能体侧 400；而 `{"version":"9.9.9"}`（形状合法但与包内 1.0.0 不同）
// 两面都忽略该字段（旧客户端硬编码 1.0.0 是历史原因，不能因形状合法就拒绝）。
//
// 判据：
//  1. 形状非法 ⇒ 400 INVALID_VERSION（修前 201）；
//  2. 形状合法但与包内不一致 ⇒ 201，且落库版本 = 包内版本（不是请求里的）。
//
// 变异验证：删掉 upload() 里的 IsVersion 校验 ⇒ 判据 1 收到 201 变红。

import (
	"net/http"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func TestUploadVersionFieldIsShapeValidatedOnly(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	// ① 非法形状 ⇒ 400（修前技能侧完全不看这个字段）。
	rawBad := makeSkillArchive(t, map[string]string{
		"SKILL.md": skillMdCustom("ver-shape", "1.0.0", "版本形状", "用于校验 version 字段形状的技能包描述。"),
	})
	w := sharedskillsDo(r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("ver-shape", "garbage", "版本形状", rawBad))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法 version 形状 = %d, want 400（F-41：技能侧修前会静默接受）; body=%s",
			w.Code, w.Body.String())
	}

	// ② 合法形状但与包内不同 ⇒ 201，落库版本以包内为准。
	rawOK := makeSkillArchive(t, map[string]string{
		"SKILL.md": skillMdCustom("ver-mismatch", "1.0.0", "版本以包内为准", "用于校验版本字段被忽略的技能包描述。"),
	})
	w = sharedskillsDo(r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("ver-mismatch", "9.9.9", "版本以包内为准", rawOK))
	if w.Code != http.StatusCreated {
		t.Fatalf("形状合法但版本不一致 = %d, want 201（包内即真相：该字段被忽略）; body=%s",
			w.Code, w.Body.String())
	}
	if _, err := serverstore.GetSharedSkill(db, "ver-mismatch", "1.0.0"); err != nil {
		t.Fatalf("落库版本不是包内版本 1.0.0: %v", err)
	}
	if _, err := serverstore.GetSharedSkill(db, "ver-mismatch", "9.9.9"); err == nil {
		t.Fatal("请求体里的 version(9.9.9) 被当成了真实版本 —— 与「包内即真相」矛盾（F-41）")
	}
}
