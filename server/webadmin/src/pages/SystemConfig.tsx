import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, RotateCcw, Save } from 'lucide-react'

import { request, ADMIN_API } from '../api'
import { PageHeader } from '../components/page-header'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { hasPermission, PERM_CONFIG_WRITE } from '../lib/rbac'
import { useFlash } from '../lib/use-flash'

/**
 * 「系统配置」页：把**部署期配置注册表**（server/internal/deployconfig）的控制台出口
 * 做全 —— 按 category 分组、展示"现在生效的是什么/从哪里来/默认是多少"，并允许
 * 在有 `config:write` 时保存。
 *
 * 为什么需要这一页（2026-10-23，用户要求「配置存数据库、控制台可改」）：
 * 过去这批旋钮（wasm 内存/编译隔离档、OIDC 信任主机、登录失败上限、遥测与审计
 * 间隔…）只能改 `.env` + 重建容器；控制台既看不到"有哪些键"，也回答不了
 * "我改了怎么没生效"。服务端的优先级是 **显式环境变量 > settings 表 > 默认**，
 * 所以本页有三件不可省略的可视化：
 *   ① 每个键的来源徽标（控制台 / 环境变量 / 默认）；
 *   ② 顶部横幅列出**仍被环境变量覆盖**的键（保存成功也不会生效）；
 *   ③ `applies_at=restart` 的键标注"需重启/重建容器生效"。
 *
 * 保存语义（与服务端一致）：只提交**改动过的**键；空串 = 删除该 settings 行
 * （回落到环境变量/默认）；服务端把 settings 写入与审计放在同一事务里。
 */

/** 一个配置项（字段名是服务端 `serverauth.ConfigItem` 的 JSON 契约）。 */
export interface ConfigItem {
  key: string
  env: string
  title: string
  description: string
  category: string
  kind: string
  /** 当前**生效值**（已按 kind 规范化）。 */
  value: string
  /** 生效值来源：env | setting | default。 */
  source: string
  default: string
  /** hot = 保存即生效；restart = 需重启/重建容器。 */
  applies_at: string
  min: number | null
  max: number | null
  choices: string[]
  env_value: string
  setting_value: string
  /** 非空 = 某个来源的值非法、已被回落（可直接展示给运维）。 */
  invalid: string
}

interface ConfigResponse {
  items: ConfigItem[]
  env_overrides: string[]
}

interface ConfigSaveResponse {
  saved: string[]
  warnings: string[]
}

/** 来源徽标文案（值是服务端的稳定契约，不要改 key）。 */
const SOURCE_LABEL: Record<string, string> = {
  env: '环境变量',
  setting: '控制台',
  default: '默认',
}

/** 来源徽标配色：环境变量覆盖要看得见（它意味着"控制台改了不生效"）。 */
const SOURCE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  env: 'destructive',
  setting: 'success',
  default: 'outline',
}

/**
 * Radix Select 不允许空串 value（会抛错），而"未设置"在这里是有语义的状态
 * （保存空串 = 删除 settings 行、回落环境变量/默认）—— 用一个不可能与真实取值
 * 冲突的哨兵值在 UI 层表达它。
 */
const UNSET = '__unset__'

/** kind 的中文提示（让管理员知道该填什么形态）。 */
const KIND_HINT: Record<string, string> = {
  string: '文本',
  int: '整数',
  bool: '布尔',
  duration: '时长（如 15m / 1h）',
  csv: '逗号分隔',
  choice: '单选',
}

/** 把服务端的取值形态化展示（空值是合法状态："未配置"）。 */
function displayValue(raw: string): string {
  return raw === '' ? '（空）' : raw
}

