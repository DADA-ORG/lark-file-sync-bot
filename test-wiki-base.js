// 一次性测试脚本（更新版）：
// 1) 验证 resolveBaseAppToken.js 能不能正确把wiki链接换成真实app_token
// 2) 分别列出 岗位表 / 日志表 的真实字段名（用 fields 接口，不依赖表里有没有数据）
//
// 用法（在项目根目录 lark-file-sync-bot/ 下）：
//   LARK_APP_ID=cli_aad23ce453399ee9 \
//   LARK_APP_SECRET=你的secret \
//   BASE_APP_TOKEN="https://dadaconsultants.sg.larksuite.com/wiki/ISgswBWN1iNbihkM4qXlexNngLc" \
//   BASE_JOBS_TABLE_ID=tblu5JATFPsghwAg \
//   BASE_LOG_TABLE_ID=tblryt9wFMAXVl17 \
//   node test-wiki-base.js
//
// 跑完把终端输出整段贴回来即可。

process.env.LARK_API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const config = require('./src/config');
const { getBaseAppToken } = require('./src/resolveBaseAppToken');
const { getTenantAccessToken } = require('./src/larkAuth');

async function listFields(appToken, accessToken, tableId, label) {
  const url = new URL(
    `${config.lark.apiBaseUrl}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`
  );
  url.searchParams.set('page_size', '100');
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();

  console.log(`\n=== ${label}（table_id=${tableId}）字段列表 ===`);
  if (data.code !== 0) {
    console.log('   拉取失败:', data.code, data.msg);
    return;
  }
  for (const f of data.data.items || []) {
    console.log(`   - ${f.field_name}  (type=${f.type})`);
  }
}

async function main() {
  console.log('1) 解析 BASE_APP_TOKEN =', config.base.appToken);

  const appToken = await getBaseAppToken();
  console.log('2) 换出来的真实 app_token =', appToken);

  const accessToken = await getTenantAccessToken();

  await listFields(appToken, accessToken, config.base.jobsTableId, '岗位信息表');
  await listFields(appToken, accessToken, config.base.logTableId, '日志表');
}

main().catch((err) => {
  console.error('测试脚本出错：', err.message);
  process.exit(1);
});
