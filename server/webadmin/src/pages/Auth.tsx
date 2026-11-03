import { useCallback, useEffect, useId, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { SecretInput } from '../components/secret-input'
import { PageHeader } from '../components/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Switch } from '../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useFlash } from '../lib/use-flash'
import { copyText } from '../lib/clipboard'

// 认证配置页(v3b): Tab 分区 + 启用绑定配置 + hide_local。
// 登录面矩阵: 客户端 = 全部已启用方式(local 可被 hide_local 隐藏);
// 管理后台 = 恒仅本地账户(SSO/LDAP/扫码一律不进后台, 服务端强制)。
//
// 2026-11-03: 新增企业微信/钉钉扫码登录(设计 docs/planning/
// 2026-11-03-wecom-dingtalk-qr-login.md §6)。两页的「回调地址」由 location.origin
// 推导并配复制按钮 —— 该值必须与管理员在服务商后台登记的回调地址逐字一致,
// 手抄错一个字符, 手机扫码后的回调就会 404 或 state 校验失败。

interface AuthConfig {
  mode?: string
  enabled?: string
  hide_local?: boolean
  /** G14: 密码最小长度(8~64,缺失=默认 10)。 */
  min_password_length?: number
  ldap?: Record<string, string>
  oidc?: Record<string, string>
  openid?: Record<string, string>
  /** 企业微信扫码(设计 §3): corp_id/agent_id/secret/redirect_url; secret 读面掩码 ***。 */
  wecom?: Record<string, string>
  /** 钉钉扫码(设计 §3): client_id/client_secret/redirect_url; client_secret 读面掩码 ***。 */
  dingtalk?: Record<string, string>
  /**
   * 外部权限源(RBAC, 2026-11-03): 扫码登录后由服务端向 RBAC 解析 uid/状态/部门。
   * 默认关闭；关闭时扫码仍走现有直连逻辑。token 读面为 *** 掩码。
   */
  identity?: {
    enabled?: boolean
    endpoint?: string
    token?: string
    methods?: string
    timeout_ms?: number
    sync_groups?: boolean
    /** 已以 RBAC uid 建立的外部用户数；>0 时关闭开关需要显式确认。 */
    rbac_user_count?: number
  }
}

/** 外部权限源(RBAC)的本地表单状态。token 单独走 SecretField，不与 provider 字段混放。 */
interface IdentityForm {
  enabled: boolean
  endpoint: string
  token: string
  methods: QrMethod[]
  timeoutMs: number
  syncGroups: boolean
  /** 服务端读回的「已有 RBAC 用户数」，只读，用来做关闭保护。 */
  rbacUserCount: number
}

/** POST /auth/test（type=identity）的返回。 */
interface IdentityTestResult {
  ok: boolean
  message?: string
  uid?: string
  name?: string
  status?: number
  departments?: string[]
}

interface FormState {
  hideLocal: boolean
  ldap: Record<string, string>
  oidc: Record<string, string>
  openid: Record<string, string>
  wecom: Record<string, string>
  dingtalk: Record<string, string>
}

type MethodKey = 'local' | 'ldap' | 'oidc' | 'openid' | 'wecom' | 'dingtalk'
type IdpKey = Exclude<MethodKey, 'local'>
type QrMethod = 'wecom' | 'dingtalk'

// 测试连接返回(ldap 目录统计)
interface ConnTestResult {
  ok: boolean
  message: string
  users?: number
  groups?: number
  sample?: Array<{ username: string; display_name?: string; email?: string; groups?: string[] }>
}

const EMPTY_FORM: FormState = {
  hideLocal: false,
  ldap: {},
  oidc: {},
  openid: {},
  wecom: {},
  dingtalk: {},
}

// 外部权限源默认值: 关闭 + 默认两种扫码方式都适用 + 3s 超时 + 同步部门为组。
const EMPTY_IDENTITY: IdentityForm = {
  enabled: false,
  endpoint: '',
  token: '',
  methods: ['wecom', 'dingtalk'],
  timeoutMs: 3000,
  syncGroups: true,
  rbacUserCount: 0,
}

const RBAC_METHODS: QrMethod[] = ['wecom', 'dingtalk']

function parseIdentityMethods(raw?: string): QrMethod[] {
  // 未下发 = 默认两种都适用(新部署); 显式空串 = 用户清空了全部方式(保存时会被拒绝)。
  if (raw === undefined) return [...RBAC_METHODS]
  const picked = raw.split(',').map((s) => s.trim()).filter((s): s is QrMethod => s === 'wecom' || s === 'dingtalk')
  return picked
}

// 各 IdP 必填项判定(未配齐 → 启用开关禁用)
const REQUIRED: Record<IdpKey, string[]> = {
  ldap: ['server_url', 'bind_dn', 'base_dn'],
  oidc: ['issuer', 'client_id', 'redirect_url'],
  openid: ['issuer', 'client_id', 'redirect_url'],
  wecom: ['corp_id', 'agent_id', 'secret', 'redirect_url'],
  dingtalk: ['client_id', 'client_secret', 'redirect_url'],
}

// 密钥字段 → 表单字段名 / secrets 状态键。启用判定必须认「已存掩码」:
// 读配置时 *** 只标记已设置、不回填输入框, 只看表单值会把已配好的方式误判成不完整。
const SECRET_FIELD: Partial<Record<IdpKey, string>> = {
  ldap: 'bind_password',
  oidc: 'client_secret',
  openid: 'client_secret',
  wecom: 'secret',
  dingtalk: 'client_secret',
}
const SECRET_STATE: Partial<Record<IdpKey, string>> = {
  ldap: 'ldap_password',
  oidc: 'oidc_secret',
  openid: 'openid_secret',
  wecom: 'wecom_secret',
  dingtalk: 'dingtalk_secret',
}

