const config = require('./config');

// 用一次 LLM 调用同时完成"抽取"和"匹配"：
// 把群消息原文 + 岗位表里全部 (公司, 岗位) 记录都喂给模型，
// 让模型直接从候选记录里判断这条更新对应哪一条 / 哪几条 / 一条都不对应，
// 比"先抽取文本再用字符串相似度匹配"准确得多，因为顾问的口语化表达模型能理解。
//
// 注意：如果岗位表记录数很大（比如超过几百条），一次性把全部记录塞进 prompt
// 会让 token 成本变高、也可能影响准确率，到时候需要先做一层粗筛（比如按关键词
// 预过滤候选公司）再喂给模型。目前先按"记录数不多"的场景实现。

const TOOL_SCHEMA = {
  name: 'report_job_update_match',
  description: '报告这条群消息对应岗位表里的哪些记录，以及更新内容摘要',
  input_schema: {
    type: 'object',
    properties: {
      matched_record_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          '能唯一确定时，这里放 1 个 record_id；如果消息信息不足以唯一确定（比如同名岗位挂了多个客户），放多个候选 record_id；完全无法匹配到候选列表里任何一条，返回空数组',
      },
      update_summary: {
        type: 'string',
        description: '把群消息里的更新内容提炼成一句简洁陈述，去掉寒暄和无关内容，保留关键信息（进展、状态变化、时间点等）',
      },
      raw_company_guess: {
        type: 'string',
        description: '模型从原文里读出来的公司名称原始文本（即使没匹配到候选列表也要填）',
      },
      raw_position_guess: {
        type: 'string',
        description: '模型从原文里读出来的岗位名称原始文本（即使没匹配到候选列表也要填）',
      },
    },
    required: ['matched_record_ids', 'update_summary', 'raw_company_guess', 'raw_position_guess'],
  },
};

async function extractAndMatch(messageText, jobsList) {
  const candidateLines = jobsList
    .map(
      (j) =>
        `- record_id=${j.recordId} | 公司=${j.company} | 岗位=${j.position}${j.alias ? ` | 别名=${j.alias}` : ''}`
    )
    .join('\n');

  const systemPrompt = `你是一个帮猎头/招聘顾问团队做岗位更新归档的助手。你会收到一条飞书群消息原文，以及一份当前有效的岗位候选记录列表。你的任务是判断这条消息说的是候选列表里的哪一条记录（可能因为顾问打字口语化、简称，需要你根据语义判断，不要求逐字匹配），并把更新内容提炼成一句简洁摘要。`;

  const userPrompt = `候选岗位记录列表：\n${candidateLines || '(候选列表为空)'}\n\n群消息原文：\n${messageText}\n\n请调用 report_job_update_match 工具报告结果。`;

  if (config.llm.provider === 'anthropic') {
    return callAnthropic(systemPrompt, userPrompt);
  }
  return callOpenAI(systemPrompt, userPrompt);
}

async function callAnthropic(systemPrompt, userPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.llm.anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
    }),
  });
  const data = await resp.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error(`LLM 未返回结构化结果: ${JSON.stringify(data)}`);
  }
  return toolUse.input;
}

async function callOpenAI(systemPrompt, userPrompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [{ type: 'function', function: { name: TOOL_SCHEMA.name, description: TOOL_SCHEMA.description, parameters: TOOL_SCHEMA.input_schema } }],
      tool_choice: { type: 'function', function: { name: TOOL_SCHEMA.name } },
    }),
  });
  const data = await resp.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) {
    throw new Error(`LLM 未返回结构化结果: ${JSON.stringify(data)}`);
  }
  return JSON.parse(call.function.arguments);
}

module.exports = { extractAndMatch };
