# Group- File Sync Bot 部署说明

飞书群里顾问 @bot 发岗位更新 → 自动识别公司/岗位 → 在 Base 里匹配对应岗位记录 → 写入关联文档。

## 一、准备工作（Base 结构）

> **2026-07-17 更新**：已换成 dadaconsultants 的正式 Base，挂在知识库下：
> Wiki 节点 `https://dadaconsultants.sg.larksuite.com/wiki/JCLgwEygCiY907kU1KKlcjBxgab`，
> 岗位表 `tblWMTsltmMpF8rL`，日志表 `tbllQecdog8LtITc`。这三个值已经填进 `.env.example` 和本地 `.env`。
> `resolveBaseAppToken.js` 会自动把 Wiki 链接换成真正的 app_token，不用手动转换。
> 之前跑通流程用的测试 Base（`YMHDbUAw8a72hTsPVbNlXnvMgqh`）信息留在 `.env.example` 注释里，不再使用。

### 1. 岗位信息表

正式表列名和之前测试表核对过的一致，`.env.example` 里的 `BASE_FIELD_*` 不用改：

| Base 里的实际列名 | 对应 `.env` 变量 | 类型 | 说明 |
| --- | --- | --- | --- |
| 客户 | `BASE_FIELD_COMPANY` | 文本（主字段） | 公司名 |
| 项目名称 | `BASE_FIELD_POSITION` | 文本 | 岗位名 |
| Lark Link/Notes | `BASE_FIELD_DOC_TOKEN` | 超链接 | 代码里的 `extractDocToken` 已经兼容这种类型（`{link, text}` 结构），会自动从链接里解析出 document_id |
| （其他列，比如"行业"） | 不涉及 | — | bot 只用上面这三列，正式表里的其他列一律忽略，不用配置 |

用户明确说明只有这三列对应 bot 需要的信息，没有单独的"别名"列，所以 `BASE_FIELD_ALIAS` 不再假设有对应列，保持默认占位值即可——代码找不到这一列时按空值处理，不影响运行。

正式表里**不是每条岗位记录都填了 Lark Link/Notes**（关联文档）。这不用提前补齐：@bot 触发某条没填文档链接的记录时，bot 会自动回复"匹配到了但这条记录没有关联文档，请检查 Base 里的文档字段"，相当于自带提醒，看到这条回复去 Base 里补链接即可。

如果之后列名有变化，改 `.env` 里对应的 `BASE_FIELD_*` 去匹配新列名即可，不用改代码。

### 2. 日志表

日志表（`tbllQecdog8LtITc`）已经手动加好 9 列（msg_id / chat_id / raw_text / company / position / matched_record_id / status / detail / time），不用再配置，bot 跑起来后会自动写记录。

### 3. 岗位文档模板

每个岗位对应的文档里，提前放一个标题 block，文字内容和 `.env` 里的 `DOC_ANCHOR_BLOCK_TEXT` 一致（默认 **"Updates（AI总结）"**，代码里是按"包含"而不是"完全相等"匹配这段文字的，见 `docsWrite.js` 的 `blockPlainText(b).includes(...)`），bot 写入的内容会追加在这个标题下面。

**如果某份文档还没放锚点标题**：不用提前手动补——bot 第一次往这份文档写入时，如果找不到锚点，会自动把内容连同一行 `⚠️ 未在文档中找到锚点` 的提示插到**文档最开头**（不是末尾，方便一打开就看到），同时群里的回复也会带上"（未找到锚点，已追加到文档开头，建议检查模板）"。看到这个提示，去文档里把提示文字替换成正式的锚点标题（`Updates（AI总结）`）即可，后续更新会正常归位。详细行为见「使用指南.md」的"锚点"章节。

## 二、飞书/Lark 自建应用配置

你们用的是 **Lark Suite 国际版**（larksuite.com 域名，不是国内飞书 feishu.cn），所以开发者后台地址是 open.larksuite.com，代码里的 API 域名也已经默认配成 `open.larksuite.com`（见 `.env.example` 里的 `LARK_API_BASE_URL`）。

在开发者后台找到你们已有的自建应用，检查"权限管理"里是否已勾选：

- 接收群聊中 @ 机器人消息事件（**不需要**"获取群组中所有消息"这种全量权限，只要 @ 触发相关权限即可）
- 发送消息 / 以应用身份发消息
- 查看、编辑多维表格（bitable 相关）
- 查看、编辑新版文档（docx 相关）
- 查看知识库/Wiki（`wiki:wiki:readonly` 或等效的 Wiki 只读权限）——如果 Base 里"关联文档"这一列存的是 Wiki 节点链接（形如 `.../wiki/xxxxx`）而不是文档直链（`.../docx/xxxxx`），代码需要先用这个权限调 Wiki API 把节点链接解析成真正的文档 id，才能写入内容

