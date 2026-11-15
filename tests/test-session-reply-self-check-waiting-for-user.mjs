import assert from 'assert/strict';
import { isReplySelfCheckWaitingForUser as check } from '../chat/session-reply-self-check.mjs';

let passed = 0, failed = 0;
function T(label, reply, user = '') {
  const got = check({ assistantTurnText: reply, userMessage: user });
  if (got) passed++; else { failed++; console.log(`  ✗ MISS(wait): ${label}\n     tail: ${JSON.stringify(reply.slice(-120))}`); }
}
function F(label, reply, user = '') {
  const got = check({ assistantTurnText: reply, userMessage: user });
  if (!got) passed++; else { failed++; console.log(`  ✗ FALSE+(continue): ${label}\n     tail: ${JSON.stringify(reply.slice(-120))}`); }
}

console.log('=== WRONG cases from production (MUST WAIT) ===');
// bulleted lettered options + 你定
T('bulleted (A)/(B) fork + 你定',
  'capacitor 都已安装。请选一个：\n- **(A) 授权特权操作**——你在产品里给本会话开特权授权，我立刻按上面三步以 andy 跑完。\n- **(B) 你自己跑**——把上面那段命令以 andy 执行，跑完告诉我。我倾向 A。你定。');
// circled path choice
T('确认走路径①吗 (或要②)',
  '产出后我会跑相关前端测试、只读自检 diff、再把 patch 交给你 apply。确认走路径①吗?(或要②,告诉我即可)确认后我直接开始读当前 token/Header 现状并产出 Phase 1 patch。');
// 选 A 还是 B
T('选 A 还是 B? 告诉我一声',
  '我把 Phase 1 patch 写到 ~/workspace，把任务派给特权执行会话以 andy 身份 apply + 跑测试 + commit，再把结果 relay 回来。选 A 还是 B?选好并(若选 A)跑完授权命令,告诉我一声,我就开始产出 Phase 1 patch。');
// 等你跑完 + 贴来
T('等你跑完把输出贴来',
  '已写回任务 note。等你跑完上面那段把输出贴来,我做只读复核收尾。');
// bulleted (a)(b)(c) + 你选
T('bulleted (a)(b)(c) + 你选',
  '下一步是真实分叉,你定:\n- (a) 部署看效果：build-deb + 安装 + 重启。\n- (b) 继续 Phase 2 slice3。\n- (c) 暂停。我建议 (a)。部署需要你确认(涉及重启)。你选。');
// restart confirmation
T('需要你明确回复：确认重启',
  '当前源码已完成，但生产 7690 服务尚未加载新路由。按服务重启安全门槛，在线启用前需要你明确回复：确认重启 RemoteLab 服务。');
// 是否现在重启服务？
T('是否现在重启服务？',
  '我已经修复：直接 Claude 模式增加 xhigh、max，新增模型元数据与实际参数传递测试，5 项定向测试全部通过。目前只差重启 remotelab-promoted.service 才会在线生效。是否现在重启服务？');
// direct question codex vs claude
T('你用的是 codex 还是 claude？',
  '所以有两种可能，修复方向完全不同，需要你确认一下：你用 plan 模式时，用的是 codex 还是 claude？你告诉我用的是哪个（或两个都遇到过），我就接着往下修。');
// 请给我复现
T('请给我一个具体复现：原文',
  '要修对，我需要确认你的具体触发：请给我一个具体复现：触发重复的那条原始请求原文 + 重复出来的内容长什么样？你贴一个实例，我就能定位是哪条、直接对症修。');
// 等你确认 + 结果一发我
T('等你确认入口网址 结果一发我',
  '当前头号嫌疑：你的入口被 Cloudflare Access 登录墙保护。等你确认：完整入口网址 + /sw.js 显示的是代码还是登录页。结果一发我，就能定方案。');
// 你先回答 #1 范围
T('你先回答 #1 的范围',
  '切换(#3)：胶囊作为 running 的折叠子态。你先回答 #1 的范围,确认 #2/#3 设计 OK,我就开工产 patch。');
// sudo restart needs you + test after
T('需要你执行 sudo restart',
  '代码已改好，但运行中的进程还是旧代码。我没有 sudo 权限，这步需要你执行：sudo systemctl restart remotelab-promoted。重启后用 claude 开 plan 模式发条消息就能看到方案卡片了。');
