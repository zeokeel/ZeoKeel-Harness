package main

// R16C-06（审计 2026-09-25，P2）的**静态判据**：文档点名"可调"的旋钮在 compose 部署里
// 必须真的够得到。
//
// 缺陷形态：`ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER`（`docs/deploy/AI-DEPLOY.md` §网关、
// `server/docs/04-auth.md` 都写"可调"）与 `ZEOKEEL_LDAP_ALLOW_PLAINTEXT`（v2.7.3 发布
// 说明与安全审计文档写"需要时设 =1"）**都不在 `server/docker-compose.yml` 的
// `server.environment` 映射里**，compose 也没有 `env_file` ⇒ 运维按文档把键写进 `.env`
// 后重启，**静默不生效、零回显**（实测 `docker compose config` 解析结果里没有它们）。
//
// 两个方向的判据：
//  1. 具名（TestComposeWiresNamedGatewayKnobs）：那两个键必须出现在解析出的
//     server.environment 里 —— 这是本次审计点名的修复对象；
//  2. 通用（TestEveryServerZEOKEELEnvNameIsWiredOrExempt）：服务端源码里出现的**每个**
//     `ZEOKEEL_*` 名字都必须"已接线"或"在豁免清单里且写明理由"。没有这一条，下一个
//     `ZEOKEEL_*` 旋钮会以完全相同的方式再漏一次（本轮就是四个同族键一起漏的）。
//
// 2026-10-23 追加第三条（TestDeployconfigRegistryEnvsStayWired）：`deployconfig` 注册表
// 把 12 个旋钮的主入口搬进了控制台（settings 表），compose 里那些行**不再是必配项**，
// 而是**历史覆盖口**。它们最容易在下一次"精简 compose"时被当成死配置删掉 —— 删一行的
// 后果恰恰是最隐蔽的一类：存量 .env 里的同名键仍然写着，容器里却没有它，升级后行为
// 静默回落到库/默认值，零报错、零回显。所以方向要反过来再判一次（注册表 → compose），
// 并且判"透传形态"（`${KEY:-}`）而不是仅仅"键存在"。
//
// 判据读的是**文件本身**（compose 的 environment 映射），不跑 docker：CI 的 Go job
// 里没有 docker compose，而"映射里有没有这个键"是纯文本事实。`docker compose config`
// 的解析结果在探针里人工核对过（temp/r16/V/evidence/{before,after}-compose.txt）。

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/goccy/go-yaml"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
)

// composePath 是部署编排文件（本测试的工作目录是 server/cmd/server）。
const composePath = "../../docker-compose.yml"

// composeServerEnvironment 解析 docker-compose.yml，返回 services.server.environment
// 的**键集合**。缺服务/缺 environment 直接 Fatal —— 判据锚点漂移必须响亮地失败，
// 而不是"没找到键 ⇒ 空集合 ⇒ 判据变成恒真"。
// composeDoc 解析 docker-compose.yml 成 map（R15C-03 的编排级对拍也要用它，
// 所以从 composeServerEnvironment 里抽出来做唯一实现）。
func composeDoc(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("读 %s: %v", composePath, err)
	}
	// 用 map 形态而不是嵌套匿名结构体：goccy/go-yaml 对"嵌套匿名结构体 + 标签"的
	// 支持与 map 形态不一致（实测结构体形态解析出空映射），而判据的取向是
	// "读到的必须是文件里真实的那段映射" —— 用最不容易悄悄退化的形态。
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("解析 %s: %v", composePath, err)
	}
	return doc
}

func composeServerEnvironment(t *testing.T) map[string]string {
	t.Helper()
	doc := composeDoc(t)
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("%s 里没有 services 映射（判据锚点漂移）", composePath)
	}
	server, ok := services["server"].(map[string]any)
	if !ok {
		t.Fatalf("%s 里没有 services.server（判据锚点漂移）", composePath)
	}
	rawEnv, ok := server["environment"].(map[string]any)
	if !ok {
		t.Fatalf("%s 的 services.server.environment 不是映射（判据锚点漂移：整段映射被搬走/改名了）", composePath)
	}
	env := make(map[string]string, len(rawEnv))
	for k, v := range rawEnv {
		env[k] = fmt.Sprintf("%v", v)
	}
	if len(env) == 0 {
		t.Fatalf("%s 的 services.server.environment 解析为空（判据锚点漂移）", composePath)
	}
	return env
}

// TestComposeWiresNamedGatewayKnobs 是 R16C-06 的具名判据。
func TestComposeWiresNamedGatewayKnobs(t *testing.T) {
	env := composeServerEnvironment(t)
	// 两个键就是审计点名的对象：它们的文档口径是"可调"，而修前写进 .env 完全无效。
	want := []string{
		"ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER",
		"ZEOKEEL_LDAP_ALLOW_PLAINTEXT",
	}
	for _, k := range want {
		if _, ok := env[k]; !ok {
			t.Errorf("%s 不在 server.environment 里 —— 文档说它可调，写进 .env 却静默不生效"+
				"（要么接线 ${%s:-}，要么删掉文档里的'可调'口径）", k, k)
		}
	}
	// 反向自证：接线必须是"透传默认值"的形状，而不是把值**写死**在 compose 里
	// （写死会让 .env 里的取值继续被无视 —— 症状一样，只是换了个地方）。
	for _, k := range want {
		if v, ok := env[k]; ok && !strings.Contains(v, "${"+k) {
			t.Errorf("%s 的取值是 %q —— 必须写成 ${%s:-} 才能让 .env 生效（写死等于换一种方式无视运维配置）", k, v, k)
		}
	}
}

