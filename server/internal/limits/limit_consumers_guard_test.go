package limits_test

// A10（审计 2026-10-22 功能合理性审计，P2）：**limits 单一真源守卫 —— 每个导出上限
// 必须真的有消费者**。
//
// 现场：既有门禁（limits_gen_test.go 的 (a)(b)(c)(d)(e)）只证明「常量 ↔ 文档」一致，
// **不证明常量有消费者**。于是 A1/A2 那类"上限登记为唯一真源、运行时真值在另一个包
// 的另一份副本"可以长期全绿：改 limits ⇒ 文档变、行为不变（A1 的资源路径 3 个上限、
// A2 的 AI 桥 2 个上限都是这个形态）。
//
// 判据（与 (b) 的"表覆盖"是两条独立的口径）：
//
//	对 limits.go 的每个**导出常量**，在本包之外必须存在**非测试**消费者：
//	  - Go：`server/**/*.go`（去掉 `_test.go` 与 `internal/limits/` 自身），按
//	    **AST 标识符**匹配（不扫注释/字符串 —— 注释里提一次不叫消费者）；
//	  - 跨端 TS 契约：`packages/**/*.{ts,tsx}`（去掉 `*.spec.*` / `*.test.*`），按
//	    词边界匹配（跨端常量在 TS 侧有同名或等值的执行点，例如 AI 桥的两条上限由
//	    aibridge_crossend_test.go 逐值对拍）。
//	例外必须进下面的 `consumerExempt` 并写清理由；白名单条目若**后来长出**了消费者
//	视为过期（删掉它，别让白名单慢慢变成一张空头名单）。
//
// 变异验证：
//   - 在 limits.go 加 `const FooMaxBytes = 7 << 20`（无任何消费者）⇒ 红（除非登记理由）；
//   - 删掉某个上限的全部生产消费者（例如把 queue 对 AppRuntimeConcurrency 的引用删掉）
//     ⇒ 该常量报红；
//   - 白名单里写一个 limits.go 里不存在的名字 ⇒ 红（死条目）；
//   - 给白名单条目补一个生产消费者 ⇒ 红（白名单已过期）。

