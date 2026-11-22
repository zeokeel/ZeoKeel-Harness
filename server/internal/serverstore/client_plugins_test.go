package serverstore

import "testing"

func clientPluginFixture() *ClientPlugin {
	return &ClientPlugin{
		ID:          "demo-plugin",
		PackageName: "@example/dsh-demo-plugin",
		DisplayName: "@example/dsh-demo-plugin",
		Description: "demo",
		Version:     "1.0.0",
		Sha256:      "abc123",
		Size:        4,
		Content:     []byte("tgz!"),
		Enabled:     true,
		UpdatedBy:   "admin",
	}
}

func TestClientPluginLifecycle(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	p := clientPluginFixture()
	if err := UpsertClientPlugin(db, p); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	rows, err := ListEnabledClientPlugins(db)
	if err != nil || len(rows) != 1 {
		t.Fatalf("list enabled = %v, %v", rows, err)
	}
	if rows[0].ID != "demo-plugin" || rows[0].PackageName != "@example/dsh-demo-plugin" {
		t.Fatalf("row = %+v", rows[0])
	}

	got, err := GetClientPlugin(db, "demo-plugin")
	if err != nil || string(got.Content) != "tgz!" {
		t.Fatalf("get = %+v, %v", got, err)
	}

	// same id + same version is refused (clients compare package_name+version)
	if err := UpsertClientPlugin(db, p); err != ErrDuplicate {
		t.Fatalf("same-version upsert = %v, want ErrDuplicate", err)
	}

	// new version replaces in place
	p.Version = "1.1.0"
	p.Content = []byte("tgz2")
	if err := UpsertClientPlugin(db, p); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	got, _ = GetClientPlugin(db, "demo-plugin")
	if got.Version != "1.1.0" || string(got.Content) != "tgz2" {
		t.Fatalf("after upgrade = %+v", got)
	}

	// package name is globally unique: a second key for the same npm package is refused
	other := clientPluginFixture()
	other.ID = "another-key"
	other.Version = "2.0.0"
	if err := UpsertClientPlugin(db, other); err != ErrDuplicate {
		t.Fatalf("package collision = %v, want ErrDuplicate", err)
	}

	// disable hides it from bootstrap but keeps the row for re-enable
	if err := SetClientPluginEnabled(db, "demo-plugin", false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if rows, _ := ListEnabledClientPlugins(db); len(rows) != 0 {
		t.Fatalf("disabled still enabled: %v", rows)
	}
	if rows, _ := ListClientPlugins(db); len(rows) != 1 {
		t.Fatalf("admin list lost disabled row: %v", rows)
	}

	if err := DeleteClientPlugin(db, "demo-plugin"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := GetClientPlugin(db, "demo-plugin"); err != ErrNotFound {
		t.Fatalf("after delete = %v, want ErrNotFound", err)
	}
}
