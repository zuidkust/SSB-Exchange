# 种子数据生成工具 — 操作说明

> 适用版本：SSB Exchange Web v0.1.0+
> 负责人：开发 / 测试
> 最后更新：2026-06-06

---

## 一、工具概述

`server/seed.js` 是一个独立的数据生成脚本，用于**模拟 11 个玩家在 21 个交易期内的真实交易行为**，产生一份可直接替换的模拟数据库，供单人开发和 QA 测试使用。

执行方式：

```bash
npm run seed
```

产出文件：

```
data/ssb-seeded.sqlite
```

### 核心特性

- 所有 11 个普通玩家账号全部激活（密码统一为 `123456`）
- 每个玩家随机买入 3–7 支股票，花费 89–100 万（初始资金 100 万）
- 管理员 `SSB-DEMO` 不参与交易，保留原始 100 万
- 自动推进 20 期（初始第 1 期 + 20 次推进 = 共 21 期）
- 生成完整的新闻（约 100 条）和资产快照（约 250 条）
- **不影响**现有 `data/ssb.sqlite`，产出到独立文件

---

## 二、运行前提

| 条件 | 说明 |
|------|------|
| Node.js | >= 22（`package.json` 已声明 `engines.node >= 22`） |
| 端口 | 随机选择 4100–4900 之间未占用端口 |
| 网络 | 仅访问 `127.0.0.1`，不需要外网 |
| 磁盘 | 输出文件约 300–400 KB |
| 时间 | 全程约 30–90 秒（取决于机器性能） |

---

## 三、使用步骤

### 3.1 生成种子数据

```bash
npm run seed
```

输出示例：

```
=== SSB Exchange Seed Script ===

Starting server on port 4586 with temp database...
Server ready.

Stocks: 36 | Initial tick: 1

=== Activating players & building portfolios ===

[01/11] DEMO01 演示玩家01 SSB018x27 SSB003x97 SSB019x30 ... => 7/7 stocks | spent ¥997036 | cash ¥2964
[02/11] DEMO02 演示玩家02 SSB011x37 SSB020x41 SSB001x36 ... => 6/6 stocks | spent ¥999438 | cash ¥562
...
[11/11] DEMO11 演示玩家11 SSB009x111 SSB015x65 SSB013x267 => 3/3 stocks | spent ¥896416 | cash ¥103584

=== Advancing 20 ticks ===
  tick   2 | day 2/9 | news 7
  tick   3 | day 3/9 | news 2
  ...
  tick  21 | day 10/9 | news 7

Stopping server...
Database saved: /Users/.../data/ssb-seeded.sqlite

=== Done ===
```

### 3.2 切换到种子数据

**关键：必须先删除旧的 WAL/SHM 文件，否则数据库会损坏！**

```bash
# 第一步：删除旧数据库的 WAL 残留文件（必须！）
rm -f data/ssb.sqlite-wal data/ssb.sqlite-shm

# 第二步：备份当前数据库
mv data/ssb.sqlite data/ssb-original.sqlite

# 第三步：启用种子数据
mv data/ssb-seeded.sqlite data/ssb.sqlite
```

### 3.3 启动验证

```bash
npm run dev
```

打开 `http://127.0.0.1:4174`，用任意玩家账号登录（密码 `123456`）：

| 账号 | 昵称 |
|------|------|
| DEMO01 | 演示玩家01 |
| DEMO02 | 演示玩家02 |
| DEMO03 | 演示玩家03 |
| DEMO04 | 演示玩家04 |
| DEMO05 | 演示玩家05 |
| DEMO06 | 演示玩家06 |
| DEMO07 | 演示玩家07 |
| DEMO08 | 演示玩家08 |
| DEMO09 | 演示玩家09 |
| DEMO10 | 演示玩家10 |
| DEMO11 | 演示玩家11 |
| SSB-DEMO | 试玩玩家（管理员，免密） |

### 3.4 切回原始数据

```bash
rm -f data/ssb.sqlite-wal data/ssb.sqlite-shm
mv data/ssb.sqlite data/ssb-seeded.sqlite
mv data/ssb-original.sqlite data/ssb.sqlite
```

---

## 四、生成数据内容详解

### 4.1 市场状态

| 参数 | 值 |
|------|----|
| current_tick | 21 |
| day_tick_index | 9（当日最后一期） |
| sleeping | 0（未休眠） |
| initial_cash | 1,000,000 |

### 4.2 玩家持仓特征

- 11 人各持有 3–7 支不同股票
- 初始资金 100 万，剩余现金约 ¥300 – ¥109,000
- 因初始时点 40% 净资产单股仓位上限（¥400,000），买入 3 支股票的玩家可能留下更多剩余资金
- T+1 已释放：买入发生在 tick 1，经 20 期推进后全部可卖

### 4.3 价格数据

- 21 期完整 OHLC（open / high / low / close / change_pct）
- 由真实价格引擎生成（含随机游走、新闻影响、量价联动）
- 各股票价格因 20 期推进已有明显涨跌分化

