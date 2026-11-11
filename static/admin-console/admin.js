(() => {
  'use strict';

  const viewTitles = {
    overview: ['总览', '查看中心服务、数据库与用量的健康状态。'],
    services: ['中心服务', '查看 Ragent 服务、数据库、入口和 Accounts 内的集成能力。'],
    monitoring: ['监控指标', '查看中心服务资源指标与语音、TURN、推送的近期用量趋势。'],
    diagnostics: ['功能测试', '运行本机健康接口、数据库和入口配置检查。'],
    database: ['数据库', '查看结构和迁移状态，创建备份并在需要时恢复。'],
    secrets: ['密钥与凭据', '安全替换正在使用的服务凭据，并按需启用云端语音识别。'],
    audit: ['操作记录', '查看密钥轮换、数据库维护和服务操作的审计记录。'],
  };
  const serviceLabels = {
    'agentoc-accounts': ['Accounts API', '账号、设备配对、ASR 用量与推送队列'],
    'turn-credential-broker': ['TURN 凭据 broker', '为跨设备会话签发 TURN 中继凭据'],
    'agentoc-signaling': ['P2P 信令服务', '为 Ragent 设备连接转发信令'],
    'agentoc-tunnel-server': ['反向隧道服务', '提供受控的远程连接入口'],
  };
  const actionLabels = {
    'secret.rotate': '轮换服务凭据',
    'speech.cloud.toggle': '更改云端语音识别状态',
    'speech.cloud.test': '测试云端语音供应商',
    'speech.cloud.settings': '更改云端语音配额',
    'database.password.rotate': '轮换数据库密码',
    'database.backup.create': '创建数据库备份',
    'database.restore': '恢复数据库备份',
    'database.migrations.apply': '应用数据库迁移',
    'service.restart': '重启中心服务',
    'diagnostics.run': '运行中心服务功能检查',
  };
  const errorMessages = {
    access_denied: '访问身份校验失败，请重新通过 Cloudflare 安全验证。',
    origin_denied: '请求来源校验失败，请刷新页面后重试。',
    ADMIN_UNAVAILABLE: '管理服务暂时不可用，请稍后刷新。',
    SYSTEM_OPERATION_FAILED: '服务器操作没有完成，请检查服务状态后重试。',
    INVALID_SECRET: '凭据格式不符合要求，请检查内容后重试。',
    INVALID_FCM_JSON: '无法解析此 JSON 文件。',
    INVALID_FCM_CREDENTIAL: '这不是有效的 Google 服务账号凭据文件。',
    RESTORE_CONFIRMATION_REQUIRED: '恢复确认文字不匹配，数据库未更改。',
    DATABASE_ROTATION_HEALTH_FAILED: '新凭据已回滚，Accounts 健康检查没有通过。',
    DATABASE_ROTATION_ROLLBACK_FAILED: '数据库密码回滚未能完成，请立即查看服务器状态。',
    OPENAI_KEY_REQUIRED: '请先保存 OpenAI API key，再启用云端语音识别。',
    PROVIDER_REVIEW_REQUIRED: '启用前请确认已检查 OpenAI API 数据控制和隐私说明。',
    ASR_MIGRATION_REQUIRED: '数据库还没有应用语音识别所需的迁移。',
    ASR_TEST_AUDIO_INVALID: '请选择不超过 20 秒的 16 kHz 单声道 16 位 WAV 音频。',
    ASR_TEST_UNAVAILABLE: '请先配置并开启云端语音服务。',
    ASR_TEST_PROVIDER_FAILED: '供应商转写失败，请检查凭据、模型权限和供应商状态。',
    ASR_SETTINGS_INVALID: '请检查语音额度和请求超时的范围。',
    SERVICE_RESTART_FAILED: '配置已写入，但服务重启未成功。请检查中心服务状态。',
    MIGRATION_FAILED: '数据库迁移执行失败，服务数据未在页面中展示。',
    RESTORE_FAILED: '备份恢复失败；恢复操作使用事务，现有数据库未被部分覆盖。',
  };

  const state = { view: 'overview', overview: null, secrets: null, database: null, audit: null, diagnostics: null, asrTest: null, busy: false };
  const root = document.getElementById('viewRoot');
  const flash = document.getElementById('flash');
  const title = document.getElementById('pageTitle');
  const description = document.getElementById('pageDescription');
  const lastUpdated = document.getElementById('lastUpdated');

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function bytes(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
    return `${(number / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function date(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
  }

  function showFlash(message, tone = 'success') {
    flash.textContent = message;
    flash.dataset.tone = tone;
    flash.classList.add('is-visible');
    window.clearTimeout(showFlash.timer);
    showFlash.timer = window.setTimeout(() => flash.classList.remove('is-visible'), 7000);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const code = payload?.error || payload?.code || 'ADMIN_UNAVAILABLE';
      throw new Error(errorMessages[code] || '操作没有完成，请刷新页面后重试。');
    }
    return payload;
  }

  async function loadOverview() {
    state.overview = await api('/api/overview');
  }
  async function loadSecrets() {
    state.secrets = await api('/api/secrets');
  }
  async function loadDatabase() {
    state.database = await api('/api/database');
  }
  async function loadAudit() {
    state.audit = await api('/api/audit');
  }

  async function refreshCurrent({ quiet = false } = {}) {
    if (state.busy) return;
    state.busy = true;
    if (!quiet) root.innerHTML = '<div class="loading-state">正在读取服务器状态…</div>';
    try {
      await loadOverview();
      if (state.view === 'secrets') await loadSecrets();
      if (state.view === 'database') await loadDatabase();
      if (state.view === 'audit') await loadAudit();
      lastUpdated.textContent = `更新于 ${date(state.overview?.updatedAt)}`;
      render();
    } catch (error) {
      root.innerHTML = '<div class="panel-card empty-state">无法载入管理数据，请刷新或稍后重试。</div>';
      showFlash(error.message, 'error');
    } finally {
      state.busy = false;
    }
  }

  function statusPill(active, healthy = true) {
    const isGood = Boolean(active && healthy);
    const isWarn = Boolean(active && !healthy);
    return `<span class="state-pill" data-state="${isGood ? 'good' : isWarn ? 'warn' : 'bad'}">${isGood ? '运行正常' : isWarn ? '服务需检查' : '未运行'}</span>`;
  }

  function serviceList() {
    const services = state.overview?.services || {};
    return Object.entries(serviceLabels).map(([id, [label, hint]]) => {
      const service = services[id] || {};
      const isHealthy = service.health === undefined ? true : service.health;
      return `<div class="service-row">
        <div class="service-info"><span class="service-mark">◈</span><span class="service-name"><strong>${esc(label)}</strong><small>${esc(hint)}</small></span></div>
        ${statusPill(service.active, isHealthy)}
        <button class="service-action" data-action="restart" data-service="${esc(id)}">重启服务</button>
      </div>`;
    }).join('');
  }

  function metric(label, value, note, icon) {
    return `<article class="metric-card"><div class="metric-top"><span>${esc(label)}</span><span class="metric-icon">${icon}</span></div><strong class="metric-value">${esc(value)}</strong><small class="metric-note">${esc(note)}</small></article>`;
  }

  function sumRows(rows, field) {
    return (rows || []).reduce((total, row) => total + Number(row[field] || 0), 0);
  }

  function renderOverview() {
    const overview = state.overview || {};
    const db = overview.database || {};
    const asrRows = db.asr || [];
    const turnRows = db.turn || [];
    const fcmRows = db.fcm || [];
    const totalAsr = sumRows(asrRows, 'requests');
    const asrMinutes = Math.floor(sumRows(asrRows, 'audioMs') / 60000);
    const activeServices = Object.values(overview.services || {}).filter((item) => item.active).length;
    const totalTurn = sumRows(turnRows, 'connections');
    const fcmTotal = sumRows(fcmRows, 'events');
    return `<div class="metric-grid">
      ${metric('在线中心服务', `${activeServices} / 4`, 'Accounts · TURN · 信令 · 隧道', '◈')}
      ${metric('Ragent 账号', overview.databaseAvailable ? Number(db.accountCount || 0).toLocaleString('zh-CN') : '不可用', overview.databaseAvailable ? '服务端账号总数' : '数据库连接失败', '◎')}
      ${metric('语音识别请求', Number(totalAsr).toLocaleString('zh-CN'), `${asrMinutes} 分钟累计音频`, '◖')}
      ${metric('数据库空间', overview.databaseAvailable ? bytes(db.databaseSizeBytes) : '不可用', overview.databaseAvailable ? `PostgreSQL ${esc(db.databaseVersion || '')}` : '请检查 PostgreSQL 容器', '▤')}
    </div>
    <div class="overview-grid">
      <section class="panel-card"><div class="panel-title-row"><div><h2>中心服务</h2><p>服务状态和健康检查</p></div><button class="btn btn-outline-secondary btn-sm" data-action="navigate" data-view="services">查看全部</button></div><div class="service-list">${serviceList()}</div></section>
      <div class="section-stack">
        <section class="panel-card"><div class="panel-title-row"><div><h2>使用概况</h2><p>数据库汇总，不显示个人凭据</p></div>${overview.databaseAvailable ? '' : '<span class="state-pill" data-state="bad">数据库不可用</span>'}</div><div class="usage-list">
          <div class="usage-row"><span>TURN 连接记录</span><strong>${Number(totalTurn).toLocaleString('zh-CN')}</strong></div>
          <div class="usage-row"><span>FCM 推送队列</span><strong>${Number(fcmTotal).toLocaleString('zh-CN')}</strong></div>
          <div class="usage-row"><span>最近数据库迁移</span><strong class="mono">${esc(db.latestMigration || '—')}</strong></div>
          <div class="usage-row"><span>待应用迁移</span><strong>${Number(overview.migrations?.pendingCount || 0)}</strong></div>
        </div></section>
        <section class="panel-card"><div class="panel-title-row"><div><h2>语音识别</h2><p>OpenAI Transcription API</p></div><span class="state-pill" data-state="${overview.asrEnabled ? 'good' : 'warn'}">${overview.asrEnabled ? '已开启' : '已关闭'}</span></div>
          <p class="muted small">${overview.asrEnabled ? '请求由 Accounts 服务转发，按 Ragent 账号统计用量。' : '云端转写目前关闭；可以在“密钥与凭据”页添加 key 并决定是否开启。'}</p>
          <button class="btn btn-outline-secondary btn-sm" data-action="navigate" data-view="secrets">管理语音设置</button>
        </section>
      </div>
    </div>`;
  }

  function renderServices() {
    const services = state.overview?.services || {};
    const platform = state.overview?.platform || {};
    const database = state.overview?.database || {};
    const fcmRows = database.fcm || [];
    const asrRows = database.asr || [];
    const fcmTotal = sumRows(fcmRows, 'events');
    const asrTotal = sumRows(asrRows, 'requests');
    const detail = {
      'agentoc-accounts': '账号和设备配对 API、用量汇总、服务端语音识别与推送队列。',
      'turn-credential-broker': '根据 Accounts 签发的短期能力凭据为设备提供 TURN 配置。',
      'agentoc-signaling': '转发手机和电脑之间建立 P2P 连接所需的信令。',
      'agentoc-tunnel-server': '提供 Ragent 远程连接通道，保持现有设备接入。',
    };
    const managedServices = Object.entries(serviceLabels).map(([id, [label]]) => {
      const service = services[id] || {};
      const healthy = service.health === undefined ? true : service.health;
      return `<article class="service-card"><div class="service-card-head"><h3>${esc(label)}</h3>${statusPill(service.active, healthy)}</div><p>${esc(detail[id])}</p><div class="service-card-foot"><small>${service.active ? `运行中${service.pid ? ` · PID ${service.pid}` : ''}` : `状态：${esc(service.state || 'unknown')}`}</small><button class="service-action" data-action="restart" data-service="${esc(id)}">重启</button></div></article>`;
    }).join('');
    const caddy = platform.caddy || {};
    const caddyStatus = caddy.active ? '运行中' : '未运行';
    const databaseStatus = state.overview?.databaseAvailable ? '数据库可用' : '数据库不可用';
    const fcmStatus = state.overview?.fcmConfigured ? '凭据格式有效' : '凭据未配置或无效';
    const asrStatus = state.overview?.asrEnabled ? '已启用' : state.overview?.asrKeyConfigured ? '已配置，当前关闭' : '未配置 API key';
    const readonlyCard = (title, badge, tone, description, foot) => `<article class="service-card"><div class="service-card-head"><h3>${esc(title)}</h3><span class="state-pill" data-state="${tone}">${esc(badge)}</span></div><p>${esc(description)}</p><div class="service-card-foot"><small>${esc(foot)}</small></div></article>`;
    const legacyGateway = platform.legacyConnectivityGateway || {};
    const orphanWarning = legacyGateway.active && !legacyGateway.fragmentPath
      ? `<div class="security-callout mt-3"><span>!</span><div><strong>发现未纳管的遗留进程</strong>旧版 connectivity-gateway 仍在运行${legacyGateway.pid ? `（PID ${legacyGateway.pid}）` : ''}，但对应 systemd 服务文件已不存在。它不会提供重启按钮；请先确认是否仍有设备依赖，再决定清理方式。</div></div>`
      : '';
    return `<div class="section-stack">
      <section><div class="panel-title-row"><div><h2>Ragent 应用服务</h2><p>仅对固定清单中的服务开放重启操作。</p></div></div><div class="service-grid">${managedServices}</div></section>
      <section><div class="panel-title-row"><div><h2>集成能力与平台依赖</h2><p>FCM 和云端语音由 Accounts 承载；这里显示配置与用量，不把它们伪装成独立守护进程。</p></div></div><div class="service-grid">
        ${readonlyCard('FCM 推送', fcmStatus, state.overview?.fcmConfigured ? 'good' : 'warn', '由 Accounts 调用 Google FCM，不存在独立的本地 FCM service。服务账号文件通过格式校验；此状态不代表 Google 端到端投递测试。', `数据库队列记录 ${Number(fcmTotal).toLocaleString('zh-CN')} 条`)}
        ${readonlyCard('云端语音识别', asrStatus, state.overview?.asrEnabled ? 'good' : 'warn', 'Accounts 将获授权的音频转发到 OpenAI Transcription API；状态依据 API key 配置和开关，不会为检查而发送音频。', `${Number(asrTotal).toLocaleString('zh-CN')} 条转写请求记录`)}
        ${readonlyCard('PostgreSQL 数据库', databaseStatus, state.overview?.databaseAvailable ? 'good' : 'bad', '账号、TURN、FCM 和语音识别用量数据存放在此数据库中；面板只显示汇总和表结构。', state.overview?.databaseAvailable ? `PostgreSQL ${database.databaseVersion || ''} · ${bytes(database.databaseSizeBytes)}` : '当前无法完成数据库查询')}
        ${readonlyCard('Caddy HTTPS 入口', caddyStatus, caddy.active ? 'good' : 'bad', '负责 Oracle 上 Ragent 域名的 HTTPS 入口和反向代理；面板仅监控，不提供重启按钮。', caddy.active ? `运行中${caddy.pid ? ` · PID ${caddy.pid}` : ''}` : `状态：${caddy.state || 'unknown'}`)}
      </div></section>
      ${orphanWarning}
      <div class="security-callout"><span>i</span><div><strong>受限服务操作</strong>面板只开放固定 Ragent 服务清单中的重启操作，不提供 shell、任意 systemd 命令或数据库任意 SQL。</div></div>
    </div>`;
  }

  function compactTime(value) {
    const text = String(value || '');
    const match = text.match(/(\d{2}:\d{2})/);
    return match ? match[1] : '—';
  }

  function trendPercent(value, maximum) {
    return Math.max(5, Math.min(100, Math.ceil(Number(value || 0) / Math.max(1, Number(maximum || 0)) * 20) * 5));
  }

  function trendChart(titleText, rows, valueField, unit) {
    const values = (rows || []).map((row) => ({
      label: String(row.date || '').slice(5),
      value: Math.max(0, Number(row[valueField] || 0)),
    }));
    if (!values.length) return `<section class="panel-card"><div class="panel-title-row"><div><h2>${esc(titleText)}</h2><p>暂无可用的近期趋势数据</p></div></div><div class="empty-state">等待数据库记录或支持该指标的历史数据。</div></section>`;
    const maximum = Math.max(1, ...values.map((item) => item.value));
    return `<section class="panel-card"><div class="panel-title-row"><div><h2>${esc(titleText)}</h2><p>最近 7 天 · 单位：${esc(unit)}</p></div></div>
      <div class="trend-bars" role="img" aria-label="${esc(titleText)}最近七天趋势">${values.map((item) => {
        const level = trendPercent(item.value, maximum);
        return `<div class="trend-column"><strong>${esc(Number(item.value).toLocaleString('zh-CN'))}</strong><div class="trend-track" data-level="${level}"><i></i></div><small>${esc(item.label)}</small></div>`;
      }).join('')}</div></section>`;
  }

  function resourceCard(label, status, sample, live = {}) {
    const isActive = Boolean(status?.active);
    const cpuPercent = sample?.cpuPercent;
    const cpu = cpuPercent != null && Number.isFinite(Number(cpuPercent)) ? `${Number(cpuPercent).toFixed(1)}%` : '—';
    const memory = sample?.memoryBytes ?? live?.memoryBytes;
    const tasks = sample?.tasks ?? live?.tasks;
    const restarts = live?.restartCount ?? sample?.restartCount;
    const cumulativeCpu = live?.cpuUsageNs;
    const cpuTotal = Number.isFinite(Number(cumulativeCpu)) ? `${(Number(cumulativeCpu) / 1e9 / 60).toFixed(1)} 分钟` : '—';
    return `<article class="resource-card"><div class="resource-card-head"><strong>${esc(label)}</strong>${statusPill(isActive, status?.health === undefined ? true : status.health)}</div>
      <div class="resource-values"><div><small>CPU 当前</small><strong>${cpu}</strong></div><div><small>内存</small><strong>${esc(memory == null ? '—' : bytes(memory))}</strong></div><div><small>任务 / 进程</small><strong>${esc(tasks ?? '—')}</strong></div><div><small>重启次数</small><strong>${esc(restarts ?? '—')}</strong></div></div>
      <small class="resource-foot">累计 CPU ${esc(cpuTotal)} · ${Number.isFinite(Number(status?.healthLatencyMs)) ? `健康探针 ${Number(status.healthLatencyMs)} ms · ` : ''}${isActive ? `自 ${esc(status?.since || '—')} 运行` : `状态：${esc(status?.state || 'unknown')}`}</small></article>`;
  }

  function renderMonitoring() {
    const overview = state.overview || {};
    const db = overview.database || {};
    const platform = overview.platform || {};
    const metrics = overview.metrics || {};
    const host = metrics.host || {};
    const history = metrics.history || [];
    const latest = history.at(-1);
    const sampleServices = latest?.services || {};
    const serviceMetrics = overview.services || {};
    const resourceCards = [
      resourceCard('Accounts API', serviceMetrics['agentoc-accounts'], sampleServices['agentoc-accounts'], serviceMetrics['agentoc-accounts']),
      resourceCard('TURN 凭据 broker', serviceMetrics['turn-credential-broker'], sampleServices['turn-credential-broker'], serviceMetrics['turn-credential-broker']),
      resourceCard('P2P 信令服务', serviceMetrics['agentoc-signaling'], sampleServices['agentoc-signaling'], serviceMetrics['agentoc-signaling']),
      resourceCard('反向隧道服务', serviceMetrics['agentoc-tunnel-server'], sampleServices['agentoc-tunnel-server'], serviceMetrics['agentoc-tunnel-server']),
      resourceCard('Caddy HTTPS 入口', platform.caddy, sampleServices.caddy, platform.caddy),
      resourceCard('PostgreSQL', platform.postgres, sampleServices.postgres, platform.postgres),
      ...(platform.legacyConnectivityGateway?.active || platform.legacyConnectivityGateway?.fragmentPath
        ? [resourceCard('旧 connectivity-gateway（需审查）', { ...platform.legacyConnectivityGateway, health: false }, sampleServices.legacyConnectivityGateway, platform.legacyConnectivityGateway)]
        : []),
    ].join('');
    const usedMemory = Number(host.memoryTotalBytes || 0) - Number(host.memoryAvailableBytes || 0);
    const memoryPercent = Number(host.memoryTotalBytes) > 0 ? `${Math.max(0, usedMemory / Number(host.memoryTotalBytes) * 100).toFixed(1)}%` : '—';
    const memoryHistory = history.slice(-12).map((sample) => ({
      date: compactTime(sample.at),
      total: Object.values(sample.services || {}).reduce((sum, item) => sum + Number(item?.memoryBytes || 0), 0),
    }));
    const memoryChart = memoryHistory.length ? `<section class="panel-card"><div class="panel-title-row"><div><h2>中心进程内存采样</h2><p>面板打开期间每分钟记录一次，最长保留 24 小时</p></div><small class="muted">${history.length} 个样本</small></div><div class="trend-bars" role="img" aria-label="中心进程内存采样趋势">${(() => {
      const maximum = Math.max(1, ...memoryHistory.map((item) => item.total));
      return memoryHistory.map((item) => `<div class="trend-column"><strong>${esc(bytes(item.total))}</strong><div class="trend-track" data-level="${trendPercent(item.total, maximum)}"><i></i></div><small>${esc(item.date)}</small></div>`).join('');
    })()}</div></section>` : '';
    const trends = db.trends || {};
    const fcmRows = db.fcm || [];
    const pendingFcm = fcmRows.filter((row) => /pending|retry|queued/i.test(String(row.status))).reduce((sum, row) => sum + Number(row.events || 0), 0);
    const failedFcm = fcmRows.filter((row) => /fail|error/i.test(String(row.status))).reduce((sum, row) => sum + Number(row.events || 0), 0);
    return `<div class="section-stack">
      <section class="metric-grid">${metric('主机内存使用', memoryPercent, `${bytes(usedMemory)} / ${bytes(host.memoryTotalBytes)}`, '▥')}${metric('系统负载', host.load1 == null ? '—' : Number(host.load1).toFixed(2), `1 / 5 / 15 分钟：${host.load5 ?? '—'} · ${host.load15 ?? '—'}`, '⌁')}${metric('磁盘可用', bytes(host.diskFreeBytes), `总量 ${bytes(host.diskTotalBytes)}`, '▤')}${metric('数据库连接', overview.databaseAvailable ? `${Number(db.databaseConnections || 0)} / ${Number(db.databaseMaxConnections || 0) || '—'}` : '不可用', '当前连接 / PostgreSQL 上限', '⇄')}${metric('监控采样', latest?.at ? date(latest.at) : '等待采样', '仅在面板打开并刷新时采样', '◷')}</section>
      <section><div class="panel-title-row"><div><h2>中心服务资源</h2><p>CPU 为最近采样间隔的单核等效占用（100% = 一个逻辑核）；累计 CPU 为服务启动后的总量。</p></div><button class="btn btn-outline-secondary btn-sm" data-action="navigate" data-view="diagnostics">运行功能检查</button></div><div class="resource-grid">${resourceCards}</div></section>
      ${memoryChart}
      <section><div class="panel-title-row"><div><h2>业务用量趋势</h2><p>来源于中心数据库的按日汇总，不包含账号标识、音频、文本或推送内容。</p></div></div><div class="trend-grid">${trendChart('云端语音识别请求', trends.asr || [], 'requests', '次')}${trendChart('TURN 连接租约', trends.turn || [], 'connections', '条')}${trendChart('FCM 推送事件', trends.fcm || [], 'events', '条')}</div></section>
      <section class="panel-card"><div class="panel-title-row"><div><h2>集成服务队列</h2><p>FCM 与云端语音由 Accounts 承载，不存在独立的本地守护进程。</p></div></div><div class="usage-list"><div class="usage-row"><span>ASR 记录总量</span><strong>${Number((db.asr || []).reduce((sum, row) => sum + Number(row.requests || 0), 0)).toLocaleString('zh-CN')}</strong></div><div class="usage-row"><span>FCM 待处理/重试</span><strong>${pendingFcm.toLocaleString('zh-CN')}</strong></div><div class="usage-row"><span>FCM 失败记录</span><strong>${failedFcm.toLocaleString('zh-CN')}</strong></div><div class="usage-row"><span>数据库可用性</span><strong>${overview.databaseAvailable ? '正常' : '不可用'}</strong></div></div></section>
      <div class="security-callout"><span>i</span><div><strong>监控数据范围</strong>主机和进程指标由 Linux、systemd 与 Docker 提供；业务趋势从数据库汇总。历史资源采样在控制台打开期间每分钟保存一次，最多保留 24 小时。</div></div>
    </div>`;
  }

  function renderDiagnostics() {
    const result = state.diagnostics;
    const asrProbe = `<section class="panel-card"><h2>语音供应商实际转写</h2><p>选择不超过 20 秒的 16 kHz、单声道、16 位 WAV 文件。此测试会发送音频至 OpenAI 并可能产生费用，不计入用户用量，也不验证手机账号链路。</p><input id="asrTestAudio" type="file" accept="audio/wav,.wav"><button class="btn btn-outline-secondary btn-sm" data-action="test-asr">测试转写</button>${state.asrTest ? `<p>识别结果：${esc(state.asrTest.text)}</p>` : ''}</section>`;
    if (!result) return `<div class="section-stack"><section class="panel-card diagnostics-intro"><div><h2>中心服务功能有效性检查</h2><p>运行只读的本机服务健康接口、数据库查询、公钥发现和 Caddy 配置校验。</p><button class="btn btn-primary" data-action="run-diagnostics">运行检查</button></div><div class="security-callout"><span>i</span><div><strong>安全范围</strong>常规检查不会调用计费接口或改变数据库。</div></div></section>${asrProbe}</div>`;
    const labels = { pass: '通过', fail: '失败', warn: '需关注', skipped: '未执行' };
    const tones = { pass: 'good', fail: 'bad', warn: 'warn', skipped: 'neutral' };
    const summary = result.summary || {};
    return `<div class="section-stack"><section class="panel-card"><div class="panel-title-row"><div><h2>最近一次检查</h2><p>${date(result.performedAt)} · 常规检查不会执行真实推送、音频转写或终端配对。</p></div><button class="btn btn-primary btn-sm" data-action="run-diagnostics">重新运行</button></div><div class="diagnostic-summary">${['pass', 'fail', 'warn', 'skipped'].map((key) => `<span class="state-pill" data-state="${tones[key]}">${labels[key]} ${Number(summary[key] || 0)}</span>`).join('')}</div></section><section class="panel-card"><div class="diagnostic-list">${(result.checks || []).map((check) => `<article class="diagnostic-row"><div><strong>${esc(check.label)}</strong><small>${esc(check.detail)}</small></div><span class="state-pill" data-state="${tones[check.status] || 'neutral'}">${labels[check.status] || '未知'}</span><time>${Number(check.durationMs || 0)} ms</time></article>`).join('')}</div></section>${asrProbe}<div class="security-callout"><span>i</span><div><strong>端到端验证边界</strong>常规检查不验证真实推送或手机账号链路；供应商测试只检查 OpenAI 转写，不代表手机端到端测试通过。</div></div></div>`;
  }

  function renderMigrations(migrations) {
    const pending = migrations?.pending || [];
    const available = migrations?.available || [];
    return `<section class="panel-card"><div class="panel-title-row"><div><h2>迁移状态</h2><p>已应用 ${migrations?.applied?.length || 0} 项 · 待应用 ${pending.length} 项</p></div>${pending.length ? '<button class="btn btn-primary btn-sm" data-action="migrate">应用待处理迁移</button>' : '<span class="state-pill" data-state="good">已同步</span>'}</div>
      ${available.length ? `<div class="table-wrap"><table class="table table-vcenter"><thead><tr><th>版本</th><th>迁移</th><th>状态</th></tr></thead><tbody>${available.slice().reverse().map((item) => `<tr><td class="mono">${esc(item.version)}</td><td class="mono">${esc(item.name)}</td><td>${item.applied ? '<span class="state-pill" data-state="good">已应用</span>' : '<span class="state-pill" data-state="warn">待处理</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">没有找到迁移文件。</div>'}</section>`;
  }

  function renderBackups(backups) {
    if (!backups?.length) return '<div class="empty-state">还没有数据库备份。</div>';
    return backups.map((backup) => `<div class="backup-row"><div><strong>${esc(backup.id)}</strong><small>${date(backup.createdAt)} · ${bytes(backup.sizeBytes)}</small></div><div class="backup-actions"><a href="/api/backups/${encodeURIComponent(backup.id)}/download">下载</a><button class="restore" data-action="restore" data-backup="${esc(backup.id)}">恢复</button></div></div>`).join('');
  }

  function renderDatabase() {
    const data = state.database || {};
    const overview = data.overview || {};
    const tables = data.tables || [];
    const backups = data.backups || [];
    return `<div class="section-stack">
      <section class="metric-grid">${metric('Ragent 账号', Number(overview.accountCount || 0).toLocaleString('zh-CN'), 'Accounts 服务中的账号', '◎')}${metric('数据库占用', bytes(overview.databaseSizeBytes), `PostgreSQL ${esc(overview.databaseVersion || '')}`, '▤')}${metric('数据表', tables.length.toLocaleString('zh-CN'), '仅显示名称、估算行数和大小', '▥')}${metric('当前迁移', esc(overview.latestMigration || '—'), `${(data.migrations?.pending || []).length} 项待处理`, '⇧')}</section>
      <section class="panel-card"><div class="panel-title-row"><div><h2>数据表</h2><p>行数为 PostgreSQL 估算值，不读取表内个人数据。</p></div></div>
        <div class="table-wrap"><table class="table table-vcenter"><thead><tr><th>表名</th><th>估算行数</th><th>大小</th></tr></thead><tbody>${tables.map((row) => `<tr><td class="mono">${esc(row.name)}</td><td>${Number(row.estimatedRows || 0).toLocaleString('zh-CN')}</td><td>${bytes(row.sizeBytes)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">没有可显示的数据表。</td></tr>'}</tbody></table></div>
      </section>
      ${renderMigrations(data.migrations)}
      <section class="panel-card"><div class="panel-title-row"><div><h2>数据库备份</h2><p>备份以受限文件权限保存在服务器；下载会使用 Cloudflare Access 保护。</p></div><button class="btn btn-primary btn-sm" data-action="backup">立即备份</button></div><div>${renderBackups(backups)}</div></section>
      <div class="security-callout"><span>i</span><div><strong>恢复会覆盖当前数据库内容</strong>恢复前系统会自动再创建一份安全备份，并在恢复过程中暂停 Accounts API。操作需要输入确认文字。</div></div>
    </div>`;
  }

  function statusById(id) {
    return (state.secrets?.items || []).find((item) => item.id === id) || { configured: false, available: true };
  }

  function credentialBadge(item) {
    if (item.active === false) return '<span class="credential-status" data-state="empty">当前未启用</span>';
    const configured = Boolean(item.configured);
    return `<span class="credential-status" data-state="${configured ? 'set' : 'empty'}">${configured ? '已配置' : item.available === false ? '路径需检查' : '未配置'}</span>`;
  }

  function secretCard({ id, title: cardTitle, description: cardDescription, inputLabel, inputType = 'password', placeholder, help, autocomplete = 'off', extra = '' }) {
    const item = statusById(id);
    return `<article class="secret-card"><div class="secret-card-head"><div><h3>${esc(cardTitle)}</h3><p>${esc(cardDescription)}</p></div>${credentialBadge(item)}</div>
      <form class="secret-form" data-secret-form="${esc(id)}">${extra}<label class="form-label small">${esc(inputLabel)}<input class="form-control" ${inputType === 'textarea' ? '' : `type="${esc(inputType)}"`} ${inputType === 'textarea' ? 'data-secret-textarea' : 'data-secret-input'} autocomplete="${esc(autocomplete)}" spellcheck="false" ${inputType === 'textarea' ? 'maxlength="1048576"' : 'maxlength="512"'} placeholder="${esc(placeholder)}" required>${inputType === 'textarea' ? '</textarea>' : ''}</label><div class="form-text">${esc(help)}</div><button class="btn btn-primary" type="submit">保存并应用</button></form>
      <div class="form-text mt-2">最近配置变更：${date(item.updatedAt)}</div></article>`;
  }

  function renderSecrets() {
    const db = statusById('database-password');
    const asrEnabled = Boolean(state.secrets?.asrEnabled);
    const keyConfigured = Boolean(statusById('openai-api-key').configured);
    const fcm = statusById('fcm-service-account');
    const limits = state.secrets?.asrSettings || { freeMinutes: 15, plusMinutes: 120, proMinutes: 600, timeoutMs: 30000, model: 'gpt-transcribe' };
    return `<div class="section-stack">
      <div class="security-callout"><span>✓</span><div><strong>密钥只写入，不回显</strong>所有凭据通过 HTTPS 直接传入服务器；页面不读取密钥值，不将内容写入浏览器缓存或操作日志。更新后会自动重启对应服务。</div></div>
      <section class="panel-card"><div class="panel-title-row"><div><h2>云端语音识别</h2><p>由 Ragent Accounts 转发到 OpenAI Transcription API。</p></div><span class="state-pill" data-state="${asrEnabled ? 'good' : 'warn'}">${asrEnabled ? '当前开启' : '当前关闭'}</span></div>
        <div class="usage-row"><span>API key</span><strong>${keyConfigured ? '已配置' : '未配置'}</strong></div>
        <div class="switch-row"><span class="switch-label"><strong>允许云端转写</strong><small>开启后，用户的授权音频会由服务器发送给 OpenAI，识别文本回到手机草稿。</small></span><input id="asrSwitch" class="switch" type="checkbox" ${asrEnabled ? 'checked' : ''} ${!keyConfigured && !asrEnabled ? 'disabled' : ''} aria-label="开启云端语音识别"></div>
        ${!asrEnabled ? '<label class="checkbox-row"><input id="asrReview" type="checkbox"><span>我已检查 OpenAI API 数据控制，并确认当前 Ragent 隐私说明已覆盖云端转写。</span></label>' : ''}
        ${!keyConfigured ? '<p class="inline-alert">尚未配置 API key。按照当前设置，云端语音识别保持关闭。</p>' : ''}
      </section>
      <section class="panel-card"><h2>语音额度与超时</h2><p>模型：${esc(limits.model)}。修改后 Accounts 服务会短暂重启；重启失败时会恢复原设置。</p><form data-asr-settings>${[['freeMinutes','Free 月额度（分钟）',0,100000],['plusMinutes','Plus 月额度（分钟）',0,100000],['proMinutes','Pro 月额度（分钟）',0,100000],['timeoutMs','供应商请求超时（毫秒）',1000,120000]].map(([name,label,min,max]) => `<label class="form-label small">${label}<input class="form-control" type="number" name="${name}" min="${min}" max="${max}" step="1" value="${Number(limits[name])}" required></label>`).join('')}<button class="btn btn-primary" type="submit">保存语音设置</button></form></section>
      <div class="secret-grid">
        ${secretCard({ id: 'openai-api-key', title: 'OpenAI Transcription API', description: '语音识别服务凭据。保存 key 不会自动开启转写。', inputLabel: '新的 API key', placeholder: '粘贴新的 OpenAI API key', help: '仅保存在 Accounts 服务器配置中；页面不会显示已有值。' })}
        <article class="secret-card"><div class="secret-card-head"><div><h3>FCM 服务账号</h3><p>用于账号推送通知的 Google service account JSON。</p></div>${credentialBadge(fcm)}</div><form class="secret-form" data-secret-form="fcm-service-account"><label class="form-label small">选择新的服务账号 JSON 文件<input class="form-control" type="file" accept="application/json,.json" data-secret-file required></label><div class="form-text">文件只上传到受保护的 Oracle 服务，保存后自动应用，不会保存在浏览器。</div><button class="btn btn-primary" type="submit" ${fcm.available === false ? 'disabled' : ''}>替换并应用</button></form><div class="form-text mt-2">最近配置变更：${date(fcm.updatedAt)}</div></article>
        ${secretCard({ id: 'turn-shared-secret', title: 'Cloudflare TURN 共享密钥', description: 'TURN 临时凭据签名密钥，轮换后由 broker 立即使用。', inputLabel: '新的 TURN 共享密钥', placeholder: '至少 32 个字符', help: '更新后会重启 TURN broker；现有连接在短期凭据有效期内逐步过期。' })}
        ${secretCard({ id: 'turn-broker-token', title: 'TURN broker 内部令牌', description: '服务间访问保护值，仅供 Ragent 中心服务使用。', inputLabel: '新的内部令牌', placeholder: '至少 32 个字符', help: state.secrets?.items?.find((item) => item.id === 'turn-broker-token')?.active === false ? '当前 broker 使用 Accounts 能力凭据模式；此令牌保留为未启用配置。' : '只更改受限的 TURN broker 配置项，不会显示其他配置内容。' })}
        <article class="secret-card"><div class="secret-card-head"><div><h3>Accounts 数据库密码</h3><p>自动生成新密码、更新 PostgreSQL 应用角色和 Accounts 配置，并验证服务恢复。</p></div>${credentialBadge(db)}</div><button class="btn btn-outline-secondary" data-action="rotate-db-password">生成并轮换数据库密码</button><div class="form-text mt-2">新密码不会显示或返回浏览器；如果健康检查失败，系统会自动回滚。</div></article>
      </div>
    </div>`;
  }

  function renderAudit() {
    const entries = state.audit?.entries || [];
    if (!entries.length) return '<section class="panel-card"><div class="empty-state">还没有管理操作记录。</div></section>';
    return `<section class="panel-card"><div class="panel-title-row"><div><h2>最近操作</h2><p>最多显示最近 100 条记录；不会保存凭据内容。</p></div></div><div class="audit-list">${entries.map((entry) => {
      const successful = ['success', 'enabled', 'disabled', 'completed'].includes(entry.result);
      const resultLabel = entry.result === 'enabled' ? '已开启' : entry.result === 'disabled' ? '已关闭' : entry.result === 'completed' ? '已完成' : entry.result === 'success' ? '完成' : '需检查';
      return `<article class="audit-item"><time>${date(entry.at)}</time><div><strong>${esc(actionLabels[entry.action] || entry.action)}</strong><small>${esc(entry.actor)} · ${esc(entry.target)}</small></div><span class="audit-outcome" data-state="${successful ? 'good' : 'bad'}">${resultLabel}</span></article>`;
    }).join('')}</div></section>`;
  }

  function render() {
    const [pageTitle, pageDescription] = viewTitles[state.view];
    title.textContent = pageTitle;
    description.textContent = pageDescription;
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === state.view));
    if (state.view === 'overview') root.innerHTML = renderOverview();
    if (state.view === 'services') root.innerHTML = renderServices();
    if (state.view === 'monitoring') root.innerHTML = renderMonitoring();
    if (state.view === 'diagnostics') root.innerHTML = renderDiagnostics();
    if (state.view === 'database') root.innerHTML = renderDatabase();
    if (state.view === 'secrets') root.innerHTML = renderSecrets();
    if (state.view === 'audit') root.innerHTML = renderAudit();
    document.getElementById('ownerIdentity').textContent = '已通过安全验证';
  }

  async function switchView(view) {
    if (!viewTitles[view]) return;
    state.view = view;
    await refreshCurrent();
  }

  async function action(path, body, successMessage, refresh = true) {
    try {
      state.busy = true;
      const result = await api(path, { method: 'POST', body });
      showFlash(typeof successMessage === 'function' ? successMessage(result) : successMessage, 'success');
      state.busy = false;
      if (refresh) await refreshCurrent();
      return result;
    } catch (error) {
      state.busy = false;
      showFlash(error.message, 'error');
      throw error;
    }
  }

  async function saveSecret(form) {
    const secretId = form.dataset.secretForm;
    const input = form.querySelector('[data-secret-input]');
    let value = input?.value || '';
    if (secretId === 'fcm-service-account') {
      const file = form.querySelector('[data-secret-file]')?.files?.[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        showFlash('JSON 文件不能超过 1 MB。', 'error');
        return;
      }
      value = await file.text();
    }
    if (!value) return;
    const buttons = form.querySelectorAll('button, input');
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await action(`/api/secrets/${encodeURIComponent(secretId)}`, { value }, '凭据已安全写入并应用。');
      if (input) input.value = '';
      const fileInput = form.querySelector('[data-secret-file]');
      if (fileInput) fileInput.value = '';
    } catch {
      if (input) input.value = '';
      const fileInput = form.querySelector('[data-secret-file]');
      if (fileInput) fileInput.value = '';
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  document.addEventListener('click', async (event) => {
    const nav = event.target.closest('[data-view]');
    if (nav && nav.matches('.nav-item, [data-action="navigate"]')) {
      event.preventDefault();
      await switchView(nav.dataset.view);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button || state.busy) return;
    const actionName = button.dataset.action;
    if (actionName === 'restart') {
      const service = button.dataset.service;
      if (!window.confirm(`确认重启 ${serviceLabels[service]?.[0] || service}？`)) return;
      await action(`/api/services/${encodeURIComponent(service)}/restart`, {}, '服务已重启。');
    } else if (actionName === 'backup') {
      await action('/api/database/backups', {}, '数据库备份已创建。');
    } else if (actionName === 'migrate') {
      if (!window.confirm('应用已审核过的 Accounts 数据库迁移？')) return;
      await action('/api/database/migrate', {}, (result) => `迁移完成：${result.applied} 项。`);
    } else if (actionName === 'restore') {
      const id = button.dataset.backup;
      const confirmation = window.prompt(`恢复会覆盖当前数据库。系统会先创建安全备份。\n\n请输入以下文字确认：\nRESTORE ${id}`);
      if (!confirmation) return;
      await action('/api/database/restore', { backupId: id, confirmation }, (result) => `数据库已恢复；恢复前安全备份：${result.safetyBackup}`);
    } else if (actionName === 'rotate-db-password') {
      if (!window.confirm('生成新密码并轮换 Accounts 数据库应用账号？服务会短暂重启；检查失败时会自动回滚。')) return;
      await action('/api/database/password-rotation', {}, '数据库密码已轮换，服务健康检查通过。');
    } else if (actionName === 'run-diagnostics') {
      try {
        const result = await action('/api/diagnostics/run', {}, '中心服务检查已完成。', false);
        state.diagnostics = result;
        await refreshCurrent();
      } catch {
        // The shared action handler already presents a safe error message.
      }
    } else if (actionName === 'test-asr') {
      const file = document.getElementById('asrTestAudio')?.files?.[0];
      if (!file || file.size > 650000) { showFlash(errorMessages.ASR_TEST_AUDIO_INVALID, 'error'); return; }
      if (!window.confirm('音频将发送给 OpenAI，可能产生费用。继续测试？')) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      try {
        state.asrTest = await action('/api/diagnostics/asr-transcription', { confirmed: true, audioBase64: btoa(binary) }, '供应商已返回转写结果。', false);
        await refreshCurrent();
      } catch { /* The action handler presents the error. */ }
    }
  });

  document.addEventListener('submit', async (event) => {
    const asrForm = event.target.closest('[data-asr-settings]');
    if (asrForm) {
      event.preventDefault();
      if (state.busy || !asrForm.reportValidity()) return;
      if (!window.confirm('保存设置并短暂重启 Accounts 服务？')) return;
      const fields = new FormData(asrForm);
      const data = Object.fromEntries(['freeMinutes', 'plusMinutes', 'proMinutes', 'timeoutMs'].map((name) => [name, Number(fields.get(name))]));
      try { await action('/api/asr/settings', data, '语音设置已更新。'); } catch { /* The action handler presents the error. */ }
      return;
    }
    const form = event.target.closest('[data-secret-form]');
    if (!form) return;
    event.preventDefault();
    await saveSecret(form);
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id !== 'asrSwitch') return;
    const enabled = event.target.checked;
    if (enabled && !document.getElementById('asrReview')?.checked) {
      event.target.checked = false;
      showFlash('请先确认已检查数据控制和隐私说明。', 'error');
      return;
    }
    if (!window.confirm(enabled ? '开启云端语音识别？用户发送的录音会转发给 OpenAI 进行转写。' : '关闭云端语音识别？用户将不能选择云端转写。')) {
      event.target.checked = !enabled;
      return;
    }
    await action('/api/asr', { enabled, reviewed: enabled }, enabled ? '云端语音识别已开启。' : '云端语音识别已关闭。');
  });

  document.getElementById('refreshButton').addEventListener('click', () => void refreshCurrent());
  window.setInterval(() => {
    if (document.visibilityState === 'visible' && ['overview', 'services', 'monitoring'].includes(state.view)) {
      void refreshCurrent({ quiet: true });
    }
  }, 60_000);
  void refreshCurrent();
})();
