package llmgateway

// 「单用户并发上限」接线判据(2026-10-23,部署配置入库):
//
// 缺陷形态:上限此前在每次判定时直接 os.Getenv —— 运维只能改 .env + 重建容器,
// 控制台看不到、也改不了。改为 deployconfig 解析后必须证明三件事:
//  1. 不设任何来源时仍是历史默认 32(逐字节一致);
//  2. 历史环境变量仍然覆盖(存量 .env 平滑升级),非法值回落默认;
//  3. main 注入的"读库"钩子真的生效(否则控制台保存 = 静默不生效)。

import (
	"strconv"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func TestMaxInflightPerUserFromDeployConfig(t *testing.T) {
	t.Helper()
	env := deployconfig.MustKey("gateway.max_inflight_per_user").Env
	t.Cleanup(func() { SetMaxInflightResolver(nil) })

	// 1) 无来源 = 历史默认 32。
	t.Setenv(env, "")
	if got := maxInflightPerUser(); got != defaultMaxInflightPerUser {
		t.Fatalf("未配置时上限 = %d，want 历史默认 %d", got, defaultMaxInflightPerUser)
	}

	// 2) 历史环境变量仍覆盖;非法(0/abc)回落默认而不是变成"全拒"或"全放"。
	t.Setenv(env, "7")
	if got := maxInflightPerUser(); got != 7 {
		t.Fatalf("环境变量覆盖后上限 = %d，want 7", got)
	}
	for _, bad := range []string{"0", "abc", "-3"} {
		t.Setenv(env, bad)
		if got := maxInflightPerUser(); got != defaultMaxInflightPerUser {
			t.Fatalf("非法环境变量 %q ⇒ 上限 %d，want 回落默认 %d", bad, got, defaultMaxInflightPerUser)
		}
	}

	// 3) 注入钩子(生产 = 读控制台设置)必须立刻生效;nil 恢复默认实现。
	t.Setenv(env, "")
	SetMaxInflightResolver(func() int { return 5 })
	if got := maxInflightPerUser(); got != 5 {
		t.Fatalf("注入钩子后上限 = %d，want 5（控制台配置不生效）", got)
	}
	SetMaxInflightResolver(nil)
	if got := maxInflightPerUser(); got != defaultMaxInflightPerUser {
		t.Fatalf("钩子复位后上限 = %d，want 默认 %d", got, defaultMaxInflightPerUser)
	}
}

// TestMaxInflightPerUserReadsConsoleSetting 用真实 PG 验证"控制台保存的值生效"
// (无 PG 时 serverstore.NewTestDB 自动 skip,与全仓约定一致)。
func TestMaxInflightPerUserReadsConsoleSetting(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	key := deployconfig.MustKey("gateway.max_inflight_per_user")
	if err := serverstore.SetSetting(db, key.Setting, "9"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	SetMaxInflightResolver(func() int { return deployconfig.Int(db, key) })
	t.Cleanup(func() { SetMaxInflightResolver(nil) })
	if got := maxInflightPerUser(); got != 9 {
		t.Fatalf("控制台保存的上限 = %d，want 9", got)
	}

	// 环境变量仍压过控制台(存量 .env 的升级安全),且这是运维唯一能救启动闸门的通道。
	t.Setenv(key.Env, strconv.Itoa(11))
	if got := maxInflightPerUser(); got != 11 {
		t.Fatalf("环境变量压过控制台后上限 = %d，want 11", got)
	}
}
