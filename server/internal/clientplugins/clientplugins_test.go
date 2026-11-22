package clientplugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func makeTarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func validPackageFiles() map[string]string {
	return map[string]string{
		"package/package.json":     `{"name":"@example/dsh-demo-plugin","version":"1.0.0","description":"demo plugin","dsh":{"bundle":{"patch":"cordis.patch.yml"}}}`,
		"package/cordis.patch.yml": `[]`,
		"package/index.js":         `export function apply() {}`,
	}
}

func TestInspectBundleValid(t *testing.T) {
	meta, err := inspectBundle(makeTarGz(t, validPackageFiles()))
	if err != nil {
		t.Fatalf("inspectBundle: %v", err)
	}
	if meta.PackageName != "@example/dsh-demo-plugin" || meta.Version != "1.0.0" {
		t.Fatalf("meta = %+v", meta)
	}
	if meta.Slug != "example-dsh-demo-plugin" {
		t.Fatalf("slug = %q", meta.Slug)
	}
	if meta.Sha256 == "" || meta.Size == 0 || meta.Description != "demo plugin" {
		t.Fatalf("meta = %+v", meta)
	}
}

func TestInspectBundleRejects(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(map[string]string)
		wantErr string
	}{
		{"missing package.json", func(f map[string]string) { delete(f, "package/package.json") }, "缺少 package.json"},
		{"missing patch file", func(f map[string]string) { delete(f, "package/cordis.patch.yml") }, "dsh.bundle.patch 指向的文件不在包内"},
		{"no dsh patch", func(f map[string]string) {
			f["package/package.json"] = `{"name":"@example/dsh-demo-plugin","version":"1.0.0"}`
		}, "缺少 dsh.bundle.patch"},
		{"install script", func(f map[string]string) {
			f["package/package.json"] = `{"name":"@example/dsh-demo-plugin","version":"1.0.0","scripts":{"postinstall":"node x.js"},"dsh":{"bundle":{"patch":"cordis.patch.yml"}}}`
		}, "不得带安装期脚本"},
		{"patch escapes", func(f map[string]string) {
			f["package/package.json"] = `{"name":"@example/dsh-demo-plugin","version":"1.0.0","dsh":{"bundle":{"patch":"../cordis.patch.yml"}}}`
		}, "指向包外路径"},
		{"bad version", func(f map[string]string) {
			f["package/package.json"] = `{"name":"@example/dsh-demo-plugin","version":"../x","dsh":{"bundle":{"patch":"cordis.patch.yml"}}}`
		}, "version 不合法"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := validPackageFiles()
			tc.mutate(files)
			_, err := inspectBundle(makeTarGz(t, files))
			if err == nil {
				t.Fatalf("expected error %q", tc.wantErr)
			}
			if tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %q, want substring %q", err, tc.wantErr)
			}
		})
	}
}

func TestInspectBundleRejectsSymlinkAndTraversal(t *testing.T) {
	// symlink member
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "package/evil", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd", Mode: 0o777})
	_ = tw.Close()
	_ = gz.Close()
	if _, err := inspectBundle(buf.Bytes()); err == nil {
		t.Fatal("symlink bundle must be rejected")
	}

	// path traversal member
	var buf2 bytes.Buffer
	gz2 := gzip.NewWriter(&buf2)
	tw2 := tar.NewWriter(gz2)
	_ = tw2.WriteHeader(&tar.Header{Name: "../evil", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})
	_, _ = tw2.Write([]byte("x"))
	_ = tw2.Close()
	_ = gz2.Close()
	if _, err := inspectBundle(buf2.Bytes()); err == nil {
		t.Fatal("traversal bundle must be rejected")
	}
}

// ---- handler-level tests (need the PostgreSQL test template; skipped without one) ----

func setupHandlers(t *testing.T) *gin.Engine {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	h := NewHandlers(db)
	r := gin.New()
	r.GET("/api/server/admin/plugins", h.List)
	r.POST("/api/server/admin/plugins", h.Upload)
	r.PUT("/api/server/admin/plugins/:id/enabled", h.SetEnabled)
	r.DELETE("/api/server/admin/plugins/:id", h.Remove)
	r.GET("/api/client/v2/plugins/:id/:version/bundle", h.Bundle)
	return r
}

func doJSON(t *testing.T, r http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestUploadListDownloadDisableDelete(t *testing.T) {
	r := setupHandlers(t)
	bundle := makeTarGz(t, validPackageFiles())
	w := doJSON(t, r, http.MethodPost, "/api/server/admin/plugins", map[string]string{
		"bundle_base64": base64.StdEncoding.EncodeToString(bundle),
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body=%s", w.Code, w.Body.String())
	}
	var created struct {
		Plugin struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"plugin"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if created.Plugin.ID != "example-dsh-demo-plugin" || created.Plugin.Version != "1.0.0" {
		t.Fatalf("created = %+v", created)
	}

	// list
	w = doJSON(t, r, http.MethodGet, "/api/server/admin/plugins", nil)
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("example-dsh-demo-plugin")) {
		t.Fatalf("list = %d %s", w.Code, w.Body.String())
	}

	// download
	w = doJSON(t, r, http.MethodGet, "/api/client/v2/plugins/example-dsh-demo-plugin/1.0.0/bundle", nil)
	if w.Code != http.StatusOK || w.Header().Get("X-Checksum-Sha256") == "" {
		t.Fatalf("download = %d headers=%v", w.Code, w.Header())
	}
	if !bytes.Equal(w.Body.Bytes(), bundle) {
		t.Fatal("downloaded bytes differ from uploaded bundle")
	}

	// same version -> 409
	w = doJSON(t, r, http.MethodPost, "/api/server/admin/plugins", map[string]string{
		"bundle_base64": base64.StdEncoding.EncodeToString(bundle),
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("same-version upload status = %d body=%s", w.Code, w.Body.String())
	}

	// disable -> bundle 404 and bootstrap would omit it
	w = doJSON(t, r, http.MethodPut, "/api/server/admin/plugins/example-dsh-demo-plugin/enabled", map[string]bool{"enabled": false})
	if w.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", w.Code, w.Body.String())
	}
	w = doJSON(t, r, http.MethodGet, "/api/client/v2/plugins/example-dsh-demo-plugin/1.0.0/bundle", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled download = %d", w.Code)
	}

	// delete
	w = doJSON(t, r, http.MethodDelete, "/api/server/admin/plugins/example-dsh-demo-plugin", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", w.Code, w.Body.String())
	}
}

func TestUploadRejectsBadTarball(t *testing.T) {
	r := setupHandlers(t)
	w := doJSON(t, r, http.MethodPost, "/api/server/admin/plugins", map[string]string{
		"bundle_base64": base64.StdEncoding.EncodeToString([]byte("not a tarball")),
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
}
