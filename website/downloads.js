(() => {
  const repo = 'ragent-app/Ragent_product';
  const status = document.getElementById('download-status');
  const grid = document.getElementById('download-grid');
  const history = document.getElementById('release-history');
  if (!status || !grid || !history) return;
  const t = text => window.siteT ? window.siteT(text) : text;
  let cached = null;
  let pending = null;
  let renderGeneration = 0;

  function classify(asset) {
    const name = asset.name.toLowerCase();
    let platform, format;
    if (name.endsWith('.msi') || name.endsWith('.exe')) { platform = 'Windows'; format = name.endsWith('.msi') ? 'MSI' : 'EXE'; }
    else if (name.endsWith('.dmg') || name.endsWith('.pkg')) { platform = 'macOS'; format = name.endsWith('.dmg') ? 'DMG' : 'PKG'; }
    else if (name.endsWith('.apk')) { platform = 'Android'; format = 'APK'; }
    else if (name.endsWith('.appimage') || name.endsWith('.deb') || name.endsWith('.rpm')) { platform = 'Linux'; format = name.split('.').pop().toUpperCase(); }
    else return null;
    let arch = /(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(name) ? 'ARM64' : /(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/.test(name) ? 'x64' : /(?:^|[-_.])(universal)(?:[-_.]|$)/.test(name) ? 'Universal' : null;
    if (!arch && platform !== 'Android') return null;
    if (!arch) arch = 'Android';
    let url;
    try { url = new URL(asset.browser_download_url); } catch (_) { return null; }
    const prefix = '/' + repo + '/releases/download/';
    const parts = url.pathname.slice(prefix.length).split('/');
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix) || parts.length !== 2 || !parts[0] || parts[1] !== encodeURIComponent(asset.name) || url.search || url.hash || url.username || url.password) return null;
    const requirement = /-windows11-/.test(name) ? 'Windows 11' : /-ubuntu24\.04-/.test(name) ? 'Ubuntu 24.04' : /-macos13plus-/.test(name) ? 'macOS 13+' : '';
    return { platform, arch, format, url: url.href, name: asset.name, requirement };
  }
  function el(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
  function link(text, url, className) { const node = el('a', text, className); node.href = url; return node; }
  async function load() {
    const generation = ++renderGeneration;
    status.textContent = t('Checking available releases…'); grid.replaceChildren(); history.replaceChildren();
    try {
      if (!cached && !pending) pending = (async () => {
        const result = [];
        for (let page = 1; ; page++) {
          const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers: { Accept: 'application/vnd.github+json' } });
          if (!response.ok) throw new Error('GitHub unavailable');
          const batch = await response.json();
          if (!Array.isArray(batch)) throw new Error('Invalid release response');
          result.push(...batch.filter(r => !r.draft));
          if (batch.length < 100) break;
        }
        return result;
      })().finally(() => { pending = null; });
      const releases = cached || await pending;
      cached = releases;
      if (generation !== renderGeneration) return;
      releases.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
      const latest = new Map();
      for (const release of releases) {
        const packages = (release.assets || []).map(classify).filter(Boolean).sort((a, b) => Number(Boolean(b.requirement)) - Number(Boolean(a.requirement)));
        if (!release.prerelease) for (const asset of packages) { const key = `${asset.platform}/${asset.arch}/${asset.format}`; if (!latest.has(key)) latest.set(key, { ...asset, version: release.tag_name }); }
        if (!packages.length) continue;
        const row = el('article', '', 'release');
        const description = el('div'); description.append(el('h3', release.tag_name), el('p', `${new Date(release.published_at).toLocaleDateString(document.documentElement.lang)}${release.prerelease ? ' · ' + t('Preview') : ''}`, 'release-meta'));
        const links = el('div', '', 'release-links');
        const shown = new Set();
        packages.forEach(asset => { const key = `${asset.platform}/${asset.arch}/${asset.format}`; if (!shown.has(key)) { shown.add(key); links.append(link(`${asset.requirement || asset.platform} · ${asset.arch} · ${asset.format}`, asset.url)); } });
        const releaseURL = new URL(release.html_url);
        if (releaseURL.origin === 'https://github.com' && releaseURL.pathname.startsWith('/' + repo + '/releases/tag/')) links.append(link(t('Release notes ↗'), releaseURL.href));
        row.append(description, links); history.append(row);
      }
      for (const platform of ['Windows', 'macOS', 'Linux', 'Android']) {
        const items = [...latest.values()].filter(a => a.platform === platform);
        if (!items.length) {
          const card = el('article', '', 'download-item'); card.append(el('h3', platform), el('p', t(platform === 'Android' ? 'The Android app is currently in closed testing.' : 'No public package is available yet.')), el('span', t('Not available'), 'unavailable')); grid.append(card);
        }
        for (const asset of items) {
          const card = el('article', '', 'download-item'); card.append(el('h3', `${asset.requirement || platform} · ${t(asset.arch)}`), el('p', `${asset.version} · ${asset.format}`), link(`${t('Download')} ${asset.format} ↓`, asset.url, 'button')); grid.append(card);
        }
      }
      status.textContent = releases.length ? '' : t('No published releases are available yet.');
      if (!history.children.length) history.append(el('p', t('No downloadable packages are available yet.')));
    } catch (_) {
      if (generation !== renderGeneration) return;
      status.replaceChildren(document.createTextNode(t('Could not load releases from GitHub. ') + ' '));
      const retry = el('button', t('Try again'), 'retry'); retry.type = 'button'; retry.addEventListener('click', load); status.append(retry);
    }
  }
  document.addEventListener('site-language-change', load);
  load();
})();
