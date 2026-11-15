#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const chatTemplateSource = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function createElement(tagName = 'div') {
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    href: '',
    target: '',
    rel: '',
    src: '',
    alt: '',
    loading: '',
    controls: false,
    preload: '',
    muted: false,
    playsInline: false,
    dataset: {},
    children: [],
    classList: {
      add(token) {
        this.owner.className = [this.owner.className, token].filter(Boolean).join(' ');
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] || null;
    },
  };
  element.classList.owner = element;
  return element;
}

const context = {
  console,
  document: {
    createElement,
  },
  resolveUiProductPath(path) {
    return typeof path === 'string' ? path : String(path || '');
  },
  renderUiIcon(name) {
    return `<svg data-icon="${name}"></svg>`;
  },
  window: {
    open() {},
    RagentBackHandler: {
      push() { return 'image-viewer'; },
      pop() {},
    },
    RagentIcons: {
      render(name) {
        return `<svg data-icon="${name}"></svg>`;
      },
    },
  },
};
context.globalThis = context;

function collectNodeText(node) {
  if (!node || typeof node !== 'object') return '';
  return [
    node.textContent || '',
    node.innerHTML || '',
    ...(Array.isArray(node.children) ? node.children.map(collectNodeText) : []),
  ].join(' ');
}

const functionsToLoad = [
  'getAttachmentArtifactFileId',
  'getAttachmentDisplayName',
  'getAttachmentKind',
  'getAttachmentSource',
  'getAttachmentDownloadSource',
  'getAttachmentTypeLabel',
  'normalizeAttachmentSizeBytes',
  'formatAttachmentSize',
  'shouldRenderAttachmentAsFileCard',
  'createAttachmentFileNode',
  'createMessageAttachmentNode',
  'createDeliveryImagePreviewNode',
  'createAttachmentDeliveryCard',
  'createComposerAttachmentPreviewNode',
];

