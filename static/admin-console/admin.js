(() => {
  'use strict';

  const viewTitles = {
    overview: ['总览', '查看中心服务、数据库与用量的健康状态。'],
    services: ['中心服务', '监控 Accounts、TURN、推送与连接服务，并执行受限重启。'],
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
    'database.password.rotate': '轮换数据库密码',
    'database.backup.create': '创建数据库备份',
    'database.restore': '恢复数据库备份',
    'database.migrations.apply': '应用数据库迁移',
    'service.restart': '重启中心服务',
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
    SERVICE_RESTART_FAILED: '配置已写入，但服务重启未成功。请检查中心服务状态。',
    MIGRATION_FAILED: '数据库迁移执行失败，服务数据未在页面中展示。',
    RESTORE_FAILED: '备份恢复失败；恢复操作使用事务，现有数据库未被部分覆盖。',
  };

  const state = { view: 'overview', overview: null, secrets: null, database: null, audit: null, busy: false };
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

  async function refreshCurrent() {
    if (state.busy) return;
    state.busy = true;
    root.innerHTML = '<div class="loading-state">正在读取服务器状态…</div>';
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
    const detail = {
      'agentoc-accounts': '账号和设备配对 API、用量汇总、服务端语音识别与推送队列。',
      'turn-credential-broker': '根据 Accounts 签发的短期能力凭据为设备提供 TURN 配置。',
      'agentoc-signaling': '转发手机和电脑之间建立 P2P 连接所需的信令。',
      'agentoc-tunnel-server': '提供 Ragent 远程连接通道，保持现有设备接入。',
    };
    return `<div class="service-grid">${Object.entries(serviceLabels).map(([id, [label]]) => {
      const service = services[id] || {};
      const healthy = service.health === undefined ? true : service.health;
      return `<article class="service-card"><div class="service-card-head"><h3>${esc(label)}</h3>${statusPill(service.active, healthy)}</div><p>${esc(detail[id])}</p><div class="service-card-foot"><small>${service.active ? `运行中${service.pid ? ` · PID ${service.pid}` : ''}` : `状态：${esc(service.state || 'unknown')}`}</small><button class="service-action" data-action="restart" data-service="${esc(id)}">重启</button></div></article>`;
    }).join('')}</div>
    <div class="security-callout mt-3"><span>i</span><div><strong>受限服务操作</strong>面板只开放固定服务清单中的重启操作，不提供 shell、systemd 任意命令或数据库任意 SQL。</div></div>`;
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
    return `<div class="section-stack">
      <div class="security-callout"><span>✓</span><div><strong>密钥只写入，不回显</strong>所有凭据通过 HTTPS 直接传入服务器；页面不读取密钥值，不将内容写入浏览器缓存或操作日志。更新后会自动重启对应服务。</div></div>
      <section class="panel-card"><div class="panel-title-row"><div><h2>云端语音识别</h2><p>由 Ragent Accounts 转发到 OpenAI Transcription API。</p></div><span class="state-pill" data-state="${asrEnabled ? 'good' : 'warn'}">${asrEnabled ? '当前开启' : '当前关闭'}</span></div>
        <div class="usage-row"><span>API key</span><strong>${keyConfigured ? '已配置' : '未配置'}</strong></div>
        <div class="switch-row"><span class="switch-label"><strong>允许云端转写</strong><small>开启后，用户的授权音频会由服务器发送给 OpenAI，识别文本回到手机草稿。</small></span><input id="asrSwitch" class="switch" type="checkbox" ${asrEnabled ? 'checked' : ''} ${!keyConfigured && !asrEnabled ? 'disabled' : ''} aria-label="开启云端语音识别"></div>
        ${!asrEnabled ? '<label class="checkbox-row"><input id="asrReview" type="checkbox"><span>我已检查 OpenAI API 数据控制，并确认当前 Ragent 隐私说明已覆盖云端转写。</span></label>' : ''}
        ${!keyConfigured ? '<p class="inline-alert">尚未配置 API key。按照当前设置，云端语音识别保持关闭。</p>' : ''}
      </section>
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
    return `<section class="panel-card"><div class="panel-title-row"><div><h2>最近操作</h2><p>最多显示最近 100 条记录；不会保存凭据内容。</p></div></div><div class="audit-list">${entries.map((entry) => `<article class="audit-item"><time>${date(entry.at)}</time><div><strong>${esc(actionLabels[entry.action] || entry.action)}</strong><small>${esc(entry.actor)} · ${esc(entry.target)}</small></div><span class="audit-outcome" data-state="${entry.result === 'success' || entry.result === 'enabled' || entry.result === 'disabled' ? 'good' : 'bad'}">${entry.result === 'success' ? '完成' : entry.result === 'enabled' ? '已开启' : entry.result === 'disabled' ? '已关闭' : '需检查'}</span></article>`).join('')}</div></section>`;
  }

  function render() {
    const [pageTitle, pageDescription] = viewTitles[state.view];
    title.textContent = pageTitle;
    description.textContent = pageDescription;
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === state.view));
    if (state.view === 'overview') root.innerHTML = renderOverview();
    if (state.view === 'services') root.innerHTML = renderServices();
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
    }
  });

  document.addEventListener('submit', async (event) => {
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
  void refreshCurrent();
})();
