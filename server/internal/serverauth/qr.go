package serverauth

// 扫码登录（企业微信 / 钉钉）的流程状态机与 HTTP 面（2026-11-03）。
//
// 与 OIDC 浏览器跳转的差别：
//   - 二维码内容由**服务端**渲染成 PNG data URL，客户端只把它塞进
//     `<img src="data:image/png;base64,…">`，既不接触 state 也不做跳转；
//   - 手机扫码后由服务商把手机浏览器带回 `/api/client/v2/auth/<name>/callback`，
//     服务端在那里兑换 code、provision 本地用户并签发 token，把结果放进内存
//     流程；桌面客户端用 `flow_id` 轮询 poll，一次性取走 token。
//
// 不变量（设计文档 docs/planning/2026-11-03-wecom-dingtalk-qr-login.md §4.5）：
//   - state / flow_id 各 32 字节随机 hex；state 单次使用（claim 在同一临界区内
//     摘除），flow_id 在终态响应时消费；
//   - state 归属于发起它的 provider：跨 provider 的 callback 一律拒绝，且
//     **不消耗**对方的流程（否则知道 state 的人可以替别人取消登录）；
//   - 流程表 TTL 5 分钟、容量 1000（满则拒绝新流程，fail-closed，不驱逐在途
//     流程）、单来源 IP 在途 10；
//   - 启动限流 30 次/5 分钟/IP，使用**独立**的 limiter（不与 OIDC 的
//     oidcFlowLimiter 共享预算）；只对**真实失败**记账，容量拒绝走独立通道
//     （与 oidc.go 的 recordFlowCapacityRejection 同口径）；
//   - 回调兑换 10s 超时 + util.SafeOutboundTransport()（链路本地/云 metadata
//     拦截、重定向逐跳复检）；
//   - token 只在**首次** poll(done) 响应里出现一次，绝不落日志、绝不进 URL。
//
// HTML 例外：本文件里的回调**成功页**是全包唯一的非 JSON 响应，属产品 HTML 面
// （设计文档 §4 明确列为唯一例外；与 `/`、`/portal` 同类）：静态字符串、
// 无外链、无图片、不拼接任何请求数据；唯一脚本是本地倒计时与尽力关闭标签页。
// 所有**失败**仍走统一的 JSON
// 错误信封（serverauth.WriteError）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	qrcode "github.com/skip2/go-qrcode"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/util"
)

const (
	// qrFlowTTL 是扫码流程的最长存活时间（设计 §4.5）。
	qrFlowTTL = 5 * time.Minute
	// qrMaxFlows 是内存流程表容量：满了**拒绝新流程**（fail-closed），不驱逐
	// 在途流程 —— 驱逐会把正在扫码的真人流程挤掉（与 oidcMaxFlows 同因）。
	qrMaxFlows = 1000
	// qrMaxFlowsPerIP 是单个来源 IP 允许同时占用的在途流程数：表容量的 1/10，
	// 填满全表至少需要 10 个来源 IP；正常扫码在数秒内被回调消费。
	qrMaxFlowsPerIP = qrMaxFlows / 10
	// qrStartMaxAttempts 是流程启动的单 IP **失败**预算（30 次/5 分钟）。
	// 成功启动不记账：真人每个二维码只 start 一次，而"成功"是匿名可得的
	// （任何人发一次合法 POST 就成功），记账会让正常登录被自己的配额误伤。
	qrStartMaxAttempts = 30
	// qrExchangeTimeout 限定回调兑换（服务商 token / 用户信息接口）。
	qrExchangeTimeout = 10 * time.Second
	// qrPNGSize 是服务端渲染的二维码边长（像素），ECC 固定 Medium。
	qrPNGSize = 320
	// qrMaxResponseBytes 限定服务商响应体，防止被控上游把内存打满。
	qrMaxResponseBytes = 1 << 20
)

