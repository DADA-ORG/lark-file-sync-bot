// 一次性测试脚本：直接调用项目里真实的 fetchAllJobs()，
// 打印出LLM匹配环节实际会看到的候选记录长什么样（尤其是company/position字段的原始类型），
// 用来排查"明明Base里有这条记录，机器人却说没匹配到"的问题。
//
// 用法（在项目根目录 lark-file-sync-bot/ 下，记得带上和线上一致的BASE_*环境变量）：
//   LARK_APP_ID=cli_aad23ce453399ee9 \
//   LARK_APP_SECRET=你的secret \
//   BASE_APP_TOKEN="https://dadaconsultants.sg.larksuite.com/wiki/ISgswBWN1iNbihkM4qXlexNngLc" \
//   BASE_JOBS_TABLE_ID=tblu5JATFPsghwAg \
//   BASE_LOG_TABLE_ID=tblryt9wFMAXVl17 \
//   BASE_FIELD_DOC_TOKEN=文档 \
//   node test-jobs-fetch.js

process.env.LARK_API_BASE_URL = process.env.LARK_API_BASE_URL || 'https://open.larksuite.com';

const { fetchAllJobs } = require('./src/bitableJobs');

async function main() {
  const jobs = await fetchAllJobs();
  console.log(`共拉到 ${jobs.length} 条记录\n`);
  for (const j of jobs) {
    console.log('record_id =', j.recordId);
    console.log('  company (typeof=' + typeof j.company + ') =', JSON.stringify(j.company));
    console.log('  position (typeof=' + typeof j.position + ') =', JSON.stringify(j.position));
    console.log('  docRef =', JSON.stringify(j.docRef));
    console.log('  --- 拼进prompt里实际会变成的文本 ---');
    console.log(`  公司=${j.company} | 岗位=${j.position}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('测试脚本出错：', err.message);
  process.exit(1);
});
