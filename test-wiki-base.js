// 一次性测试脚本：验证 resolveBaseAppToken.js 能不能正确把wiki链接换成真实app_token，
// 并且能不能用换出来的app_token真的读到表里的记录。
//
// 用法（在项目根目录 lark-file-sync-bot/ 下）：
//   LARK_APP_ID=cli_aad23ce453399ee9 \
//   LARK_APP_SECRET=你的secret \
//   BASE_APP_TOKEN="https://dadaconsultants.sg.larksuite.com/wiki/ISgswBWN1iNbihkM4qXlexNngLc" \
//   node test-wiki-base.js
//
// 跑完把终端输出整段贴回来即可，脚本不会保存/打印app_secret本身。

process.env.LARK_API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const config = require('./src/config');
const { getBaseAppToken } = require('./src/resolveBaseAppToken');
const { getTenantAccessToken } = require('./src/larkAuth');

const TEST_TABLE_ID = 'tblryt9wFMAXVl17'; // 来自你发的wiki链接里的 ?table= 参数

async function main() {
  console.log('1) 解析 BASE_APP_TOKEN =', config.base.appToken);

  const appToken = await getBaseAppToken();
  console.log('2) 换出来的真实 app_token =', appToken);

  const accessToken = await getTenantAccessToken();
  const url = new URL(
    `${config.lark.apiBaseUrl}/open-apis/bitable/v1/apps/${appToken}/tables/${TEST_TABLE_ID}/records`
  );
  url.searchParams.set('page_size', '5');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();

  console.log('3) 读表结果 code =', data.code, ' msg =', data.msg);
  if (data.code === 0) {
    console.log('   共', data.data.total, '条记录，前几条 fields：');
    for (const item of data.data.items || []) {
      console.log('   -', JSON.stringify(item.fields));
    }
  } else {
    console.log('   完整返回：', JSON.stringify(data));
  }
}

main().catch((err) => {
  console.error('测试脚本出错：', err.message);
  process.exit(1);
});
