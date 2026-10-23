package telemetry

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// withLimits 设置限流阈值(写入该用例的临时库 —— 阈值现由 deployconfig 从
// settings 解析)并换一个干净的限流桶(限流器是进程级共享,用户 id 每个临时库
// 都从 1 开始,不清会跨用例互相挤占预算)。
func withLimits(t *testing.T, db *sql.DB, perUser, perSkill int) {
	t.Helper()
	for key, val := range map[string]int{
		"telemetry.max_per_min":           perUser,
		"telemetry.max_per_skill_per_min": perSkill,
	} {
		if err := serverstore.SetSetting(db, key, strconv.Itoa(val)); err != nil {
			t.Fatalf("写限流设置 %s: %v", key, err)
		}
	}
	prevLimiter := skillCallLimiter
	skillCallLimiter = newCallLimiter(time.Minute)
	t.Cleanup(func() { skillCallLimiter = prevLimiter })
}

// P2-20 回归:同一用户超过每分钟上限后 429,且不再累加 calls(刷榜无效)。
// srvcore-2 起写侧要求计数目标对调用者可见,故先把技能授权给 alice ——
// 本用例考的是限流,不是授权。
func TestSkillCallRateLimitedPerUser(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, db, 2, 100)
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "codeql", Version: "1.0.0", Enabled: 1, Archive: []byte("pkg")}); err != nil {
		t.Fatal(err)
	}
	grantSkill(t, db, "codeql", "alice")

	for i := 0; i < 2; i++ {
		if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
			t.Fatalf("call %d = %d %s", i+1, w.Code, w.Body.String())
		}
	}
	w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd call = %d, want 429", w.Code)
	}
	if !strings.Contains(w.Body.String(), "RATE_LIMITED") {
		t.Fatalf("429 body = %s, want RATE_LIMITED envelope", w.Body.String())
	}
	s, err := serverstore.GetSkill(db, "codeql")
	if err != nil {
		t.Fatal(err)
	}
	if s.Calls != 2 {
		t.Fatalf("calls = %d, want 2 (rate-limited report must not count)", s.Calls)
	}
}

// 单技能桶:同一技能反复上报受限,其他技能不受影响(防单 App 刷票)。
func TestSkillCallRateLimitedPerSkill(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, db, 100, 1)
	for _, name := range []string{"skill-a", "skill-b"} {
		if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: name, Version: "1.0.0", Enabled: 1, Archive: []byte("pkg")}); err != nil {
			t.Fatal(err)
		}
		grantSkill(t, db, name, "alice")
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"skill-a"}`); w.Code != http.StatusOK {
		t.Fatalf("skill-a first = %d", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"skill-a"}`); w.Code != http.StatusTooManyRequests {
		t.Fatalf("skill-a second = %d, want 429", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"skill-b"}`); w.Code != http.StatusOK {
		t.Fatalf("skill-b first = %d, want 200 (per-skill bucket)", w.Code)
	}
}

// 限流按用户隔离:一个账号被限不影响其他账号。
func TestSkillCallRateLimitIsPerUser(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, db, 1, 100)
	uid2, err := serverstore.CreateUserWithPassword(db, "bob", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	token2, err := serverauth.IssueToken(db, uid2)
	if err != nil {
		t.Fatal(err)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
		t.Fatalf("alice first = %d", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusTooManyRequests {
		t.Fatalf("alice second = %d, want 429", w.Code)
	}
	if w := post(r, token2, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
		t.Fatalf("bob first = %d, want 200 (per-user bucket)", w.Code)
	}
}

// 非法请求不消耗上报预算(限流在校验之后)。
func TestSkillCallInvalidRequestDoesNotConsumeBudget(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, db, 1, 100)
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"a/b"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid name = %d, want 400", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
		t.Fatalf("valid call after invalid = %d, want 200", w.Code)
	}
}

// 阈值现由 deployconfig 解析:环境变量仍压过控制台保存的设置(存量 .env 的
// 升级安全 —— 优先级翻成"库优先"会让老部署的行为静默变化)。
func TestSkillCallLimitEnvOverridesSetting(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, db, 1, 1) // 控制台:每用户/每技能各 1 次
	t.Setenv(deployconfig.MustKey("telemetry.max_per_min").Env, "100")
	t.Setenv(deployconfig.MustKey("telemetry.max_per_skill_per_min").Env, "100")
	for i := 0; i < 3; i++ {
		if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
			t.Fatalf("第 %d 次上报 = %d, want 200(环境变量必须压过控制台设置)", i+1, w.Code)
		}
	}
}
