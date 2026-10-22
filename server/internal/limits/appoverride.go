// 本文件定义**应用级限流覆盖的取值形态**（决策
// docs/decisions/2026-10-22-wasm-per-app-limits.md §2.1）。
//
// 为什么类型住在 limits 包（而不是 applimits）：
//
//	applimits 校验"全局 + 覆盖"的**组合**，而它本来就 import readyz；readyz 又
//	import queue（`Options.Scheduler *queue.Scheduler`），queue 需要持有覆盖表
//	⇒ 若覆盖类型定义在 applimits，queue → applimits 会与 applimits → readyz → queue
//	构成**导入环**。把"四个 int + 继承语义"这个**纯数据**放进叶子包 limits（它本来
//	就是这些数值的唯一真源），三边都能用同一份类型：queue 直接持有它，applimits 用
//	`type AppOverride = limits.AppOverride` 别名暴露（方法集、JSON 键完全同一份），
//	没有第二份定义可漂移。
//
// 语义（0 = 继承）：四轴都是并发/容量，0 在任何合法组合里都不成立，因此可以当哨兵。
package limits

// AppOverride 是**单个应用**的限流覆盖：四个并发轴，**0 = 继承全局**。
//
// 字段名（JSON 键）是跨语言契约：管理端表单与 `PUT /wasm-apps/:app_id/limits`
// 的请求体与它逐字对齐；与 applimits.Limits 的同名轴同义。
type AppOverride struct {
	// AppRunning 覆盖单应用同时运行数（0 = 继承）。
	AppRunning int `json:"app_running"`
	// AppQueue 覆盖单应用队列长度（0 = 继承）。
	AppQueue int `json:"app_queue"`
	// UserPerAppRunning 覆盖单用户单应用在跑（0 = 继承）。
	UserPerAppRunning int `json:"user_per_app_running"`
	// UserPerAppQueued 覆盖单用户单应用排队（0 = 继承）。
	UserPerAppQueued int `json:"user_per_app_queued"`
}

// AppOverrideFieldNames 返回覆盖的字段名（顺序即表单顺序）。
//
// 它是**唯一清单**：解析（未知键 fail-loud）、审计明细、管理端视图与测试都读它，
// 任何一处另写一份都会在"新增第五个轴"时漂移。
func AppOverrideFieldNames() []string {
	return []string{"app_running", "app_queue", "user_per_app_running", "user_per_app_queued"}
}

// IsZero 报告"没有覆盖"（四轴全 0 = 全部继承全局）。
func (o AppOverride) IsZero() bool { return o == AppOverride{} }

// Equal 是**幂等判定的唯一实现**：同一份覆盖（0 与 0 相等）为 true。
//
// 为什么需要它：保存路径要回答"这次 PUT 有没有改变任何东西" —— 无变化就不写审计、
// 也不重复下发（决策 §2.6 第 5 条）。
func (o AppOverride) Equal(other AppOverride) bool { return o == other }

// Axes 是**四个并发轴**的取值集合（全局值 / 生效值都用它表达）。
//
// 它存在的唯一理由：让"套用覆盖"这条规则只实现一次（`Axes.Resolve`），
// applimits.ApplyOverride 与 queue.effectiveOptionsLocked 都调它 —— 两边各写一遍
// `if ov.X > 0` 的话，"继承的轴要不要跟着父轴收紧"这种细节必然漂移。
type Axes struct {
	AppRunning        int
	AppQueue          int
	UserPerAppRunning int
	UserPerAppQueued  int
}

// Resolve 返回"全局四轴 + 本应用覆盖"的**生效值**。
//
// 两条规则（第二条是 2026-10-22 的关键细节，见下面的说明）：
//
//	① 非 0 的覆盖轴直接生效（0 = 继承）；
//	② **继承的**子轴在父轴被收紧时**向下钳**到父轴：
//	   `user_per_app_running ≤ app_running`、`user_per_app_queued ≤ app_queue`。
//
// 为什么必须有 ②：`app_running=1`（把一个应用整体降成串行）是决策 §2.6 第 4 条的
// 原样用例，而全局的 `user_per_app_running` 默认是 2 —— 若不做 ②，这条合法且最常用的
// 收紧会被判成"非法组合"（2 > 1），管理员只能再手填一遍子轴，且一旦全局默认值变化
// 就要重新填。**向下钳只会收紧、永不放宽**，因此这是 fail-closed 方向。
//
// 反过来说：**显式**给出的子轴不会被钳（例如显式 `user_per_app_running=3` 配
// `app_running=2`）—— 那是管理员明确要的组合，按 `Validate` 拒（fail-loud，
// 绝不静默把它改成 2）。
func (a Axes) Resolve(o AppOverride) Axes {
	out := a
	if o.AppRunning > 0 {
		out.AppRunning = o.AppRunning
	}
	if o.AppQueue > 0 {
		out.AppQueue = o.AppQueue
	}
	if o.UserPerAppRunning > 0 {
		out.UserPerAppRunning = o.UserPerAppRunning
	} else if out.AppRunning > 0 && out.UserPerAppRunning > out.AppRunning {
		out.UserPerAppRunning = out.AppRunning
	}
	if o.UserPerAppQueued > 0 {
		out.UserPerAppQueued = o.UserPerAppQueued
	} else if out.AppQueue > 0 && out.UserPerAppQueued > out.AppQueue {
		out.UserPerAppQueued = out.AppQueue
	}
	return out
}

// Value 返回某字段在该覆盖上的值（0 = 继承；未知字段返回 0）。
//
// 单一取值点：校验、审计明细与测试都用它读某一轴，避免"三个 switch 各写一遍"。
func (o AppOverride) Value(field string) int {
	switch field {
	case "app_running":
		return o.AppRunning
	case "app_queue":
		return o.AppQueue
	case "user_per_app_running":
		return o.UserPerAppRunning
	case "user_per_app_queued":
		return o.UserPerAppQueued
	}
	return 0
}
