const { getTenantAccessToken } = require('./larkAuth');
const config = require('./config');

// 进程内缓存：换出来的 obj_token 在 Base 存在期间不会变，
// 同一个函数实例（Vercel 热启动）内复用，避免每次请求都多打一次 wiki API。
let cachedAppToken = null;

function extractWikiNodeToken(raw) {
  if (!raw) return null;
  const match = raw.match(/wiki\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// BASE_APP_TOKEN 环境变量支持两种格式：
// 1) 原始 Bitable app_token（独立 Base，比如测试 Base：YMHDbUAw8a72hTsPVbNlXnvMgqh）
// 2) 完整的 Wiki 节点链接（挂在知识库下的正式 Base），比如
//    https://dadaconsultants.sg.larksuite.com/wiki/ISgswBWN1iNbihkM4qXlexNngLc
//    这种情况下链接里的 token 是 wiki node_token，不能直接当 app_token 用，
//    要先调 /open-apis/wiki/v2/spaces/get_node 换出真正的 obj_token。
// 已实测（2026-07-17，用 dadaconsultants 的 App 实测过）：这一步不需要额外申请
// wiki 权限，现有应用权限（能读 Bitable 的权限）已经够用，直接调用即可成功。
async function getBaseAppToken() {
  if (cachedAppToken) return cachedAppToken;

  const raw = config.base.appToken;
  if (!raw) throw new Error('缺少 BASE_APP_TOKEN 环境变量');

  const wikiNodeToken = extractWikiNodeToken(raw);
  if (!wikiNodeToken) {
    // 不是 wiki 链接格式，当作原始 app_token 直接用（保持对测试 Base 的兼容）
    cachedAppToken = raw;
    return cachedAppToken;
  }

  const accessToken = await getTenantAccessToken();
  const url = new URL(`${config.lark.apiBaseUrl}/open-apis/wiki/v2/spaces/get_node`);
  url.searchParams.set('token', wikiNodeToken);
  url.searchParams.set('obj_type', 'wiki');
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`解析 Base 所在的 Wiki 节点失败: ${data.code} ${data.msg}`);
  }
  const node = data.data && data.data.node;
  if (!node) {
    throw new Error('解析 Base 所在的 Wiki 节点失败：接口没有返回 node 信息');
  }
  if (node.obj_type !== 'bitable') {
    throw new Error(
      `BASE_APP_TOKEN 指向的 Wiki 节点不是多维表格(bitable)，而是「${node.obj_type}」类型，请检查链接是否填对了`
    );
  }

  cachedAppToken = node.obj_token;
  return cachedAppToken;
}

module.exports = { getBaseAppToken };
