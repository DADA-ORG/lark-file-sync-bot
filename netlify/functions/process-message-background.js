// 已弃用：项目改用 Vercel 部署，对应的新文件是 ../../api/process-message.js
// 沙箱环境不允许删除文件，这里留一个空壳，实际不会被调用到。
module.exports.handler = async () => ({ statusCode: 410, body: 'moved to Vercel, see /api/process-message.js' });
