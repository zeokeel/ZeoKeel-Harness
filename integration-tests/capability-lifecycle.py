#!/usr/bin/env python3
"""能力生命周期跨层 E2E（真 server + 真 wire）：员工上传 → 管理员审批 → 第二账号安装/更新。

## 为什么要这条腿（能力中心盘点 F-12，跨层 E2E 缺口）

能力中心的核心不变量是**跨层**的：员工上传的版本落在 `pending`，管理员审批后才对
**第二个账号**可见、可下载（安装），更新走同一套发布内核（版本递增/投影切换/旧版本可回滚）。
此前仓里没有任何一条用例把这三层（**员工面 HTTP → 管理端审批 → 员工面下载/安装**）
串起来跑：单包的 Go 测试各测一段、`electron-shots` 测 UI 结构、dex/ldap 只测登录。

本脚本用**真服务端 + 真 HTTP**（不 mock、不跳过 wire）走完整链路，断言四件事实：

1. **上传落 pending**：`POST /api/client/v2/shared-skills` 返回 201 且版本/状态与包内一致；
   `SKILL.md` 是身份真源（版本取自包内，不经请求）。
2. **审批可见性**：审批前管理员 `GET /api/server/admin/capabilities/approvals` 能看到这一行；
   第二个账号**看不到**（列表不含、归档 GET 404 —— 与"不存在"同形，不泄露存在性）。
3. **审批 + 授权才可安装**：管理员 `POST …/shared-skills/:name/:version/approve` 后，
   第二个账号**仍未授权**时依旧 404（双门制：审核 + 授权）；管理员
   `PUT …/shared-skills/:name/grant` 之后，第二个账号列表可见、`GET …/:version/archive`
   200，`X-Skill-Version` 与**下载字节的 sha256** 必须与上传时一致（安装器完整性契约）。
4. **更新与回滚**：作者上传 2.0.0 → 审批 → 第二账号看到的最新版本切到 2.0.0 且下载内容
   变了；**1.0.0 的归档仍可下载**（版本历史是回滚面，不能被更新覆盖）。

## 判据纪律（与 dex/ldap 同一套，见 integration-tests/README.md）

判据表 `CRITERIA` 是**唯一真源**，运行期只按 **id** 经 `contractkit.Reporter.report()`
求值；每条判据配**正例 + 负例**夹具，`--self-test` / `--self-check` 逐条自证；
`scripts/check-integration-tests.mjs` 还会在变异副本上把每条 `evaluate` 掏成 `return []`
并要求**具名变红**。把判据散写回运行期、或把某条判据换成恒真，都会在这几层当场红。

## 环境缺失时**显式 SKIP**（绝不打印 PASS）

| 原因码 | 触发条件 |
|---|---|
| `missing-server` | `GET {server}/healthz` 不可达/非 200 |
| `missing-credentials` | 缺员工 A/B/管理员账号（参数或环境变量），或登录失败 / 管理员开了 MFA（本脚本不做第二步登录） |

退出码：`0` = PASS；`1` = FAIL（契约不满足）；`2` = 用法错误；`77` = SKIP（未验证任何东西）。

## 账号与参数

需要**三个**真实账号（同一台服务端）：
- **员工 A**：非 admin（非管理员的发布会落 `pending`；管理员上传会直接 approved，
  本用例会因此判红并提示换账号）；负责上传两个版本。
- **员工 B**：第二个账号，验证"审批 + 授权后才能安装"。授权对象是 B 的用户名
  （`PUT …/:name/grant {"username": …}`）。
- **管理员**：`/api/server/admin/login`（本地账号；需要 `capability:write`，super_admin 即可）。

命令行优先于环境变量：

```bash
python3 capability-lifecycle.py [server] \
  --employee-user <uA> --employee-password <pA> \
  --second-user <uB> --second-password <pB> \
  --admin-user <admin> --admin-password <pAdmin>
# 环境变量：CAPABILITY_E2E_EMPLOYEE_USER/PASSWORD、CAPABILITY_E2E_SECOND_USER/PASSWORD、
#           CAPABILITY_E2E_ADMIN_USER/PASSWORD、SERVER_BASE（缺省 http://127.0.0.1:8091）
```

## 状态副作用与清理（认账）

真服务端上本用例会**创建**一个名字形如 `cap-e2e-<run-id>` 的组织共享技能（1.0.0 + 2.0.0
两个 approved 版本）并给员工 B 建一条授权。`approved` 版本**按设计不可删除**（F-01：
删除会销毁正在服务的归档字节），所以本脚本**不**在结束时删除它；跑完会打印清理指引：

```bash
# 下架（可逆，立刻对员工不可见/不可安装；管理端仍可见以便审计）
curl -X PUT "$SERVER/api/server/admin/shared-skills/<name>/enabled" \
  -H "X-CSRF-Token: <csrf>" -H "Content-Type: application/json" \
  -b "zeokeel_session=<sid>" -d '{"enabled":false}'
```

请用**专用测试部署**跑它（与 dex/ldap 的"真服务端"前置同一档），不要对着生产跑。
"""

import base64
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

