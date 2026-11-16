# LumDeck 审查结论与修复执行方案

2026-11-16 · 基线 `988c2d9`，含工作树里的 13 个已修改文件、新增 Windows 凭据命令和两份未跟踪测试。由 Codex 并行审查和制定实施方案，由 Gemini 4 Hydrogen 通过 AGY CLI 修改代码。行号对应修复前工作树。

## 审查结论

| YT 维度 | 评分 | 主要依据 |
| --- | --- | --- |
| 代码质量 | 5/10 | 干净环境中测试、类型检查、构建均受阻。凭据写入吞错，Gmail 冷启动空白，Stripe 输出不完整总额。 |
| 代码效率 | 5/10 | Dock 已按 UID 复用实例。设置写入仍触发窗口 IPC，世界时钟每秒重复构造格式化器，部分刷新异步重入或存活超过组件。 |
| 可复用性 | 6/10 | Widget 自动注册和上下文边界已建立。超时实现重复且语义有缺口，原生命令文档高估了实现覆盖。 |

YT 门禁未通过。未发现已发生的生产损害，以下 P1 均具有源码证据或本地复现。危害条件包括既有明文配置、原生恢复失败、非信任 URL 被点击，以及并发刷新或输入更新。基线 `cargo check --locked --offline --manifest-path src-tauri/Cargo.toml` 通过。首次基线 `npm test`、本地 `tsc --noEmit` 和 Vite 构建均因缺失 Vitest 失败。审查期间工作树已新增 Vitest 4.1.12、happy-dom 21.0.4 和锁文件条目，本方案保留这组改动并重跑验证。独立 Node fixture 复现了 Gmail 已存令牌冷启动空白、响应头到达后正文不受超时或取消控制，以及 Stripe 只读一页并跨币种比较 minor units。原生窗口、真实账户、系统凭据和任务栏行为待隔离环境验收。

## 实施顺序与修改边界

A 先恢复前端测试门禁。B 和 D 可与 A 并行改各自文件。C 在 A 验证后开始。E 在 C 之后改同一批提供方文件，F 按 B、C、E 的最终接口更新文档。每批验证后报告实际改动、命令结果、剩余缺口和涉及文件。保留当前工作树里用户已有改动。

### A · 恢复前端门禁 · P1

证据 `package.json:12` 有 Vitest 脚本，`vite.config.ts:2` 导入 Vitest，`vite.config.ts:17` 需要 DOM 环境，`package.json:20` 和 lock 缺依赖。

1. 保留当前工作树已补齐的 Vitest/happy-dom 和锁文件。仅在干净安装、运行或类型检查证实有兼容问题时修正对应依赖。
2. `vite.config.ts` 恢复从 Vite 导入。将测试配置与 DOM 环境移到 `vitest.config.ts`，保留 5183、strictPort 和现有构建设置。
3. 运行 `npm ci`、`npm test`、本地 `tsc --noEmit` 和 Vite build。补齐依赖后已经实跑出 5 通过、4 失败。GitHub 未读数、Gmail 冷启动和股票刷新是实现缺陷。Instagram 实际显示紧凑格式 `1.2K`，用例应同时验证格式和精确值的 title。由 E 修复这四项。

### B · Windows 状态恢复、采样及 IPC 权限边界 · P1

**B1 架构与幂等。** `window.rs:107` 吞备份失败，`window.rs:130` 重复 enable 可覆盖磁盘原件，`window.rs:150`、`window.rs:173` 写失败仍删备份。流程改为 `读取原态 → 持久化恢复记录 → 修改系统 → 成功恢复 → 清理记录`。内存和文件在同一事务锁下协调，初次捕获才写备份。用同目录临时文件、同步后原子改名，备份失败时中止修改。原注册表备份格式可读，损坏备份要报错并保留。重复 enable 保留首份原态。恢复失败保留重试所需记录，启动恢复失败时阻止后续启用覆盖旧记录。已有启用、切换设置、托盘退出、窗口退出都使用同一幂等恢复路径。`dock.ts:270` 的 WebView close 缺少 `core:window:allow-close`，通过 Rust `quit_app` 统一 Dock 右键和托盘退出，并复用恢复入口。设置按钮等待真实结果，失败保持先前选择并显示简短错误，浏览器预览通过现有环境检测降级。模拟测试覆盖 enable 两次并重启、写备份失败、写注册表失败、失败后重试恢复、两次 restore；仅用测试替身，不改动机器真实注册表。

