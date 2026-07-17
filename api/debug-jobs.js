// 临时调试接口：直接在线上环境跑一遍 fetchAllJobs()，把结果和当前生效的字段名配置吐出来。
// 排查完问题之后记得删掉这个文件再push一次，不要长期留在生产环境里。
//
// 用简单的 key 校验（复用 LARK_APP_SECRET）挡一下，避免被随便访问看到Base数据，
// 但这终究是临时排查用的，不是正式的鉴权方案。
//
// 访问方式：
//   curl "https://lark-file-sync-bot.vercel.app/api/debug-jobs?key=你的LARK_APP_SECRET"

const config = require('../src/config');
const { fetchAllJobs } = require('../src/bitableJobs');
const { getBaseAppToken } = require('../src/resolveBaseAppToken');

module.exports = async (req, res) => {
  if (!config.lark.appSecret || req.query.key !== config.lark.appSecret) {
    res.status(401).send('unauthorized');
    return;
  }

  try {
    const resolvedAppToken = await getBaseAppToken();
    const jobs = await fetchAllJobs();

    res.status(200).json({
      fieldConfig: config.base.fields,
      rawBaseAppTokenEnv: config.base.appToken,
      resolvedAppToken,
      jobsTableId: config.base.jobsTableId,
      logTableId: config.base.logTableId,
      count: jobs.length,
      jobs: jobs.map((j) => ({
        recordId: j.recordId,
        company: j.company,
        position: j.position,
        alias: j.alias,
        hasDoc: !!j.docRef,
        docRef: j.docRef,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
