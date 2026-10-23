# 部署配置入库（数据库 + 控制台），环境变量降级为覆盖口（2026-10-23）

- 状态：**已实施**
- 用户口径（本轮）：**「系统配置配到数据库里，不要用一大堆环境变量启动」** —— 部署只要
  4 个引导键，其余运维该调的旋钮在控制台可见、可改、改了能生效。
- 涉及代码：`server/internal/deployconfig`（注册表 + 解析）、`server/internal/serverauth/config_admin.go`
  （管理端 API）、`server/webadmin/src/pages/SystemConfig.tsx`（「系统配置」页）；
  本节只记**为什么这样切**，字段级口径在代码注释里。

## 1. 缺陷形态（修前）

1. **同一个旋钮在 8 个包各自 `os.Getenv`**：登录失败上限在 `serverauth`、遥测预算在
   `telemetry`、in-flight 闸门在 `llmgateway`、审计链间隔在 `cmd/server`、应用平台档位在
   `wasmapp`……"能不能调、现在是多少、默认是多少"没有任何单点能回答。
2. **控制台完全看不见它们**：webadmin 只有各业务域自己的配置面（网关页、应用平台页……），
   部署级旋钮没有可视出口；运维只能读文档 + 猜 `.env`。
3. **改一条限流要重建容器**：容器里的 env 是**启动期快照**，改完必须 `docker compose up -d`
   —— 为了调一个每用户并发数重启服务，可用性代价与配置粒度完全不成比例。
4. **非法值口径不一**：有的键 `strconv.Atoi` 失败静默回落默认、有的直接 `log.Fatalf`、
   有的完全不校验；同一个部署里出现两套"写错会怎样"。
5. **升级即静默变行为**：想"改成库优先"必须同时回答"存量 `.env` 里的值算不算数"，
   否则升级后行为静默变化（见 §3 的取舍）。

## 2. 设计

### 2.1 唯一真源：注册表

`server/internal/deployconfig/keys.go` 的 `registry` 是**唯一真源**：每个可配置项在
**一处**声明 `Setting`（`settings` 表键）、`Env`（历史环境变量名 = 覆盖口）、`Title`、
`Description`、`Category`（控制台分组）、`Kind`（string/int/bool/duration/csv/choice）、
`Default`、取值域（`Min`/`Max`/`MinDuration`/`Choices`）与 `AppliesAt`（生效时机）。

- 解析（`Resolve`）与校验（`Key.Parse`）**只实现一次**：读取路径（运行时）与控制台保存路径
  共用同一份判据 ⇒ "控制台能存进去、启动时被判非法回落"这种两侧漂移不可能再出现。
- 新增键的纪律写在 `registry` 的注释里：先声明（含说明与取值域）再改调用点；`Env` 名必须与
  历史代码逐字一致（改名 = 换契约）。

当前 12 项（控制台分组 / settings 键 / 历史 env 覆盖口）：

| 控制台分组 | settings 键 | 历史 env | 生效时机 |
|---|---|---|---|
| 认证与安全 | `auth.login_max_attempts` | `ZEOKEEL_LOGIN_MAX_ATTEMPTS` | 保存即生效 |
| 认证与安全 | `auth.ldap_allow_plaintext` | `ZEOKEEL_LDAP_ALLOW_PLAINTEXT` | 保存即生效 |
| 对外地址与更新 | `deploy.update_endpoint` | `ZEOKEEL_UPDATE_ENDPOINT` | 保存即生效 |
| 网络与反代 | `deploy.trusted_hosts` | `ZEOKEEL_TRUSTED_HOSTS` | 保存即生效 |
| AI 网关 | `gateway.max_inflight_per_user` | `ZEOKEEL_GATEWAY_MAX_INFLIGHT_PER_USER` | 保存即生效 |
| 遥测 | `telemetry.max_per_min` | `ZEOKEEL_TELEMETRY_MAX_PER_MIN` | 保存即生效 |
| 遥测 | `telemetry.max_per_skill_per_min` | `ZEOKEEL_TELEMETRY_MAX_PER_SKILL_PER_MIN` | 保存即生效 |
| 遥测 | `telemetry.error_reporting_max_per_min` | `ZEOKEEL_TELEMETRY_ERROR_REPORTING_MAX_PER_MIN` | 保存即生效 |
| 审计 | `audit.chain_interval` | `ZEOKEEL_AUDIT_CHAIN_INTERVAL` | **需重启/重建容器** |
| 应用平台 | `wasm.apps_extra_reserved` | `ZEOKEEL_APPS_EXTRA_RESERVED` | **需重启/重建容器** |
| 应用平台 | `wasm.memory_profile` | `ZEOKEEL_WASM_MEMORY_PROFILE` | **需重启/重建容器** |
| 应用平台 | `wasm.compile_isolation` | `ZEOKEEL_COMPILE_ISOLATION` | **需重启/重建容器** |