**B2 算法与性能。** `extras.rs:48` 对当前 Up 网卡累计值先汇总再相减，接入或重连携带历史计数的接口会伪造流量。获取失败会写入零基线。`network.widget.ts:9` 显示 bits/s，Rust 当前计算的是 octets/s。改为按稳定接口 LUID 保存 In/Out 样本，对相邻两次都存在且该方向计数单调的接口累加增量，加入、退出和计数归零自然重建基线。枚举失败保留上一有效样本并报告错误，成功后按实际时间差算速，用宽位中间值把 octets/s 转 bits/s。按现有刷新周期设合理的最小采样窗口，其间多个 Widget 共享缓存结果。CPU `system.rs:28` 同样保护采样间隔和失败基线，保持现有 JSON 类型与调用方。Rust 注入样本覆盖网卡加入、离开、计数回退、枚举失败、短时间重复调用和 125,000 octet/s→1 Mb/s。

**B3 窗口通讯。** `dock.ts:57` 每次 store 变更都 reposition，笔记保存也会触发同步样式读取与 IPC。`dock.ts:111` 从 CSS 读逻辑单位，`window.rs:40` 却用物理高度。前端只在启动、edge/size 变化及必要的屏幕尺度变化请求定位，防止同一几何重复发出，可合并尚未执行的旧定位。后端用目标 monitor scale factor 将逻辑高度换算为物理高度后再计算 top/bottom。保持既有 IPC 参数名并记录单位，验证 100%/125%/150%/200% 和 top/bottom，测试设置-only 更新触发 0 次定位。避免无条件监听 resize 形成自激。

**B4 外部链接。** `hackernews-top.widget.ts:63`、`hackernews-top.widget.ts:93` 把上游 URL 送到 `extras.rs:15` 的通用 ShellExecute。上游提供非 Web URL 且用户点击才触发。前端只接受无内嵌凭据的绝对 HTTP(S) URL，不合法时用验证过的数字 item ID 构造 HN 讨论链接。加专用 `open_web_url` Rust 命令，用 URL parser 校验 scheme、host、userinfo 和 NUL，再复用 ShellExecute。前端只在浏览器预览用验证后的 `window.open`。保留 Launcher 和 Quick Toggles 的本地 `open_path`。用 mock 测试 `file:`、`javascript:`、`ms-settings:`、UNC、HTTPS，禁止测试调用真实 shell。

### C · 凭据和组件生命周期 · P1

**C1 架构。** `store.ts:56`、`store.ts:90` 通用设置会反复写回旧版明文，六个 Widget 已改为只读 Vault。确立所有权：store 持有布局和非敏感设置，凭据适配层持有每实例密钥迁移与 IPC，Widget 只通过 `WidgetContext` 调用。六个旧字段映射为 GitHub `token`、Gmail/Instagram `accessToken`、Stripe/Stock `apiKey`、AI usage `sessionKey`，均从同 UID 的旧设置迁移到现有 `LumDeck:<uid>:<key>`。Vault 有值时沿用 Vault，只补写真实缺失项。Rust `creds.rs:41` 要区分 `ERROR_NOT_FOUND` 和真实读取错误，避免读故障触发覆盖。Vault 写入/读回成功后才剔除对应旧字段并确认 localStorage 提交，失败保留可重试的原数据，下一次成功可继续；持久化失败不能被当作已清理。浏览器预览可用会话内凭据，禁止回写新明文或假报已迁移。不要记录密钥、带 token URL 或包含这些值的错误。