权限改动之后需要发布新版本，走一次企业管理员审核。

记下"凭证与基础信息"里的 App ID 和 App Secret，填进 `.env`。

## 三、推送到 GitHub + Vercel 部署

走 Git 部署的话，Vercel 会在每次 `git push` 到主分支时自动构建部署，不用再手动跑部署命令。

### 1. 推送代码到 GitHub

在自己电脑上（不是这份说明所在的沙箱环境）执行：

```bash
cd lark-file-sync-bot
git init
git add .
git commit -m "init: lark file sync bot"
```

去 GitHub 网站新建一个空仓库（不要勾选自动生成 README，避免冲突），拿到仓库地址后：

```bash
git branch -M main
git remote add origin git@github.com:你的用户名/仓库名.git
git push -u origin main
```

`.gitignore` 已经排除了 `node_modules/`、`.env`、`.vercel/`，密钥不会被提交上去。

### 2. 在 Vercel 里导入这个仓库

去 vercel.com 后台 → Add New → Project → Import Git Repository，选刚推上去的仓库，Vercel 会自动识别到 `api/` 目录，不需要额外配置 Build 命令。

导入过程中会有一步"Environment Variables"，把 `.env.example` 里列的所有变量按实际值填进去（App ID、App Secret、Base 相关、LLM key 等）。**记得生成一个 `INTERNAL_SECRET`**（`api/lark-event.js` 和 `api/process-message.js` 之间用它互相校验身份），本地可以用 `openssl rand -hex 16` 生成一串填进去。

点 Deploy，第一次部署完成后会给你一个项目地址，比如 `https://your-project.vercel.app`。

之后每次改代码，本地 `git push` 到 main 分支，Vercel 就会自动重新部署，不用再手动操作。环境变量如果要改，去 Vercel 项目 Settings → Environment Variables 改，改完需要手动触发一次 Redeploy 才会生效。

> 关于免费 Hobby 套餐够不够用：Vercel 现在的 Hobby 套餐每月给 100万次函数调用、4 个 Active CPU 小时、360 GB-hrs 内存配额，而且等 LLM/网络请求返回结果的等待时间不计入 Active CPU（只有真正占用 CPU 计算的时间才算）。一天 10 条消息一个月也就 300 条左右，每条消息对应 2 次函数调用（lark-event + process-message），怎么算都远远用不到限额的零头，免费套餐完全够用。函数超时上限现在也有 300 秒（5 分钟），`vercel.json` 里配的 60 秒绰绰有余。

## 四、配置飞书事件订阅回调

回到开发者后台 → 事件与回调 → 事件订阅，把请求网址填成：

```
https://your-project.vercel.app/api/lark-event
```

保存时飞书会发一次 URL 校验请求，`api/lark-event.js` 会自动响应，显示"已验证"就说明握手成功。

然后在"添加事件"里订阅：`接收消息 im.message.receive_v1`。

最后把 bot 拉进目标群聊（群设置 → 添加机器人）。

## 五、验证流程

在群里 @bot 发一条类似"@bot ABC公司的销售岗位，客户那边说明天二面"的消息，正常情况下几秒内 bot 会回复处理结果（同步成功 / 未匹配到 / 匹配到多条需要确认）。如果没反应，按下面顺序排查：

1. Vercel 项目后台 → Deployments → 对应部署 → Functions/Logs，看 `lark-event` 和 `process-message` 的调用日志和报错
2. 检查开发者后台事件订阅状态是不是"已验证"
3. 检查日志表（Base）里有没有新记录，status 字段能看出卡在哪一步
4. 如果 `process-message` 报 401，说明 `INTERNAL_SECRET` 没配或者两个函数环境变量的值对不上

## 目录结构

```
lark-file-sync-bot/
├── api/
│   ├── lark-event.js       # 飞书回调入口（同步，快速返回）
│   └── process-message.js  # 实际处理逻辑（由 lark-event.js 内部触发）
├── src/
│   ├── config.js       # 环境变量统一读取
│   ├── larkAuth.js      # tenant_access_token 获取与缓存
│   ├── larkCrypto.js    # 事件加密解密
│   ├── larkBotInfo.js   # bot open_id
│   ├── bitableJobs.js   # 岗位表读取
│   ├── bitableLog.js    # 日志表读写 + 去重
│   ├── llmExtract.js    # LLM 抽取 + 匹配
│   ├── docsWrite.js     # 文档写入
│   └── messageReply.js  # 群内回复
├── .env.example
├── vercel.json
└── package.json
```
