# Third-party notices

Ragent includes or uses third-party software and assets under their own
licenses. The following inventory covers identified vendored files; dependency
and asset review is still in progress and this list is not yet complete.

| Component | Location | License and attribution |
| --- | --- | --- |
| Three.js | `static/vendor/` | MIT; see `third_party_licenses/three.js-MIT.txt` and `static/vendor/THREE-LICENSE.txt`. |
| marked | `static/marked.min.js` | MIT; see `third_party_licenses/marked-MIT.txt`. |
| QR Code Generator | `static/qr-creator.min.js` | MIT; the notice and license are embedded in the file. |
| Vditor | `static/chat/vendor/vditor/` | MIT; see the included `NOTICE.md`. |
| Tabler Icons | `static/chat/activity-icons/` | MIT; see `third_party_licenses/tabler-icons-MIT.txt` and the included `NOTICE.md`. |
| Inter | `static/chat/fonts/` and Android `core/designsystem/.../font/` | SIL Open Font License 1.1; see `static/chat/fonts/InterVariable-latin-OFL.txt`. |
| Studio Small 09 | `static/vendor/studio_small_09_1k.hdr` | CC0; credited to Sergej Majboroda / Poly Haven in `static/vendor/THREE-LICENSE.txt`. |
| Gradle wrapper | `android/gradle/wrapper/gradle-wrapper.jar` and wrapper scripts | Apache-2.0; Gradle is a separate project. |
| extended-spans and multiplatform-markdown-renderer ports | Android `core/agentui/.../markdown/` | Apache-2.0; source files retain original copyright and upstream attribution. |
| web-push | npm dependency | MPL-2.0; copyright 2015 Marco Castelluccio. See the license distributed with the package and https://www.mozilla.org/MPL/2.0/. |
| Node.js 24.12.0 | bundled desktop runtimes | MIT and other third-party licenses; see `third_party_licenses/node/v24.12.0-LICENSE.txt`, from the [Node.js v24.12.0 source](https://github.com/nodejs/node/blob/v24.12.0/LICENSE). Packaging requires notices matching the bundled Node version. |
| Codex CLI | bundled Linux and macOS provider runtime | Apache-2.0; see the bundled Apache license and the native package's included component notices. The packaged provider version is recorded in `runtime/provider-versions`. |
| Claude Code | bundled Linux and macOS provider runtime | Proprietary; the native package's `LICENSE.md` is included with the binary. Its use and preinstallation are subject to [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance). The packaged version and binary SHA-256 are recorded in `runtime/provider-versions`. |
| http_ece 1.2.0 | npm dependency | MIT; see `third_party_licenses/npm/http_ece-1.2.0-MIT.txt`, from the [upstream v1.2.0 source](https://github.com/martinthomson/encrypted-content-encoding/tree/v1.2.0). |
| agent-base 6.0.2, https-proxy-agent 5.0.1, data-uri-to-buffer 4.0.1, pg-types 2.2.0, pgpass 1.0.5 | npm dependencies | MIT; full notices extracted from the installed packages' READMEs are in `third_party_licenses/npm/`. |
| abstract-logging 2.0.1 | npm dependency | MIT; see `third_party_licenses/npm/abstract-logging-2.0.1-MIT.txt`, transcribed from the author's linked license page on 2026-11-01. The page displays the current year dynamically. |
| eastasianwidth 0.2.0 | npm dependency | MIT according to its published package metadata; see `third_party_licenses/npm/eastasianwidth-0.2.0-MIT.txt` for the author's [later upstream notice](https://github.com/komagata/eastasianwidth/blob/1d41951a59d6/MIT-LICENSE.txt). The 0.2.0 source tree does not contain a standalone license file. |

Other npm, Gradle, Android SDK, and runtime dependencies retain their respective
licenses. Consult their distributed license files; they are not relicensed by
the Ragent project license.

The Android client uses Google ML Kit barcode scanning and Google Play services.
These dependencies are subject to their own terms, including the [ML Kit terms
and privacy notice](https://developers.google.com/ml-kit/terms) and [Android SDK
terms](https://developer.android.com/studio/terms). Google states that ML Kit
processes input on-device and may send API performance and usage metrics to
Google. Review the applicable notices and data disclosures for the actual
Android release build.

License texts for the Go modules used by the P2P host build are collected in
[`third_party_licenses/go/`](third_party_licenses/go/README.md). Packaging and
license review for all delivered components remains in progress.
