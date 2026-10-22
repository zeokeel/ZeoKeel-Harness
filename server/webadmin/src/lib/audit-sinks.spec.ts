import { describe, expect, it } from 'vitest'
import { ACTION_LABEL } from '../pages/Audit'
import {
  analyzeAuditGraph,
  blankComments,
  deriveStoreAppenders,
  scanCalls,
  findAuditActionFields,
  findAuditRowWriters,
  type AuditSinkSeed,
  type GoSourceFile,
} from './audit-sinks'

// 审计 R13-F F-07 / W-2 的**判据自证**：用合成 Go 源码夹具（可读、可改、不依赖真实
// 服务端树）证明"动作名经参数传入本地包装"这一形态**必被发现**，并且不被发现时会
// 让审计页的标签判据变红。
//
// 形态直接取自 R13-F 的实测探针（W-P5c）：
//   func probeAuditWrapper2(db *sql.DB, username, action, detail string) {
//       _ = serverstore.AuditLog(db, username, action, detail)
//   }
//   probeAuditWrapper2(db, adminUsername(c), "probe_new_action2", conn.ID)
// 旧抽取器（只认 sink 动作实参位上的字面量）看不见 probe_new_action2 ⇒ 假绿。

/** 与 `Audit.test.tsx` 的 `AUDIT_SINKS` 同形的最小种子集。 */
const SEEDS: AuditSinkSeed[] = [
  { name: 'AuditLog', actionArg: 2 },
  { name: 'auditLog', actionArg: 3 },
  { name: 'AuditLogApp', actionArg: 3 },
  { name: 'AuditLogTx', actionArg: 2 },
  { name: 'auditApp', actionArg: 2 },
  { name: 'auditOrg', actionArg: 1 },
  { name: 'Audit', actionArg: 1 },
]

const WRAPPERS: GoSourceFile = {
  path: 'internal/connectors/admin.go',
  text: `package connectors

import (
	"database/sql"
	"log"
)

// 一层包装：动作作为形参透传进已登记 sink。
func probeAuditWrapper2(db *sql.DB, username, action, detail string) {
	_ = serverstore.AuditLog(db, username, action, detail)
}

// 两层包装：动作继续以形参向上透传。
func probeAuditWrapper3(db *sql.DB, username, action, detail string) {
	probeAuditWrapper2(db, username, action, detail)
}

// 参数换位：action 不在最后一位。
func probeAuditReordered(db *sql.DB, action, username string) {
	_ = serverstore.AuditLog(db, username, action, "")
}

// *Tx 变体（签名 (tx, username, action, detail)）。
func probeAuditTx(tx *sql.Tx, action string) {
	_ = serverstore.AuditLogTx(tx, "boss", action, "")
}

// 应用维度 + 组织级出口。
func probeAuditApp(appID, action string) {
	_ = serverstore.AuditLogApp(nil, appID, "boss", action, "")
}

// 反例：同名 action 形参但**没有**流向任何写入点 ⇒ 不许被当成审计动作。
func probeNotAudit(action string) {
	log.Println(action)
}

func probeCallSites(db *sql.DB, c *gin.Context, conn Conn) {
	probeAuditWrapper2(db, adminUsername(c), "probe_new_action2", conn.ID)
	probeAuditWrapper3(db, adminUsername(c), "probe_new_action3", conn.ID)
	probeAuditReordered(db, "probe_reordered_action", adminUsername(c))
	probeAuditTx(nil, "probe_tx_action")
	probeAuditApp("demo", "probe_app_action")
	probeNotAudit("probe_not_audit")
	_ = serverstore.AuditLog(db, adminUsername(c), "probe_direct_action", conn.ID)
}
`,
}

const GRAPH = analyzeAuditGraph([WRAPPERS], SEEDS)
const FOUND = [...GRAPH.actions.keys()].sort()