// TestDeployconfigRegistryEnvsStayWired 是 2026-10-23 的判据：
// deployconfig 注册表里每个 Key.Env 必须**仍在** compose 的 server.environment 里。
//
// 这些行现在是**历史覆盖口，不是必需项**：新部署不用设置（控制台「系统配置」页才是主
// 入口），但存量部署的 .env 里就写着它们。因此判据的取向是"注册表是契约、compose 是
// 兑现处"——删掉一行，旧 .env 就会静默失效。同时判透传形态：写死默认值与删掉等价。
func TestDeployconfigRegistryEnvsStayWired(t *testing.T) {
	env := composeServerEnvironment(t)
	keys := deployconfig.Keys()
	if len(keys) < 12 {
		t.Fatalf("deployconfig 注册表只有 %d 项（判据锚点漂移：注册表被摘空/改名了）", len(keys))
	}
	for _, k := range keys {
		if k.Env == "" {
			t.Errorf("%s 没有声明 Env：存量 .env 的覆盖口会断（每个注册项都必须有历史 env 名）", k.Setting)
			continue
		}
		v, ok := env[k.Env]
		if !ok {
			t.Errorf("%s（控制台键 %s）不在 %s 的 server.environment 里 —— 它是存量 .env 的"+
				"历史覆盖口，删掉后旧 .env 静默失效（新部署不设置它，但存量部署会）",
				k.Env, k.Setting, composePath)
			continue
		}
		if !strings.Contains(v, "${"+k.Env) {
			t.Errorf("%s 的取值是 %q —— 必须写成 ${%s:-} 才能让存量 .env 继续生效"+
				"（写死默认值等于换一种方式无视 .env）", k.Env, v, k.Env)
		}
		// 两个清单语义相反：历史覆盖口必须接线，豁免清单是"故意不接线"。
		// 同时出现 ⇒ 判据自相矛盾（无论是哪一边过期，都必须有人来收口）。
		if reason, exempt := zeokeelEnvExemptions[k.Env]; exempt {
			t.Errorf("%s 同时出现在 deployconfig 注册表与 zeokeelEnvExemptions（%s）——"+
				"注册表的键是历史覆盖口、必须接线，请删掉这条豁免", k.Env, reason)
		}
	}
}

// TestEnvExampleListsHistoricalOverrides 判"文档面也把覆盖口留住了"：
// server/.env.example 的「历史覆盖口」清单必须逐一列出注册表里的 env 名。
//
// 为什么值得一条判据：.env.example 是部署时唯一被复制成 .env 的模板，运维改配置时先看
// 它。清单漏一个键，等于告诉存量部署"这个名字不存在了"——而它其实还在生效（或更糟：
// 被顺手删掉）。
func TestEnvExampleListsHistoricalOverrides(t *testing.T) {
	const envExamplePath = "../../.env.example"
	raw, err := os.ReadFile(envExamplePath)
	if err != nil {
		t.Fatalf("读 %s: %v", envExamplePath, err)
	}
	text := string(raw)
	var missing []string
	for _, k := range deployconfig.Keys() {
		if k.Env == "" || !strings.Contains(text, k.Env) {
			missing = append(missing, fmt.Sprintf("%s（%s）", k.Env, k.Setting))
		}
	}
	if len(missing) > 0 {
		t.Errorf("%s 的「历史覆盖口」清单漏了这些键（存量部署会以为它们不存在）:\n  %s",
			envExamplePath, strings.Join(missing, "\n  "))
	}
}

