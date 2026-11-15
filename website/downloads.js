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
    if (/^ragent-.+-android-proot-ubuntu24\.04-arm64\.tar\.gz$/.test(name)) { platform = 'Android local runtime'; format = 'TAR.GZ'; }
    else if (name.endsWith('.msi') || name.endsWith('.exe')) { platform = 'Windows'; format = name.endsWith('.msi') ? 'MSI' : 'EXE'; }
    else if (name.endsWith('.dmg') || name.endsWith('.pkg')) { platform = 'macOS'; format = name.endsWith('.dmg') ? 'DMG' : 'PKG'; }
    else if (name.endsWith('.apk')) { platform = 'Android'; format = 'APK'; }
    else if (name.endsWith('.appimage') || name.endsWith('.deb') || name.endsWith('.rpm')) { platform = 'Linux'; format = name.split('.').pop().toUpperCase(); }
    else return null;
    let arch = /(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(name) ? 'ARM64' : /(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/.test(name) ? 'x64' : /(?:^|[-_.])(universal)(?:[-_.]|$)/.test(name) ? 'Universal' : null;
    if (!arch && platform !== 'Android') return null;
    if (!arch) arch = 'Universal';
    let url;
    try { url = new URL(asset.browser_download_url); } catch (_) { return null; }
    const prefix = '/' + repo + '/releases/download/';
    const parts = url.pathname.slice(prefix.length).split('/');
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix) || parts.length !== 2 || !parts[0] || parts[1] !== encodeURIComponent(asset.name) || url.search || url.hash || url.username || url.password) return null;
    const requirement = /-windows11-/.test(name) ? 'Windows 11' : /-ubuntu24\.04-/.test(name) ? 'Ubuntu 24.04' : /-rhel9-/.test(name) ? 'RHEL 9' : /-linux-/.test(name) && format === 'DEB' ? 'Ubuntu / Debian' : /-macos13plus-/.test(name) ? 'macOS 13+' : /-android8plus-/.test(name) ? 'Android 8+' : '';
    return { platform, arch, format, url: url.href, name: asset.name, requirement, digest: asset.digest };
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
        if (!release.prerelease) for (const asset of packages) { const key = `${asset.platform}/${asset.requirement}/${asset.arch}/${asset.format}`; if (!latest.has(key)) latest.set(key, { ...asset, version: release.tag_name }); }
        if (!packages.length) continue;
        const row = el('article', '', 'release');
        const description = el('div'); description.append(el('h3', release.tag_name), el('p', `${new Date(release.published_at).toLocaleDateString(document.documentElement.lang)}${release.prerelease ? ' · ' + t('Preview') : ''}`, 'release-meta'));
        const links = el('div', '', 'release-links');
        const shown = new Set();
        packages.forEach(asset => { const key = `${asset.platform}/${asset.requirement}/${asset.arch}/${asset.format}`; if (!shown.has(key)) { shown.add(key); links.append(link(`${asset.platform === 'Android local runtime' ? t('Android local runtime') : asset.requirement || asset.platform} · ${asset.arch} · ${asset.format}`, asset.url)); } });
        const releaseURL = new URL(release.html_url);
        if (releaseURL.origin === 'https://github.com' && releaseURL.pathname.startsWith('/' + repo + '/releases/tag/')) links.append(link(t('Release notes ↗'), releaseURL.href));
        row.append(description, links); history.append(row);
      }
      const preferred = [...latest.values()].sort((a, b) => {
        const priority = item => item.requirement === 'Ubuntu / Debian' ? 2 : item.requirement ? 1 : 0;
        return priority(b) - priority(a);
      });
      const seenDigests = new Set();
      const distinct = preferred.filter(item => {
        if (!/^sha256:[a-f0-9]{64}$/.test(item.digest || '')) return true;
        const aliasGroup = item.platform === 'Linux' && item.format === 'DEB' && ['Ubuntu / Debian', 'Ubuntu 24.04'].includes(item.requirement) ? 'ubuntu-debian' : item.platform === 'Windows' && ['', 'Windows 11'].includes(item.requirement) ? 'windows' : item.requirement;
        const key = `${item.platform}/${aliasGroup}/${item.arch}/${item.format}/${item.digest}`;
        if (seenDigests.has(key)) return false;
        seenDigests.add(key); return true;
      });
      for (const platform of ['Windows', 'macOS', 'Linux', 'Android', 'Android local runtime']) {
        const items = distinct.filter(a => a.platform === platform);
        if (!items.length && platform === 'Android local runtime') continue;
        if (!items.length) {
          const card = el('article', '', 'download-item'); card.append(el('h3', platform), el('p', t(platform === 'Android' ? 'The Android app is currently in closed testing.' : 'No public package is available yet.')), el('span', t('Not available'), 'unavailable')); grid.append(card);
        }
        for (const asset of items) {
          const card = el('article', '', 'download-item');
          if (platform === 'Android local runtime') {
            card.append(el('h3', t('Android local runtime · ARM64')),
              el('p', `${asset.version} · ${asset.format}`),
              el('p', t('Requires an ARM64 Android device, Termux, proot-distro and Ubuntu 24.04. This is a service archive, not an Android app or Linux desktop installer.')),
              el('p', t('Start Ragent in Termux before connecting the Android app. Android may suspend the service in the background.')),
              link(`${t('Download')} ${asset.format} ↓`, asset.url, 'button'),
              link(t('Installation instructions ↗'), `https://github.com/${repo}/blob/main/docs/android-proot.md`));
          } else {
            card.append(el('h3', `${asset.requirement || platform} · ${t(asset.arch)}`), el('p', `${asset.version} · ${asset.format}`), link(`${t('Download')} ${asset.format} ↓`, asset.url, 'button'));
            if (asset.requirement === 'Ubuntu / Debian') {
              card.append(el('p', t('Ubuntu 22.04, 24.04, 26.04 and Debian 12, 13. Requires systemd and glibc 2.34 or later.')),
                link(t('Linux validation details ↗'), `https://github.com/${repo}/blob/main/docs/linux-release-acceptance.md`));
            }
            if (asset.requirement === 'RHEL 9' && asset.format === 'RPM') {
              const release = releases.find(item => item.tag_name === asset.version && !item.prerelease);
              const verified = (id) => Boolean(release && /^sha256:[a-f0-9]{64}$/.test(asset.digest || '') && String(release.body || '').includes(`<!-- ragent-linux-validated:${asset.name}:${id}:9:x64:${asset.digest} -->`));
              card.append(el('p', `${t(verified('rocky') ? 'Rocky Linux 9.8: installation compatibility verified.' : 'Rocky Linux 9.8: validation pending.')} ${t(verified('rhel') ? 'RHEL 9: installation compatibility verified.' : 'RHEL 9: validation pending.')}`),
                link(t('Linux validation details ↗'), `https://github.com/${repo}/blob/main/docs/linux-release-acceptance.md`));
            }
            if (platform === 'Android') card.append(el('p', t('The GitHub APK is signed separately from the Google Play build. Uninstall the other version before switching.')));
          }
          grid.append(card);
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