describe('审计 sink 调用图闭包（合成夹具自证）', () => {
  it('包装函数把 sink 作为参数传入 ⇒ 动作名必须被抽出来（一层/两层/换位/*Tx/App 变体全在内）', () => {
    expect(FOUND).toEqual([
      'probe_app_action',
      'probe_direct_action',
      'probe_new_action2',
      'probe_new_action3',
      'probe_reordered_action',
      'probe_tx_action',
    ])
    // 位置信息指向**调用点**（而不是 sink 自己的定义处），便于排障。
    expect(GRAPH.actions.get('probe_new_action2')).toContain('internal/connectors/admin.go')
  })

  it('反例：同名 action 形参但没流向写入点 ⇒ 不算审计动作（真·数据流而不是"扫字符串"）', () => {
    expect(FOUND).not.toContain('probe_not_audit')
    // 同一份源码里"probe_not_audit"是实打实存在的字符串 —— 证明判据不是"文件里出现过的串"。
    expect(WRAPPERS.text).toContain('"probe_not_audit"')
  })

  it('抽出来的动作若没有中文标签 ⇒ 审计页判据必红（这就是 R13-F 的假绿被堵住的地方）', () => {
    const unlabeled = FOUND.filter((a) => !(a in ACTION_LABEL))
    expect(unlabeled).toContain('probe_new_action2')
    expect(unlabeled.length).toBe(FOUND.length)
  })

  it('闭包自证：载体参数位被正确标出（换位参数也认得出）', () => {
    const entries = [...GRAPH.carriers.entries()].map(([id, idxs]) => `${id.split('|').pop()}:${idxs.join(',')}`)
    expect(entries).toContain('probeAuditWrapper2:2')
    expect(entries).toContain('probeAuditWrapper3:2')
    expect(entries).toContain('probeAuditReordered:1')
    expect(entries).toContain('probeAuditTx:1')
    expect(entries.some((e) => e.startsWith('probeNotAudit'))).toBe(false)
  })
})

// 反证 F-7：动作名不是字面量，而是**包级 const**（`retirement/scheduler.go` 的
// `const auditAction = "wasm_app_purge"`）。旧判据只认承载位上的 `"…"` 字面量 ⇒ 整条写点
// 在真源上不可见，于是"新增写点必须补中文标签"这条判据永远绿。
const CONST_ACTION: GoSourceFile = {
  path: 'internal/wasmapp/retirement/scheduler.go',
  text: `package retirement

const auditAction = "wasm_app_purge"

// auditActor 是**执行者**（不是动作名）：它落在 4 参签名的下标 1 上，
// 必须**不能**被当成"待补标签的动作"（按实参个数消歧）。
const auditActor = "system"

const auditNotAnAction = "just_a_value_with_underscores"

const threeArgAction = "wasm_app_three_arg"

const (
	tickAction  string = "wasm_app_purge_tick"
	otherAction        = "wasm_app_purge_other"
)

type Options struct {
	Audit func(appID, username, action, detail string) error
}

// 同一出口名的**另一种签名**（3 参：动作在下标 1）—— 消歧必须按实参个数做，
// 不能把两种签名混成一个载体位集合。
type LegacyOptions struct {
	Audit func(username, action, detail string) error
}

func (s *Scheduler) run(opt Options, legacy LegacyOptions, appID string) {
	_ = opt.Audit(appID, auditActor, auditAction, "detail")
	_ = opt.Audit(appID, "boss", tickAction, "detail")
	_ = opt.Audit(appID, auditNotAnAction, otherAction, "detail")
	_ = opt.Audit(appID, "boss", undefinedConst, "detail")
	_ = opt.Audit(appID, "boss", "wasm_app_literal_action", "detail")
	_ = legacy.Audit("boss", threeArgAction, "detail")
}
`,
}

/**
 * 这份夹具的 `Audit` 字段签名是 `func(appID, username, action, detail)`（动作在 2）——
 * 正是 `retirement.Scheduler` 的形态。SEEDS 里默认只登记了 3 参形态（动作在 1），
 * 这里补上 4 参形态（与 `Audit.test.tsx` 的 `AUDIT_FORWARDING_SINKS` 同一份登记表）。
 */
const CONST_SEEDS: AuditSinkSeed[] = [...SEEDS, { name: 'Audit', actionArg: 2 }]
const CONST_GRAPH = analyzeAuditGraph([CONST_ACTION], CONST_SEEDS)

