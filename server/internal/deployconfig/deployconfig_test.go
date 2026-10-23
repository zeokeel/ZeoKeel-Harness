package deployconfig

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// newDeployTestDB 打开一个真实的 PG 测试库（无 PG 环境自动 skip，与全仓约定一致）。
func newDeployTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	return db
}

func setSetting(db *sql.DB, key, value string) error {
	return serverstore.SetSetting(db, key, value)
}

// TestRegistryIntegrity 是注册表的**自证**：注册表是"唯一真源"，它自己先得不自相矛盾。
//
// 这些断言看起来琐碎，但它们对应的是真实发生过的缺陷类：
//   - 同一个 settings 键声明两次 ⇒ 两个调用点读到两个默认值；
//   - 环境变量名拼错（不以 ZEOKEEL_ 开头 / 与历史代码不一致）⇒ 存量部署的覆盖静默失效；
//   - 默认值自身非法（例如 duration 写成 "1 hour"）⇒ Resolve 每次回落空串，旋钮变成隐形；
//   - choice 的默认值不在候选中 ⇒ 控制台下拉框显示不出当前值。
func TestRegistryIntegrity(t *testing.T) {
	settings := map[string]bool{}
	envs := map[string]bool{}
	for _, k := range registry {
		if k.Setting == "" || k.Env == "" || k.Title == "" || k.Description == "" || k.Category == "" {
			t.Fatalf("注册项字段不全：%+v", k)
		}
		if settings[k.Setting] {
			t.Fatalf("settings 键重复：%s", k.Setting)
		}
		settings[k.Setting] = true
		if envs[k.Env] {
			t.Fatalf("环境变量名重复：%s", k.Env)
		}
		envs[k.Env] = true
		if !strings.HasPrefix(k.Env, "ZEOKEEL_") {
			t.Errorf("%s 的 Env=%q 必须以 ZEOKEEL_ 开头（历史契约）", k.Setting, k.Env)
		}
		if !strings.Contains(k.Setting, ".") || strings.ToLower(k.Setting) != k.Setting {
			t.Errorf("%s 的键名必须是小写点分形式", k.Setting)
		}
		switch k.Kind {
		case KindString, KindInt, KindBool, KindDuration, KindCSV, KindChoice:
		default:
			t.Errorf("%s 的 Kind=%q 未实现", k.Setting, k.Kind)
		}
		switch k.AppliesAt {
		case AppliesHot, AppliesRestart:
		default:
			t.Errorf("%s 的 AppliesAt=%q 非法", k.Setting, k.AppliesAt)
		}
		// 默认值必须可解析（空默认值合法，表示"未配置"）。
		if _, err := k.Parse(k.Default); err != nil {
			t.Errorf("%s 的默认值非法：%v", k.Setting, err)
		}
		// typed 键必须有默认值（否则未配置时生效值为空，调用点拿到零值）。
		if k.Kind != KindString && k.Kind != KindCSV && k.Default == "" {
			t.Errorf("%s 是 %s 类，必须声明非空默认值", k.Setting, k.Kind)
		}
		if k.Kind == KindChoice {
			if len(k.Choices) == 0 {
				t.Errorf("%s 是 choice 但没有候选", k.Setting)
			}
			ok := false
			for _, c := range k.Choices {
				if c == k.Default {
					ok = true
				}
			}
			if !ok {
				t.Errorf("%s 的默认值 %q 不在候选中", k.Setting, k.Default)
			}
		}
	}
	if len(registry) < 10 {
		t.Fatalf("注册表只有 %d 项（判据锚点漂移：注册表被清空/搬家了？）", len(registry))
	}
}