### 4.4 新闻

- 约 100 条新闻，来源包括真实利好/利空、假新闻、辟谣、宏观政策等
- 每条新闻有影响周期和价格影响强度
- 前端可见字段经过白名单过滤（不含 truth_type 等敏感字段）

### 4.5 资产快照

- 约 250 条 `asset_snapshots`，覆盖每个玩家在多个 tick 的资产状态
- 用于排行榜收益率计算

---

## 五、技术原理

### 5.1 工作流程

```
启动临时服务器（随机端口 + 临时 SQLite DB）
  │
  ├─ 管理员 SSB-DEMO 登录
  │
  ├─ 对每个玩家账号：
  │    ├─ POST /api/auth/login（设置密码激活）
  │    ├─ GET /api/state（获取行情）
  │    └─ POST /api/trade（逐支买入）
  │
  ├─ 推进 20 期：
  │    └─ POST /api/admin/advance（含新闻生成 + 价格计算）
  │
  ├─ 关闭服务器
  ├─ WAL checkpoint（合并写入主 DB）
  ├─ 清理旧 WAL/SHM 残留
  └─ 复制 → data/ssb-seeded.sqlite
```

### 5.2 关键环境变量

脚本启动服务器时设置：

| 变量 | 值 | 作用 |
|------|----|------|
| `SSB_DB_PATH` | `/tmp/ssb_seed_xxx.sqlite` | 使用临时数据库，不影响真实数据 |
| `SSB_DISABLE_CLOCK` | `1` | 禁用自动时钟推进 |
| `SSB_FORCE_MARKET_OPEN` | `1` | 强制市场为开市状态 |

### 5.3 单股仓位上限处理

服务器对单只股票持仓有当前净资产 40% 上限。种子脚本在初始时点尚无贷款、基金或持仓盈亏，因此按初始资金 × 0.4 = ¥400,000 计算，并同时考虑：
1. 可用现金预算
2. 初始时点单股 40% 上限（`Math.floor(400000 / 股价 / 100)` 手）

这可能导致买入 3 支股票的玩家比买入 7 支的玩家留下更多现金（无法突破 40% 上限）。

### 5.4 现金计算

由于服务器的 `/api/trade` 响应中 `user.cash` 存在**已知 bug**（第 5.5 节说明），脚本采用本地计算：

```
spent = price × lots × 100 × (1 + 0.001)  // 含 0.1% 手续费
cash  = cash - spent
```

### 5.5 已知限制

| 问题 | 影响 | 状态 |
|------|------|------|
| 交易后服务端 `user.cash` 未更新内存对象 | `/api/trade` 响应的 `user.cash` 不反映扣款 | 脚本已绕过，本地计算现金 |
| WAL 文件残留导致 DB 损坏 | 切换数据库时必须手动删除 `-wal` / `-shm` 文件 | 见 3.2 节操作步骤 |
| 每日 9 期限制 | 第 10 期起 `day_tick_index` 不再增长 | 不影响价格和新闻生成 |

---

## 六、常见问题

### Q: 脚本报 "Server did not become ready"

**原因**：服务器启动超时（>15 秒）。

**解决**：
1. 检查是否有其他进程占用端口。`lsof -i :4174`
2. 重试一次 `npm run seed`
3. 如持续失败，检查 Node 版本 `node --version`（需 >= 22）

### Q: 启动后数据库报 "malformed database schema"

**原因**：切换数据库时没有删除旧的 WAL/SHM 文件。

**解决**：
```bash
rm -f data/ssb.sqlite-wal data/ssb.sqlite-shm
```

### Q: 想生成更多/更少 tick 的数据

修改 `server/seed.js` 中的常量：
```js
const ADVANCE_TICKS = 20;  // 改成你需要的期数
```

### Q: 想用不同的随机种子生成不同数据

每次运行 `npm run seed` 都会产生不同的随机结果（不同股票选择、不同分配比例），因为脚本没有固定随机种子。

### Q: 如何重置回完全干净的初始状态

```bash
npm run reset-db    # 重建 data/ssb.sqlite（36 只默认股票 + 11 只基金 + 12 个未激活账号）
```

---

## 七、与现有测试的关系

| 测试 | 是否受影响 | 说明 |
|------|-----------|------|
| `npm test` | 否 | 测试使用独立临时数据库 |
| `npm run seed` | 否（新增脚本） | 独立运行，不触碰真实数据 |
| `npm run dev` | 切换 DB 后生效 | 种子数据需手动替换 `ssb.sqlite` |

---

## 八、修改记录

| 日期 | 变更 |
|------|------|
| 2026-06-06 | 默认目录扩充为 36 只股票和 11 只基金；种子脚本仍使用独立数据库。 |
| 2026-06-03 | 初版。支持 11 玩家 + 20 期推进。新增 WAL 清理逻辑与操作文档 |