**生效时机**的判据是"这个值在进程里怎么被用掉"：读路径每次解析的（限流、限额、开关）=
`hot`；在启动时一次性装配的（调度器 tick、平台内存档位、编译隔离、保留名集合）= `restart`。
`restart` 不是实现偷懒，而是值的语义本身绑定在已装配的对象上（例：档位决定实例池与内存水位，
换档位必须重建池）。

### 2.2 优先级：显式 env > 控制台 > 默认

**为什么不是"库优先"**（2026-10-23 明确取舍）：

1. **升级安全**：存量部署的 `.env` 里就写着这些键。若改成库优先，升级后行为会静默变化 ——
   例如小内存机器原本靠 `ZEOKEEL_WASM_MEMORY_PROFILE=small` 才能启动，库里没有这一行时
   会回落到 `default`，启动自检直接拒绝启动，而那台机器这时**连控制台都进不去**。
2. **逃生口**：`wasm.memory_profile` / `wasm.compile_isolation` 是**启动闸门** —— 库里的值
   配错会让容器起不来。这时唯一能救的就是"容器外的开关"（env 在编排层，库里的值要容器起来
   才能读）。
3. **不静默**：env 压过库值必须**看得见**。两处点名：控制台该页给"环境变量覆盖"徽标/横幅；
   启动日志一行 `deployconfig: 以下配置来自环境变量（优先于控制台配置；…）：<键名列表>`
   （只打键名，不打取值）。于是"我在控制台改了怎么没生效"永远带线索。

代价（认账）：同一个键有 env 行时控制台改不动。处置明确写在页面与文档里：删掉 `.env` 那一行，
交还控制台。

### 2.3 非法值与告警

- **控制台保存路径**：`Key.Parse` 校验，非法直接 `400 VALIDATION`（错误文案含键名与取值域），
  不入库。
- **读取路径**：非法值**回落到下一个来源**并各打一次 WARNING（`warnOnce` 按 键+原因 去重，
  因为限流类键在热路径上）。不让一条写错的配置把服务端起不来 —— 启动闸门类键仍由各自的
  装配点决定 fail-closed（`wasm.memory_profile` 解析失败即 `log.Fatalf`，保留原有语义）。

### 2.4 管理端接口与页面

- `GET /api/server/admin/config` → `{items:[{key,env,title,description,category,kind,value,
  source,default,applies_at,min,max,choices,env_value,setting_value,invalid}],env_overrides:[…]}`
  （`source` = `env` / `setting` / `default`，是稳定契约，前端徽标依赖它）。
- `PUT /api/server/admin/config {values:{key:value}}` → `{saved:[…],warnings:[…]}`：只接受注册表
  认识的键（未知键 400）；空串 = 删除该 `settings` 行（回落 env/默认）；写库 + 审计同事务
  （`action=deploy_config`，detail 记 `key: old→new`）；生效值来自 env 的键在 `warnings` 里点名。
- 页面：webadmin 侧栏**「系统配置」**（`config:read` 可见 / `config:write` 可写；**不**给
  `auditor` —— 该页暴露部署拓扑与限额口径）。按 `Category` 分组卡片，每项显示标题、说明、
  生效值、来源徽标、生效时机；`restart` 类给"保存后需 `docker compose up -d server`"提示。

### 2.5 部署面收敛

- `server/.env.example` 从 186 行收敛成「4 个必填 + 历史覆盖口清单 + 有意不入库清单」；
- `server/docker-compose.yml` 的 `server.environment` 按「启动必需/引导 / 网络拓扑 /
  历史覆盖口 / 有意不入库」分组注释，**不删任何现有键**（见 §2.6 判据）；
