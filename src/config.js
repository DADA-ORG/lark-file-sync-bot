// 统一读取环境变量，所有和"你们具体的 Base 结构"相关的东西都收在这里，
// 以后 Base 字段名/表结构变了，只改这一个文件。
module.exports = {
  lark: {
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    encryptKey: process.env.LARK_ENCRYPT_KEY || '',
    verificationToken: process.env.LARK_VERIFICATION_TOKEN || '',
    // 国际版 Lark Suite 用 open.larksuite.com，国内版飞书用 open.feishu.cn
    // dadaconsultants 用的是 larksuite.com 域名，所以默认值是国际版
    apiBaseUrl: process.env.LARK_API_BASE_URL || 'https://open.larksuite.com',
  },
  base: {
    appToken: process.env.BASE_APP_TOKEN,
    jobsTableId: process.env.BASE_JOBS_TABLE_ID,
    logTableId: process.env.BASE_LOG_TABLE_ID,
    fields: {
      company: process.env.BASE_FIELD_COMPANY || '公司名称',
      position: process.env.BASE_FIELD_POSITION || '岗位名称',
      alias: process.env.BASE_FIELD_ALIAS || '别名关键词',
      docToken: process.env.BASE_FIELD_DOC_TOKEN || '关联文档token',
    },
  },
  doc: {
    anchorBlockText: process.env.DOC_ANCHOR_BLOCK_TEXT || '群内更新记录',
  },
  llm: {
    provider: process.env.LLM_PROVIDER || 'anthropic',
    model: process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929',
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
  },
  // api/lark-event.js 内部触发 api/process-message.js 时用这个密钥互相校验，
  // 防止有人直接对外网 POST /api/process-message 伪造事件、白嫖 LLM 调用或乱写文档
  internalSecret: process.env.INTERNAL_SECRET,
  // Vercel 会自动注入 VERCEL_URL（当前部署域名，不带协议头），本地 vercel dev
  // 调试时用 PUBLIC_URL 兜底
  siteUrl: process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.PUBLIC_URL || 'http://localhost:3000',
};
