(() => {
  const languages = {'en':'English','zh-CN':'简体中文','zh-TW':'繁體中文','ja':'日本語','ko':'한국어','fr':'Français','es':'Español'};
  const initial = () => {
    try { const saved = localStorage.getItem('ragent-site-language'); if (languages[saved]) return saved; } catch (_) {}
    const tag = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase();
    if (tag.startsWith('zh')) return /tw|hk|mo|hant/.test(tag) ? 'zh-TW' : 'zh-CN';
    return languages[tag.split('-')[0]] ? tag.split('-')[0] : 'en';
  };
  let current = initial(), dictionary = {};
  const linuxTranslations = {
    'zh-CN': {'Linux package targets.': 'Linux 软件包目标。', 'Candidate targets have not completed release validation. Automatic updates are enabled only for targets validated for that release.': '候选目标尚未完成发布验证。自动更新仅针对该版本已验证的目标启用。', 'Installation compatibility verified': '安装兼容验收通过', 'Candidate — validation pending': '候选版本，等待验证', 'Requires systemd and glibc 2.34 or later. See the Linux target status below for supported distribution versions.': '需要 systemd 和 glibc 2.34 或更高版本。发行版版本支持情况见下方 Linux 目标状态。'},
    'zh-TW': {'Linux package targets.': 'Linux 套件目標。', 'Candidate targets have not completed release validation. Automatic updates are enabled only for targets validated for that release.': '候選目標尚未完成發行驗證。自動更新僅針對該版本已驗證的目標啟用。', 'Installation compatibility verified': '安裝相容驗收通過', 'Candidate — validation pending': '候選版本，等待驗證', 'Requires systemd and glibc 2.34 or later. See the Linux target status below for supported distribution versions.': '需要 systemd 和 glibc 2.34 或更新版本。發行版版本支援情況見下方 Linux 目標狀態。'},
  };
  const originals = new WeakMap();
  const pageTitle = document.title;
  const description = document.querySelector('meta[name="description"]');
  const pageDescription = description?.content;
  const nav = document.querySelector('.nav');
  const control = document.createElement('div'); control.className = 'language-control';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'language-button'; button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'language-list');
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.4 3.7 5.4 3.7 9s-1.2 6.6-3.7 9c-2.5-2.4-3.7-5.4-3.7-9S9.5 5.4 12 3Z"/></svg><span></span><svg class="language-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3"/></svg>';
  const label = button.querySelector('span');
  const menu = document.createElement('div'); menu.id = 'language-list'; menu.className = 'language-list'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  for (const [value, name] of Object.entries(languages)) { const option = document.createElement('button'); option.type = 'button'; option.className = 'language-option'; option.setAttribute('role', 'menuitemradio'); option.dataset.language = value; option.textContent = name; menu.append(option); }
  control.append(button, menu); nav.insertBefore(control, nav.querySelector('.menu-toggle'));
  function closeMenu() { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  function openMenu(focus = false) { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); if (focus) (menu.querySelector('[aria-checked="true"]') || menu.firstElementChild).focus(); }
  button.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
  button.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(true); } });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); button.focus(); return; }
    const options = [...menu.querySelectorAll('button')], index = options.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus(); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); options[event.key === 'Home' ? 0 : options.length - 1].focus(); }
  });
  document.addEventListener('click', event => { if (!control.contains(event.target)) closeMenu(); });
  const legacyPackageMessage = 'The new shared package is not published yet; an Ubuntu 24.04 package is available above.';
  linuxTranslations['zh-CN'][legacyPackageMessage] = '新的通用软件包尚未发布；上方提供 Ubuntu 24.04 软件包。';
  linuxTranslations['zh-TW'][legacyPackageMessage] = '新的共用套件尚未發行；上方提供 Ubuntu 24.04 套件。';
  const compatibilityMessage = 'Compatibility target only; automatic updates are not available.';
  linuxTranslations['zh-CN'][compatibilityMessage] = '仅作兼容性验证目标；暂不支持自动更新。';
  linuxTranslations['zh-TW'][compatibilityMessage] = '僅作相容性驗證目標；暫不支援自動更新。';
  const validationMessage = 'Candidate targets have not completed release validation. Automatic updates require both support and validation for that release.';
  linuxTranslations['zh-CN'][validationMessage] = '候选目标尚未完成发布验证。自动更新需要支持该目标且该版本已完成验证。';
  linuxTranslations['zh-TW'][validationMessage] = '候選目標尚未完成發行驗證。自動更新需要支援該目標且該版本已完成驗證。';
  const linuxBriefTranslations = {
    'zh-CN': ['Ubuntu 22.04、24.04、26.04 和 Debian 12、13。需要 systemd 和 glibc 2.34 或更高版本。', 'Linux 验收详情 ↗', 'Rocky Linux 9.8：安装兼容验收通过。', 'Rocky Linux 9.8：等待验收。', 'RHEL 9：安装兼容验收通过。', 'RHEL 9：尚未验收。'],
    'zh-TW': ['Ubuntu 22.04、24.04、26.04 和 Debian 12、13。需要 systemd 和 glibc 2.34 或更新版本。', 'Linux 驗收詳情 ↗', 'Rocky Linux 9.8：安裝相容驗收通過。', 'Rocky Linux 9.8：等待驗收。', 'RHEL 9：安裝相容驗收通過。', 'RHEL 9：尚未驗收。'],
    ja: ['Ubuntu 22.04、24.04、26.04 および Debian 12、13。systemd と glibc 2.34 以降が必要です。', 'Linux の検証詳細 ↗', 'Rocky Linux 9.8：インストール互換性を検証済み。', 'Rocky Linux 9.8：検証待ち。', 'RHEL 9：インストール互換性を検証済み。', 'RHEL 9：未検証。'],
    ko: ['Ubuntu 22.04, 24.04, 26.04 및 Debian 12, 13. systemd와 glibc 2.34 이상이 필요합니다.', 'Linux 검증 상세 ↗', 'Rocky Linux 9.8: 설치 호환성 검증 완료.', 'Rocky Linux 9.8: 검증 대기 중.', 'RHEL 9: 설치 호환성 검증 완료.', 'RHEL 9: 아직 검증되지 않음.'],
    fr: ['Ubuntu 22.04, 24.04, 26.04 et Debian 12, 13. Nécessite systemd et glibc 2.34 ou version ultérieure.', 'Détails de validation Linux ↗', 'Rocky Linux 9.8 : compatibilité d’installation vérifiée.', 'Rocky Linux 9.8 : validation en attente.', 'RHEL 9 : compatibilité d’installation vérifiée.', 'RHEL 9 : validation en attente.'],
    es: ['Ubuntu 22.04, 24.04, 26.04 y Debian 12, 13. Requiere systemd y glibc 2.34 o posterior.', 'Detalles de validación de Linux ↗', 'Rocky Linux 9.8: compatibilidad de instalación verificada.', 'Rocky Linux 9.8: validación pendiente.', 'RHEL 9: compatibilidad de instalación verificada.', 'RHEL 9: validación pendiente.'],
  };
  const linuxBriefKeys = ['Ubuntu 22.04, 24.04, 26.04 and Debian 12, 13. Requires systemd and glibc 2.34 or later.', 'Linux validation details ↗', 'Rocky Linux 9.8: installation compatibility verified.', 'Rocky Linux 9.8: validation pending.', 'RHEL 9: installation compatibility verified.', 'RHEL 9: validation pending.'];
  const translate = text => (current === 'en' ? text : linuxBriefTranslations[current]?.[linuxBriefKeys.indexOf(text)] || linuxTranslations[current]?.[text] || dictionary[current]?.[text] || text);
  window.siteT = translate;
  function apply() {
    document.documentElement.lang = current;
    document.title = translate(pageTitle);
    if (description) description.content = translate(pageDescription);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (node.parentElement.closest('script,style,.language-control,#download-grid,#release-history,#download-status')) continue;
      if (!originals.has(node)) originals.set(node, node.nodeValue);
      const original = originals.get(node), trimmed = original.trim();
      if (trimmed) node.nodeValue = original.replace(trimmed, translate(trimmed));
    }
    document.querySelectorAll('[alt],[aria-label]').forEach(node => {
      if (node.closest('.language-control')) return;
      for (const name of ['alt','aria-label']) if (node.hasAttribute(name)) {
        const key = 'original' + name.replace('-','');
        if (!node.dataset[key]) node.dataset[key] = node.getAttribute(name);
        node.setAttribute(name, translate(node.dataset[key]));
      }
    });
    label.textContent = languages[current];
    button.setAttribute('aria-label', `${translate('Choose language')}: ${languages[current]}`);
    menu.setAttribute('aria-label', translate('Choose language'));
    menu.querySelectorAll('button').forEach(option => option.setAttribute('aria-checked', String(option.dataset.language === current)));
    document.dispatchEvent(new Event('site-language-change'));
  }
  menu.addEventListener('click', event => { const option = event.target.closest('button[data-language]'); if (!option) return; current = option.dataset.language; try { localStorage.setItem('ragent-site-language', current); } catch (_) {} closeMenu(); apply(); button.focus(); });
  label.textContent = languages[current];
  fetch('translations.json?v=linux-targets-20261115').then(response => { if (!response.ok) throw Error('translation unavailable'); return response.json(); }).then(data => { dictionary = data; apply(); }).catch(() => { document.documentElement.lang = 'en'; });
})();