import (
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// consumerExempt 是"没有包外消费者"的**白名单**（每条必须写清为什么它是例外）。
//
// 三类，判据：这些常量要么是**推导参数/别名**（真上限另有其名且确有消费者），
// 要么是**跨端契约**（执行值在 TS 侧、由对拍用例咬住）。不要为"让某条测试变绿"
// 往这里加真正的上限 —— 那会让 A10 的门禁失效（与 (b) 的 exemptDecls 同一条纪律）。
var consumerExempt = map[string]string{
	// —— 跨端契约：执行值在 TS 侧（Go 侧只是真源表，值由对拍用例钉住）——
	"AIBridgeMaxMessages":     "跨端 AI 桥上限：Go 侧零消费者，执行值在 packages/host/wasm-apps-host/src/ai-chat.ts 的 AI_CHAT_MAX_MESSAGES 与 packages/client/wasm-apps/src/client/app-ai.ts 的 APP_AI_MESSAGES_MAX；等值由 aibridge_crossend_test.go 逐值对拍（A2）",
	"AIBridgeMessageMaxBytes": "跨端 AI 桥单条上限：执行值在 ai-chat.ts 的 AI_CHAT_MAX_CONTENT_BYTES 与 app-ai.ts 的 APP_AI_MESSAGE_MAX_BYTES；等值由 aibridge_crossend_test.go 逐值对拍（A2）",

	// —— 别名 / 推导参数：真上限另有其名，且那个名字有生产消费者 ——
	"AppConcurrency":            "语义别名：生产消费者引用的是 AppRuntimeConcurrency（= 本常量，见 queue/applimits/appserver 的 PerAppRunning/AppRunning），别名本身只在 limits 包内与文档表里使用",
	"AppDBPageSize":             "换算单位（SQLite 页大小，规范固定）：真上限是 AppDBMaxBytes（= 页数 × 本常量），后者有生产消费者；本常量只在 limits 包内换算与 appdb 的测试断言里出现",
	"MaxJSONEscapeExpansion":    "推导参数：只在 limits 包内推导 MaxDeliverablePayloadBytes / SQLMaxResultBytes（真上限见那些表项），没有任何外部消费者是**预期**而非遗漏",
	"FrameEnvelopeReserveBytes": "推导参数：只在 limits 包内推导 MaxDeliverablePayloadBytes（真上限见该表项）；保留量本身不可调，也不该被外部包直接读",

	// —— 已有跨包等值断言（改 limits 不同步会红），但实现常量刻意写字面量 ——
	"RowsPageMax": "跨包等值断言：api/rows.go 保留同值实现常量 rowsMaxLimit（字面量，便于跨语言对拍），等值由 rows_page_limit_binding_test.go 咬住 —— 改 limits 不同步 rows.go 会红；不写成 `= limits.RowsPageMax` 是为了不把 JSON 契约数字绑进编译期",

	// —— 已知残差（A1 类：登记为上限、今天没有行为消费者）——
	"ReleaseCacheMaxBytes": "**已知残差**（A10 查出来的 A1 类形态）：resources 缓存在 2026-09-20 改成只存元数据后，字节预算不再被任何代码引用（资源字节计入 module_cache_mb）；常量仍留在 limits 表里对外宣称一个不存在的字节上界。本轮只登记不处置（删除它要连带改 limitsspec/生成物/skill references，属产品口径决定），处置方向见 temp/wasm-audit-2026-10-22/wave2-server.md",
}

// TestEveryExportedLimitHasConsumer 是本文件的主体判据（详见文件头）。
func TestEveryExportedLimitHasConsumer(t *testing.T) {
	// 只需要**名字**（不需要常量值），因此用轻量 AST 解析而不是 limits_gen_test.go 的
	// parseExportedDecls（后者跑 go/types + source importer，要几十秒）。
	constNames := exportedConstNames(t, limitsSourceFile)
	if len(constNames) < 60 {
		t.Fatalf("只解析出 %d 个导出常量，远低于预期 —— AST 解析可能失效（假绿防线）", len(constNames))
	}
	repoRoot := filepath.Dir(moduleRootOf(t))
	consumers, stats := collectLimitConsumers(t, repoRoot, constNames)
	// 扫描面自检：任何一个语料面为空，这条判据就退化成恒真（本仓对"空转判据"的纪律）。
	if stats.goFiles < 100 || stats.tsFiles < 50 {
		t.Fatalf("消费者扫描面异常（go=%d ts=%d）—— 判据会退化成恒真，不得静默通过", stats.goFiles, stats.tsFiles)
	}

	// 导出变量（枚举表/映射）由 (b) 的"表覆盖 + 显式豁免"管，本判据只看上限常量。
	usedExempt := map[string]bool{}
	var missing []string
	for _, name := range constNames {
		has := consumers[name]
		reason, exempt := consumerExempt[name]
		switch {
		case exempt && has:
			t.Errorf("白名单已过期：%s 现在有包外消费者了 —— 请从 consumerExempt 删掉它（白名单只登记真正的例外）", name)
		case exempt && reason == "":
			t.Errorf("白名单条目 %s 没有写理由 —— 例外必须能解释", name)
			usedExempt[name] = true
		case exempt:
			usedExempt[name] = true
		case !has:
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("这些导出上限在包外**没有任何非测试消费者**（A10）：%s\n"+
			"  后果：改 limits 只会改文档，运行期行为不变 —— 上限的真值实际上在别处（A1/A2 的形态）。\n"+
			"  处置二选一：① 让生产代码真的引用它（推荐）；② 若它是推导参数/别名/跨端契约，\n"+
			"  在 consumerExempt 里登记并写清理由。", strings.Join(missing, ", "))
	}
	// 白名单不得留死条目（常量改名/删除后忘了清理会让"例外"慢慢变成一张空头名单）。
	declared := map[string]bool{}
	for _, name := range constNames {
		declared[name] = true
	}
	for name, reason := range consumerExempt {
		if !declared[name] {
			t.Errorf("白名单里的 %s 在 limits.go 里已不存在（理由：%s）—— 请删掉这条例外", name, reason)
		}
	}
}

// exportedConstNames 用轻量 AST 解析收集 limits.go 的**导出常量名**（不求值）。
func exportedConstNames(t *testing.T, filename string) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filename, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 %s: %v", filename, err)
	}
	var out []string
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range vs.Names {
				if name.IsExported() {
					out = append(out, name.Name)
				}
			}
		}
	}
	return out
}

