# SSB 交易所

SSB 交易所是一款小圈子 Web 股票模拟游戏。玩家使用虚拟资金在虚构市场中交易，观察新闻、行情、排行和持仓反馈。

> ⚠️ **这是一个游戏，不是真实交易工具。** 所有股票、公司、新闻和赛事均为虚构。

## 技术栈

- **前端**：原生 HTML / CSS / JavaScript（无框架）
- **后端**：Node.js >= 22 标准库 HTTP 服务
- **数据库**：SQLite，通过 Node 内置 `node:sqlite` 访问
- **依赖**：**零 npm 运行时依赖**，只用 Node 标准库

## 快速开始

```bash
# 启动服务（默认 http://127.0.0.1:4174）
npm run dev

# 默认管理员账号：SSB-DEMO（无密码）

# 重置本地数据库
npm run reset-db
```

端口冲突时可用环境变量指定：

```bash
PORT=4175 npm run dev
```

## 开发种子数据

项目提供了仅供本地开发/测试使用的随机数据脚本：

```bash
npm run seed
```

这会模拟 11 个玩家玩过一段时间后的市场状态，生成独立数据库 `data/ssb-seeded.sqlite`，方便检查排行、持仓、历史行情、新闻累积效果。

## 开源发布说明

仓库默认只包含产品代码、文档和可复现的演示数据生成脚本，不包含本地运行状态：

- `data/`、`backups/`、`.claude/`、`归档/` 和 `web/config.local.js` 已被忽略，不应提交。
- `web/config.js` 是开源默认配置；备案号、私有 API 地址等部署信息放入本地的 `web/config.local.js`。
- 如果本地 Git 历史曾包含内部交接资料、部署资料或压缩包，公开发布时建议从当前工作树创建干净快照或新仓库，不要直接公开原历史。

## 当前功能

- 固定账号登录 / 首次设置密码
- 36 只股票、六个一级板块和动态锚 / 趋势行情
- 股票详情（近 5 期交易手数和金额）
- 11 只基金的净值、成分/持仓、申购赎回和交易记录
- 16 队虚构篮球联赛、排名、球队卡片、单场胜负竞猜
- 买入 / 卖出 / T+1 释放
- 北京时间 08:00-16:00 自动推进；完整交易日 8 期
- 管理员手动补推进
- 新闻生成、价格影响、辟谣和日报
- 同一 tick 净买卖盘影响下一 tick 价格
- 排行榜、贷款额度、资产快照与强平
- 管理员运营台、市场重置、玩家密码重置
- 持仓、现金、交易记录查询

## 验证命令

```bash
npm test
node --check server/server.js
node --check server/db.js
node --check server/data.js
node --check server/accounts.js
node --check web/app.js
```

## 目录结构

```text
ssb-exchange/
├── web/                   浏览器前端
│   ├── index.html
│   ├── app.js            SPA 客户端
│   ├── styles.css
│   └── config.js
├── server/                Node.js 后端
│   ├── server.js          HTTP 服务 + API 路由
│   ├── db.js              SQLite 初始化与查询
│   ├── data.js            股票定义、价格引擎
│   ├── funds.js           基金净值、申赎与强平
│   ├── futures.js         期货引擎
│   ├── sports.js          篮球联赛引擎
│   ├── news.js            新闻生成引擎
│   └── *.js               （其他模块与测试）
├── data/                  本地 SQLite 数据（不提交）
├── docs/newbie-guide/     玩家教程
├── 玩家手册.md             玩家手册
├── LICENSE                 MIT 许可证
└── package.json
```

## 许可证

[MIT](LICENSE)