# 契约判据通道（判定 + 计数 + 自检）在三个 .py 与门禁之间**只允许一份实现**。
# 关掉 .pyc 落地：本目录不在 .gitignore 的 __pycache__ 白名单里，导入本地模块
# 会在工作树里留下未跟踪目录（门禁每跑一次就多一份噪声）。
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    from contractkit import (  # noqa: E402 - 路径必须先插入,导入位置由设计决定
        EXIT_FAIL,
        EXIT_PASS,
        EXIT_SKIP,
        EXIT_USAGE,
        CriteriaError,
        Reporter,
        criteria_dump,
        observation_of,
        report_self_check_result,
        report_self_test_result,
        run_criteria_self_test,
        run_reporter_self_check,
    )
except ImportError as exc:  # pragma: no cover - 只在文件布局被破坏时触发
    print(f'capability-lifecycle: 无法加载契约判据通道 contractkit({exc})', file=sys.stderr)
    raise SystemExit(1)

DEFAULT_BASE = 'http://127.0.0.1:8091'
SESSION_COOKIE = 'zeokeel_session'
HTTP_TIMEOUT = 60.0

# SKIP 的**原因码闭集**（本用例允许打出的那几个）。
# 门禁（scripts/check-integration-tests.mjs）按它做双向对账：登记表里的 skipReasons 必须与这里
# 逐字相等、每个原因码都必须有调用点、每个调用点都必须给登记过的原因码。
SKIP_REASONS = ('missing-server', 'missing-credentials')


def skip(reason, detail):
    """让本用例以 SKIP(77) 收尾的**唯一出口**；原因码必须登记在 SKIP_REASONS 里。"""
    assert reason in SKIP_REASONS, f'未登记的 SKIP 原因码: {reason}'
    assert detail, 'SKIP 必须带可读的观测细节（否则聚合层只剩"跳过"两个字）'
    print(f'SKIP[{reason}]: {detail} —— 本次未验证任何东西')
    return EXIT_SKIP