// zeokeelEnvExemptions 是**故意不接进 compose** 的 ZEOKEEL_* 名字，每条必须写明理由。
//
// 注意它与 deployconfig 注册表的口径**相反**：注册表里的 12 个键是**历史覆盖口**，
// 必须接线（存量 .env 靠它们），一律不得进这张豁免清单 —— 判据
// TestDeployconfigRegistryEnvsStayWired 会拦住自相矛盾的条目。
//
// 判据的取向是"服务端源码提到的每个 ZEOKEEL_* 名字都要有归宿"：接线（compose 里能看见）
// 或豁免（这里能看见理由）。两边都没有 = 又一个"文档/代码里有、部署里够不到"的旋钮。
var zeokeelEnvExemptions = map[string]string{
	// 镜像内路径：由 Dockerfile 的 ENV 提供（不是运维旋钮）。
	"ZEOKEEL_CHANNEL_DIR":        "镜像内渠道内容目录（Dockerfile ENV ZEOKEEL_CHANNEL_DIR）",
	"ZEOKEEL_CLIENT_RELEASE_DIR": "镜像内客户端安装包目录（Dockerfile ENV ZEOKEEL_CLIENT_RELEASE_DIR）",
	"ZEOKEEL_CHANNEL_FILE":       "镜像内渠道声明文件路径（Dockerfile 落盘，见 updatecheck）",
	"ZEOKEEL_DEMO_APPS_DIR":      "镜像内内置演示应用目录（Dockerfile 打进 /opt/zeokeel/demo-apps）",
	// 编译子进程内部参数：由 verify/compile 的实参传递，父进程环境里的同名值**不被读取**
	// （见 internal/wasmapp/compile/env.go 的注释），所以它不是部署旋钮。
	"ZEOKEEL_COMPILE_MEMORY_PAGES": "编译子进程的内存上限（由父进程以实参注入，父环境同名值不生效）",
	// 已废除：写进 .env 会被启动自检大声告警并给出清理命令（cmd/server/legacy_config.go）。
	// 故意不接线 —— 接线等于给废除开关续命。
	"ZEOKEEL_APPS_BASE_DOMAIN":         "已废除（legacy_config.go 告警 + 清理命令）",
	"ZEOKEEL_TRUSTED_PROXIES_EXPLICIT": "已废除（legacy_config.go 告警 + 清理命令）",
}

// zeokeelEnvLiteral 匹配 Go 源码里的 ZEOKEEL_* 名字字面量（含 const 声明 ——
// 经由常量的读取同样是一句"这个键存在"，判据不该因为写法不同而漏掉）。
var zeokeelEnvLiteral = regexp.MustCompile(`"ZEOKEEL_[A-Z0-9_]+"`)

// zeokeelEnvNamesInSource 从一份 Go 源码里取出 ZEOKEEL_* 名字字面量。
//
// **整行注释不算**（2026-10-23 追加）：`deployconfig` 的包注释用
// os.Getenv 举例（`os.Getenv("ZEOKEEL_X")`），注释里的示例名不是可配置项。此前那是要给它
// 登记一条豁免才能过 —— 等于为一句说明性文字养肥豁免清单，而豁免清单越肥，
// "真的漏接线"越难被看见。
func zeokeelEnvNamesInSource(raw string) []string {
	var out []string
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		for _, m := range zeokeelEnvLiteral.FindAllString(line, -1) {
			out = append(out, strings.Trim(m, `"`))
		}
	}
	return out
}

// TestEveryServerZEOKEELEnvNameIsWiredOrExempt 是 R16C-06 的通用判据：
// 服务端源码里提到的每个 ZEOKEEL_* 名字，要么在 compose 的 server.environment 里，
// 要么在豁免清单里（带理由）。
func TestEveryServerZEOKEELEnvNameIsWiredOrExempt(t *testing.T) {
	env := composeServerEnvironment(t)

	roots := []string{filepath.Join("..", "..", "internal"), filepath.Join("..", "..", "cmd")}
	seen := map[string]string{} // 名字 -> 首个出现的相对路径（报错时指路）
	for _, root := range roots {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				// 跳过生成物/依赖目录；vendor 里不会有我们的 env 名。
				if base := info.Name(); base == "webadmin" || base == "node_modules" || base == "testdata" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			raw, rerr := os.ReadFile(path)
			if rerr != nil {
				return rerr
			}
			for _, name := range zeokeelEnvNamesInSource(string(raw)) {
				if _, ok := seen[name]; !ok {
					seen[name] = path
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("遍历 %s: %v", root, err)
		}
	}
	if len(seen) < 10 {
		t.Fatalf("只扫到 %d 个 ZEOKEEL_* 名字（判据锚点漂移：源码扫描没生效）", len(seen))
	}

	var unwired []string
	for name, where := range seen {
		if _, ok := env[name]; ok {
			continue
		}
		if _, ok := zeokeelEnvExemptions[name]; ok {
			continue
		}
		unwired = append(unwired, name+" ("+where+")")
	}
	sort.Strings(unwired)
	if len(unwired) > 0 {
		t.Errorf("这些 ZEOKEEL_* 名字既不在 %s 的 server.environment 里、也没有豁免理由："+
			"写进 .env 会静默不生效（接线写成 `ZEOKEEL_X: ${ZEOKEEL_X:-}`，或在 zeokeelEnvExemptions 里写明为什么它不是部署旋钮）:\n  %s",
			composePath, strings.Join(unwired, "\n  "))
	}

	// 反向守卫：豁免清单不得**陈旧**（一个已经接线的键留在豁免里 = 下一次漏接线的温床）。
	for name := range zeokeelEnvExemptions {
		if _, wired := env[name]; wired {
			t.Errorf("%s 已经接线，但仍留在豁免清单里 —— 请从 zeokeelEnvExemptions 删掉", name)
		}
	}
	// 豁免清单里的名字也必须真的还在源码里出现（否则是死条目）。
	for name := range zeokeelEnvExemptions {
		if _, ok := seen[name]; !ok {
			t.Errorf("豁免清单里的 %s 在服务端源码里已经不存在 —— 请删掉这条死豁免", name)
		}
	}
}
