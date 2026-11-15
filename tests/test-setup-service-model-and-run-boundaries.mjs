import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

const setup = read('setup.sh');
assert.match(setup, /Created: \/etc\/systemd\/system\/ragent\.service/, 'Linux setup should install the owner system service');
assert.match(setup, /sudo systemctl start ragent\.service/, 'Linux setup should start the owner system service');
assert.match(setup, /sudo systemctl enable ragent\.service/, 'Linux setup should enable the owner system service');
assert.doesNotMatch(setup, /Created: ~\/\.config\/systemd\/user\/ragent-chat\.service/, 'Linux setup should not install the legacy owner user service');
assert.doesNotMatch(setup, /systemctl --user start ragent-chat\.service/, 'Linux setup should not start the legacy owner user service');

const startScript = read('start.sh');
assert.match(startScript, /sudo systemctl start ragent\.service/, '`ragent start` should target the owner system service on Linux');

const stopScript = read('stop.sh');
assert.match(stopScript, /sudo systemctl stop ragent\.service/, '`ragent stop` should target the owner system service on Linux');

const readme = read('README.md');
assert.match(readme, /journalctl -u ragent\.service -n 50/, 'README troubleshooting should point Linux users at the owner system service logs');
assert.match(readme, /\/var\/log\/ragent\/chat-server\.log/, 'README should point Linux users at the system log directory');

const readmeZh = read('README.zh.md');
assert.match(readmeZh, /journalctl -u ragent\.service -n 50/, 'README.zh troubleshooting should point Linux users at the owner system service logs');
assert.match(readmeZh, /\/var\/log\/ragent\/chat-server\.log/, 'README.zh should point Linux users at the system log directory');

const agents = read('AGENTS.md');
assert.match(agents, /run-launcher\.mjs/, 'AGENTS should document the run launcher');
assert.match(agents, /run-projection\.mjs/, 'AGENTS should document the run projection layer');
assert.match(agents, /run-reconciler\.mjs/, 'AGENTS should document the run reconciler');

const architecture = read('docs/project-architecture.md');
assert.match(architecture, /chat\/run-launcher\.mjs/, 'Architecture doc should describe the run launcher');
assert.match(architecture, /chat\/run-projection\.mjs/, 'Architecture doc should describe the run projection layer');
assert.match(architecture, /chat\/run-reconciler\.mjs/, 'Architecture doc should describe the run reconciler');
assert.match(architecture, /runner-supervisor\.mjs` \(compatibility shim/i, 'Architecture doc should demote runner-supervisor to a compatibility shim');

const implementationMapping = read('notes/current/core-domain-implementation-mapping.md');
assert.match(implementationMapping, /chat\/run-launcher\.mjs/, 'Current implementation mapping should reference the run launcher');
assert.match(implementationMapping, /chat\/run-projection\.mjs/, 'Current implementation mapping should reference the run projection layer');
assert.match(implementationMapping, /chat\/run-reconciler\.mjs/, 'Current implementation mapping should reference the run reconciler');

const setupDoc = read('docs/setup.md');
assert.match(setupDoc, /ragent\.service/, 'Setup contract should name the Linux owner service explicitly');

console.log('test-setup-service-model-and-run-boundaries: ok');
