# SSB 交易所 Web 前端

`web/` 是当前主线前端，不再是探针，也不再连接 CloudBase。

## 运行方式

从项目根目录启动后端：

```bash
npm run dev
```

然后打开：

```text
http://127.0.0.1:4174
```

端口被占用时：

```bash
PORT=4175 npm run dev
```

## 配置

`web/config.js` 保留开源默认配置：

```js
window.SSB_WEB_CONFIG = {
  apiBase: '',
  filing: {
    icpText: '',
    icpUrl: 'https://beian.miit.gov.cn/',
    publicSecurityText: '',
    publicSecurityUrl: ''
  }
};
```

默认同源调用 `/api/*`。如果前端和后端分开部署，再把 `apiBase` 改成后端地址。

私有部署信息放在 `web/config.local.js`，该文件不会提交。可从 `web/config.local.example.js` 复制后填写备案号、公安备案号或私有 API 地址。

## 品牌配色

以下颜色从 logo 原图 `web/ssb-icon-master.png` 的实际像素取样提取，作为后续整站视觉统一的品牌基准色：

- 品牌主蓝：`#114084`，RGB `17, 64, 132`
- 品牌金色：`#CF972B`，RGB `207, 151, 43`
- 品牌白：`#FFFFFF`，RGB `255, 255, 255`

说明：

- 这组值比肉眼估色更接近 logo 原稿，适合作为主题色、按钮色、图表色、导航高亮和品牌背景的统一参考。
- 网页实现层中的白色统一按纯白 `#FFFFFF` 处理；此前提取出的近白值视为像素取样误差。
- 当前前端样式中的品牌层已对齐，如 `--primary: #114084`、`--brand-gold: #CF972B`、`--primary-ink: #FFFFFF`；涨跌、风险、危险等功能色继续保持独立语义。

## 自测

```bash
npm test
```

`npm test` 会依次执行：

- 真实后端烟测（临时数据库 + 临时端口）
- 交易错误提示检查
- 登录页和交易区前端渲染检查

浏览器流程：

- 输入邀请码 `SSB-DEMO`
- 查看行情
- 买入 1 手
- 等待自动推进，或管理员手动补推进 tick
- 卖出 1 手
- 确认持仓、现金、交易记录刷新

Alpha 市场时间固定为北京时间 08:00-16:00，每小时推进一期，包含 16:00 共 9 期；封盘后前端应显示只读状态并禁用交易按钮。