func TestParseKinds(t *testing.T) {
	login := MustKey("auth.login_max_attempts")
	interval := MustKey("audit.chain_interval")
	ldap := MustKey("auth.ldap_allow_plaintext")
	profile := MustKey("wasm.memory_profile")
	hosts := MustKey("deploy.trusted_hosts")

	cases := []struct {
		name    string
		key     Key
		raw     string
		want    string
		wantErr bool
	}{
		{"空串=未配置", login, "  ", "", false},
		{"整数", login, " 42 ", "42", false},
		{"整数下限", login, "0", "", true},
		{"非整数", login, "abc", "", true},
		{"布尔1", ldap, "1", "true", false},
		{"布尔on", ldap, "ON", "true", false},
		{"布尔乱写", ldap, "maybe", "", true},
		{"时长", interval, "15m", "15m0s", false},
		{"时长过短", interval, "500ms", "", true},
		{"时长非法", interval, "1 hour", "", true},
		{"时长非正", interval, "-1h", "", true},
		{"choice 规范化", profile, " SMALL ", "small", false},
		{"choice 未知", profile, "medium", "", true},
		{"csv 去空去重", hosts, " a.example.com, ,b.example.com,a.example.com ", "a.example.com,b.example.com", false},
		{"csv 含空白", hosts, "a b.example.com", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := c.key.Parse(c.raw)
			if c.wantErr != (err != nil) {
				t.Fatalf("Parse(%q) err=%v，期望 err=%v", c.raw, err, c.wantErr)
			}
			if !c.wantErr && got != c.want {
				t.Fatalf("Parse(%q)=%q，期望 %q", c.raw, got, c.want)
			}
			if c.wantErr && !strings.Contains(err.Error(), c.key.Title) {
				t.Fatalf("错误信息必须点名配置项：%v", err)
			}
		})
	}
}

func TestLookups(t *testing.T) {
	k, ok := ByEnv("ZEOKEEL_LOGIN_MAX_ATTEMPTS")
	if !ok || k.Setting != "auth.login_max_attempts" {
		t.Fatalf("ByEnv 查不到：%+v ok=%v", k, ok)
	}
	if _, ok := BySetting("auth.nope"); ok {
		t.Fatal("未知键必须返回 false")
	}
	if got := len(SettingKeys()); got != len(Keys()) {
		t.Fatalf("SettingKeys=%d, Keys=%d", got, len(Keys()))
	}
	defer func() {
		if recover() == nil {
			t.Fatal("MustKey 对未知键必须 panic")
		}
	}()
	MustKey("auth.nope")
}

// TestResolveFixedValues 验证"无来源时用默认值"以及默认值的具体数值 ——
// 它们是与历史行为**逐字节一致**的契约（升级后行为不许变）。
func TestResolveFixedValues(t *testing.T) {
	for _, env := range []string{
		"ZEOKEEL_LOGIN_MAX_ATTEMPTS", "ZEOKEEL_LDAP_ALLOW_PLAINTEXT",
		"ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER", "ZEOKEEL_TELEMETRY_MAX_PER_MIN",
		"ZEOKEEL_TELEMETRY_MAX_PER_SKILL_PER_MIN", "ZEOKEEL_TELEMETRY_ERROR_REPORTING_MAX_PER_MIN",
		"ZEOKEEL_AUDIT_CHAIN_INTERVAL", "ZEOKEEL_APPS_EXTRA_RESERVED",
		"ZEOKEEL_WASM_MEMORY_PROFILE", "ZEOKEEL_COMPILE_ISOLATION",
	} {
		t.Setenv(env, "")
	}
	want := map[string]string{
		"auth.login_max_attempts":               "10",
		"auth.ldap_allow_plaintext":             "false",
		"gateway.max_inflight_per_user":         "32",
		"telemetry.max_per_min":                 "60",
		"telemetry.max_per_skill_per_min":       "10",
		"telemetry.error_reporting_max_per_min": "10",
		"audit.chain_interval":                  "1h0m0s",
		"wasm.memory_profile":                   "default",
		"wasm.compile_isolation":                "auto",
	}
	for setting, expected := range want {
		v := Resolve(nil, MustKey(setting))
		if v.Source != SourceDefault {
			t.Errorf("%s 期望来源 default，得到 %s", setting, v.Source)
		}
		if v.Raw != expected {
			t.Errorf("%s 默认值=%q，期望 %q（与历史行为不一致）", setting, v.Raw, expected)
		}
	}
}