// qrCallbackSuccessHTML 是手机扫码落地页（产品 HTML 面，见文件头）。
//
// 边界：静态字符串，无外链/无外部资源/无任何请求数据插值；唯一脚本是本地
// 倒计时与尽力而为的 window.close()，供扫码完成后自动收起标签页。浏览器
// 不允许脚本关闭非脚本打开的标签页时，页面保留“请手动关闭”提示。
const qrCallbackSuccessHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录成功</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f6f8; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  main { text-align: center; padding: 32px; }
  .ok { width: 52px; height: 52px; margin: 0 auto 16px; border-radius: 50%; background: #e8f7ee; color: #1f9d55; font-size: 28px; line-height: 52px; font-weight: 700; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  p { font-size: 15px; color: #646a73; margin: 0; }
  .hint { margin-top: 20px; font-size: 13px; color: #8a9099; }
  button { margin-top: 18px; padding: 8px 18px; border: 1px solid #d0d3d9; border-radius: 8px; background: #fff; color: #1f2329; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
<main>
<div class="ok" aria-hidden="true">✓</div>
<h1>登录成功</h1>
<p>请返回客户端继续使用。</p>
<p class="hint" id="close-hint">窗口将在 5 秒后自动关闭</p>
<button type="button" id="close-btn">立即关闭</button>
</main>
<script>
(function () {
  var left = 5
  var hint = document.getElementById('close-hint')
  var btn = document.getElementById('close-btn')
  function closeTab() {
    try { window.close() } catch (e) {}
  }
  btn.addEventListener('click', closeTab)
  var timer = setInterval(function () {
    left -= 1
    if (left > 0) {
      hint.textContent = '窗口将在 ' + left + ' 秒后自动关闭'
      return
    }
    clearInterval(timer)
    hint.textContent = '请手动关闭此标签页'
    closeTab()
  }, 1000)
})()
</script>
</body>
</html>
`

// 流程表哨兵错误。启动路径据此区分**真实失败**（计失败预算）与**平台容量**
// 拒绝（单独计数 + 独立审计动作，不计失败预算）。
var (
	errQRFlowTableFull      = errors.New("qr: too many in-flight login flows")
	errQRFlowQuotaPerIP     = errors.New("qr: too many in-flight login flows from this client")
	errQRFlowUnknown        = errors.New("qr: unknown or consumed flow")
	errQRStateUnknown       = errors.New("qr: unknown or expired state")
	errQRStateWrongProvider = errors.New("qr: state belongs to another provider")
)

// qrFlowCapacityRejections 是**因平台自身容量**被拒的扫码流程启动计数
// （在途流程表满 / 单来源 IP 在途配额满）。
//
// 与 qrStartLimiter 的分工与 OIDC 完全一致（见 oidcFlowCapacityRejections）：
// 容量拒绝不是攻击证据，把它算进失败预算会让一个 NAT 出口在登录潮里自我强化
// 成 5 分钟封锁。生产读者：GET /api/server/admin/server-info 的
// `qr.capacity_rejections`（与 oidc 并排看，才能区分"暴力尝试"与"容量打满"）。
var qrFlowCapacityRejections atomic.Int64

// QRFlowCapacityRejections 返回进程级的扫码容量拒绝计数（唯一真源）。
func QRFlowCapacityRejections() int64 {
	return qrFlowCapacityRejections.Load()
}

// qrFlow 是一条扫码登录流程（进程内存；重启即失效，符合"无状态优先"）。
type qrFlow struct {
	// id 是 flow_id（32 字节 hex），客户端轮询凭据；state 由服务商回传。
	id        string
	state     string
	provider  string
	ip        string
	createdAt time.Time

	// 终态字段由 callback 在持有表锁时写入，poll 在锁内读取。
	done       bool
	failed     bool
	token      string
	user       *serverstore.User
	mustChange bool
	errCode    string
	errMessage string
}

// qrPollResult 是 poll 的一次性快照（终态响应后流程即被删除）。
type qrPollResult struct {
	status     string
	token      string
	user       *serverstore.User
	mustChange bool
	errCode    string
	errMessage string
}

func (r qrPollResult) failedPayload() gin.H {
	return gin.H{"code": r.errCode, "message": r.errMessage}
}

// qrFlowTable 是进程内的扫码流程表。
//
// flows 按 flow_id 索引（客户端轮询），states 按 state 索引（服务商回调）。
// 两个索引必须在**每一次**插入/删除时同步：漏删 states 会让一次性 state 可重放，
// 漏删 flows 会让 token 在内存里多留到下一次清扫。
type qrFlowTable struct {
	mu     sync.Mutex
	flows  map[string]*qrFlow
	states map[string]string // state -> flow_id
}

func newQRFlowTable() *qrFlowTable {
	return &qrFlowTable{flows: map[string]*qrFlow{}, states: map[string]string{}}
}

// create 生成一条新流程并占位。容量判定与占位在同一临界区 ⇒ 并发灌表无法穿透。
func (t *qrFlowTable) create(provider, ip string) (*qrFlow, error) {
	id, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	state, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sweepLocked(now)
	if len(t.flows) >= qrMaxFlows {
		return nil, errQRFlowTableFull
	}
	if t.flowsForIPLocked(ip) >= qrMaxFlowsPerIP {
		return nil, errQRFlowQuotaPerIP
	}
	f := &qrFlow{id: id, state: state, provider: provider, ip: ip, createdAt: now}
	t.flows[id] = f
	t.states[state] = id
	return f, nil
}

// discard 删除一条**尚未被回调消费**的流程（启动期 AuthURL/二维码失败时）。
func (t *qrFlowTable) discard(f *qrFlow) {
	if f == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.deleteLocked(f)
}

// claim 原子地认领一个 state：成功时该 state 立即失效（单次使用），返回的流程
// 仍留在表里等待 poll。跨 provider 的 state **不消耗**，只报错 —— 否则知道
// state 的第三方可以替别人取消登录。
func (t *qrFlowTable) claim(state, provider string) (*qrFlow, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	id, ok := t.states[state]
	if !ok {
		return nil, errQRStateUnknown
	}
	f := t.flows[id]
	if f == nil {
		// 索引不一致（理论上不可达）：按未知 state 处理并清掉残留索引。
		delete(t.states, state)
		return nil, errQRStateUnknown
	}
	if f.provider != provider {
		return nil, errQRStateWrongProvider
	}
	if now.Sub(f.createdAt) >= qrFlowTTL {
		t.deleteLocked(f)
		return nil, errQRStateUnknown
	}
	delete(t.states, f.state)
	return f, nil
}

// markDone 记录回调成功的结果（token 在这里进入内存，只等一次 poll）。
func (t *qrFlowTable) markDone(f *qrFlow, token string, user *serverstore.User) {
	if f == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	f.done = true
	f.token = token
	f.user = user
	f.mustChange = user != nil && user.PasswordMustChange
}

// markFailed 记录回调失败结论，让轮询拿到与手机浏览器**同一结论**。
func (t *qrFlowTable) markFailed(f *qrFlow, code, message string) {
	if f == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	f.failed = true
	f.errCode = code
	f.errMessage = message
}

// poll 返回流程的当前状态。pending 不消费；expired/done/failed 是终态，
// 响应后流程即删除（flow_id 随即失效）。
//
// 过期判定在清扫**之前**取快照：否则本次请求的 flow 会先被清掉，poll 只能看到
// 404，客户端就失去了"二维码已过期"这个可区分结论。清扫同时覆盖表里其它
// 过期流程（终态无人来取时不能永远占着内存和 token），触发点 = create 的容量
// 检查与每次 poll。
func (t *qrFlowTable) poll(flowID, provider string) (qrPollResult, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	f := t.flows[flowID]
	// provider 不匹配按"不存在"处理：不向调用方泄露另一个登录方式的流程是否存在。
	if f == nil || f.provider != provider {
		return qrPollResult{}, errQRFlowUnknown
	}
	// 轮询也是清扫点：终态流程若客户端再不来取（关闭窗口/断网），不能永远占着
	// 内存和 token。先取快照，再清扫 —— 被清掉的若是本次请求的 flow，下面的
	// 判定仍按快照给出 expired（终态语义不变）。
	now := time.Now()
	expired := now.Sub(f.createdAt) >= qrFlowTTL
	t.sweepLocked(now)
	if expired {
		return qrPollResult{status: "expired"}, nil
	}
	switch {
	case f.done:
		res := qrPollResult{
			status: "done", token: f.token, user: f.user, mustChange: f.mustChange,
		}
		t.deleteLocked(f)
		return res, nil
	case f.failed:
		res := qrPollResult{status: "failed", errCode: f.errCode, errMessage: f.errMessage}
		t.deleteLocked(f)
		return res, nil
	default:
		return qrPollResult{status: "pending"}, nil
	}
}

// flowsForIPLocked 统计某来源 IP 当前占用的在途流程数；caller holds t.mu。
// 复杂度 O(len(flows)) ≤ 1000，只在启动时跑一次，不值得再维护一份计数索引。
func (t *qrFlowTable) flowsForIPLocked(ip string) int {
	n := 0
	for _, f := range t.flows {
		if f.ip == ip {
			n++
		}
	}
	return n
}

// sweepLocked 清理过期流程（含尚未被消费的 state）；caller holds t.mu。
func (t *qrFlowTable) sweepLocked(now time.Time) {
	for _, f := range t.flows {
		if now.Sub(f.createdAt) >= qrFlowTTL {
			t.deleteLocked(f)
		}
	}
}

// deleteLocked 同时删除两个索引；caller holds t.mu。
func (t *qrFlowTable) deleteLocked(f *qrFlow) {
	delete(t.flows, f.id)
	if t.states[f.state] == f.id {
		delete(t.states, f.state)
	}
}

// ---------------------------------------------------------------------------
// 二维码渲染
// ---------------------------------------------------------------------------

// qrPNGDataURL 把扫码 URL 渲染成 320px、ECC Medium 的 PNG data URL。
//
// 为什么在服务端生成：客户端只允许渲染 `<img>`，禁止把服务端返回的 SVG/HTML
// 塞进登录页（被控服务端的注入面）。PNG 是唯一被客户端接受的格式。
func qrPNGDataURL(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", errors.New("qr: empty content")
	}
	png, err := qrcode.Encode(text, qrcode.Medium, qrPNGSize)
	if err != nil {
		return "", fmt.Errorf("qr: encode png: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

// qrPNGDataURLFromPNG 把服务商返回的 PNG 图片变成客户端能接受的 data URL。
//
// 客户端硬约束：`data:image/png;base64,` 前缀 + 总长 ≤200_000 字符（见
// packages/host/enterprise/src/auth-gate.ts 的 isPngDataURL）。这里在服务端
// 先把形状和体积钉死，坏图不会被转发给客户端。
func qrPNGDataURLFromPNG(data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("qr: empty png")
	}
	if !bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return "", errors.New("qr: 服务商返回的不是 PNG")
	}
	encoded := base64.StdEncoding.EncodeToString(data)
	if len(encoded) > 190_000 {
		return "", errors.New("qr: png 过大")
	}
	return "data:image/png;base64," + encoded, nil
}

// ---------------------------------------------------------------------------
// 出站 HTTP（服务商公开 API）
// ---------------------------------------------------------------------------

// qrOutboundClient 是扫码兑换的**统一出站 client**：10s 超时 + 目标复检
// （链路本地/云 metadata 拦截）+ 重定向逐跳复检，与 oidcOutboundClient 同款
// 护栏（设计 §4.5）。服务商域名是编译期常量，但出站护栏仍是纵深防御 ——
// 它同时覆盖 DNS rebinding 与未来可能的基址注入。
var qrOutboundClient = &http.Client{
	Timeout:   qrExchangeTimeout,
	Transport: util.SafeOutboundTransport(),
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("qr: too many redirects")
		}
		return util.CheckOutboundTarget(req.Context(), req.URL.Hostname())
	},
}

// qrSafeURLError 剥掉 *url.Error 里的 URL：企业微信的 gettoken 把 corpsecret
// 放在 query 里，而 net/http 的错误字符串会带完整 URL —— 直接回显/落日志就是
// 一次凭据泄漏。只保留底层原因（连接失败/超时等），它不包含请求地址。
func qrSafeURLError(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) && uerr.Err != nil {
		return uerr.Err
	}
	return err
}

// qrGetJSON 发起 GET 并解码 JSON 响应（响应体有界）。
// label 用于错误信息；**绝不能**把 rawURL 拼进错误（可能含 secret）。
func qrGetJSON(ctx context.Context, client *http.Client, rawURL, label string, out any) error {
	return qrGetJSONWithHeaders(ctx, client, rawURL, label, nil, out)
}

// qrGetJSONWithHeaders 同 qrGetJSON，额外附带请求头（钉钉 users/me 的
// x-acs-dingtalk-access-token 走这里；token 不进 URL）。
func qrGetJSONWithHeaders(ctx context.Context, client *http.Client, rawURL, label string, headers map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fmt.Errorf("%s: 请求构造失败", label)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return qrDoJSON(client, req, label, out)
}

// qrPostJSON 发起 POST(JSON body)并解码 JSON 响应。
func qrPostJSON(ctx context.Context, client *http.Client, rawURL, label string, body, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("%s: 请求编码失败", label)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, strings.NewReader(string(payload)))
	if err != nil {
		return fmt.Errorf("%s: 请求构造失败", label)
	}
	req.Header.Set("Content-Type", "application/json")
	return qrDoJSON(client, req, label, out)
}

func qrDoJSON(client *http.Client, req *http.Request, label string, out any) error {
	if client == nil {
		client = qrOutboundClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s: 请求失败: %w", label, qrSafeURLError(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("%s: 服务商返回 HTTP %d", label, resp.StatusCode)
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, qrMaxResponseBytes))
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("%s: 响应解析失败", label)
	}
	return nil
}

// authRedirectURLAllowed 是浏览器跳转类登录方式 redirect_url 的**唯一判据**
// （webadmin 保存与 provider 构建共用）：必须 https，或 http 回环。
//
// 空串由调用方决定语义（未配置允许，启用时必填）；这里只判"非空值是否合法"。
func authRedirectURLAllowed(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	host := strings.Trim(u.Hostname(), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// qrStartBudgetKey 是扫码流程启动限流桶的**唯一键构造点**。
//
// 与 oidcFlowBudgetKey 同形，但用的是独立的 limiter 实例（每 API 一个，见
// API.qrStartLimiter），所以键里没有 dbLimiterScope：实例本身已经按 API 隔离。
func qrStartBudgetKey(c *gin.Context) string {
	return "qr-start-ip:" + c.ClientIP()
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

// qrStartHandler 处理 `POST /api/client/v2/auth/<name>/qr/start`。
//
// 请求体被忽略：回调地址来自服务端 settings，**不信任**客户端传入的任何
// 回跳参数（否则就是把 token 送去攻击者域名的入口）。
func (a *API) qrStartHandler(name string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p := a.qrProvider(name)
		if p == nil {
			writeError(c, http.StatusNotFound, "NOT_FOUND", "该登录方式未配置或已禁用")
			return
		}
		// 失败预算：判定只读，真实失败出口各 record 一次；成功不记账
		// （理由见 qrStartMaxAttempts —— 启动成功是匿名可得的）。
		startKey := qrStartBudgetKey(c)
		if a.qrStartLimiter.blocked(startKey) {
			_ = serverstore.AuditLog(a.DB, name, "login_fail", "rate_limited ip="+c.ClientIP())
			writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
			return
		}
		recordFailure := func() { a.qrStartLimiter.record(startKey) }
		// 容量拒绝走独立通道：计入进程级读数 + 写**动作可区分**的审计
		// （qr_flow_capacity，不是 login_fail），对外仍是同一个 429 文案。
		recordCapacity := func(reason string) {
			qrFlowCapacityRejections.Add(1)
			if a.DB != nil {
				_ = serverstore.AuditLog(a.DB, name, "qr_flow_capacity",
					"capacity_rejected reason="+reason+" ip="+c.ClientIP())
			}
		}
		flow, err := a.qrFlows.create(name, c.ClientIP())
		if err != nil {
			switch {
			case errors.Is(err, errQRFlowTableFull):
				recordCapacity("flow_table_full")
				writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
			case errors.Is(err, errQRFlowQuotaPerIP):
				recordCapacity("per_ip_quota")
				writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
			default:
				recordFailure()
				writeError(c, http.StatusInternalServerError, "INTERNAL", "二维码生成失败")
			}
			return
		}
		authURL, err := p.AuthURL(flow.state)
		if err != nil {
			a.qrFlows.discard(flow)
			recordFailure()
			_ = serverstore.AuditLog(a.DB, name, "login_fail", "start_failed ip="+c.ClientIP())
			writeError(c, http.StatusInternalServerError, "INTERNAL", "二维码生成失败")
			return
		}
		var png string
		if imgp, ok := p.(QRImageProvider); ok {
			// 官方二维码图片：直接返回服务商图片（转 PNG），不要把登录页 URL
			// 编码成二维码 —— 那会变成二次扫码（2026-11-03 真机缺陷）。
			img, ierr := imgp.QRImage(c.Request.Context(), flow.state)
			if ierr != nil {
				a.qrFlows.discard(flow)
				recordFailure()
				_ = serverstore.AuditLog(a.DB, name, "login_fail", "start_provider_failed ip="+c.ClientIP())
				writeError(c, http.StatusBadGateway, "QR_PROVIDER_UNAVAILABLE", "二维码生成失败:服务商暂不可用,请稍后重试")
				return
			}
			png, err = qrPNGDataURLFromPNG(img)
		} else {
			png, err = qrPNGDataURL(authURL)
		}
		if err != nil {
			a.qrFlows.discard(flow)
			recordFailure()
			_ = serverstore.AuditLog(a.DB, name, "login_fail", "start_failed ip="+c.ClientIP())
			writeError(c, http.StatusInternalServerError, "INTERNAL", "二维码生成失败")
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"flow_id": flow.id,
			// qr_url 是服务商官方登录页（含 state）。客户端用 iframe 嵌入它，
			// 让页面在手机确认后自己完成 redirect；仅靠 qr_png 图片时没有页面
			// 轮询/跳转，手机会停在“登录成功”而不回调（2026-11-03 真机缺陷）。
			"qr_url":     authURL,
			"qr_png":     png,
			"expires_in": int(qrFlowTTL.Seconds()),
		})
	}
}

// qrPollHandler 处理 `GET /api/client/v2/auth/<name>/qr/poll?flow_id=`。
//
// 未知/已消费/属于别的登录方式的 flow_id 一律 404（不泄露是否曾经存在）。
// 终态响应（done/failed/expired）会消费 flow_id，再轮询即 404。
func (a *API) qrPollHandler(name string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if a.qrProvider(name) == nil {
			writeError(c, http.StatusNotFound, "NOT_FOUND", "该登录方式未配置或已禁用")
			return
		}
		flowID := strings.TrimSpace(c.Query("flow_id"))
		if flowID == "" {
			writeError(c, http.StatusBadRequest, "VALIDATION", "缺少 flow_id")
			return
		}
		res, err := a.qrFlows.poll(flowID, name)
		if err != nil {
			writeError(c, http.StatusNotFound, "NOT_FOUND", "流程不存在或已失效")
			return
		}
		switch res.status {
		case "done":
			c.JSON(http.StatusOK, gin.H{
				"status": "done",
				"token":  res.token,
				"user":   userJSON(res.user),
				// 与本地登录同字段：客户端据此进入强制改密态。
				"must_change_password": res.mustChange,
			})
		case "failed":
			c.JSON(http.StatusOK, gin.H{"status": "failed", "error": res.failedPayload()})
		case "expired":
			c.JSON(http.StatusOK, gin.H{"status": "expired"})
		default:
			c.JSON(http.StatusOK, gin.H{"status": "pending"})
		}
	}
}

// qrCallbackHandler 处理 `GET /api/client/v2/auth/<name>/callback?code=&state=`。
//
// 由**手机浏览器**落地（服务商后台登记的 redirect_uri）。身份/授权边界完全
// 复用 OIDC 回调：provisionUser（外部身份按 ExternalID 绑定，不接管本地行）、
// Status != 1 → 401、RoleAuditor → 401 AUDITOR_NOT_ALLOWED、
// issueTokenForLogin（含自助签发配额）。失败时同时把流程标记为 failed，
// 让桌面端轮询拿到**同一个结论**（code + message）。
func (a *API) qrCallbackHandler(name string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p := a.qrProvider(name)
		if p == nil {
			writeError(c, http.StatusNotFound, "NOT_FOUND", "该登录方式未配置或已禁用")
			return
		}
		code := c.Query("code")
		state := strings.TrimSpace(c.Query("state"))
		if state == "" {
			writeError(c, http.StatusBadRequest, "VALIDATION", "缺少 code 或 state")
			return
		}
		// claim 原子消费 state：重复回调 / 已过期 / 跨 provider 都在这里被挡住。
		flow, err := a.qrFlows.claim(state, name)
		if err != nil {
			if errors.Is(err, errQRStateWrongProvider) {
				writeError(c, http.StatusBadRequest, "VALIDATION", "state 与登录方式不匹配")
				return
			}
			writeError(c, http.StatusBadRequest, "VALIDATION", "state 无效或已过期")
			return
		}
		failWith := func(status int, code, message, reason string) {
			a.qrFlows.markFailed(flow, code, message)
			detail := "ip=" + c.ClientIP()
			if reason != "" {
				detail = reason + " " + detail
			}
			_ = serverstore.AuditLog(a.DB, name, "login_fail", detail)
			writeError(c, status, code, message)
		}
		fail := func(status int, code, message string) {
			failWith(status, code, message, "")
		}
		if code == "" {
			fail(http.StatusBadRequest, "VALIDATION", "缺少 code 或 state")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), qrExchangeTimeout)
		defer cancel()
		ui, err := p.Exchange(ctx, code)
		if err != nil {
			fail(http.StatusUnauthorized, "AUTH_FAILED", "扫码登录认证失败")
			return
		}
		// 外部身份解析（RBAC 定制客户，默认关闭）：未启用/未命中时是纯 no-op。
		// 失败 fail-closed，且把稳定 code + 可读 message 交给流程，客户端 poll
		// 拿到的是与手机端一致的结论。
		ui, identErr := a.enrichExternalIdentity(ctx, name, ui)
		if identErr != nil {
			failWith(identErr.status, identErr.code, identErr.message, identErr.reason)
			return
		}
		identityApplied := ui.ExternalSource == "rbac"
		user, err := a.provisionUser(ui)
		if err != nil {
			if identityApplied && (errors.Is(err, serverstore.ErrIdentityConflict) || errors.Is(err, errUsernameLocalAccount)) {
				failWith(http.StatusForbidden, "IDENTITY_CONFLICT",
					"该用户名已被本地账号占用，请联系管理员", identityReasonConflict)
				return
			}
			if errors.Is(err, serverstore.ErrIdentityConflict) {
				fail(http.StatusUnauthorized, "AUTH_FAILED", "该用户名已绑定到其它身份源账号,请联系管理员")
				return
			}
			fail(http.StatusInternalServerError, "INTERNAL", "用户创建失败")
			return
		}
		if user.Status != 1 {
			fail(http.StatusUnauthorized, "AUTH_FAILED", "账号已禁用")
			return
		}
		// 审计账号禁止登录客户端（与本地登录/OIDC 回调同一道边界）。
		if user.Role == serverstore.RoleAuditor {
			fail(http.StatusUnauthorized, "AUDITOR_NOT_ALLOWED", "审计账号不可登录客户端,请使用管理后台")
			return
		}
		// 与本地登录/OIDC 回调共用同一份自助签发配额（按 user_id）。
		token, err := a.issueTokenForLogin(c, user)
		if err != nil {
			if errors.Is(err, errTokenIssueQuota) {
				fail(http.StatusTooManyRequests, "RATE_LIMITED", "令牌签发过于频繁,请稍后再试")
				return
			}
			fail(http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
			return
		}
		// token 只进内存流程，等首次 poll 取走；不写日志、不进 URL。
		a.qrFlows.markDone(flow, token, user)
		_ = serverstore.AuditLog(a.DB, user.Username, "login_success", name+" ip="+c.ClientIP())
		// 唯一的 text/html 响应（产品 HTML 面，见文件头）：静态字符串、无外链、
		// 无请求数据插值；唯一脚本是本地倒计时/尽力关闭，故 CSP 只放行 inline。
		c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(qrCallbackSuccessHTML))
	}
}