- `docs/deploy/AI-DEPLOY.md` §2.2 改成四个引导变量、新增 §2.6「系统配置在控制台，不在 `.env`」。

### 2.6 注意：`ZEOKEEL_PUBLIC_BASE_URL` 不在这 12 项里

「对外访问地址」早已是 `settings.server.base_url`，在**控制台「网关」页**编辑
（`clientrelease` 读取）；env `ZEOKEEL_PUBLIC_BASE_URL` 是它的覆盖口。本次不改它的
优先级与页面（避免与本轮"部署配置入库"混在一起），只把文档口径从"配 .env"改成
"控制台网关页（env 兼容）"。

## 3. 不可入库清单及理由

判据是三条之一：**① 库还不可用时要读它**；**② 进库等于把秘密/凭据搬进同一份数据**；
**③ 它描述的是"进程外的事实"**（网络拓扑、镜像内容、容器身份），服务进程自己改不了。

| 键 | 归属 | 不入库的理由 |
|---|---|---|
| `PG_PASSWORD` / 派生出的 PG DSN（`--pg-dsn`） | compose → command | **①**：打开数据库之前就要用；"把 DB 地址放进 DB"是自指悖论。且密码进 `settings` 表等于把库凭据复制进它保护的库里 |
| `ZEOKEEL_MASTER_KEY` | env / `data/master.key` | **②**：它是**凭证加密密钥**（AES-GCM 主密钥）。放进同一个库 = 加密形同虚设（拿到库就拿到明文）。历史口径已登记"master key 不写 settings 表" |
| `ZEOKEEL_ADMIN_PASSWORD` | env（引导） | **②**：初始超管密码是**引导**凭据（只在首次启动创建 admin 时读一次）；进库后"谁能读设置"＝"谁能读初始密码"，且引导发生在"还没有管理员/还没有会话"的时刻 —— 没有控制台可用 |
| `ZEOKEEL_CHANNEL` + 镜像内路径（`ZEOKEEL_CHANNEL_DIR` / `ZEOKEEL_CLIENT_RELEASE_DIR` / `ZEOKEEL_CHANNEL_FILE` / `ZEOKEEL_DEMO_APPS_DIR` / `ZEOKEEL_SKILL_SEED_DIR`） | 镜像（Dockerfile ENV）/ env | **③**：渠道是**镜像内容**（构建期烘焙的声明与素材，服务端启动时要校验"进程渠道 == 镜像渠道"，不一致拒绝启动）；镜像内路径是**镜像布局**，不是运维旋钮 —— 改它等于改挂载点，服务进程无权决定 |
| `TZ` | compose | **③**：时区在**容器启动前**就决定了日志/日切口径，且 postgres 容器与 server 容器必须同一个值（跨容器事实）。归 compose 是唯一能保证两侧一致的位置 |
| `ZEOKEEL_DB_MAX_OPEN_CONNS` | env | **①**：连接池在 `sql.Open` 之后立即装配，**早于**任何 `settings` 读取；把它放库会让"池上限"依赖"池里的查询" |
| `ZEOKEEL_MIGRATION_LOCK_TIMEOUT_MS` / `ZEOKEEL_MIGRATION_ADVISORY_TIMEOUT_MS` / `ZEOKEEL_MIGRATION_SLOW_MS` | env | **①**：迁移执行器跑在"库刚打开、schema 可能还是旧的"阶段（启动闸门），此时不能假设新表/新设置可读；它们还决定"迁移失败怎么退出"，把失败语义交给还没建好的库是循环依赖 |
| `ZEOKEEL_TRUSTED_PROXIES` / `CADDY_IP` / `SERVER_IP` / `PG_IP` / `NETWORK_SUBNET` | compose | **③**：网络拓扑是**容器编排事实**（固定 IP 由 compose `ipam` 分配）。服务进程改库里的"可信代理"无法改变容器实际所在网段；让它们可改只会制造"库说 A、容器在 B"的分叉，且这条分叉直接影响限流键（XFF 信任错 = 全组织共桶） |
| compose 的 `DOMAIN` / `TLS_MODE` / `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | compose | **③**：域名与证书模式决定 Caddy 挂载哪个模板、证书从哪来；端口映射在容器创建时生效。**它们由部署编排决定，不由服务端进程决定**（服务端只知道自己收到的请求） |
| `SERVER_IMAGE` | compose/.env | **③**：它决定"下一个容器用哪个镜像"，属于部署动作（升级），不是运行期配置；写进库还会变成"用旧镜像里的代码读新库里的镜像名"的错位 |

原则：**"谁能改、改了在哪一层生效"必须与"值真正生效的位置"一致。** 库里的值只能影响
"服务进程读它之后的行为"；任何在进程启动之前/之外生效的东西放进来都只是假象。

## 4. 兼容与升级路径

1. **存量部署零动作**：`.env` 里的旧 `ZEOKEEL_*` 行继续生效（且优先），行为与升级前逐字一致。
   升级后启动日志会打一行 `deployconfig: 以下配置来自环境变量…` —— 那是**告知**，不是告警。
2. **迁移到控制台**（可选、按需）：删掉 `.env` 里对应行 → `docker compose up -d server` →
   控制台「系统配置」里改。`restart` 类改完同样要重建容器。
3. **没有一次性数据迁移**：`settings` 表里原本没有这 12 个键的行（此前它们只在 env 里），
   所以不需要搬数据；谁也没配置过就该用默认值。
4. **回滚**：新版本写进库的行对旧版本二进制是**未知 `settings` 键** —— 旧版本只读自己认识的
   键，不会因此启动失败（已知且接受的残留：旧版本上看不到、也不生效）。
5. **`ZEOKEEL_PUBLIC_BASE_URL`**：保留 env 覆盖口；控制台入口在「网关」页（§2.6）。

## 5. 判据（可执行，不是口头承诺）

| 判据 | 位置 | 拦什么 |
|---|---|---|
| 注册表自证：`Setting`/`Env` 唯一、默认值可按 `Kind` 解析、取值域自洽 | `server/internal/deployconfig/deployconfig_test.go` | 新增键写错默认值/域/重名 |
| 解析优先级与回落：env > setting > default、非法值逐个回落并告警 | 同上（`Resolve` 用例） | 优先级漂移、"非法值让读取失败" |
| **注册表里每个 `Key.Env` 必须仍在 compose 的 `server.environment` 里，且是 `${KEY:-}` 透传形态** | `server/cmd/server/compose_env_test.go` 的 `TestDeployconfigRegistryEnvsStayWired` | 下一次"精简 compose"把历史覆盖口删掉 ⇒ 存量 `.env` 静默失效 |
| **`server/.env.example` 的「历史覆盖口」清单必须列全注册表的 env 名** | 同文件的 `TestEnvExampleListsHistoricalOverrides` | 文档面把覆盖口漏掉/写错一代 |
| 源码里出现的每个 `ZEOKEEL_*` 名字必须在 compose 里接线，或在豁免清单里写明理由 | 同文件的 `TestEveryServerZEOKEELEnvNameIsWiredOrExempt` | 又一个"文档说可调、部署里够不到"的旋钮 |
| 管理端鉴权：`config:read` / `config:write`；auditor 不给；未知键 400；空串 = 删行；保存写审计 | `server/internal/serverauth`、`server/internal/router` 的测试 | 越权读写、口径破坏、审计缺失 |
| 前端：「系统配置」页渲染来源徽标、restart 提示、env 覆盖横幅、保存失败不乐观更新 | `server/webadmin/src/pages/SystemConfig.test.tsx` | 页面撒谎（"改成功了"但没生效） |

## 6. 非目标（明确不做）

1. **不把 secrets 放库**：主密钥、PG 密码、初始超管密码不进 `settings`（§3）。
2. **不做"在线改 DB 地址/连接池"**：数据库连接参数、池上限、迁移预算永远不进库 —— 它们
   必须在"库可用"之前生效（§3）。
3. **不做"库优先"**：env 仍然最高（§2.2），代价与处置已写进页面与文档。
4. **不把网络拓扑/镜像内容变成可写配置**：`TRUSTED_PROXIES`/固定 IP/`DOMAIN`/`TLS_MODE`/
   渠道声明仍是编排与镜像的事实（§3）。
5. **不为"在线改档位"做热重载**：`restart` 类键仍是"保存 → 重建容器"，不引入运行期重建
   实例池/调度器（复杂度与故障面远超收益）。
6. **不删除任何 compose 里的历史键**：删了存量 `.env` 就静默失效（判据在上表）。
