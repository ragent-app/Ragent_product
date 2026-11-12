(() => {
  const languages = {'en':'English','zh-CN':'简体中文','zh-TW':'繁體中文','ja':'日本語','ko':'한국어','fr':'Français','es':'Español'};
  const initial = () => {
    try { const saved = localStorage.getItem('agentoc-site-language'); if (languages[saved]) return saved; } catch (_) {}
    const tag = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase();
    if (tag.startsWith('zh')) return /tw|hk|mo|hant/.test(tag) ? 'zh-TW' : 'zh-CN';
    return languages[tag.split('-')[0]] ? tag.split('-')[0] : 'en';
  };
  let current = initial(), dictionary = {};
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
  const translate = text => (current === 'en' ? text : dictionary[current]?.[text] || text);
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
  menu.addEventListener('click', event => { const option = event.target.closest('button[data-language]'); if (!option) return; current = option.dataset.language; try { localStorage.setItem('agentoc-site-language', current); } catch (_) {} closeMenu(); apply(); button.focus(); });
  label.textContent = languages[current];
  fetch('translations.json?v=crossplatform-20261113').then(response => { if (!response.ok) throw Error('translation unavailable'); return response.json(); }).then(data => { dictionary = data; apply(); }).catch(() => { document.documentElement.lang = 'en'; });
})();