**C2 接口与竞争。** `tile.ts:56` 的 `setSecret/deleteSecret` 吞错。替换为可感知失败的契约，区分未配置与后端故障。六个提供方的保存/清除事件等待操作成功才改变本地连接状态，失败保留旧状态或表单，并允许重试。每 Widget UID 串行化迁移、写、删；合法重复删除幂等。显式删除 Tile 时按映射清理 Vault，删除失败保持布局和重试入口。临时卸载、重排不清理凭据。需考虑 Vault 删除成功后布局持久化失败，反馈真实状态并保留可重试操作，不能宣称整个事务已完成。Gmail 令牌输入改为 password 并关闭拼写检查。准备 mock 测试及旧版 localStorage fixture，覆盖 Vault 已有值、有原值、写失败、持久化失败、双击、删除重试和两 UID 隔离。

**C3 生命周期与标识。** `tile.ts:87` 异步 mount 在删除后仍可启动，`tile.ts:103` 固定 interval 可重入。mount 前初始化可取消生命周期，在已卸载时不调用 mount，卸载立刻取消信号，迟到实例只销毁一次。框架自动刷新在上次完成后才安排下次，保持首次刷新由已有 Widget 决定；手动刷新仍有提供方内的防重逻辑。异步 mount 有可选生命周期信号，或将网络首次刷新与返回实例解耦。 `store.ts:78` 重复 UID 使 `dock.ts:100` 的 Map 复用错误，修复为稳定去重，首个合法 UID 保留并沿用凭据；不要把用户原 UID 重写成新的凭据命名空间。拖拽优先复用 `mounted.get(uid)`，避免把旧 UID 拼成 CSS selector。若该改动落在 B 编辑的 `dock.ts`，B 负责，C 只改 store 与 tile。测试已卸载 pending mount、自动刷新不重入、重复 UID 及仍保留设置/布局的重排。

### D · 计时与世界时钟 · P1/P2

`timer.widget.ts:88`、`pomodoro.widget.ts:106` 暂停使用最近一次 tick 的 remaining。重复在 tick 前暂停可以让计时器丢掉所有经过时间。暂停先根据当前 deadline 精确结算，再执行现有的结束或相位转换，结束状态及次数只计一次。保留暂停恢复、手动重置及 Pomodoro 跨相位的现有产品逻辑，fake clock 覆盖 199/249ms 提前暂停和事件循环晚于截止点。

`world-clock.widget.ts:47` 每城市每秒初始化多次 `Intl.DateTimeFormat`。独立 Node 微基准 30×4 个时区，一次预热、9 次采样，原构造路径中位 175.49ms，缓存格式器路径中位 1.11ms，未测 WebView2 帧时间。按有效时区缓存格式化器并复用本地日期计算，列表更新时淘汰缓存，标记 DOM 仅在值变化时更新。对比相同日期、夏令时切换、跨本地午夜以及任意 re-render。 `world-clock.widget.ts:22` 把已保存空数组替换成默认城市，保留显式空列表，用测试覆盖清空后重新加载。

### E · 请求完整性、过期结果和提供方算法 · P1

共享 HTTP 辅助模块及 TikTok、Stack Overflow、两份 Weather Widget 作为独立子批并行实施。主批在 B、C 后迁移其余提供方和 Hacker News，复用独立子批的接口。两批各用独立测试文件，主批负责修正现有 `widgets.test.ts`。