const METHOD_META: Record<MethodKey, { label: string; desc: string }> = {
  local: { label: '本地账号', desc: '后台恒启用; 客户端可隐藏' },
  ldap: { label: 'LDAP', desc: '企业目录认证(仅员工面)' },
  oidc: { label: 'OIDC', desc: '浏览器跳转登录(仅客户端)' },
  openid: { label: 'OpenID', desc: '浏览器跳转登录(仅客户端)' },
  wecom: { label: '企业微信', desc: '扫码登录(仅客户端)' },
  dingtalk: { label: '钉钉', desc: '扫码登录(仅客户端)' },
}

// 「测试连接」只对有发现/绑定握手的方式有意义; 扫码方式没有可探测端点(设计 §6 未定义)。
const TESTABLE_TABS = new Set<string>(['ldap', 'oidc', 'openid'])

// 扫码回调地址(客户端面): 服务商后台登记的 redirect_uri 必须与它逐字一致。
// 取 location.origin 而不是已保存的 redirect_url: 管理员此刻打开管理端用的就是
// 对外地址, 复制这一份最不容易错(服务端保存时仍会校验 https/回环 http)。
function callbackUrl(method: QrMethod): string {
  return `${location.origin}/api/client/v2/auth/${method}/callback`
}

export default function Auth() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [enabled, setEnabled] = useState<string[]>(['local'])
  const [minPasswordLength, setMinPasswordLength] = useState(10)
  const [authErr, setAuthErr] = useState('')
  // P3: flash 定时器由 useFlash 统一清理。
  const [authMsg, setAuthMsg] = useFlash(4000)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  // 2026-09-23 审计 WEB-2(P0):`finally { setLoading(false) }` 曾是整页**唯一**的
  // 渲染闸门 ⇒ `GET /auth` 失败后表单照样渲染并解锁,而此时的初值是最空的一份
  // (`enabled=['local']`、`EMPTY_FORM`、`secrets={}`),前端校验只遍历"启用中的
  // 非 local"(空循环直接过)⇒ 一次「保存认证配置」就把 `auth.enabled` 收敛成
  // `local`、清空 LDAP/OIDC/OpenID 全部字段,并用**空串的密文覆盖已存密钥**
  // (不可恢复,全员 SSO/LDAP 登录当场失败)。与 Gateway/ErrorMonitoring 同口径:
  // **成功才解锁**。`cfgLoaded` 只在成功分支置 true,失败分支置 false。
  const [cfgLoaded, setCfgLoaded] = useState(false)
  const [tab, setTab] = useState('local')
  // 密码/密钥是否「已设置」(服务端掩码 *** 表示已存值,不能回填进输入框)
  const [secrets, setSecrets] = useState<Record<string, 'has-value' | 'unset'>>({})
  // 用户显式"清空"的密钥(保存时提交空串覆盖)
  const [clearedSecrets, setClearedSecrets] = useState<Record<string, boolean>>({})
  // 回调地址复制回执(按方式区分, 切页不串台; 定时器由 useFlash 统一清理)。
  const [copiedTag, flashCopied] = useFlash(2500)
  const [copyErr, setCopyErr] = useState('')
  // 外部权限源(RBAC): 表单 + 服务端原始开关(判断「从开改关」是否需要二次确认)。
  const [identity, setIdentity] = useState<IdentityForm>(EMPTY_IDENTITY)
  const [identityWasEnabled, setIdentityWasEnabled] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  // 「测试解析」面板: provider + 渠道身份 + 结果。
  const [testProvider, setTestProvider] = useState<QrMethod>('wecom')
  const [testProviderUserID, setTestProviderUserID] = useState('')
  const [testUnionID, setTestUnionID] = useState('')
  const [testMobile, setTestMobile] = useState('')
  const [identityTesting, setIdentityTesting] = useState(false)
  const [identityTestResult, setIdentityTestResult] = useState<IdentityTestResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setAuthErr('')
    try {
      const r = await request(`${ADMIN_API}/auth`) as { auth?: AuthConfig }
      const a = r.auth ?? {}
      setMinPasswordLength(a.min_password_length || 10)
      setEnabled((a.enabled ?? 'local').split(',').map((s) => s.trim()).filter(Boolean))
      setForm({
        hideLocal: a.hide_local ?? false,
        ldap: nonSecret(a.ldap ?? {}),
        oidc: nonSecret(a.oidc ?? {}),
        openid: nonSecret(a.openid ?? {}),
        wecom: nonSecret(a.wecom ?? {}),
        dingtalk: nonSecret(a.dingtalk ?? {}),
      })
      // 外部权限源(RBAC): token 与其它密钥同语义(*** = 已存,不回填)。
      const ident = a.identity ?? {}
      setIdentity({
        enabled: ident.enabled ?? false,
        endpoint: ident.endpoint ?? '',
        token: '',
        methods: parseIdentityMethods(ident.methods),
        timeoutMs: ident.timeout_ms || 3000,
        syncGroups: ident.sync_groups ?? true,
        rbacUserCount: ident.rbac_user_count ?? 0,
      })
      setIdentityWasEnabled(ident.enabled ?? false)
      setConfirmDisable(false)
      setIdentityTestResult(null)
      // 服务端对已配置的密钥返回 *** → 标记「已设置」,输入框显示占位
      setSecrets({
        ldap_password: isSet(a.ldap?.bind_password),
        oidc_secret: isSet(a.oidc?.client_secret),
        openid_secret: isSet(a.openid?.client_secret),
        wecom_secret: isSet(a.wecom?.secret),
        dingtalk_secret: isSet(a.dingtalk?.client_secret),
        identity_token: isSet(ident.token),
      })
      setCfgLoaded(true) // WEB-2:读到真配置才解锁写面
    } catch (err: any) {
      setAuthErr(err.message)
      setCfgLoaded(false) // WEB-2:失败保持锁定(空初值不是"当前配置")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 掩码值不得回填进表单:回显 *** 会让下一次保存把 *** 当新密码写回
  // (服务端把 *** 解释为「保持现值」,但用户改过其它字段再保存时,输入框
  // 里的 *** 会被当密码……实测行:掩码只用于状态,不进 value)。
  function nonSecret(cfg: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg)) out[k] = v === '***' ? '' : v
    return out
  }
  function isSet(v?: string): 'has-value' | 'unset' {
    return v === '***' ? 'has-value' : 'unset'
  }

  // 密钥字段:输入框有新值 → 齐;否则看服务端「已存且未被显式清空」。
  const secretReady = (key: IdpKey): boolean => {
    const field = SECRET_FIELD[key]
    if (field && (form[key][field] ?? '').trim() !== '') return true
    const stateKey = SECRET_STATE[key]
    if (!stateKey || clearedSecrets[stateKey]) return false
    return secrets[stateKey] === 'has-value'
  }

  const isReady = (key: MethodKey): boolean => {
    if (key === 'local') return true
    return (REQUIRED[key] ?? []).every((f) =>
      SECRET_FIELD[key] === f ? secretReady(key) : (form[key][f] ?? '').trim() !== '',
    )
  }

  const toggle = (key: MethodKey, on: boolean) => {
    if (key === 'local') return // 恒启用
    setEnabled((prev) => on ? [...prev.filter((x) => x !== key), key] : prev.filter((x) => x !== key))
  }

  // ---- 外部权限源(RBAC) ----
  // 密钥语义与 OIDC/LDAP 完全一致: 新输入 → 提交新值; 已存且未清空/未重输 → ***
  // 保持现值; 显式清空 → 空串。顺序不能反: 用户「先清空、又输入新值」时必须提交新值。
  const identityTokenForSave = (): string => {
    if (identity.token.trim() !== '') return identity.token
    if (clearedSecrets.identity_token) return ''
    return secrets.identity_token === 'has-value' ? '***' : ''
  }
  const identityTokenReady = (): boolean =>
    identity.token.trim() !== '' || (!clearedSecrets.identity_token && secrets.identity_token === 'has-value')
  const identityTimeoutValid = (): boolean =>
    Number.isFinite(identity.timeoutMs) && identity.timeoutMs >= 200 && identity.timeoutMs <= 10000
  const identityReady = (): boolean =>
    identity.endpoint.trim() !== '' && identity.methods.length > 0 && identityTokenReady() && identityTimeoutValid()
  // 从「已启用」改成「关闭」且已有 RBAC 用户 → 必须显式勾选确认，否则拒绝保存。
  // 服务端还有一道 409 IDENTITY_USERS_EXIST 兜底（并发/绕过前端时）。
  const needsDisableConfirm = (): boolean =>
    identityWasEnabled && !identity.enabled && identity.rbacUserCount > 0
  // 「测试解析」用**已保存**的 endpoint/令牌(测试接口不接收 token 字段)。
  // 刻意不要求 enabled=true：管理员应先测通再启用；未保存令牌时才禁用，
  // 避免把「测试失败」误读成配置错误。
  const canTestIdentity = (): boolean =>
    identity.endpoint.trim() !== '' &&
    secrets.identity_token === 'has-value' && !clearedSecrets.identity_token
  const toggleIdentityMethod = (m: QrMethod, on: boolean) => {
    setIdentity((prev) => ({
      ...prev,
      methods: on ? [...prev.methods.filter((x) => x !== m), m] : prev.methods.filter((x) => x !== m),
    }))
  }

  const [testMsg, setTestMsg] = useState('')
  const [testDetail, setTestDetail] = useState<ConnTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  // 测试解析: 只把渠道身份发给服务端(服务端用已保存的 endpoint/令牌去查 RBAC)。
  async function testIdentity() {
    if (!canTestIdentity() || identityTesting) return
    setIdentityTesting(true)
    setIdentityTestResult(null)
    try {
      const r = await request(`${ADMIN_API}/auth/test`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'identity',
          provider: testProvider,
          provider_user_id: testProviderUserID.trim(),
          union_id: testUnionID.trim(),
          mobile: testMobile.trim(),
        }),
      }) as IdentityTestResult
      setIdentityTestResult(r)
    } catch (e: any) {
      setIdentityTestResult({ ok: false, message: e.message })
    } finally {
      setIdentityTesting(false)
    }
  }

  // v3b §1.2: 测试当前 Tab 提供方连接(不保存)。LDAP 传完整配置(含
  // 过滤器),密码留空/占位 = 用已保存的(服务端回读),不再把 *** 当密码。
  async function testConnection() {
    setTesting(true); setTestMsg(''); setAuthErr(''); setTestDetail(null)
    try {
      const body: any = { type: tab }
      if (tab === 'ldap') {
        body.ldap = {
          server_url: form.ldap.server_url,
          bind_dn: form.ldap.bind_dn,
          bind_password: form.ldap.bind_password,
          base_dn: form.ldap.base_dn,
          user_filter: form.ldap.user_filter,
          user_attr: form.ldap.user_attr,
          group_filter: form.ldap.group_filter,
          group_attr: form.ldap.group_attr,
        }
      }
      if (tab === 'oidc' || tab === 'openid') body.oidc = { issuer: tab === 'oidc' ? form.oidc.issuer : form.openid.issuer }
      const r = await request(`${ADMIN_API}/auth/test`, { method: 'POST', body: JSON.stringify(body) }) as ConnTestResult
      setTestMsg(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`)
      if (r.sample) setTestDetail(r)
    } catch (e: any) {
      setTestMsg(`✗ ${e.message}`)
    } finally { setTesting(false) }
  }

  // 复制回调地址: 走 lib/clipboard(内网 http 没有 navigator.clipboard 时回落
  // execCommand)。失败必须明说"请手动复制", 不能假装成功。
  async function copyCallback(method: QrMethod) {
    const ok = await copyText(callbackUrl(method))
    if (ok) {
      setCopyErr('')
      flashCopied(method)
      return
    }
    flashCopied('')
    setCopyErr('复制失败(浏览器未授予剪贴板权限):请手动选择上面的地址复制。')
  }

  async function saveAuth() {
    if (busy) return
    // WEB-2:没读到真配置时,表单里那份空初值不是"当前配置" —— 原地拒绝,
    // 不发那个必然抹掉 SSO 与密钥的请求(按钮/fieldset 已禁用,这里是兜底)。
    if (!cfgLoaded) {
      setAuthErr('认证配置未加载成功,保存已锁定(避免用空配置覆盖现有认证方式与已存密钥)。请点击「重新加载配置」后重试。')
      return
    }
    setAuthErr('')
    // 启用中的 IdP 必须配置完整(前端校验; 服务端亦有校验)
    for (const key of enabled.filter((k) => k !== 'local')) {
      if (!isReady(key as IdpKey)) {
        setAuthErr(`${METHOD_META[key as MethodKey]?.label} 配置不完整, 请完成必填项后再保存`)
        return
      }
    }
    // 外部权限源: 启用时 endpoint/令牌/至少一种方式必填, 超时 200–10000ms。
    if (identity.enabled && !identityReady()) {
      setAuthErr('外部权限源(RBAC)配置不完整: endpoint、服务令牌、至少一种适用方式必填, 超时需在 200–10000ms 之间')
      return
    }
    // 关闭保护: 已有 RBAC 用户时必须显式确认(服务端 409 是第二道防线)。
    if (needsDisableConfirm() && !confirmDisable) {
      setAuthErr(`已有 ${identity.rbacUserCount} 个用户以 RBAC uid 建立; 关闭外部权限源后他们将无法再用扫码登录, 请勾选「我确认关闭」后再保存`)
      return
    }
    setBusy(true)
    try {
      // 密码字段语义(服务端契约):未输入(空)且已存在保存值 → 提交 ***
      // 保持现值; 用户输入新值 → 提交新值。空串仅在用户显式清空时提交。
      // 此前把服务端掩码 *** 回显进输入框,用户一保存就把 *** 当密码/清空
      // 密码写回 ——「每次保存后用不了」的根因。
      const secretField = (value: string, preset: 'has-value' | 'unset', cleared: boolean): string => {
        // 用户显式清空 → 提交空串(服务端清空保存值)
        if (cleared) return ''
        // 已设置且未输入新值 → *** 保持现值
        if (value === '') return preset === 'has-value' ? '***' : ''
        // 用户输入了新值(或初次配置) → 提交
        return value
      }
      const ldapBody = { ...form.ldap, bind_password: secretField(form.ldap.bind_password ?? '', secrets.ldap_password, !!clearedSecrets.ldap_password) }
      const oidcBody = { ...form.oidc, client_secret: secretField(form.oidc.client_secret ?? '', secrets.oidc_secret, !!clearedSecrets.oidc_secret) }
      const openidBody = { ...form.openid, client_secret: secretField(form.openid.client_secret ?? '', secrets.openid_secret, !!clearedSecrets.openid_secret) }
      // 企业微信/钉钉与 oidc 完全同一套密钥语义(*** = 保持现值, 空串 = 清空)。
      const wecomBody = { ...form.wecom, secret: secretField(form.wecom.secret ?? '', secrets.wecom_secret, !!clearedSecrets.wecom_secret) }
      const dingtalkBody = { ...form.dingtalk, client_secret: secretField(form.dingtalk.client_secret ?? '', secrets.dingtalk_secret, !!clearedSecrets.dingtalk_secret) }
      // 外部权限源(RBAC): 关闭时把非法超时归一成默认值(避免「清空旧配置」被
      // 超时校验挡住); 启用时上一段已保证 200–10000。
      const identityBody: Record<string, unknown> = {
        enabled: identity.enabled,
        endpoint: identity.endpoint.trim(),
        token: identityTokenForSave(),
        methods: identity.methods.join(','),
        timeout_ms: identityTimeoutValid() ? identity.timeoutMs : 3000,
        sync_groups: identity.syncGroups,
      }
      // confirm_disable 只在「确实从开改关且已有 RBAC 用户」且用户勾选时提交。
      if (needsDisableConfirm() && confirmDisable) identityBody.confirm_disable = true
      const body: any = {
        enabled: enabled.join(','),
        hide_local: form.hideLocal,
        min_password_length: minPasswordLength,
        ldap: ldapBody,
        oidc: oidcBody,
        openid: openidBody,
        wecom: wecomBody,
        dingtalk: dingtalkBody,
        identity: identityBody,
      }
      await request(`${ADMIN_API}/auth`, { method: 'PUT', body: JSON.stringify(body) })
      setAuthMsg('认证配置已保存(重启服务端后生效)')
      setClearedSecrets({})
      setConfirmDisable(false)
      void load()
    } catch (err: any) {
      setAuthErr(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>

  return (
    <div className="space-y-6">
      <PageHeader
        title="认证配置"
        desc="员工登录方式(本地/LDAP/OIDC/OpenID/企业微信/钉钉扫码); 管理后台恒仅本地账户(SSO/LDAP 不进后台)"
      />
      <Card>
        <CardHeader>
          <CardTitle>启用方式</CardTitle>
          <CardDescription>勾选的方式出现在客户端登录页; 管理后台不受影响。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authErr && <div className="text-sm text-destructive">{authErr}</div>}
          {/* WEB-2:失败时明说"整表已锁定",否则空表单读起来像"当前没有任何认证方式"。 */}
          {!cfgLoaded && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              认证配置未加载成功,表单已锁定:此时表单里是最空的一份初值(仅本地账号、LDAP/OIDC/OpenID
              字段为空、密钥标记为未设置),保存会用空配置覆盖服务端现有的认证方式与已存密钥。
            </div>
          )}
          {authMsg && <div className="text-sm text-green-600">{authMsg}</div>}
          {/* 写面闸门(WEB-2):fieldset disabled 一次罩住全部输入;下方保存按钮再显式禁用一次。 */}
          <fieldset disabled={!cfgLoaded} className="space-y-4">
          <div className="flex flex-wrap gap-3 rounded-md border p-3">
            {Object.keys(METHOD_META).map((keyRaw) => {
              const key = keyRaw as MethodKey
              const on = enabled.includes(key)
              const ready = isReady(key)
              return (
                <label key={key} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${on ? 'border-primary/40 bg-accent' : 'hover:bg-muted'}`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#4176E6]"
                    checked={on}
                    disabled={key === 'local' || !ready}
                    onChange={(e) => toggle(key, e.target.checked)}
                  />
                  <span className="font-medium">{METHOD_META[key].label}</span>
                  <span className="text-xs text-muted-foreground">{!ready ? '(配置不完整)' : METHOD_META[key].desc}</span>
                </label>
              )
            })}
          </div>

          {/* hide_local 开关 */}
          <div className="flex items-start gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              id="hide-local"
              className="mt-1 h-4 w-4 accent-[#4176E6]"
              checked={form.hideLocal}
              onChange={(e) => setForm({ ...form, hideLocal: e.target.checked })}
            />
            <div className="space-y-0.5">
              <Label htmlFor="hide-local" className="text-[13px] text-foreground">隐藏客户端本地登录入口</Label>
              <p className="text-xs text-muted-foreground">
                启用后客户端登录页不显示本地账号方式(仅 IdP); 管理后台本地登录恒可用, 不受此开关影响。
              </p>
            </div>
          </div>

          {/* Tab 分区配置 */}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="local">本地账号</TabsTrigger>
              <TabsTrigger value="ldap">LDAP</TabsTrigger>
              <TabsTrigger value="oidc">OIDC</TabsTrigger>
              <TabsTrigger value="openid">OpenID</TabsTrigger>
              <TabsTrigger value="wecom">企业微信扫码</TabsTrigger>
              <TabsTrigger value="dingtalk">钉钉扫码</TabsTrigger>
              <TabsTrigger value="identity">外部权限源</TabsTrigger>
            </TabsList>

            <TabsContent value="local" className="space-y-2">
              <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                本地账号恒启用(管理员回退)。此页无需配置; 新建/管理账户请在「用户」页操作。
              </div>
              <div className="space-y-1 rounded-md border p-3">
                <Label htmlFor="min-password-length">密码最小长度(G14)</Label>
                <Input
                  id="min-password-length"
                  type="number"
                  min={8}
                  max={64}
                  value={minPasswordLength}
                  onChange={(e) => setMinPasswordLength(Number(e.target.value) || 10)}
                />
                <p className="text-xs text-muted-foreground">
                  新建用户/重置密码/自助改密的最短密码位数(8~64,默认 10); 改动只影响密码校验, 不追溯既有密码。
                </p>
              </div>
            </TabsContent>

            <TabsContent value="ldap" className="space-y-3">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">LDAP 配置(仅员工面)</div>
                <div className="mb-2 text-xs text-muted-foreground">
                  配置保存后每 1 小时自动同步一次用户与组(新员工/离职/组调整 1 小时内生效); 也可在「测试连接」后立即保存以当场同步。
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="ldap" label="服务器地址(ldap://...)" value={form.ldap.server_url ?? ''} ph="ldap://ldap.example.com:389" k="server_url" set={(v) => setForm({ ...form, ldap: { ...form.ldap, server_url: v } })} />
                  <Field abbr="ldap" label="Bind DN" value={form.ldap.bind_dn ?? ''} ph="cn=admin,dc=example,dc=com" k="bind_dn" set={(v) => setForm({ ...form, ldap: { ...form.ldap, bind_dn: v } })} />
                  <SecretField label="Bind 密码(已设置=保持现值)" preset={secrets.ldap_password} value={form.ldap.bind_password ?? ''} onChange={(v) => setForm({ ...form, ldap: { ...form.ldap, bind_password: v } })} onClear={() => { setForm({ ...form, ldap: { ...form.ldap, bind_password: '' } }); setClearedSecrets({ ...clearedSecrets, ldap_password: true }) }} />
                  <Field abbr="ldap" label="Base DN" value={form.ldap.base_dn ?? ''} ph="dc=example,dc=com" k="base_dn" set={(v) => setForm({ ...form, ldap: { ...form.ldap, base_dn: v } })} />
                  <Field abbr="ldap" label="用户过滤器(默认 (uid=%s))" value={form.ldap.user_filter ?? ''} ph="(uid=%s)" k="user_filter" set={(v) => setForm({ ...form, ldap: { ...form.ldap, user_filter: v } })} />
                  <Field abbr="ldap" label="用户名字段(属性,默认 uid)" value={form.ldap.user_attr ?? ''} ph="uid / cn / sAMAccountName / mail" k="user_attr" set={(v) => setForm({ ...form, ldap: { ...form.ldap, user_attr: v } })} />
                  <Field abbr="ldap" label="组过滤器(可选)" value={form.ldap.group_filter ?? ''} ph="(memberOf=cn=%s)" k="group_filter" set={(v) => setForm({ ...form, ldap: { ...form.ldap, group_filter: v } })} />
                  <Field abbr="ldap" label="组属性(默认 cn)" value={form.ldap.group_attr ?? ''} k="group_attr" set={(v) => setForm({ ...form, ldap: { ...form.ldap, group_attr: v } })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="oidc" className="space-y-3">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">OIDC 配置(仅客户端)</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="oidc" label="Issuer" value={form.oidc.issuer ?? ''} ph="https://idp.example.com" k="issuer" set={(v) => setForm({ ...form, oidc: { ...form.oidc, issuer: v } })} />
                  <Field abbr="oidc" label="Client ID" value={form.oidc.client_id ?? ''} k="client_id" set={(v) => setForm({ ...form, oidc: { ...form.oidc, client_id: v } })} />
                  <SecretField label="Client Secret(已设置=保持现值)" preset={secrets.oidc_secret} value={form.oidc.client_secret ?? ''} onChange={(v) => setForm({ ...form, oidc: { ...form.oidc, client_secret: v } })} onClear={() => { setForm({ ...form, oidc: { ...form.oidc, client_secret: '' } }); setClearedSecrets({ ...clearedSecrets, oidc_secret: true }) }} />
                  <Field abbr="oidc" label="Redirect URL" value={form.oidc.redirect_url ?? ''} ph="https://zeokeel.example.com/api/client/v2/auth/oidc/callback" k="redirect_url" set={(v) => setForm({ ...form, oidc: { ...form.oidc, redirect_url: v } })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="openid" className="space-y-3">
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">OpenID 配置(独立 IdP, 仅客户端)</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="openid" label="Issuer" value={form.openid.issuer ?? ''} ph="https://openid.example.com" k="issuer" set={(v) => setForm({ ...form, openid: { ...form.openid, issuer: v } })} />
                  <Field abbr="openid" label="Client ID" value={form.openid.client_id ?? ''} k="client_id" set={(v) => setForm({ ...form, openid: { ...form.openid, client_id: v } })} />
                  <SecretField label="Client Secret(已设置=保持现值)" preset={secrets.openid_secret} value={form.openid.client_secret ?? ''} onChange={(v) => setForm({ ...form, openid: { ...form.openid, client_secret: v } })} onClear={() => { setForm({ ...form, openid: { ...form.openid, client_secret: '' } }); setClearedSecrets({ ...clearedSecrets, openid_secret: true }) }} />
                  <Field abbr="openid" label="Redirect URL" value={form.openid.redirect_url ?? ''} ph="https://zeokeel.example.com/api/client/v2/auth/openid/callback" k="redirect_url" set={(v) => setForm({ ...form, openid: { ...form.openid, redirect_url: v } })} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="wecom" className="space-y-3">
              <CallbackHint method="wecom" copied={copiedTag === 'wecom'} onCopy={() => void copyCallback('wecom')} error={copyErr} />
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">企业微信配置(扫码登录, 仅客户端)</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="wecom" label="企业 ID(corp_id)" value={form.wecom.corp_id ?? ''} ph="ww1234567890abcdef" k="corp_id" set={(v) => setForm({ ...form, wecom: { ...form.wecom, corp_id: v } })} />
                  <Field abbr="wecom" label="自建应用 AgentId" value={form.wecom.agent_id ?? ''} ph="1000002" k="agent_id" set={(v) => setForm({ ...form, wecom: { ...form.wecom, agent_id: v } })} />
                  <SecretField label="自建应用 Secret(已设置=保持现值)" clearLabel="清空已保存密钥" preset={secrets.wecom_secret} value={form.wecom.secret ?? ''} onChange={(v) => setForm({ ...form, wecom: { ...form.wecom, secret: v } })} onClear={() => { setForm({ ...form, wecom: { ...form.wecom, secret: '' } }); setClearedSecrets({ ...clearedSecrets, wecom_secret: true }) }} />
                  <Field abbr="wecom" label="回调地址(Redirect URL)" value={form.wecom.redirect_url ?? ''} ph={callbackUrl('wecom')} k="redirect_url" set={(v) => setForm({ ...form, wecom: { ...form.wecom, redirect_url: v } })} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  在「企业微信管理后台 → 应用管理 → 自建应用 → 企业微信授权登录」里登记上面的回调地址;
                  员工在客户端点「企业微信扫码登录」后, 手机扫码确认即可完成登录。
                </p>
              </div>
            </TabsContent>

            <TabsContent value="dingtalk" className="space-y-3">
              <CallbackHint method="dingtalk" copied={copiedTag === 'dingtalk'} onCopy={() => void copyCallback('dingtalk')} error={copyErr} />
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">钉钉配置(扫码登录, 仅客户端)</div>
                <div className="grid grid-cols-2 gap-3">
                  <Field abbr="dingtalk" label="AppKey(Client ID)" value={form.dingtalk.client_id ?? ''} ph="dingxxxxxxxxxxxxxxxx" k="client_id" set={(v) => setForm({ ...form, dingtalk: { ...form.dingtalk, client_id: v } })} />
                  <SecretField label="AppSecret(已设置=保持现值)" clearLabel="清空已保存密钥" preset={secrets.dingtalk_secret} value={form.dingtalk.client_secret ?? ''} onChange={(v) => setForm({ ...form, dingtalk: { ...form.dingtalk, client_secret: v } })} onClear={() => { setForm({ ...form, dingtalk: { ...form.dingtalk, client_secret: '' } }); setClearedSecrets({ ...clearedSecrets, dingtalk_secret: true }) }} />
                  <Field abbr="dingtalk" label="回调地址(Redirect URL)" value={form.dingtalk.redirect_url ?? ''} ph={callbackUrl('dingtalk')} k="redirect_url" set={(v) => setForm({ ...form, dingtalk: { ...form.dingtalk, redirect_url: v } })} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  在「钉钉开放平台 → 应用开发 → 登录与分享」里登记上面的回调地址;
                  员工在客户端点「钉钉扫码登录」后, 手机扫码确认即可完成登录。
                </p>
              </div>
            </TabsContent>

            <TabsContent value="identity" className="space-y-3" data-testid="identity-panel">
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-sm font-medium">外部权限源(RBAC，可选)</div>
                    <p className="text-xs text-muted-foreground">
                      启用后，扫码登录以 RBAC 返回的 uid 作为用户名；RBAC 查不到/停用的用户将无法登录。
                    </p>
                  </div>
                  <Switch
                    checked={identity.enabled}
                    onCheckedChange={(v) => {
                      setIdentity({ ...identity, enabled: v })
                      if (v) setConfirmDisable(false)
                    }}
                    aria-label="启用外部权限源"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field
                    abbr="identity"
                    label="解析接口(endpoint)"
                    value={identity.endpoint}
                    ph="https://rbac.example.com/internal/v1/identity/resolve"
                    k="endpoint"
                    set={(v) => setIdentity({ ...identity, endpoint: v })}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="identity-timeout" className="text-xs text-muted-foreground">超时(毫秒, 200–10000)</Label>
                    <Input
                      id="identity-timeout"
                      type="number"
                      min={200}
                      max={10000}
                      value={identity.timeoutMs}
                      onChange={(e) => setIdentity({ ...identity, timeoutMs: Number(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <SecretField
                  label="服务令牌(已设置=保持现值)"
                  clearLabel="清空已保存令牌"
                  preset={secrets.identity_token}
                  value={identity.token}
                  onChange={(v) => setIdentity({ ...identity, token: v })}
                  onClear={() => {
                    setIdentity({ ...identity, token: '' })
                    setClearedSecrets({ ...clearedSecrets, identity_token: true })
                  }}
                />

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">适用方式(至少一个)</div>
                  <div className="flex flex-wrap gap-4">
                    {RBAC_METHODS.map((m) => (
                      <label key={m} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id={`identity-method-${m}`}
                          aria-label={`适用方式：${METHOD_META[m].label}`}
                          checked={identity.methods.includes(m)}
                          onChange={(e) => toggleIdentityMethod(m, e.target.checked)}
                        />
                        {METHOD_META[m].label}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    只有勾选的扫码方式会走 RBAC 解析；未勾选的方式保持现有直连登录。
                  </p>
                  {identity.enabled && identity.methods.length === 0 && (
                    <p className="text-xs text-destructive">至少选择一种适用方式。</p>
                  )}
                </div>

                <div className="flex items-start gap-3 rounded-md border p-3">
                  <Switch
                    id="identity-sync-groups"
                    checked={identity.syncGroups}
                    onCheckedChange={(v) => setIdentity({ ...identity, syncGroups: v })}
                    aria-label="用 RBAC 部门替换 ZeoKeel 组"
                  />
                  <div className="space-y-0.5">
                    <Label htmlFor="identity-sync-groups" className="text-[13px] text-foreground">
                      用 RBAC 部门替换 ZeoKeel 组
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      开启后每次登录会用 RBAC 返回的部门全量替换该用户的组归属，会覆盖手工组；关闭则只登录、不动组。
                    </p>
                  </div>
                </div>

                {identity.rbacUserCount > 0 && (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    当前已有 <span className="font-semibold text-foreground">{identity.rbacUserCount}</span> 个用户以 RBAC uid 建立。
                    关闭外部权限源后，这些用户将无法再用扫码登录；如需关闭，请先迁移或确认已不再需要。
                  </div>
                )}

                {needsDisableConfirm() && (
                  <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                    <p className="text-xs text-destructive">
                      已关闭外部权限源，但仍有 {identity.rbacUserCount} 个 RBAC 用户。保存前请确认：关闭后这些用户将无法登录。
                    </p>
                    <label className="flex items-center gap-2 text-sm text-destructive">
                      <Checkbox
                        id="identity-confirm-disable"
                        checked={confirmDisable}
                        onChange={(e) => setConfirmDisable(e.target.checked)}
                      />
                      我确认关闭
                    </label>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div>
                  <div className="text-sm font-medium">测试解析</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    用已保存的 endpoint 与服务令牌调用 RBAC；不会修改任何数据。
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="identity-test-provider" className="text-xs text-muted-foreground">渠道</Label>
                    <Select value={testProvider} onValueChange={(v) => setTestProvider(v as QrMethod)}>
                      <SelectTrigger id="identity-test-provider" aria-label="解析渠道">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="wecom">企业微信</SelectItem>
                        <SelectItem value="dingtalk">钉钉</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    abbr="identity-test"
                    label="渠道用户 ID(企微 userid)"
                    value={testProviderUserID}
                    k="provider_user_id"
                    set={setTestProviderUserID}
                  />
                  <Field
                    abbr="identity-test"
                    label="钉钉 unionId"
                    value={testUnionID}
                    k="union_id"
                    set={setTestUnionID}
                  />
                  <Field
                    abbr="identity-test"
                    label="手机号(可选)"
                    value={testMobile}
                    k="mobile"
                    set={setTestMobile}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void testIdentity()}
                    disabled={identityTesting || !canTestIdentity()}
                  >
                    {identityTesting ? '解析中…' : '测试解析'}
                  </Button>
                  {!canTestIdentity() && (
                    <span className="text-xs text-muted-foreground">
                      请先填写 endpoint/令牌并保存后再测试（无需先启用）。
                    </span>
                  )}
                </div>
                {identityTestResult && (
                  identityTestResult.ok ? (
                    <div className="space-y-0.5 rounded-md border bg-muted/20 p-3 text-[13px]">
                      <div>uid: <span className="font-mono font-medium">{identityTestResult.uid || '(空)'}</span></div>
                      <div>姓名: {identityTestResult.name || '(空)'}</div>
                      <div>状态: {identityTestResult.status === 1 ? '正常' : identityTestResult.status === 0 ? '停用' : '(未知)'}</div>
                      <div>部门: {identityTestResult.departments?.length ? identityTestResult.departments.join('、') : '(无)'}</div>
                    </div>
                  ) : (
                    <div className="text-[13px] text-red-600">✗ {identityTestResult.message || '解析失败'}</div>
                  )
                )}
              </div>
            </TabsContent>
          </Tabs>

          <div className="flex gap-2">
            <Button variant="outline" onClick={testConnection} disabled={testing || !TESTABLE_TABS.has(tab) || !cfgLoaded}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
            <Button onClick={saveAuth} disabled={busy || !cfgLoaded}>{busy ? '保存中…' : '保存认证配置'}</Button>
          </div>
          {testMsg && <div className={`text-[13px] ${testMsg.startsWith('✓') ? 'text-green-600' : 'text-red-600'}`}>{testMsg}</div>}
          {testDetail && testDetail.ok && (
            <div className="rounded-md border bg-muted/20 p-3 text-[13px]">
              <div className="mb-1 font-medium">
                目录统计: 匹配到 <span className="text-green-700 font-semibold">{testDetail.users ?? 0}</span> 个用户,
                {' '}<span className="text-green-700 font-semibold">{testDetail.groups ?? 0}</span> 个组
              </div>
              {(testDetail.sample?.length ?? 0) > 0 && (
                <div className="space-y-0.5">
                  <div className="text-muted-foreground">用户样例(前 {testDetail.sample!.length} 个):</div>
                  {testDetail.sample!.map((u, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="font-mono">{u.username}</span>
                      <span className="text-muted-foreground">{u.display_name || u.email || ''}</span>
                      {u.groups && u.groups.length > 0 && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{u.groups.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-xs text-muted-foreground">保存后立即同步一次, 之后每 1 小时自动同步(新员工/离职/组变更 1 小时内生效)。</div>
            </div>
          )}
          </fieldset>
          {/* WEB-2:重试入口必须在 fieldset **外面** —— 锁定时它是唯一可点的按钮。 */}
          {!cfgLoaded && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()} disabled={loading}>重新加载配置</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * 回调地址展示 + 复制(企业微信/钉钉两页共用):
 * ① 地址由 location.origin 推导 —— 管理员打开管理端的对外地址就是手机扫码后
 *    浏览器落地的地址; ② 复制失败必须明说"请手动复制", 不假装成功(同 lib/clipboard 约定)。
 */
function CallbackHint(props: {
  method: QrMethod
  copied: boolean
  onCopy: () => void
  error: string
}) {
  const url = callbackUrl(props.method)
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-sm font-medium">回调地址({METHOD_META[props.method].label})</div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded border bg-background px-2 py-1 font-mono text-xs">{url}</code>
        <Button type="button" variant="outline" size="sm" onClick={props.onCopy}>
          {props.copied ? <Check /> : <Copy />}
          {props.copied ? '已复制' : '复制'}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        请到服务商后台登记该回调地址，值必须逐字一致(含协议、域名、端口、路径与大小写)。
      </p>
      {props.error && <p className="text-xs text-destructive">{props.error}</p>}
    </div>
  )
}

function Field(props: { label: string; value: string; ph?: string; k: string; abbr?: string; set: (v: string) => void }) {
  const id = `auth-field-${props.abbr ?? 'x'}-${props.k}`
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{props.label}</Label>
      <Input id={id} value={props.value} placeholder={props.ph ?? ''} onChange={(e) => props.set(e.target.value)} />
    </div>
  )
}

function SecretField(props: {
  label: string
  value: string
  preset?: 'has-value' | 'unset'
  clearLabel?: string
  onChange: (v: string) => void
  onClear?: () => void
}) {
  // P2-48: 原来用 Math.random() 生成 id → 每次渲染都变,Label htmlFor 与 Input id 失联
  // (无障碍关联断链,点击标签不聚焦、屏幕阅读器读不出)。useId 在单次挂载内稳定。
  const id = `auth-secret-${useId()}`
  const preset = props.preset ?? 'unset'
  // 已设置且未输入新值: 显示「已配置」徽标, 输入框留空(不显示 ***,
  // 避免用户把 *** 当密码; 留空 + 已设置 = 服务端保持现值)。
  const configured = preset === 'has-value' && props.value === ''
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs text-muted-foreground">{props.label}</Label>
        {configured && props.onClear && (
          <button
            type="button"
            onClick={props.onClear}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            {props.clearLabel ?? '清空已保存密码'}
          </button>
        )}
      </div>
      <div className="relative">
        <SecretInput
          id={id}
          value={props.value}
          placeholder={configured ? '已配置(重新输入可覆盖)' : ''}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {configured && (
          <span className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
            已配置
          </span>
        )}
      </div>
    </div>
  )
}