# ---------------------------------------------------------------------------
# HTTP 原语（stdlib；不引入第三方依赖，与 dex/ldap 同一取向）
# ---------------------------------------------------------------------------
class Response:
    """一次 HTTP 调用的结果（状态码 / 头 / 字节体）；4xx/5xx 也原样返回而不是抛。"""

    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        try:
            return json.loads(self.body.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return None

    def header(self, name):
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return ''


def http(server, method, path, *, token=None, cookie=None, csrf=None, json_body=None,
         raw_body=None, timeout=HTTP_TIMEOUT):
    """发一次真 HTTP 请求。4xx/5xx 不抛异常（判据需要看真实状态码与信封）。"""
    url = server.rstrip('/') + path
    data = None
    headers = {}
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    elif raw_body is not None:
        data = raw_body
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if cookie:
        headers['Cookie'] = f'{SESSION_COOKIE}={cookie}'
    if csrf:
        headers['X-CSRF-Token'] = csrf
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return Response(response.status, list(response.headers.items()), response.read())
    except urllib.error.HTTPError as exc:
        return Response(exc.code, list(exc.headers.items()) if exc.headers else [], exc.read())
    except (urllib.error.URLError, OSError) as exc:
        return Response(0, [], str(exc).encode('utf-8', 'replace'))


# ---------------------------------------------------------------------------
# 归档构造（包内即真相：name/version/title/description 全在 SKILL.md frontmatter）
# ---------------------------------------------------------------------------
def skill_archive(name, version, note=''):
    """构造一个合法的技能 zip（根 SKILL.md），返回字节。

    与服务端 `skillmanifest.Parse` 的硬门槛逐条对齐：kebab-case name、semver version、
    标题非空、description ≥10 字、正文 ≥50 字、无 BOM、无 metadata.sources 溯源键。
    `note` 用来制造**内容不同**的两个版本（版本 2 的归档字节必须与版本 1 不同，
    否则服务端会以"内容未变更"拒绝，判据也就测不到更新）。
    """
    body = (
        f'# {name}\n\n'
        f'这是集成测试生成的技能正文（版本 {version}）。{note}'
        '正文必须足够长：服务端要求至少五十个字符，否则整份技能被判定为空壳。\n'
    )
    frontmatter = (
        '---\n'
        f'name: {name}\n'
        f'version: {version}\n'
        f'title: 生命周期测试技能 {version}\n'
        'description: 集成测试夹具：验证上传、审批、授权、安装与更新链路。\n'
        'author: capability-e2e\n'
        'category: 测试\n'
        '---\n\n'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('SKILL.md', frontmatter + body)
    return buffer.getvalue()


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def version_key(version):
    """"2.0.0" → (2, 0, 0)：列表里挑"最新版本"用（服务端投影口径是 semver 最大 approved）。"""
    parts = []
    for chunk in str(version).split('.'):
        try:
            parts.append(int(chunk))
        except ValueError:
            parts.append(-1)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


# ---------------------------------------------------------------------------
# 判据表（**唯一真源**；运行期只按 id 求值）
# ---------------------------------------------------------------------------
def _body_text(value):
    """把观测里的 body 统一成可读文本（dict / bytes / str 都能打印）。

    为什么需要它：判据负例夹具直接给解析后的 JSON（dict），而报错信息要能读——
    在 f-string 里直接切片 dict 会在**夹具自检**里抛 KeyError（判据自己被自己的
    诊断语句打死），那是典型的"判据的判据"事故。
    """
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)[:200]
    if isinstance(value, bytes):
        return value[:200].decode('utf-8', 'replace')
    return str(value)[:200]

def evaluate_upload_created(obs):
    obs = observation_of(obs, 'upload-created')
    problems = []
    if obs.get('status') != 201:
        problems.append(f'上传应 201，实际 {obs.get("status")}：{_body_text(obs.get("body"))}')
        return problems
    skill = (obs.get('body') or {}).get('skill') or {}
    if skill.get('name') != obs.get('expected_name'):
        problems.append(f'响应里的 name 不是本次声明的 {obs.get("expected_name")!r}：{skill!r}')
    if skill.get('version') != obs.get('expected_version'):
        problems.append(f'响应里的 version 不是包内的 {obs.get("expected_version")!r}：{skill!r}')
    if skill.get('status') != 'pending':
        problems.append(
            f'非管理员上传必须落 pending（实际 {skill.get("status")!r}）—— '
            '若上传账号本身是管理员，发布会直接 approved，请换一个非管理员员工账号')
    return problems


def evaluate_pending_approval_queued(obs):
    obs = observation_of(obs, 'pending-approval-queued')
    problems = []
    if obs.get('status') != 200:
        problems.append(f'审批队列应 200，实际 {obs.get("status")}：{_body_text(obs.get("body"))}')
        return problems
    rows = obs.get('rows') or []
    matched = [row for row in rows
               if row.get('kind') == 'skill'
               and row.get('name') == obs.get('expected_name')
               and row.get('version') == obs.get('expected_version')]
    if not matched:
        problems.append(
            f'审批队列里没有 {obs.get("expected_name")}@{obs.get("expected_version")}'
            f'（队列 {len(rows)} 行）—— 上传没有进入审批面')
        return problems
    if matched[0].get('status') != 'pending':
        problems.append(f'审批行状态应为 pending，实际 {matched[0].get("status")!r}')
    return problems


def evaluate_pending_not_visible(obs):
    obs = observation_of(obs, 'pending-not-visible')
    problems = []
    name = obs.get('expected_name')
    if obs.get('list_status') != 200:
        problems.append(f'第二个账号列表应 200，实际 {obs.get("list_status")}')
    if name in (obs.get('list_names') or []):
        problems.append(f'待审版本 {name!r} 不应出现在第二个账号的可见列表里（审核前不可见）')
    if obs.get('archive_status') != 404:
        problems.append(
            f'审批前下载应 404（与不存在同形），实际 {obs.get("archive_status")}'
            ' —— 未审核内容不得被下载/安装')
    return problems


def evaluate_approve_committed(obs):
    obs = observation_of(obs, 'approve-committed')
    problems = []
    if obs.get('status') != 200:
        problems.append(f'approve 应 200，实际 {obs.get("status")}：{_body_text(obs.get("body"))}')
        return problems
    body = obs.get('body') or {}
    if body.get('ok') is not True:
        problems.append(f'approve 响应必须 {{"ok":true}}，实际 {body!r}')
    if obs.get('admin_status') != 'approved':
        problems.append(f'管理端列表里该版本应为 approved，实际 {obs.get("admin_status")!r}')
    return problems


def evaluate_visibility_requires_grant(obs):
    obs = observation_of(obs, 'visibility-requires-grant')
    problems = []
    name = obs.get('expected_name')
    if name in (obs.get('list_names') or []):
        problems.append(
            f'审批通过但尚未授权时，{name!r} 不应出现在第二个账号的列表里'
            ' —— 双门制漏了授权门')
    if obs.get('archive_status') != 404:
        problems.append(
            f'未授权时下载应 404（不泄露存在性），实际 {obs.get("archive_status")}'
            ' —— 审核通过 ≠ 全组织可见')
    return problems


def evaluate_grant_visible(obs):
    obs = observation_of(obs, 'grant-visible')
    problems = []
    if obs.get('grant_status') != 200:
        problems.append(f'授权应 200，实际 {obs.get("grant_status")}：{_body_text(obs.get("body"))}')
        return problems
    if obs.get('list_status') != 200:
        problems.append(f'授权后列表应 200，实际 {obs.get("list_status")}')
        return problems
    if obs.get('expected_name') not in (obs.get('list_names') or []):
        problems.append(
            f'授权后 {obs.get("expected_name")!r} 仍不在第二个账号的可见列表里'
            f'（实际 {obs.get("list_names")!r}）')
    if not (obs.get('versions') or []):
        problems.append('授权后列表行没有任何版本 —— 可见性与版本投影不一致')
    return problems


def evaluate_archive_install(obs):
    obs = observation_of(obs, 'archive-install')
    problems = []
    if obs.get('status') != 200:
        problems.append(f'下载应 200，实际 {obs.get("status")}：{_body_text(obs.get("body"))}')
        return problems
    if int(obs.get('content_length') or 0) <= 0:
        problems.append('下载体为空 —— 安装器拿到空归档')
    if obs.get('x_skill_version') != obs.get('expected_version'):
        problems.append(
            f'X-Skill-Version 应为 {obs.get("expected_version")!r}，'
            f'实际 {obs.get("x_skill_version")!r} —— 下载的版本与审批的版本不一致')
    if obs.get('checksum_header') != obs.get('computed_checksum'):
        problems.append(
            f'X-Skill-Checksum 应为下载字节的 sha256（{obs.get("computed_checksum")}），'
            f'实际 {obs.get("checksum_header")!r} —— 完整性头失真会让客户端拒绝安装')
    return problems


def evaluate_archive_bytes_equal_upload(obs):
    obs = observation_of(obs, 'archive-bytes-equal-upload')
    problems = []
    if obs.get('downloaded_sha256') in (None, ''):
        problems.append('没有拿到下载字节的 sha256')
    if obs.get('downloaded_sha256') != obs.get('uploaded_sha256'):
        problems.append(
            f'下载字节（{obs.get("downloaded_sha256")}）与上传字节'
            f'（{obs.get("uploaded_sha256")}）不一致 —— 审核/存储链路改写了归档')
    return problems


def evaluate_update_version(obs):
    obs = observation_of(obs, 'update-version')
    problems = []
    if obs.get('upload_status') not in (200, 201):
        problems.append(f'上传 2.0.0 应 200/201，实际 {obs.get("upload_status")}')
        return problems
    if obs.get('approve_status') != 200:
        problems.append(f'审批 2.0.0 应 200，实际 {obs.get("approve_status")}')
        return problems
    versions = obs.get('versions') or []
    if not versions:
        problems.append('更新后列表没有任何版本')
        return problems
    latest = max(versions, key=version_key)
    if latest != obs.get('expected_latest'):
        problems.append(f'第二个账号看到的最新版本应为 {obs.get("expected_latest")!r}，实际 {latest!r}')
    if obs.get('old_checksum') == obs.get('new_checksum'):
        problems.append('2.0.0 的下载内容与 1.0.0 相同 —— 更新没有真的换内容（判据测不到更新）')
    return problems


def evaluate_legacy_version_still_served(obs):
    obs = observation_of(obs, 'legacy-version-still-served')
    problems = []
    if obs.get('status') != 200:
        problems.append(
            f'历史版本下载应 200（回滚面），实际 {obs.get("status")}'
            ' —— 更新不得覆盖旧版本归档')
    if obs.get('x_skill_version') != obs.get('expected_version'):
        problems.append(
            f'历史版本响应头 X-Skill-Version 应为 {obs.get("expected_version")!r}，'
            f'实际 {obs.get("x_skill_version")!r}')
    return problems


CRITERIA = [
    {'id': 'upload-created', 'name': '员工上传落 pending 且版本取自包内',
     'evaluate': evaluate_upload_created},
    {'id': 'pending-approval-queued', 'name': '待审版本进入管理员审批队列',
     'evaluate': evaluate_pending_approval_queued},
    {'id': 'pending-not-visible', 'name': '审核前第二个账号不可见/不可下载',
     'evaluate': evaluate_pending_not_visible},
    {'id': 'approve-committed', 'name': '管理员审批通过且投影为 approved',
     'evaluate': evaluate_approve_committed},
    {'id': 'visibility-requires-grant', 'name': '审核通过但未授权仍不可见（双门制）',
     'evaluate': evaluate_visibility_requires_grant},
    {'id': 'grant-visible', 'name': '授权后第二个账号可见该技能',
     'evaluate': evaluate_grant_visible},
    {'id': 'archive-install', 'name': '第二账号 GET 归档：200 + 版本/完整性头一致',
     'evaluate': evaluate_archive_install},
    {'id': 'archive-bytes-equal-upload', 'name': '下载字节与上传字节逐字节一致（sha256）',
     'evaluate': evaluate_archive_bytes_equal_upload},
    {'id': 'update-version', 'name': '上传审批 2.0.0 后最新版本与内容切换',
     'evaluate': evaluate_update_version},
    {'id': 'legacy-version-still-served', 'name': '历史版本 1.0.0 仍可下载（回滚面）',
     'evaluate': evaluate_legacy_version_still_served},
]

# 判据 id → 名称（登记值核对与诊断用；增删判据必须同步 scripts/check-integration-tests.mjs）。
CRITERIA_IDS = [item['id'] for item in CRITERIA]


# ---------------------------------------------------------------------------
# 自检夹具（每条判据至少一条正例 + 一条负例；门禁按 id 精确对拍条数）
# ---------------------------------------------------------------------------
SELF_TEST_FIXTURES = [
    # upload-created
    {'id': 'upload-created', 'expect': True, 'why': '201 + pending + 版本来自包内',
     'observation': {'status': 201, 'expected_name': 'cap-e2e-abcd1234',
                     'expected_version': '1.0.0',
                     'body': {'skill': {'name': 'cap-e2e-abcd1234', 'version': '1.0.0',
                                        'status': 'pending'}}}},
    {'id': 'upload-created', 'expect': False, 'why': '负例：管理员上传直接 approved',
     'observation': {'status': 201, 'expected_name': 'cap-e2e-abcd1234',
                     'expected_version': '1.0.0',
                     'body': {'skill': {'name': 'cap-e2e-abcd1234', 'version': '1.0.0',
                                        'status': 'approved'}}}},
    # pending-approval-queued
    {'id': 'pending-approval-queued', 'expect': True, 'why': '队列含 pending 行',
     'observation': {'status': 200, 'expected_name': 'cap-e2e-abcd1234', 'expected_version': '1.0.0',
                     'rows': [{'kind': 'skill', 'name': 'cap-e2e-abcd1234',
                               'version': '1.0.0', 'status': 'pending'}]}},
    {'id': 'pending-approval-queued', 'expect': False, 'why': '负例：队列里只有别的技能',
     'observation': {'status': 200, 'expected_name': 'cap-e2e-abcd1234', 'expected_version': '1.0.0',
                     'rows': [{'kind': 'skill', 'name': 'other-skill',
                               'version': '1.0.0', 'status': 'pending'}]}},
    # pending-not-visible
    {'id': 'pending-not-visible', 'expect': True, 'why': '列表无、下载 404',
     'observation': {'expected_name': 'cap-e2e-abcd1234', 'list_status': 200,
                     'list_names': ['other-skill'], 'archive_status': 404}},
    {'id': 'pending-not-visible', 'expect': False, 'why': '负例：下载返回 200（审核前可装）',
     'observation': {'expected_name': 'cap-e2e-abcd1234', 'list_status': 200,
                     'list_names': ['cap-e2e-abcd1234'], 'archive_status': 200}},
    # approve-committed
    {'id': 'approve-committed', 'expect': True, 'why': '200 + ok:true + approved',
     'observation': {'status': 200, 'body': {'ok': True}, 'admin_status': 'approved'}},
    {'id': 'approve-committed', 'expect': False, 'why': '负例：409 名称冲突',
     'observation': {'status': 409, 'body': {'error': {'code': 'CONFLICT'}},
                     'admin_status': 'pending'}},
    # visibility-requires-grant
    {'id': 'visibility-requires-grant', 'expect': True, 'why': '未授权：列表无、下载 404',
     'observation': {'expected_name': 'cap-e2e-abcd1234', 'list_names': [],
                     'archive_status': 404}},
    {'id': 'visibility-requires-grant', 'expect': False, 'why': '负例：未授权却列表可见',
     'observation': {'expected_name': 'cap-e2e-abcd1234',
                     'list_names': ['cap-e2e-abcd1234'], 'archive_status': 404}},
    # grant-visible
    {'id': 'grant-visible', 'expect': True, 'why': '授权 200 后列表含该技能',
     'observation': {'grant_status': 200, 'list_status': 200,
                     'expected_name': 'cap-e2e-abcd1234',
                     'list_names': ['cap-e2e-abcd1234'], 'versions': ['1.0.0']}},
    {'id': 'grant-visible', 'expect': False, 'why': '负例：授权 200 但列表仍不可见',
     'observation': {'grant_status': 200, 'list_status': 200,
                     'expected_name': 'cap-e2e-abcd1234',
                     'list_names': [], 'versions': []}},
    # archive-install
    {'id': 'archive-install', 'expect': True, 'why': '200 + 版本头 + 校验头一致',
     'observation': {'status': 200, 'content_length': 512,
                     'expected_version': '1.0.0', 'x_skill_version': '1.0.0',
                     'checksum_header': 'abc', 'computed_checksum': 'abc'}},
    {'id': 'archive-install', 'expect': False, 'why': '负例：未授权 404',
     'observation': {'status': 404, 'content_length': 0,
                     'expected_version': '1.0.0', 'x_skill_version': '',
                     'checksum_header': '', 'computed_checksum': 'abc'}},
    {'id': 'archive-install', 'expect': False,
     'why': '负例：X-Skill-Checksum 与下载字节不符（完整性头失真）',
     'observation': {'status': 200, 'content_length': 512,
                     'expected_version': '1.0.0', 'x_skill_version': '1.0.0',
                     'checksum_header': 'deadbeef', 'computed_checksum': 'abc'}},
    # archive-bytes-equal-upload
    {'id': 'archive-bytes-equal-upload', 'expect': True, 'why': '两端 sha256 相同',
     'observation': {'uploaded_sha256': 'abc', 'downloaded_sha256': 'abc'}},
    {'id': 'archive-bytes-equal-upload', 'expect': False, 'why': '负例：下载字节被改写',
     'observation': {'uploaded_sha256': 'abc', 'downloaded_sha256': 'def'}},
    # update-version
    {'id': 'update-version', 'expect': True, 'why': '2.0.0 成为最新且内容变化',
     'observation': {'upload_status': 201, 'approve_status': 200,
                     'expected_latest': '2.0.0', 'versions': ['1.0.0', '2.0.0'],
                     'old_checksum': 'aaa', 'new_checksum': 'bbb'}},
    {'id': 'update-version', 'expect': False, 'why': '负例：审批失败，最新仍是 1.0.0',
     'observation': {'upload_status': 201, 'approve_status': 409,
                     'expected_latest': '2.0.0', 'versions': ['1.0.0'],
                     'old_checksum': 'aaa', 'new_checksum': 'aaa'}},
    {'id': 'update-version', 'expect': False, 'why': '负例：2.0.0 内容与 1.0.0 相同',
     'observation': {'upload_status': 201, 'approve_status': 200,
                     'expected_latest': '2.0.0', 'versions': ['1.0.0', '2.0.0'],
                     'old_checksum': 'aaa', 'new_checksum': 'aaa'}},
    # legacy-version-still-served
    {'id': 'legacy-version-still-served', 'expect': True, 'why': '1.0.0 仍 200 且版本头正确',
     'observation': {'status': 200, 'expected_version': '1.0.0', 'x_skill_version': '1.0.0'}},
    {'id': 'legacy-version-still-served', 'expect': False, 'why': '负例：更新把旧版本覆盖成 404',
     'observation': {'status': 404, 'expected_version': '1.0.0', 'x_skill_version': ''}},
]

# 夹具条数下限（棘轮）：删夹具必须同时改这个常量与门禁里的登记值并写明理由。
CAPABILITY_MIN_FIXTURES = 22


def _new_reporter():
    """运行期的判定通道（`--self-check` 与真实跑**共用同一个构造点**）。

    门禁的 `runtime-wrapper` 变异就注入在这里 —— 把通道换成恒真包装之后
    `--self-check` 必须非零（自检消费的就是运行期这条通道）。
    """
    return Reporter(CRITERIA)


# ---------------------------------------------------------------------------
# 自检入口（判据本体 / 判定通道 / 判据表登记值）
# ---------------------------------------------------------------------------
def self_test():
    result = run_criteria_self_test(CRITERIA, SELF_TEST_FIXTURES)
    if result['total'] < CAPABILITY_MIN_FIXTURES:
        result['failures'].append(
            f'判据夹具只剩 {result["total"]} 条（下限 {CAPABILITY_MIN_FIXTURES}）—— 判据被删到没有判别力')
        result['passed'] = result['total'] - len(result['failures'])
    return report_self_test_result(result)


def self_check():
    reporter = _new_reporter()
    result = run_reporter_self_check(reporter, CRITERIA, SELF_TEST_FIXTURES)
    return report_self_check_result(result)


# ---------------------------------------------------------------------------
# 参数解析（命令行 > 环境变量；位置参数 = 服务端地址）
# ---------------------------------------------------------------------------
def parse_args(argv):
    options = {
        'server': os.environ.get('SERVER_BASE') or DEFAULT_BASE,
        'employee_user': os.environ.get('CAPABILITY_E2E_EMPLOYEE_USER', ''),
        'employee_password': os.environ.get('CAPABILITY_E2E_EMPLOYEE_PASSWORD', ''),
        'second_user': os.environ.get('CAPABILITY_E2E_SECOND_USER', ''),
        'second_password': os.environ.get('CAPABILITY_E2E_SECOND_PASSWORD', ''),
        'admin_user': os.environ.get('CAPABILITY_E2E_ADMIN_USER', ''),
        'admin_password': os.environ.get('CAPABILITY_E2E_ADMIN_PASSWORD', ''),
        'self_test': False,
        'self_check': False,
        'dump': False,
    }
    flags = {
        '--employee-user': 'employee_user', '--employee-password': 'employee_password',
        '--second-user': 'second_user', '--second-password': 'second_password',
        '--admin-user': 'admin_user', '--admin-password': 'admin_password',
    }
    positional = []
    rest = list(argv)
    while rest:
        item = rest.pop(0)
        if item == '--self-test':
            options['self_test'] = True
        elif item == '--self-check':
            options['self_check'] = True
        elif item == '--dump-criteria':
            options['dump'] = True
        elif item in flags:
            if not rest:
                print(f'capability-lifecycle: {item} 需要一个值', file=sys.stderr)
                raise SystemExit(EXIT_USAGE)
            options[flags[item]] = rest.pop(0)
        elif item in ('-h', '--help'):
            print(__doc__)
            raise SystemExit(EXIT_PASS)
        elif item.startswith('-'):
            print(f'capability-lifecycle: 未知参数 {item}（用 --help）', file=sys.stderr)
            raise SystemExit(EXIT_USAGE)
        else:
            positional.append(item)
    if len(positional) > 1:
        print('capability-lifecycle: 最多一个位置参数（服务端地址）', file=sys.stderr)
        raise SystemExit(EXIT_USAGE)
    if positional:
        options['server'] = positional[0]
    return options


# ---------------------------------------------------------------------------
# 运行期编排（真 server + 真 wire）
# ---------------------------------------------------------------------------
def login_employee(server, username, password):
    """客户端面本地登录 → Bearer token（`/api/client/v2/auth/login`）。"""
    return http(server, 'POST', '/api/client/v2/auth/login',
                json_body={'username': username, 'password': password})


def login_admin(server, username, password):
    """管理端登录 → (session cookie, csrf token)；MFA 开启时返回 (None, None)。"""
    response = http(server, 'POST', '/api/server/admin/login',
                    json_body={'username': username, 'password': password})
    if response.status != 200:
        return None, None, response
    payload = response.json() or {}
    if payload.get('mfa_required'):
        return None, None, response
    cookie = ''
    for key, value in response.headers:
        if key.lower() == 'set-cookie' and value.startswith(SESSION_COOKIE + '='):
            cookie = value.split(';', 1)[0].split('=', 1)[1]
    csrf = payload.get('csrf_token') or ''
    if cookie == '' or csrf == '':
        return None, None, response
    return cookie, csrf, response


def admin_headers(cookie):
    return {'cookie': cookie}


def list_employee_skills(server, token):
    response = http(server, 'GET', '/api/client/v2/shared-skills', token=token)
    payload = response.json() or {}
    rows = payload.get('skills') or []
    names = sorted({str(row.get('name')) for row in rows})
    versions = sorted({str(row.get('version')) for row in rows})
    return response.status, names, versions, rows


def find_admin_row(server, cookie, name, version):
    response = http(server, 'GET', '/api/server/admin/shared-skills', cookie=cookie)
    rows = (response.json() or {}).get('skills') or []
    for row in rows:
        if row.get('name') == name and row.get('version') == version:
            return response.status, row
    return response.status, None


def download_archive(server, token, name, version):
    return http(server, 'GET', f'/api/client/v2/shared-skills/{name}/{version}/archive', token=token)


def main(argv):
    options = parse_args(argv)
    if options['self_test']:
        return self_test()
    if options['self_check']:
        return self_check()
    if options['dump']:
        print(json.dumps(criteria_dump(CRITERIA, SELF_TEST_FIXTURES), ensure_ascii=False, indent=2))
        return EXIT_PASS

    server = options['server'].rstrip('/')
    reporter = _new_reporter()

    def finish():
        ok = reporter.failures() == 0
        print('RESULT:', 'PASS' if ok else 'FAIL')
        return EXIT_PASS if ok else EXIT_FAIL

    print(f'== 能力生命周期跨层 E2E（server={server}） ==')

    # 0. 环境探测 —— 先分清"环境没起来(SKIP)"与"契约不满足(FAIL)"。
    health = http(server, 'GET', '/healthz')
    if health.status != 200:
        return skip('missing-server',
                    f'{server}/healthz 不可达/非 200（status={health.status}）—— 服务端没起来')

    required = [('employee', options['employee_user'], options['employee_password']),
                ('second', options['second_user'], options['second_password']),
                ('admin', options['admin_user'], options['admin_password'])]
    missing = [label for label, username, password in required if username == '' or password == '']
    if missing:
        return skip('missing-credentials',
                    '缺这些账号参数/环境变量：'
                    + ', '.join(f'{label}(账号/密码)' for label in missing)
                    + ' —— 本用例需要员工A/员工B/管理员三个真实账号')

    employee_login = login_employee(server, options['employee_user'], options['employee_password'])
    if employee_login.status != 200 or not (employee_login.json() or {}).get('token'):
        return skip('missing-credentials',
                    f'员工A 登录失败（status={employee_login.status}）—— '
                    '账号/密码不对，或该服务端未启用 local 登录')
    employee_token = (employee_login.json() or {})['token']

    second_login = login_employee(server, options['second_user'], options['second_password'])
    if second_login.status != 200 or not (second_login.json() or {}).get('token'):
        return skip('missing-credentials',
                    f'员工B（第二个账号）登录失败（status={second_login.status}）—— 账号/密码不对')
    second_token = (second_login.json() or {})['token']

    admin_cookie, admin_csrf, admin_login = login_admin(
        server, options['admin_user'], options['admin_password'])
    if admin_cookie is None:
        payload = admin_login.json() or {}
        mfa = payload.get('mfa_required')
        return skip('missing-credentials',
                    f'管理员登录未拿到会话（status={admin_login.status}'
                    f'{", mfa_required=True（本用例不做第二步登录）" if mfa else ""}）—— '
                    '需要本地管理员账号（capability:write）')

    run_id = uuid.uuid4().hex[:8]
    name = f'cap-e2e-{run_id}'
    version_one = '1.0.0'
    version_two = '2.0.0'
    archive_one = skill_archive(name, version_one, note='第一版。')
    archive_two = skill_archive(name, version_two, note='第二版（内容必须与第一版不同）。')
    checksum_one = sha256_hex(archive_one)
    checksum_two = sha256_hex(archive_two)

    print(f'  ·  本轮技能名 {name}（跑完会留在服务端：approved 版本按设计不可删除）')

    # 1. 员工 A 上传 1.0.0 → 必须落 pending（非管理员发布）。
    upload_one = http(server, 'POST', '/api/client/v2/shared-skills', token=employee_token,
                      json_body={'name': name, 'archive': base64.b64encode(archive_one).decode('ascii')})
    upload_one_payload = upload_one.json() or {}
    reporter.report('upload-created', {
        'status': upload_one.status, 'body': upload_one_payload,
        'expected_name': name, 'expected_version': version_one,
    })

    # 2. 待审版本必须进入管理员审批队列。
    approvals = http(server, 'GET', '/api/server/admin/capabilities/approvals', cookie=admin_cookie)
    approvals_payload = approvals.json() or {}
    reporter.report('pending-approval-queued', {
        'status': approvals.status,
        'body': json.dumps(approvals_payload, ensure_ascii=False)[:300],
        'rows': approvals_payload.get('approvals') or [],
        'expected_name': name, 'expected_version': version_one,
    })

    # 3. 审核前：第二个账号列表不含、下载 404（与不存在同形）。
    list_before_status, names_before, _, _ = list_employee_skills(server, second_token)
    archive_before = download_archive(server, second_token, name, version_one)
    reporter.report('pending-not-visible', {
        'expected_name': name, 'list_status': list_before_status,
        'list_names': names_before, 'archive_status': archive_before.status,
    })

    # 4. 管理员审批通过。
    approve = http(server, 'POST',
                   f'/api/server/admin/shared-skills/{name}/{version_one}/approve',
                   cookie=admin_cookie, csrf=admin_csrf)
    _, admin_row_one = find_admin_row(server, admin_cookie, name, version_one)
    reporter.report('approve-committed', {
        'status': approve.status,
        'body': approve.json() or {},
        'admin_status': (admin_row_one or {}).get('status'),
    })

    # 5. 双门制：审核通过但**未授权**时，第二个账号仍不可见（不泄露存在性）。
    list_pending_grant_status, names_pending_grant, _, _ = list_employee_skills(server, second_token)
    archive_pending_grant = download_archive(server, second_token, name, version_one)
    reporter.report('visibility-requires-grant', {
        'expected_name': name, 'list_names': names_pending_grant,
        'archive_status': archive_pending_grant.status,
    })

    # 6. 管理员把该技能授权给员工 B（用户级授权）。主体不存在时是配置错误 ⇒ FAIL 并指路。
    grant = http(server, 'PUT', f'/api/server/admin/shared-skills/{name}/grant',
                 cookie=admin_cookie, csrf=admin_csrf,
                 json_body={'username': options['second_user']})
    list_granted_status, names_granted, versions_granted, _ = list_employee_skills(server, second_token)
    reporter.report('grant-visible', {
        'grant_status': grant.status,
        'body': json.dumps(grant.json() or {}, ensure_ascii=False)[:300],
        'list_status': list_granted_status, 'expected_name': name,
        'list_names': names_granted, 'versions': versions_granted,
    })

    # 7. 第二账号安装（= GET 归档）：版本头与完整性头必须对得上。
    download_one = download_archive(server, second_token, name, version_one)
    reporter.report('archive-install', {
        'status': download_one.status,
        'body': download_one.body[:200].decode('utf-8', 'replace'),
        'content_length': len(download_one.body),
        'expected_version': version_one,
        'x_skill_version': download_one.header('X-Skill-Version'),
        'checksum_header': download_one.header('X-Skill-Checksum'),
        'computed_checksum': sha256_hex(download_one.body),
    })

    # 8. 下载字节必须与上传字节一致（审核/存储链路不得改写归档）。
    reporter.report('archive-bytes-equal-upload', {
        'uploaded_sha256': checksum_one,
        'downloaded_sha256': sha256_hex(download_one.body) if download_one.status == 200 else None,
    })

    # 9. 更新：员工 A 上传 2.0.0 → 审批 → 第二个账号看到最新版本切换、内容变化。
    upload_two = http(server, 'POST', '/api/client/v2/shared-skills', token=employee_token,
                      json_body={'name': name, 'archive': base64.b64encode(archive_two).decode('ascii')})
    approve_two = http(server, 'POST',
                       f'/api/server/admin/shared-skills/{name}/{version_two}/approve',
                       cookie=admin_cookie, csrf=admin_csrf)
    _, _, versions_after_update, _ = list_employee_skills(server, second_token)
    download_two = download_archive(server, second_token, name, version_two)
    reporter.report('update-version', {
        'upload_status': upload_two.status,
        'approve_status': approve_two.status,
        'expected_latest': version_two,
        'versions': versions_after_update,
        'old_checksum': sha256_hex(download_one.body) if download_one.status == 200 else '',
        'new_checksum': sha256_hex(download_two.body) if download_two.status == 200 else '',
    })

    # 10. 回滚面：1.0.0 必须仍可下载（更新不得覆盖旧版本归档）。
    download_one_again = download_archive(server, second_token, name, version_one)
    reporter.report('legacy-version-still-served', {
        'status': download_one_again.status,
        'expected_version': version_one,
        'x_skill_version': download_one_again.header('X-Skill-Version'),
    })

    print(f'  ·  清理指引（approved 不可删，请下架）：'
          f'PUT {server}/api/server/admin/shared-skills/{name}/enabled'
          ' -b zeokeel_session=<sid> -H "X-CSRF-Token: <csrf>" -d \'{"enabled":false}\'')
    return finish()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