1. 复用一个有界的 fetch+响应体消费函数。超时和父级 AbortSignal 要持续到 JSON/text 完成，区分 `aborted/timeout/http/decode`，finally 清理计时器和 listener。将真实同类调用迁移到共用函数，优先 Gmail、GitHub、Stripe、Stock、Instagram、TikTok、HN、Weather，StackOverflow 若现有路径同类则迁移。HN 改动需 B 完成后再编辑同一文件。保持响应 status/headers 可读，继续用 GitHub 的 Link 解析。401/403 给出鉴权/权限状态，429 尊重合法 Retry-After，停止主动轰炸。304 等无响应体状态不要强制 JSON。保留现有刷新周期，按需要限制单轮总预算。
2. Gmail `gmail-unread.widget.ts:68` 初始 view 改为未渲染，确保已存 token 启动必渲染一次，同时让 first refresh 不阻塞返回销毁入口。401 停止旧凭据自动轮询并维持重连表单，保存新值后才恢复。添加回归断言从 401 等过一次周期仍无重取，保留用户文本。
3. `stock-quote.widget.ts:95` 在 loading guard 前增加代数导致当前结果被丢弃；`instagram-followers.widget.ts:160` 和 `tiktok-profile.widget.ts:179` 忽略配置变更后的新刷新，旧结果可污染当前表单。采用每次请求局部 controller/代数或等效机制。同配置普通刷新合并，配置/凭据变更使旧作业失效并启动新作业，只有当前作业可以改 DOM 或释放自己的活动状态。测试 A→B、旧成功/旧 401 晚到、卸载中止以及已返回响应头后的慢体。
4. GitHub `github-activity.widget.ts:12` 会把 `?per_page=1&page=17` 解析成 1。先定位 rel=last 的 URL，再用 searchParams 单独读取 page 并验证正安全整数。测试两个参数次序、多个 Link 和无效输入。401 回到可更换凭据的表单。
5. Stripe `revenue.widget.ts:4` 只查 100 条，`revenue.widget.ts:122` 跨币种比较 raw minor units，`revenue.widget.ts:262` 仍把金额作为 30 天总额展示。查询使用固定一次的 `created[gte]`、`starting_after` 游标，设置明确的页数和单轮总时限，识别空页和重复游标。按币种独立累加 `amount_captured - amount_refunded`，只在指定币种下显示该币种总值与趋势。显式排除无效数据并测试 `amount=10000,captured=6000,refunded=1000` 应计 50 USD。同步完善已有 mock payload。多币种的 UI 明示其他币种或显式可选，不隐式比较跨币种金额。100+ 条、重复游标、部分完成、混合 USD/JPY、不合法金额和退款使用 fixture。遇预算，上屏明确标识金额部分结果，避免把 Net charges 报成完整财务结算。

### F · 通讯能力、可观测性、交付门禁 · P2

集成复核补项。凭据字段映射必须只读取对象自有属性或使用 `Map`，旧布局中未知的 Widget ID（含 `constructor`、`__proto__`）仍按未知 Widget 保留。删除 Tile 与凭据保存同时发生时，禁止已被删除的 UID 排队重建凭据。用针对性测试覆盖。清理仅供测试、应用路径未调用的迁移包装接口，保留用于实际凭据读取的幂等迁移。

`lib.rs:21` 未注册 `volume_*`、`brightness_*`、`now_playing/media_control` 和 `ai_usage`，`docs/WIDGET_AUTHORING.md:93` 却列成调用能力。记录已注册命令、事件、CSP 和 Widget 请求权限边界。修正文档里明文存凭据、onSettings 外部订阅和 resize 自动回调等不匹配的说法。标注这四组功能当前是降级入口，避免重复发不存在的命令或在其不可用时收集新的敏感凭据。保留现有 Widget ID 和布局。浏览器预览和原生状态可区分。原生功能本体需另立需求和验收。 `core/tauri.ts:27` 捕获事件订阅拒绝并保留已退订后不会生效的保护，使用不含凭据的操作名和错误类别诊断；避免高频重复日志。

## 六个盲区与通过标准

