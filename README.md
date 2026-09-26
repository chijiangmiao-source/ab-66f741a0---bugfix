# 深海采集站 · 故障闭环审计页

判定离散事件系统的**故障可诊断性**：是否存在一条**已发生故障的无限执行**与一条
**从未发生故障的无限执行**，二者的可观察回执序列（剔除静默 `SILENT` 后的 ASCII
回执）**逐元素完全相同**。若存在，故障可被一条始终正常的执行无限期伪装，系统
**不可诊断**。

判定基于标准的 **verifier / twin-plant** 构造（Sampas–Lafortune / Yoo–Lafortune
框架），直接在同步积上分析无限行为，**不做有限回放、不比较位置名称**。

## 判定方法

1. 构造同步积（verifier），状态为 `(故障副本位置 p, 正常副本位置 q, 故障标志 f)`：
   - `SYNC`：两侧各走一条**非静默且回执相同**的迁移；正常副本只允许走 `N`，
     故障副本取到 `F` 时 `f=1`；
   - `F_SILENT`：故障副本单独走一条 `SILENT` 迁移（`F` 时置 `f=1`）；
   - `N_SILENT`：正常副本单独走一条静默的 `N` 迁移。
2. 在同步积上求 SCC（迭代式 Tarjan）。不可诊断 ⇔ 从初态可达的某个 `f=1` SCC 中
   存在**合格闭环**：闭环内既移动故障副本、又移动正常副本（重复该闭环时两侧都是
   无限执行；单侧静默空转、对侧停滞不算伪装）。
3. 不可诊断时，按规则稳定裁决并展示：
   **先按公共前缀可观察回执长度、再按闭环回执长度、平局按迁移标识拼接**取最小证据；
   展示最短共同前缀、可重复闭环（`[ … ] ω`）与两侧逐步迁移对应表。
4. 可诊断时展示全部已检查的 `f=1` 诊断对摘要（无环 / 正常侧停滞等）。

正确性经独立参照实现交叉验证：`scripts/fuzz.mjs` 生成上万随机模型，与独立的
增强空间判据、独立 Kosaraju SCC 划分逐一比对，零分歧。

## 规程录入格式

每行一条声明，`#` 起始为注释：

```text
loc 位置名
init 初始位置
trans 迁移标识 源位置 目标位置 F|N 回执|SILENT
```

- `F` 故障迁移 / `N` 正常迁移；`SILENT` 表示无回执（静默）；
- 回执为非空可打印 ASCII（不含空白），如 `ack.42`；
- 悬空目标/源、重复迁移标识、非法回执、缺 init 等错误均定位到**行/列**，
  提交后旧裁决结论立即清除。

## 并发共享复核与过期任务防护

- **内容完全相同的并发提交共享同一次实际复核**：两名值班工程师在两个页面几乎同时
  提交同一规程时，服务只复核一次，裁决广播给全部等待者，各页面收到一致结果
  （`/healthz` 的 `computationsStarted` 只增一次）。
- **取消/超时只摘除本任务的等待**：共享复核上仍有其他等待者时计算照常继续，
  互不影响；最后一个等待者离开后才 `worker.terminate()`，不留孤儿计算。
- **取消后立即以相同文本重新提交**：启动并完成一次全新的复核，不会挂上已终止的旧计算。
- 前端以任务代次（jobId）守卫：计算期间修改规程或手动取消，立即取消在途任务，
  迟到响应不可能改写当前草稿与结果；旧结果保留并标注“已过期”。
- 服务端新任务携带 `supersedes`，先取消旧任务；单任务超时摘除
  （默认 30s，`JOB_TIMEOUT_MS` 可调）。计算在 Worker 线程执行，不阻塞事件循环。
- `/healthz` 可观测性：`activeJobs`（等待中的提交数）、`activeComputations`
  （进行中的实际复核数）、`computationsStarted`（累计实际复核次数）。

## 运行

```bash
# 本地
npm start                 # 默认 0.0.0.0:8080
PORT=9090 npm start       # 端口可调

# Docker
docker compose up --build          # web 常驻；verify 与 acceptance 依次执行至退出
APP_PORT=9090 docker compose up --build

# 只跑校验服务（执行完退出，退出码 0 通过 / 非 0 失败）
docker compose run --rm verify

# 只跑并发/取消语义验收（真实 HTTP，退出码同上）
docker compose run --rm acceptance
```

健康检查：`GET /healthz`（Dockerfile 与 Compose 均已配置）。

## acceptance 服务内容

`acceptance` 服务等待 `web` 健康且 `verify` 通过后，对其执行真实 HTTP 验收：

1. 两个并发相同规程：均成功、结果一致、`computationsStarted` 恰好 +1；
2. 取消其中一个并发页面：取消响应 `cancelled=true`、被取消请求 409，另一请求照常完成；
3. 取消后以相同文本重新提交：完成本次新复核（不悬挂、不误报已取消）；
4. 计算中提交另一份规程：互不影响，各自正常裁决；
5. `supersedes` 取代在途任务：被取代者 409，新提交完成复核；
6. 每个场景后 `/healthz` 的 `activeJobs` / `activeComputations` 均归零。

任一项失败即以非零退出码退出。本地等价命令：`npm run acceptance`
（未设 `BASE_URL` 时自动拉起临时真实服务进程）。

## verify 服务内容

`verify` 服务等待 `web` 健康后对其执行真实 HTTP 冒烟，顺序为：

1. 构建检查（`node --check` 全部源文件）；
2. 代码测试（`node --test`：静默双环、可诊断回执、防误报、解析定位、HTTP 集成）；
3. 随机模型交叉验证（独立参照实现 2000 例 + SCC 等价核对）；
4. HTTP 冒烟：健康检查、静默双环判不可诊断且证据完整、可诊断回执判可诊断、
   悬空目标定位、静态资源、取消竞速无 5xx 且无残留任务。

任一步失败即以非零退出码退出。本地等价命令：`npm run verify`。

## 目录

```
server.js            HTTP 服务 + 任务/共享复核/取消管理
src/parser.mjs       规程解析与行列级错误定位
src/diagnoser.mjs    verifier 构造、SCC、稳定证据提取
src/analyze.mjs      视图模型（序列一致性核验）
src/worker.mjs       Worker 线程判定
public/              审计页前端
test/                单元、HTTP 集成与并发语义测试
scripts/fuzz.mjs     随机模型交叉验证
scripts/verify.mjs   verify 服务入口
scripts/acceptance.mjs 并发/取消语义验收入口
Dockerfile, docker-compose.yml
```
