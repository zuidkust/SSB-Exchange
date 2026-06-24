window.SSB_WEB_CONFIG = {
  // 同源部署时留空即可；如果前后端分开部署，填入后端 API 地址。
  apiBase: '',
  // 开源默认不包含任何部署备案信息；线上部署可在 config.local.js 中覆盖。
  filing: {
    icpText: '',
    icpUrl: 'https://beian.miit.gov.cn/',
    publicSecurityText: '',
    publicSecurityUrl: ''
  }
};
