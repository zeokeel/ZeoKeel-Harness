package appstore

// F-02(能力中心审计 2026-10-26,P1):注册空壳 App 的**释放**路径。
//
// 缺陷现场:管理端「新建」只登记 App 身份(POST /skills、POST /agents),内容
// 另一步上传;打错名字/放弃创建后,这一行既没有版本也没有删除入口,而名称
// 跨渠道互斥(市场占名同时挡组织同名)—— 唯一出路是改库。
//
// 修法:DELETE /api/server/admin/apps/:kind/:app_id,只在**空壳**时硬删:
//   - 没有未软删版本(pending/approved 都算"有内容");
//   - 非官方归属;
//   - kind ∈ {skill, agent}(WASM 应用有自己的 purge 生命周期)。
// 任何一条不满足 ⇒ 409 + 明确 code(APP_HAS_RELEASES / APP_OFFICIAL),不删数据。
//
// 判据即下面这些用例:空壳可释放(名称可再次登记)、有版本/官方被拒且数据
// 原样保留、软删墓碑不阻止释放但会随 CASCADE 清掉、授权一并清理、审计留痕。

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// newDeleteAppServer 建一棵只挂 DELETE /apps/:kind/:app_id 的测试树,并模拟
// AdminAuth 写入 admin_user 上下文(生产路径由 serverauth.AdminAuth 负责)。
func newDeleteAppServer(db *sql.DB) http.Handler {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandlers(db)
	r.DELETE("/apps/:kind/:app_id", func(c *gin.Context) {
		c.Set("admin_user", &serverstore.User{Username: "admin"})
		h.DeleteApp(c)
	})
	return r
}

func TestDeleteEmptyAppReleasedName(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.UpsertApp(db, &serverstore.App{Kind: serverstore.AppKindSkill,
		AppID: "typo-skill", Title: "打错的名字", Owner: "alice", Channel: serverstore.AppChannelMarket, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	// 空壳也可以有授权(授权按 name 生效,不要求有版本)。
	if err := serverstore.GrantApp(db, serverstore.AppKindSkill, "typo-skill", "bob", "user"); err != nil {
		t.Fatal(err)
	}

	r := newDeleteAppServer(db)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/apps/skill/typo-skill", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("释放空壳 = %d %s", w.Code, w.Body.String())
	}
	if _, err := serverstore.GetApp(db, serverstore.AppKindSkill, "typo-skill"); !errors.Is(err, serverstore.ErrNotFound) {
		t.Fatalf("空壳未被删除: %v", err)
	}
	// 授权随名称释放一起清理(否则同名新内容会继承旧授权)。
	grants, err := serverstore.ListAppGrants(db, serverstore.AppKindSkill, "typo-skill")
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 0 {
		t.Fatalf("旧授权残留: %+v", grants)
	}
	// 名称真的还给了平台:同名 App 可以重新登记(跨渠道互斥不再被占名行挡住)。
	if err := serverstore.UpsertApp(db, &serverstore.App{Kind: serverstore.AppKindSkill,
		AppID: "typo-skill", Title: "重新登记", Owner: "bob", Channel: serverstore.AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatalf("名称未释放: %v", err)
	}
	// 审计留痕(app_delete 按 app_id 归集)。
	rows, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 10, "app_delete", "")
	if err != nil || len(rows) != 1 {
		t.Fatalf("app_delete 审计 = %d rows err=%v", len(rows), err)
	}
}

func TestDeleteAppWithReleasesConflicts(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.UpsertApp(db, &serverstore.App{Kind: serverstore.AppKindAgent,
		AppID: "has-release", Title: "有版本", Owner: "alice", Channel: serverstore.AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: "has-release", Version: "1.0.0",
		Title: "有版本", Publisher: "alice", Checksum: "sum", Archive: []byte("zip"),
		Status: serverstore.ReleaseStatusApproved,
	}); err != nil {
		t.Fatal(err)
	}
	r := newDeleteAppServer(db)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/apps/agent/has-release", nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("有版本时释放 = %d %s, want 409", w.Code, w.Body.String())
	}
	if !containsCode(w.Body.String(), "APP_HAS_RELEASES") {
		t.Fatalf("error.code 应为 APP_HAS_RELEASES: %s", w.Body.String())
	}
	// 数据原样保留。
	if _, err := serverstore.GetApp(db, serverstore.AppKindAgent, "has-release"); err != nil {
		t.Fatalf("被拒的释放仍删了 App: %v", err)
	}
	if rel, err := serverstore.GetRelease(db, serverstore.AppKindAgent, "has-release", "1.0.0"); err != nil ||
		rel.Status != serverstore.ReleaseStatusApproved || len(rel.Archive) == 0 {
		t.Fatalf("被拒的释放破坏了版本: %+v err=%v", rel, err)
	}
}

func TestDeleteOfficialEmptyAppConflicts(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	// 官方归属的内容即使没有版本也不允许释放(蓝标身份归平台)。
	if err := serverstore.UpsertApp(db, &serverstore.App{Kind: serverstore.AppKindSkill,
		AppID: "official-shell", Title: "官方空壳", Owner: "alice", Channel: serverstore.AppChannelMarket, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "official-shell", true, ""); err != nil {
		t.Fatal(err)
	}
	r := newDeleteAppServer(db)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/apps/skill/official-shell", nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("释放官方空壳 = %d %s, want 409", w.Code, w.Body.String())
	}
	if !containsCode(w.Body.String(), "APP_OFFICIAL") {
		t.Fatalf("error.code 应为 APP_OFFICIAL: %s", w.Body.String())
	}
	if _, err := serverstore.GetApp(db, serverstore.AppKindSkill, "official-shell"); err != nil {
		t.Fatalf("官方空壳被删除: %v", err)
	}
}

func TestDeleteAppOnlySoftDeletedReleasesAllowed(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.UpsertApp(db, &serverstore.App{Kind: serverstore.AppKindSkill,
		AppID: "tombstone", Title: "只剩墓碑", Owner: "alice", Channel: serverstore.AppChannelOrg, Enabled: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindSkill, AppID: "tombstone", Version: "1.0.0",
		Publisher: "alice", Status: serverstore.ReleaseStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	// 产品删除入口只允许 pending/rejected;这里用通用原语模拟"早已软删"。
	if err := serverstore.SoftDeleteRelease(db, serverstore.AppKindSkill, "tombstone", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	r := newDeleteAppServer(db)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/apps/skill/tombstone", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("只有软删墓碑时释放 = %d %s, want 200", w.Code, w.Body.String())
	}
	if list, err := serverstore.ListReleases(db, serverstore.AppKindSkill, "tombstone"); err != nil || len(list) != 0 {
		t.Fatalf("墓碑应随 App 一起清除(CASCADE): %d 条 err=%v", len(list), err)
	}
}

func TestDeleteAppArgumentValidation(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	r := newDeleteAppServer(db)
	cases := []struct {
		path string
		want int
	}{
		{"/apps/widget/ghost", http.StatusBadRequest}, // kind 白名单
		{"/apps/skill/Bad_Name", http.StatusBadRequest},
		{"/apps/skill/never-existed", http.StatusNotFound},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, tc.path, nil))
		if w.Code != tc.want {
			t.Fatalf("DELETE %s = %d %s, want %d", tc.path, w.Code, w.Body.String(), tc.want)
		}
	}
}

// containsCode 判定 JSON 错误信封里是否带指定 error.code。
func containsCode(body, code string) bool {
	return strings.Contains(body, `"code":"`+code+`"`)
}