| 盲区 | 证据与修复归属 |
| --- | --- |
| 幂等性 | B1 重复 enable 与恢复。C 迁移、重试和删除。 |
| 安全性 | B4 上游链接授权边界。C 旧明文与 Vault 故障。 |
| 可观测性 | B/C/E/F 的可操作错误分类。以 fixture 核对 UI，检查日志不含敏感输入。 |
| 数据完整性 | B 原件和计数基线。C UID、旧设置。D 到期时间。E Stripe 分页币种。 |
| 并发竞态 | C pending mount、自动轮询与凭据互斥。E 延迟响应和卸载。 |
| 外部韧性 | E 正文超时、取消、401/403/429/故障恢复。F 原生能力降级。 |

执行结束跑 `npm ci`、`npm test`、`tsc --noEmit`、`npm run build`、`cargo check --locked`、`cargo test --locked` 和 `git diff --check`。Windows 冒烟包含打开 Dock、增删和重排、缩放与上下边缘、启动与退出、任务栏恢复、测试凭据隔离及托盘事件。真实系统写入用隔离环境；没有合适隔离环境时使用确定性替身验证并明确冒烟缺口。WebView2 整机性能待测，建议默认布局和 10/30 Widget，每个场景至少 3 次冷启动、10 分钟空闲和 30 次增删。记录首帧、CPU、JS heap、活跃定时器、IPC/HTTP 每分钟和拖拽 p95 帧时间。自动化验收覆盖计时器清理、并发计数上限和设置-only 定位 0 次。

修复批次独立可回滚。凭据迁移成功后旧版本可能要求重连，回滚时不要再把密钥写进明文。任务栏恢复记录应保留到成功恢复。基线保留于本机临时副本，用于比对用户原有改动和本轮实现。

[Vitest 测试环境](https://v3.vitest.dev/guide/environment) · [Stripe 列出 Charges](https://docs.stripe.com/api/charges/list) · [Stripe Charge 字段](https://docs.stripe.com/api/charges/object) · [Stripe 币种](https://docs.stripe.com/currencies) · [Tauri URL 类型](https://docs.rs/tauri/latest/tauri/struct.Url.html) · [AGY headless CLI](https://antigravity.google/docs/cli/headless/)

## 实施与最终验证

Codex 完成三路 YT 审查、四个专项和修复方案。Gemini 4 Hydrogen 通过 AGY CLI 以 `xhigh` 和 `high` 实施。早期按旧分工启动的 Gemini 审查会话已停止，源码保留。Windows 批次在 OAuth 401 后由 `high` 续作。凭据和 IPC 契约批次的超时会话已写入实现，集成修复由后续 `high` 会话完成，最终结果以全量复跑为准。

| 批次 | 实施结果 |
| --- | --- |
| A | Vite 构建和 Vitest 测试各有独立配置。保留已补齐的锁定依赖。 |
| B | Windows 任务栏备份、恢复与退出路径，HiDPI、去重定位、网速和 CPU 采样、受限 Web URL IPC。新备份沿用原始字节格式，可由旧版本读取。 |
| C | 旧凭据按 UID 迁移、Vault 错误反馈、删除竞态防护、异步挂载与串行自动刷新。 |
| D | 计时暂停与到期、世界时钟格式器缓存及空列表持久化。 |
| E | 有界正文读取和中止，提供方旧请求隔离、重连和限流，GitHub 分页计数，Stripe 净捕获额有界分页与分币种展示。 |
| F | 订阅失败脱敏诊断，未注册命令降级，Widget 作者文档与代码对齐。 |

`npm ci`、`tsc --noEmit`、`npm run build`、锁定依赖的 `cargo check` 和 `git diff --check` 均通过。Vitest 共 9 个文件、65 项用例通过。Rust 共 18 项用例通过。真实 Windows 任务栏、托盘、多屏 DPI、真实外部账户和 WebView2 整机性能尚未验收。音量、亮度、媒体控制和 AI 用量仍按当前原生能力降级。

执行中工作树新增外部提交 `cba3f7d`，包含部分并行改动。本次 AGY 调度未发出提交或推送指令。最终核验基于该提交和当时的未提交工作树。