describe('动作名是包级常量时也必须被抽出来（反证 F-7）', () => {
  it('同包 const 实参 ⇒ 值被当作动作名（单条声明 / const 分组 / 带类型标注都在内）', () => {
    const found = [...CONST_GRAPH.actions.keys()].sort()
    expect(found).toContain('wasm_app_purge')
    expect(found).toContain('wasm_app_purge_tick')
    expect(found).toContain('wasm_app_purge_other')
    // 位置指向**常量声明处**（排障时直接跳过去改动作名）。
    expect(CONST_GRAPH.actions.get('wasm_app_purge')).toBe('internal/wasmapp/retirement/scheduler.go:3')
  })

  it('按实参个数消歧：执行者常量不会变成动作名，3 参签名自己那条照样认得出', () => {
    const found = [...CONST_GRAPH.actions.keys()]
    // 4 参调用 ⇒ 只认下标 2；下标 1 的 `auditActor="system"` / `auditNotAnAction="just_…"`
    // 都落在"用户名字段"上，不是动作名。
    expect(found).not.toContain('system')
    expect(found).not.toContain('just_a_value_with_underscores')
    // 3 参签名（动作在下标 1）自己那条照样认得出。
    expect(found).toContain('wasm_app_three_arg')
    // 未定义的标识符解析不出来 ⇒ 不会凭空造一个动作名。
    expect(found).not.toContain('undefinedConst')
    // 字面量路径不受影响（两种形态并存）。
    expect(found).toContain('wasm_app_literal_action')
  })

  it('反证：只认字面量的旧口径在这份夹具里只能看到 1 条，新口径能看到 5 条', () => {
    const literalOnly = new Set<string>()
    for (const call of scanCalls(blankComments(CONST_ACTION.text))) {
      const arg = call.args[2]?.trim()
      const m = arg === undefined ? null : /^"([^"]*)"$/u.exec(arg)
      if (m !== null) literalOnly.add(m[1]!)
    }
    expect([...literalOnly]).toEqual(['wasm_app_literal_action', 'detail'])
    expect([...CONST_GRAPH.actions.keys()].sort()).toEqual([
      'wasm_app_literal_action',
      'wasm_app_purge',
      'wasm_app_purge_other',
      'wasm_app_purge_tick',
      'wasm_app_three_arg',
    ])
  })
})

describe('审计写入面派生（合成夹具自证）', () => {
  const STORE_V1: GoSourceFile = {
    path: 'internal/serverstore/audit.go',
    text: `package serverstore

func auditLog(db *sql.DB, appID, username, action, detail string) error {
	_, err := db.Exec("INSERT INTO audit_logs (username, action) VALUES (?, ?)", username, action)
	return err
}

func AuditLog(db *sql.DB, username, action, detail string) error {
	return auditLog(db, "", username, action, detail)
}

func writeAuditBatch(db *sql.DB, batch []auditRequest) []error {
	_, err := db.Exec("INSERT INTO audit_logs (username, action) VALUES (?, ?)", "", "")
	return err
}
`,
  }
  /** 同一个文件 + 一个新写的 store 追加 API（"新增一个能写审计行的函数"）。 */
  const STORE_V2: GoSourceFile = {
    path: 'internal/serverstore/audit.go',
    text: `${STORE_V1.text}
func AuditLogAdmin(db *sql.DB, username, action, detail string) error {
	return auditLog(db, "", username, action, detail)
}
`,
  }

  it('派生集合 = 声明 action 形参且能到达 INSERT 的函数（plumbing 不入集合）', () => {
    expect([...deriveStoreAppenders(STORE_V1).entries()].sort()).toEqual([['AuditLog', 2], ['auditLog', 3]])
    // writeAuditBatch 直写 INSERT 但动作来自结构体字段 ⇒ 不能当"动作形参 sink"。
    expect([...deriveStoreAppenders(STORE_V1).keys()]).not.toContain('writeAuditBatch')
    // 行写入点 = 函数体里直接出现 INSERT 的函数（转发者不算，它自己不写行）。
    expect([...findAuditRowWriters([STORE_V1]).keys()].sort()).toEqual(['auditLog', 'writeAuditBatch'])
    expect(findAuditRowWriters([STORE_V1]).get('writeAuditBatch')?.actionArg).toBeNull()
  })

  it('新增一个能写审计行的函数 ⇒ 派生集合变大（未登记即红的能力在这里）', () => {
    const before = [...deriveStoreAppenders(STORE_V1).keys()].sort()
    const after = [...deriveStoreAppenders(STORE_V2).keys()].sort()
    const registered = ['AuditLog', 'auditLog', 'AuditLogApp', 'AuditLogTx']
    expect(after.filter((n) => !registered.includes(n))).toEqual(['AuditLogAdmin'])
    expect(before).not.toContain('AuditLogAdmin')
  })

  it('func(… action …) 型注入出口可派生（新增出口字段不登记即红的能力在这里）', () => {
    const withField: GoSourceFile = {
      path: 'internal/wasmapp/api/handlers.go',
      text: `package api

type Options struct {
	Audit   func(username, action, detail string)
	AuditV2 func(username, action, detail string)
	Now     func() time.Time
	Logger  func(format string, args ...any)
}
`,
    }
    const derived = findAuditActionFields([withField])
    expect([...derived.keys()].sort()).toEqual(['Audit', 'AuditV2'])
    expect(derived.get('Audit')?.actionArg).toBe(1)
  })
})
