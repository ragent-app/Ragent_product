import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(repositoryRoot, 'packaging', 'windows', 'ragent-installer-embedded-ui.cpp'),
  'utf8',
);
const initializeStart = source.indexOf('extern "C" __declspec(dllexport) UINT __stdcall InitializeEmbeddedUI');
assert.notEqual(initializeStart, -1, 'embedded UI initialization entrypoint exists');
assert.match(source, /message == INSTALLMESSAGE_FILESINUSE\s*\|\|\s*message == INSTALLMESSAGE_RMFILESINUSE\) return IDIGNORE/,
  'interactive MSI must not automatically shut down other applications when files are in use');
const initialize = source.slice(initializeStart);
assert.match(initialize, /MsiQueryProductStateW\(productCode\) == INSTALLSTATE_DEFAULT[\s\S]*?RAGENT_INPLACE_UPDATE[\s\S]*?_wcsicmp\(remove, L"ALL"\)/,
  'the update UI is enabled only for a supported installed product and leaves explicit uninstall to MSI');
assert.match(initialize, /g\.minorUpdate[\s\S]*?MsiSetPropertyW\(install, L"REINSTALL", L"ALL"\)/,
  'only a same-product update enters the existing MSI reinstall transaction');
assert.match(source, /MsiEnumRelatedProductsW[\s\S]*?if \(!product\.empty\(\)\) return false/,
  'major-update discovery rejects ambiguous registered products');
assert.match(initialize, /FindRelatedInstallation\(install, previousProduct\)[\s\S]*?FindInstalledFolder\(install, g\.minorUpdate \? productCode : previousProduct\.c_str\(\)/,
  'the major-update UI resolves the predecessor installation path from MSI registration');
assert.match(source, /if \(g\.updating\) SubmitInstall\(\); else \{ SetPage\(Page::Location\)/,
  'an update does not ask the user to select a new installation folder');
assert.match(source, /gCancelRequested\.load\(\) && \(gInstallResult\.load\(\) == 2 \|\| gInstallResult\.load\(\) == ERROR_INSTALL_USEREXIT\)\) SetPage\(Page::Cancelled\)/,
  'a confirmed cancellation is presented as cancelled rather than an installation error');
assert.match(source, /MsiRecordGetInteger\(record, 1\) == 1722\s*&& CopyRecordField\(record, 2\) == L"ManagedFreshGuard"[\s\S]*?Setup could not validate the selected folder or retained installation/,
  'a fresh-install guard failure explains the folder or retained-installation issue instead of showing only 1722');
assert.match(initialize, /g\.installPath\.clear\(\)/, 'no install folder is prefilled before the user chooses one');
assert.match(source, /CoCreateInstance\(CLSID_FileOpenDialog[\s\S]*?FOS_PICKFOLDERS/, 'Browse uses the modern Windows shell folder picker');
assert.match(source, /SetWindowTextW\(g\.pathEdit, path\)/, 'the selected folder is copied into the custom path field');
assert.match(source, /FindRecoverySourceHint\(\)[\s\S]*?ChooseRecoverySource\(previous\)[\s\S]*?g\.recoverySource = std::move\(normalizedPrevious\)/,
  'retained data uses a recorded location or an explicitly selected previous directory');
assert.match(initialize, /MsiSetPropertyW\(install, L"RAGENT_RECOVERY_SOURCE", g\.recoverySource\.c_str\(\)\)/,
  'the recovery source is passed to the MSI transaction');

assert.match(
  initialize,
  /HANDLE initializationEvents\[\]\s*=\s*\{\s*gUiReadyEvent\s*,\s*gExitEvent\s*\};\s*DWORD wait\s*=\s*WaitForMultipleObjects\(2\s*,\s*initializationEvents/,
  'initialization waits for the window-ready signal separately from the user action',
);
assert.match(
  initialize,
  /if\s*\(wait\s*!=\s*WAIT_OBJECT_0\)\s*\{[\s\S]*?HANDLE userActionEvents\[\]\s*=\s*\{\s*gExitEvent\s*,\s*gStartEvent\s*\};\s*wait\s*=\s*WaitForMultipleObjects\(2\s*,\s*userActionEvents/,
  'a ready window remains open until the user starts or cancels setup',
);
assert.match(
  initialize,
  /if\s*\(wait\s*!=\s*WAIT_OBJECT_0\s*\+\s*1\)\s*\{[\s\S]*?UINT propertyResult\s*=\s*MsiSetPropertyW/,
  'the MSI install properties are set only after the user starts setup',
);
assert.doesNotMatch(
  initialize,
  /HANDLE initializationEvents\[\]\s*=\s*\{\s*gUiReadyEvent\s*,\s*gExitEvent\s*,\s*gStartEvent\s*\}/,
  'the ready signal cannot be mistaken for the user start action',
);

const messageHandlerStart = source.indexOf('case kInstallMessage: {');
const messageHandlerEnd = source.indexOf('case WM_PAINT:', messageHandlerStart);
assert.notEqual(messageHandlerStart, -1, 'embedded UI message handler exists');
assert.notEqual(messageHandlerEnd, -1, 'embedded UI message handler has a following case');
const messageHandler = source.slice(messageHandlerStart, messageHandlerEnd);
assert.match(
  messageHandler,
  /std::unique_ptr<std::wstring> detail;\s*if\s*\(wParam\s*==\s*1\s*\|\|\s*wParam\s*==\s*3\s*\|\|\s*wParam\s*==\s*4\)\s*\{\s*detail\.reset\(reinterpret_cast<std::wstring\*>\(lParam\)\);/,
  'only heap-owned text messages are interpreted and freed as strings',
);
assert.doesNotMatch(
  messageHandler,
  /delete\s+detail\s*;/,
  'numeric progress messages are never deleted as pointers',
);
assert.match(
  source,
  /SetThreadDpiAwarenessContext\(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2\)/,
  'the setup window uses per-monitor DPI awareness',
);
assert.match(
  source,
  /float ScaleForMonitor\(HMONITOR monitor, UINT dpi\)[\s\S]*?rcWork[\s\S]*?kDesignWidth[\s\S]*?kDesignHeight/,
  'window scale is capped to the monitor work area',
);
assert.match(
  source,
  /SetWindowPos\(g\.window, HWND_BOTTOM[\s\S]*?SetEvent\(gStartEvent\)/,
  'the setup window yields foreground Z-order before Windows Installer may request elevation',
);
assert.match(
  source,
  /if\s*\(message\s*==\s*INSTALLMESSAGE_INSTALLSTART\)\s*\{\s*if\s*\(HWND window\s*=\s*gUiWindow\.load\(\)\)\s*PostMessageW\(window,\s*kRestoreInstallerWindow/,
  'the setup window returns to the foreground after the elevation transition',
);
assert.match(
  source,
  /case WM_ERASEBKGND:\s*[\s\S]*?return 1;/,
  'background erase is suppressed between progress paints',
);
assert.match(
  source,
  /case kInstallMessage:\s*\{[\s\S]*?InvalidateRect\(window,\s*nullptr,\s*FALSE\);/,
  'MSI progress updates do not erase the whole window before repainting',
);
assert.match(
  source,
  /Gdiplus::Bitmap frame\(width, height, PixelFormat32bppPARGB\)[\s\S]*?target\.DrawImage\(&frame, 0, 0\)/,
  'the installer surface is drawn off-screen and copied to the window in one frame',
);

console.log('Windows MSI embedded UI startup, progress ownership, DPI, elevation foreground, and flicker contracts passed.');
