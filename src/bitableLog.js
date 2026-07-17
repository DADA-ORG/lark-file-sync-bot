const { getTenantAccessToken } = require('./larkAuth');
const { getBaseAppToken } = require('./resolveBaseAppToken');
const config = require('./config');

// 日志表建议的列（在 Base 里新建一张空表，列名和下面这些 key 对应即可，
// 建表时字段类型：msg_id/company/position/status 用单行文本，raw_text/detail 用多行文本，time 用日期）
// msg_id | chat_id | raw_text | company | position | matched_record_id | status | detail | time

async function hasProcessed(msgId) {
  const token = await getTenantAccessToken();
  const appToken = await getBaseAppToken();
  const url = `${config.lark.apiBaseUrl}/open-apis/bitable/v1/apps/${appToken}/tables/${config.base.logTableId}/records/search`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      filter: {
        conjunction: 'and',
        conditions: [{ field_name: 'msg_id', operator: 'is', value: [msgId] }],
      },
      page_size: 1,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    console.error('查询日志表失败（不阻断主流程，按未处理继续走）', data);
    return false;
  }
  return (data.data.items || []).length > 0;
}

async function writeLog({ msgId, chatId, rawText, company, position, matchedRecordId, status, detail }) {
  const token = await getTenantAccessToken();
  const appToken = await getBaseAppToken();
  const url = `${config.lark.apiBaseUrl}/open-apis/bitable/v1/apps/${appToken}/tables/${config.base.logTableId}/records`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      fields: {
        msg_id: msgId,
        chat_id: chatId,
        raw_text: rawText,
        company: company || '',
        position: position || '',
        matched_record_id: matchedRecordId || '',
        status,
        detail: detail || '',
        time: Date.now(),
      },
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    console.error('写入日志表失败', data);
  }
}

module.exports = { hasProcessed, writeLog };