func TestResolveEnvAndOverride(t *testing.T) {
	k := MustKey("gateway.max_inflight_per_user")
	t.Setenv("ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER", "64")
	v := Resolve(nil, k)
	if v.Source != SourceEnv || v.Raw != "64" || !v.SetByEnv() {
		t.Fatalf("环境变量应生效：%+v", v)
	}
	// 非法环境变量 ⇒ 告警并回落默认，不 panic、不阻塞。
	t.Setenv("ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER", "abc")
	v = Resolve(nil, k)
	if v.Source != SourceDefault || v.Raw != "32" {
		t.Fatalf("非法环境变量应回落默认：%+v", v)
	}
	if v.Invalid == "" || !strings.Contains(v.Invalid, "ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER") {
		t.Fatalf("非法值必须记录来源与原因：%+v", v)
	}
}

func TestDurationMaxBounds(t *testing.T) {
	k := MustKey("audit.chain_interval")
	// 下限 1s 是**兼容存量**的选择：旧实现接受任意正 duration，存量部署有 30s 的档。
	if _, err := k.Parse("1s"); err != nil {
		t.Fatalf("下限边界应合法：%v", err)
	}
	if _, err := k.Parse("30s"); err != nil {
		t.Fatalf("存量 30s 档必须仍然合法（否则升级即静默改行为）：%v", err)
	}
	if _, err := k.Parse("500ms"); err == nil {
		t.Fatal("低于 MinDuration 必须拒绝")
	}
	if d := Resolve(nil, k).AsDuration(); d != time.Hour {
		t.Fatalf("默认间隔=%s，期望 1h", d)
	}
}

// TestResolvePriorityEnvOverSetting 用真实 PG（无 PG 时自动 skip）验证三层优先级。
func TestResolvePriorityEnvOverSetting(t *testing.T) {
	db := newDeployTestDB(t)
	k := MustKey("telemetry.max_per_min")

	if err := setSetting(db, k.Setting, "99"); err != nil {
		t.Fatalf("写设置：%v", err)
	}
	v := Resolve(db, k)
	if v.Source != SourceSetting || v.Raw != "99" || !v.SettingSet {
		t.Fatalf("库中设置应生效：%+v", v)
	}

	t.Setenv(k.Env, "7")
	v = Resolve(db, k)
	if v.Source != SourceEnv || v.Raw != "7" {
		t.Fatalf("环境变量应压过库：%+v", v)
	}
	if !v.SettingSet || v.SettingRaw != "99" {
		t.Fatalf("来源信息必须保留两侧原始值：%+v", v)
	}

	// 库中非法值 ⇒ 回落默认并标记 Invalid。
	t.Setenv(k.Env, "")
	if err := setSetting(db, k.Setting, "-5"); err != nil {
		t.Fatalf("写设置：%v", err)
	}
	v = Resolve(db, k)
	if v.Source != SourceDefault || v.Raw != "60" || v.Invalid == "" {
		t.Fatalf("库中非法值应回落默认并标记：%+v", v)
	}
}

func TestSnapshotOrder(t *testing.T) {
	db := newDeployTestDB(t)
	if err := setSetting(db, "auth.login_max_attempts", "20"); err != nil {
		t.Fatalf("写设置：%v", err)
	}
	t.Setenv("ZEOKEEL_TELEMETRY_MAX_PER_MIN", "5")
	snap := Snapshot(db)
	if len(snap) != len(Keys()) {
		t.Fatalf("Snapshot=%d 项，注册表=%d 项", len(snap), len(Keys()))
	}
	for i, k := range Keys() {
		if snap[i].Key.Setting != k.Setting {
			t.Fatalf("Snapshot 顺序漂移：第 %d 项=%s，期望 %s", i, snap[i].Key.Setting, k.Setting)
		}
	}
	overridden := EnvOverridden(db)
	if len(overridden) != 1 || overridden[0] != "telemetry.max_per_min" {
		t.Fatalf("EnvOverridden=%v，期望只有 telemetry.max_per_min", overridden)
	}
}