vm.runInNewContext(
  [
    ...functionsToLoad.map((name) => extractFunctionSource(uiSource, name)),
    'globalThis.createMessageAttachmentNode = createMessageAttachmentNode;',
    'globalThis.createAttachmentDeliveryCard = createAttachmentDeliveryCard;',
    'globalThis.createComposerAttachmentPreviewNode = createComposerAttachmentPreviewNode;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

assert.match(
  chatTemplateSource,
  /id="imgFileInput"[^>]*accept="\*\/\*"/,
  'chat attachment picker should accept all file types',
);
assert.doesNotMatch(
  chatTemplateSource,
  /id="imgFileInput"[^>]*accept="image\/\*,video\/\*"/,
  'chat attachment picker should no longer be limited to images and videos',
);

const genericMessageNode = context.createMessageAttachmentNode({
  filename: 'stored-report.csv',
  originalName: 'report.csv',
  mimeType: 'text/csv',
  sizeBytes: 2048,
});
assert.equal(genericMessageNode.tagName, 'DIV', 'generic message attachments should render as attachment rows');
assert.ok(genericMessageNode.className.includes('attachment-card'), 'generic message attachments should render as file cards');
assert.equal(genericMessageNode.children.length, 2, 'generic file card should include file details and a download action');
assert.equal(genericMessageNode.children[0].className, 'attachment-file', 'generic file card should reuse the attachment file shell');
assert.equal(genericMessageNode.children[0].children[1].children[0].textContent, 'report.csv', 'generic file card should show the original file name');
assert.equal(genericMessageNode.children[0].children[1].children[1].textContent, 'CSV · 2 KB', 'generic file card should show file type and size');
assert.match(genericMessageNode.children[0].children[0].innerHTML, /data-icon="file-download"/, 'generic file card should use the modern file-download icon');
assert.equal(genericMessageNode.children[1].tagName, 'A', 'generic file card should include a download link');
assert.equal(genericMessageNode.children[1].href, '/api/media/stored-report.csv', 'generic message attachment should point at the media route');
assert.equal(genericMessageNode.children[1].download, 'report.csv', 'generic message attachment should preserve the download filename');
assert.match(genericMessageNode.children[1].className, /attachment-download-btn--icon/, 'generic file card should use the modern icon-only download action');
assert.match(genericMessageNode.children[1].innerHTML, /data-icon="download"/, 'generic file card should render the download icon');

const resultAssetNode = context.createMessageAttachmentNode({
  assetId: 'fasset_result_video',
  originalName: 'rough cut.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 4096,
  renderAs: 'file',
});
assert.equal(resultAssetNode.tagName, 'DIV', 'result file assets should render as attachment rows');
assert.equal(resultAssetNode.children[0].children[1].children[0].textContent, 'rough cut.mp4', 'result attachment row should show the exported file name');
assert.equal(resultAssetNode.children[0].children[1].children[1].textContent, 'MP4 · 4 KB', 'result attachment row should show file size metadata');
assert.equal(resultAssetNode.children[1].href, '/api/assets/fasset_result_video/download?download=1', 'result attachment row should request an explicit download for file assets');

const sharedAssetNode = context.createMessageAttachmentNode({
  assetId: 'asset_shared_attachment',
  url: 'share-asset/snap_demo/asset_shared_attachment',
  originalName: 'shared-report.csv',
  mimeType: 'text/csv',
  sizeBytes: 1024,
  renderAs: 'file',
});
assert.equal(sharedAssetNode.tagName, 'DIV', 'shared snapshot file attachments should render as attachment rows');
assert.equal(sharedAssetNode.children[1].href, 'share-asset/snap_demo/asset_shared_attachment?download=1', 'shared snapshot file downloads should stay on the public share asset route');

const singleDeliveryRow = context.createAttachmentDeliveryCard(
  { type: 'attachment_delivery', content: 'Generated files ready to download.' },
  [
    {
      assetId: 'fasset_result_video',
      originalName: 'rough cut.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
    },
  ],
);
assert.equal(singleDeliveryRow.tagName, 'SECTION', 'a single attachment delivery should use the shared delivery group shell');
assert.match(singleDeliveryRow.className, /artifact-group/, 'a single attachment delivery should expose one artifact group');
assert.equal(singleDeliveryRow.children.length, 1, 'a single attachment delivery should contain one file list');
assert.match(singleDeliveryRow.children[0].className, /delivery-card-files/, 'a single attachment delivery should use the shared file list shell');
assert.equal(singleDeliveryRow.children[0].children.length, 1, 'a single attachment delivery should contain one file row');
assert.match(singleDeliveryRow.children[0].children[0].className, /attachment-card/, 'a single attachment delivery should keep the file-row semantics');

const deliveryCard = context.createAttachmentDeliveryCard(
  { type: 'attachment_delivery', content: 'Generated files ready to download.' },
  [
    {
      assetId: 'fasset_result_video',
      originalName: 'rough cut.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
    },
    {
      assetId: 'fasset_result_csv',
      originalName: 'summary.csv',
      mimeType: 'text/csv',
      sizeBytes: 2048,
    },
  ],
);
assert.equal(deliveryCard.tagName, 'SECTION', 'multiple attachment deliveries should render one semantic group');
assert.match(deliveryCard.className, /artifact-group/, 'multiple attachment deliveries should expose one artifact group');
assert.equal(deliveryCard.children.length, 1, 'delivery card should only contain the file list');
assert.match(deliveryCard.children[0].className, /delivery-card-files/, 'delivery card should render file rows directly');
assert.match(deliveryCard.children[0].className, /artifact-group-list/, 'delivery card should expose the shared artifact group list semantics');
assert.equal(deliveryCard.children[0].children.length, 2, 'delivery group should contain multiple transparent file rows');
assert.equal(
  deliveryCard.children[0].children[0].className.includes('delivery-card-file'),
  true,
  'delivery file row should keep delivery-card-file styling',
);
assert.match(deliveryCard.children[0].children[0].className, /artifact-row/, 'delivery file rows should share the artifact row contract');
assert.doesNotMatch(
  collectNodeText(deliveryCard),
  /Delivery|Output ready|Generated files ready to download|产物|结果文件/u,
  'delivery card should not render labels, ready titles, summaries, or event copy',
);

const mixedDeliveryCard = context.createAttachmentDeliveryCard(
  { type: 'attachment_delivery', content: 'Generated files ready to download.' },
  [
    {
      assetId: 'fasset_result_csv',
      originalName: 'summary.csv',
      mimeType: 'text/csv',
      sizeBytes: 2048,
    },
    {
      assetId: 'fasset_preview_png',
      originalName: 'shot.png',
      mimeType: 'image/png',
    },
  ],
);
assert.equal(mixedDeliveryCard.children.length, 2, 'mixed deliveries should keep files above the image preview strip');
assert.match(mixedDeliveryCard.children[0].className, /delivery-card-files/, 'mixed deliveries should keep non-image files in the artifact card');
assert.match(mixedDeliveryCard.children[1].className, /delivery-card-images/, 'mixed deliveries should place image previews below file rows');
assert.equal(mixedDeliveryCard.children[1].children.length, 1, 'mixed image previews should render as one horizontal preview tile');
assert.equal(mixedDeliveryCard.children[1].children[0].children[0].tagName, 'IMG', 'delivery image preview should render a direct image');
assert.match(mixedDeliveryCard.children[1].children[0].children[1].className, /delivery-image-download/, 'delivery image preview should expose an overlay download action');
assert.equal(mixedDeliveryCard.children[1].children[0].children[1].download, 'shot.png', 'delivery image download should preserve the filename');

const imageAssetNode = context.createMessageAttachmentNode({
  assetId: 'fasset_preview_png',
  originalName: 'shot.png',
  mimeType: 'image/png',
});
assert.equal(imageAssetNode.tagName, 'IMG', 'image file assets should still render inline previews');
assert.equal(imageAssetNode.src, '/api/assets/fasset_preview_png/download', 'image previews should keep the plain asset route');

const sharedImageNode = context.createMessageAttachmentNode({
  assetId: 'asset_shared_image',
  url: 'share-asset/snap_demo/asset_shared_image',
  originalName: 'share-shot.png',
  mimeType: 'image/png',
});
assert.equal(sharedImageNode.tagName, 'IMG', 'shared snapshot images should still render inline previews');
assert.equal(sharedImageNode.src, 'share-asset/snap_demo/asset_shared_image', 'shared snapshot image previews should use the public share asset route');

const genericComposerPreview = context.createComposerAttachmentPreviewNode({
  objectUrl: 'blob:report',
  originalName: 'report.csv',
  mimeType: 'text/csv',
});
assert.equal(genericComposerPreview.tagName, 'DIV', 'generic composer attachments should render as preview cards');
assert.ok(genericComposerPreview.className.includes('attachment-file-compact'), 'generic composer attachments should use the compact file preview card');

const imageComposerPreview = context.createComposerAttachmentPreviewNode({
  objectUrl: 'blob:image',
  originalName: 'shot.png',
  mimeType: 'image/png',
});
assert.equal(imageComposerPreview.tagName, 'IMG', 'image composer attachments should still render as image previews');

const audioMessageNode = context.createMessageAttachmentNode({
  filename: 'voice.wav',
  originalName: 'voice.wav',
  mimeType: 'audio/wav',
});
assert.equal(audioMessageNode.tagName, 'AUDIO', 'audio message attachments should keep native audio controls');

console.log('test-chat-attachment-rendering: ok');