// consumerStats 是扫描面统计（用于"判据不空转"的自检）。
type consumerStats struct {
	goFiles int
	tsFiles int
}

// collectLimitConsumers 收集**包外**消费者（Go AST 标识符 + TS 词边界）。
//
// 为什么 Go 侧用 AST 而不是文本匹配：注释里提到常量名（本仓注释密度很高）会让
// "零消费者的死常量"看起来有人用。TS 侧没有等价工具，用词边界正则是可接受的近似
// （TS 文件里这些名字只会出现在声明/使用处）。
func collectLimitConsumers(t *testing.T, repoRoot string, constNames []string) (map[string]bool, consumerStats) {
	t.Helper()
	out := map[string]bool{}
	var stats consumerStats
	selfDir := filepath.Join(repoRoot, "server", "internal", "limits")
	fset := token.NewFileSet()

	// addGo 用 go/scanner 只收 **IDENT token**：等价于"AST 标识符"，但快一个量级
	// （本判据要扫上千个文件），且**注释里的名字不会被收**（不传扫描注释的 flag）。
	addGo := func(path string) {
		if strings.HasSuffix(path, "_test.go") {
			return
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读 %s: %v", path, err)
		}
		var sc scanner.Scanner
		file := fset.AddFile(path, -1, len(src))
		sc.Init(file, src, nil, 0)
		stats.goFiles++
		for {
			_, tok, lit := sc.Scan()
			if tok == token.EOF {
				return
			}
			if tok == token.IDENT {
				out[lit] = true
			}
		}
	}
	err := filepath.WalkDir(filepath.Join(repoRoot, "server"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == selfDir || d.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			addGo(path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 server/: %v", err)
	}

	// TS/TSX：只收非测试文件（`*.spec.ts(x)` / `*.test.ts(x)` 不算"非测试消费者"）。
	// 词边界用**手写扫描**而不是逐名字编译正则：语料是上千个文件 × 上百个名字，
	// 逐对正则匹配会让这条门禁慢到没人愿意跑（实测 30s → 1s 量级）。
	tsWord := containsWord
	err = filepath.WalkDir(filepath.Join(repoRoot, "packages"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == "dist" || d.Name() == "lib" {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".ts") && !strings.HasSuffix(name, ".tsx") {
			return nil
		}
		if strings.HasSuffix(name, ".spec.ts") || strings.HasSuffix(name, ".spec.tsx") ||
			strings.HasSuffix(name, ".test.ts") || strings.HasSuffix(name, ".test.tsx") {
			return nil
		}
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		stats.tsFiles++
		text := string(src)
		for _, name := range constNames {
			if tsWord(text, name) {
				out[name] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 packages/: %v", err)
	}
	return out, stats
}

// containsWord 报告 text 里是否出现一个**词边界完整**的 name（`\bNAME\b` 的等价物）。
func containsWord(text, name string) bool {
	if name == "" {
		return false
	}
	for from := 0; from <= len(text); {
		i := strings.Index(text[from:], name)
		if i < 0 {
			return false
		}
		at := from + i
		beforeOK := at == 0 || !isIdentByte(text[at-1])
		end := at + len(name)
		afterOK := end >= len(text) || !isIdentByte(text[end])
		if beforeOK && afterOK {
			return true
		}
		from = at + 1
	}
	return false
}

// isIdentByte 判定 [A-Za-z0-9_]（TS 标识符的"词内"字符；够用于词边界判据）。
func isIdentByte(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9', b == '_':
		return true
	}
	return false
}