export default function SystemConfig() {
  const [items, setItems] = useState<ConfigItem[]>([])
  const [envOverrides, setEnvOverrides] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [okMsg, flash] = useFlash(2500)

  const canWrite = hasPermission(PERM_CONFIG_WRITE)

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true)
    setError('')
    try {
      const data = await request<ConfigResponse>(`${ADMIN_API}/config`)
      const nextItems = data.items ?? []
      setItems(nextItems)
      setEnvOverrides(data.env_overrides ?? [])
      const nextDrafts: Record<string, string> = {}
      for (const item of nextItems) nextDrafts[item.key] = item.value
      setDrafts(nextDrafts)
      setLoaded(true)
      return true
    } catch (err) {
      // 失败时保持"未加载"：表单与保存都锁死（不能拿默认值当真实配置再保存回去，
      // 那会把服务器上的设置覆盖成空）。
      setError(err instanceof Error ? err.message : '配置读取失败')
      setLoaded(false)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 按 category 分组（顺序 = 服务端返回的注册表顺序，category 首次出现的位置）。 */
  const groups = useMemo(() => {
    const order: string[] = []
    const map = new Map<string, ConfigItem[]>()
    for (const item of items) {
      if (!map.has(item.category)) {
        map.set(item.category, [])
        order.push(item.category)
      }
      map.get(item.category)!.push(item)
    }
    return order.map((category) => ({ category, entries: map.get(category)! }))
  }, [items])

  /** 键 → 配置项（横幅里显示中文名/环境变量名用）。 */
  const itemByKey = useMemo(() => {
    const map = new Map<string, ConfigItem>()
    for (const item of items) map.set(item.key, item)
    return map
  }, [items])

  /** 改动过的键（只提交这些：全量提交会把"默认/未配置"的键写成显式 settings 行）。 */
  const dirtyKeys = useMemo(
    () => items.filter((item) => (drafts[item.key] ?? '') !== item.value).map((item) => item.key),
    [items, drafts],
  )

  const setDraft = (key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: value }))
  }

  async function save() {
    if (dirtyKeys.length === 0) return
    const values: Record<string, string> = {}
    for (const key of dirtyKeys) values[key] = drafts[key] ?? ''
    setSaving(true)
    setWarnings([])
    try {
      const res = await request<ConfigSaveResponse>(`${ADMIN_API}/config`, {
        method: 'PUT',
        body: JSON.stringify({ values }),
      })
      // 保存成功后再回读一次（不乐观更新：界面上的"已保存"必须来自服务端真值）。
      const refreshed = await load()
      setWarnings(res.warnings ?? [])
      if (refreshed) flash(`已保存 ${res.saved?.length ?? 0} 项`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 渲染一个配置项的输入控件（bool/choice = Select；其余 = Input）。 */
  function renderControl(item: ConfigItem) {
    const id = `config-${item.key}`
    const draft = drafts[item.key] ?? ''
    if (item.kind === 'bool' || item.kind === 'choice') {
      const choices = item.kind === 'bool' ? ['true', 'false'] : item.choices
      return (
        <Select
          value={draft === '' ? UNSET : draft}
          onValueChange={(value) => setDraft(item.key, value === UNSET ? '' : value)}
          disabled={!loaded || !canWrite || saving}
        >
          <SelectTrigger id={id} aria-label={item.title}>
            <SelectValue placeholder="未设置" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>未设置（回落环境变量 / 默认）</SelectItem>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {item.kind === 'bool' ? (choice === 'true' ? '开启' : '关闭') : choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
    return (
      <Input
        id={id}
        aria-label={item.title}
        value={draft}
        inputMode={item.kind === 'int' ? 'numeric' : undefined}
        placeholder={item.default === '' ? '未设置' : `默认 ${item.default}`}
        disabled={!loaded || !canWrite || saving}
        onChange={(e) => setDraft(item.key, e.target.value)}
      />
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="系统配置"
        desc="部署期配置（原本只能改 .env + 重建容器）。优先级：环境变量 > 控制台 > 默认值；保存即写库并审计。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || saving}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
            <Button onClick={() => void save()} disabled={!loaded || !canWrite || saving || dirtyKeys.length === 0}>
              <Save className="h-4 w-4" />
              {saving ? '保存中…' : dirtyKeys.length > 0 ? `保存 ${dirtyKeys.length} 项` : '保存'}
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>
      )}
      {okMsg && <div className="rounded-md border border-green-500/40 p-3 text-sm text-green-600">{okMsg}</div>}

      {/* 保存成功但"没生效"的唯一线索：被环境变量覆盖的键（服务端 warnings 也逐个点名）。 */}
      {warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700">
          <div className="font-medium">以下配置已写入控制台，但当前不会生效：</div>
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      {envOverrides.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700">
          <div className="font-medium">
            以下 {envOverrides.length} 项仍被环境变量覆盖（只读提示）
          </div>
          <div className="mt-1">
            {envOverrides.map((key) => (
              <div key={key}>
                · {itemByKey.get(key)?.title ?? key}（{key}）
                {itemByKey.get(key)?.env ? ` — 环境变量 ${itemByKey.get(key)!.env}` : ''}
              </div>
            ))}
          </div>
          <div className="mt-1">
            环境变量优先级高于控制台：在这里保存不会生效。如需以控制台为准，请删除 .env
            中的对应行并重建容器。
          </div>
        </div>
      )}

      {!loaded && !loading && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700">
          配置未加载成功，表单与保存已锁定。
        </div>
      )}

      {!canWrite && loaded && (
        <div className="rounded-md border border-slate-200 p-3 text-sm text-muted-foreground">
          当前账号只有 config:read 权限：可以查看，保存已禁用（写面仅 super_admin）。
        </div>
      )}

      {loading && items.length === 0 && <div className="text-sm text-muted-foreground">配置加载中…</div>}

      {groups.map((group) => (
        <Card key={group.category}>
          <CardHeader>
            <CardTitle>{group.category}</CardTitle>
            <CardDescription>{group.entries.length} 项配置</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {group.entries.map((item) => {
              const draft = drafts[item.key] ?? ''
              const dirty = draft !== item.value
              return (
                <div key={item.key} className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`config-${item.key}`} className="text-sm font-medium">
                      {item.title}
                    </Label>
                    <Badge variant={SOURCE_VARIANT[item.source] ?? 'outline'}>{SOURCE_LABEL[item.source] ?? item.source}</Badge>
                    {item.applies_at === 'restart' && (
                      <Badge variant="outline" className="border-amber-500/60 text-amber-700">
                        需重建容器生效
                      </Badge>
                    )}
                    {dirty && <Badge variant="secondary">未保存</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.description}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="min-w-[240px] flex-1">{renderControl(item)}</div>
                    {item.setting_value !== '' && canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="删除控制台保存的值，回落到环境变量/默认"
                        disabled={!loaded || saving}
                        onClick={() => setDraft(item.key, '')}
                      >
                        <RotateCcw className="h-4 w-4" />
                        清除控制台值
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>当前生效：{displayValue(item.value)}</span>
                    <span>默认：{displayValue(item.default)}</span>
                    <span>
                      类型：{KIND_HINT[item.kind] ?? item.kind}
                      {item.kind === 'int' && (item.min !== null || item.max !== null)
                        ? `（${item.min ?? '-∞'} ~ ${item.max ?? '+∞'}）`
                        : ''}
                      {item.kind === 'choice' && item.choices.length > 0 ? `（${item.choices.join(' / ')}）` : ''}
                    </span>
                    <span>环境变量：{item.env}</span>
                  </div>
                  {item.applies_at === 'restart' && (
                    <div className="mt-1 text-[11px] text-amber-700">
                      修改后需重启 / 重建容器生效（该值在服务启动时一次性装配）。
                    </div>
                  )}
                  {item.source === 'env' && (
                    <div className="mt-1 text-[11px] text-amber-700">
                      当前生效值来自环境变量 {item.env}；在控制台保存不会生效，请删除 .env 中对应行。
                    </div>
                  )}
                  {item.setting_value !== '' && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      控制台已保存值：{displayValue(item.setting_value)}
                    </div>
                  )}
                  {item.invalid && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      配置值非法（已回落）：{item.invalid}
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