// 装上或还有问题告诉我
T('你去登录后试着装一下 告诉我',
  '你去 thelab.example.test 登录后试着装一下，正常情况下这次就能弹出安装提示了。装上或还有问题，都告诉我。');
T('贴 git log 和测试结果给我',
  'apply + commit 后再走构建+部署。贴 git log --oneline -2 + 测试结果给我，我接复核 + 部署。');
// English: which database
T('EN: which database do you want',
  'The schema is ready. Which database do you want me to use for the migration?');
// EN: please provide api key
T('EN: need your api key',
  'I can wire this up, but I still need your OpenAI API key to authenticate. Please provide it and I will finish.');
// EN: pick one option
T('EN: pick one of these',
  'Options:\nA) Email a summary\nB) Post to Slack\nC) Generate a PDF\nPick one and I will apply it.');
T('EN: A dot B dot choose A or B',
  'I need your deployment preference before I can continue:\nA. Deploy to staging\nB. Deploy to production\nPlease choose A or B.');
// EN: confirm before restart
T('EN: confirm before restart',
  'The fix is verified. I need your confirmation before I restart the production server. Confirm?');
// Chinese preference: 你更倾向哪个
T('你想用 Postgres 还是 SQLite 你更倾向哪个',
  '存储这块我可以用 Postgres 或 SQLite，你想用哪个？你更倾向哪个？');
T('询问用户意见 你觉得怎么样',
  '我可以把导航改成底部标签栏，也可以保留侧边抽屉。这个方案你觉得怎么样？');
T('询问用户怎么看',
  '两种信息架构都会影响后续页面组织。你怎么看？');
T('EN what do you think',
  'I can prioritize speed or stronger consistency guarantees. What do you think?');
T('EN does this look right to you',
  'The revised hierarchy keeps the primary action visible. Does this look right to you?');
T('真实样本：全做 1-6 还是先挑几个',
  '北极星建议顺序已经整理好。\n\n要我全做 1-6（一次打包），还是先挑几个？全做的话我就按上面顺序开切片。');
T('中文：先全量还是先局部',
  '我可以先全量重构，也可以先只改移动端入口。你希望我先全量做完，还是先局部验证？');
T('EN: do all or start small',
  'I can do all six changes in one pass, or start with the first two. Do you want me to do all six, or start small?');

console.log('\n=== LEGIT cases (MUST CONTINUE / not catch) ===');
F('permission offer 要我查吗？', '要我查吗？');
F('permission offer 要我继续吗', '迁移文件已创建。要我继续执行吗？');
F('permission EN want me to continue', 'I have created the migration. Want me to continue and run it?');
F('permission EN should I proceed', 'Tests pass. Should I proceed with the deploy?');
F('smoke probe', 'RAGENT_CLAUDE_SMOKE_OK');
F('asset message', 'Generated files ready to download.');
F('analysis recommendation (no user q)',
  '建议下一步直接实施 P0 + P1，这两部分就能让设置栏在视觉上明显接近会话栏；图标和动效可以随后补充。');
F('artifact + recommendation',
  '完整方案、Deb 目录结构、安全协议、四阶段开发路线和验收标准已经写入设计文档。本轮没有修改运行代码。建议下一步直接实施 Phase 0。Artifacts: - /srv/.../architecture.md');
F('interrupted run resume (mid-work)',
  '实现上有两个关键点：只读语义必须来自 run 元数据；始终在输出最下端则需要在后续消息渲染后重新把进度摘要移到末尾。现在我先确认历史与实时两条渲染路径。');
F('done + optional offer',
  '记录已更新。One UI 移动前端工作流收尾：Phase 1+2 全部完成并 live-verified，无未决项。要接 Phase 3 时再叫我。');
F('plain completion', 'All set. The task is complete.');
F('API error interrupt', 'API Error: Request rejected (429) · Usage limit reached for 5 hour.');

console.log('\n=== DELEGATION override ===');
F('user delegated 你自己决定', '你想用 Postgres 还是 SQLite？', '存储你自己决定，弄好就行');
F('user delegated 直接做', '要我继续吗？', '直接做完，不用问');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
