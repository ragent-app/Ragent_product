# 官网链接唤起 Ragent 手机配对方案

## 目标

在 Linux Ragent 主机创建一次性手机配对邀请后，输出一个 HTTPS 链接。用户把链接复制到 Android 手机上打开，系统跳转到 Ragent，并继续现有的账号认领和设备配对流程。

此方案用完整配对载荷生成链接，不另外引入短码映射服务，不把配对凭据存到官网服务器。

## 现有能力

- `ragent pair` 已向本机 Ragent 创建配对邀请，并能在终端显示二维码、短码和完整 `ragent://pair?...` 配对 URI；也支持 `--no-qr` 和 `--json`。
- Android Manifest 已注册 `ragent://pair`，应用收到该深链后会进入既有配对流程。
- 配对 URI 中的邀请令牌是 192 位随机值。当前 CLI 默认邀请有效期为 120 秒，可通过参数在 30 至 600 秒范围内设置。
- 短码是 8 位十六进制值，即 32 位随机性。Android 当前没有输入短码的入口，因此本方案不依赖短码。

## 链接格式

CLI 将 UTF-8 编码的完整配对 URI 转为无填充 Base64URL，并输出如下形式：

```text
https://ragent.agentoncloud.com/pair#v1.<base64url-pairing-uri>
```

`v1` 是官网跳转页载荷格式版本，不是 Ragent 应用的配对协议版本。使用 Base64URL 可以避免 URI 中的 `?`、`&` 等字符破坏外层链接结构。

## 交互流程

1. 用户在 Linux 主机运行 `ragent pair --share-link`（命令名称可在实现时确定）。CLI 通过现有邀请 API 创建一次性邀请，并将其完整配对 URI 封装为官网链接。
2. CLI 在终端打印链接、有效期和安全提示。用户复制链接，通过自己选择的方式发送或粘贴到手机。链接较长，不适合手动输入。
3. Android 打开 HTTPS 链接。如果安装了并验证了 Ragent 的 Android App Link，系统可直接把链接交给 Ragent；否则由官网 `/pair` 静态页读取 `#` 片段并显示“打开 Ragent”按钮。
4. 静态页只在浏览器内解码并校验载荷格式，清除地址栏中的片段，再通过 `ragent://pair?...` 唤起应用。该页面不向任何服务端提交配对 URI 或令牌。
5. Ragent App 继续执行现有的扫码配对后续流程，包括登录状态检查、账号认领、设备签名与连接初始化。

## 官网跳转页要求

- 页面路径固定为 `/pair`，可由现有静态网站托管，不需要增加配对凭据数据库或兑换 API。
- 只接受格式正确、解码后 scheme 为 `ragent` 且 host 为 `pair` 的 URI；拒绝任意外部 scheme，避免把官网变成开放重定向器。
- 在解析后通过 `history.replaceState` 移除地址栏中的 `#` 内容，并只在当前页面内存中保留待打开的 URI。
- 优先尝试打开深链；由于 Android 浏览器可能阻止页面加载时自动切换 App，应同时提供明确的“打开 Ragent”按钮和未安装应用时的说明。
- 跳转页不得加载第三方脚本、广告、分析 SDK 或外部字体，不得把片段发送到 API、日志或遥测。
- 设置严格 CSP、`Referrer-Policy: no-referrer` 和 `Cache-Control: no-store`。HTTPS 片段通常不会随网页请求发送，但仍应防止页面脚本或浏览器侧工具读取它。

## Android App Link 方案

为了让用户打开 HTTPS 链接时更可靠地直接进入 App，可在 Ragent Android 应用中增加已验证 App Link：

- Manifest 声明 `https://ragent.agentoncloud.com/pair` 路径。
- 官网提供 `/.well-known/assetlinks.json`，登记对应应用的包名和签名 SHA-256 指纹。
- Play 与 GitHub APK 若包名或签名不同，分别登记每个发行变体的准确包名和证书指纹。
- App Link 入口从 HTTPS URI 的 fragment 读取 `v1` 载荷、解码得到原始 `ragent://pair?...`，然后交给现有配对深链处理代码。
- 未安装 App 或域名验证失败时，系统仍可打开官网 `/pair` 页面作为回退。

App Link 需要正确的发行签名和域名关联配置；在这些配置验证完成前，应保留自定义 scheme 跳转页作为回退路径。

## 安全与隐私边界

- 完整链接含有一次性邀请令牌，应按配对凭据保护。只发送给预期的手机，不要公开发布或粘贴到不可信网站。
- 邀请继续采用短有效期和一次性兑换；本方案不延长邀请有效期。跨设备复制耗时较长时，可由用户显式选择现有 TTL 参数，仍受 600 秒上限约束。
- URL fragment 不会随 `/pair` HTTP 请求发给网站服务器，因此静态网页可以在不让服务端看见令牌的情况下解包链接。
- 片段仍可能留在手机浏览器历史、剪贴板、键盘或屏幕截图中。网页应尽快清除地址栏片段；用户也应避免把链接发到会被多人访问或长期留存的地方。
- 不采用短网址数据库作为默认方案。短网址必须在服务端保存短码到邀请载荷的映射，会扩大凭据可见面，并引入过期、一次性兑换、限速和中心化存储需求。
- 保持现有账号认领、设备公钥签名和实例身份校验。获得链接本身不应绕过这些流程。

## 实现范围

1. 给 Linux `ragent pair` 增加分享链接输出选项，将现有邀请 URI 封装成官网 HTTPS fragment 链接；二维码和原始 URI 输出可继续保留。
2. 在官网增加最小化 `/pair` 页面，支持校验、清除 fragment、打开 Ragent 和未安装 App 的回退说明。
3. 在 Android 增加 HTTPS App Link 接收与载荷解包；已有 `ragent://pair` 处理保持不变。
4. 为官网配置 App Links 关联文件和 Android 各发行变体的证书指纹。
5. 更新 Linux CLI 帮助、Android 配对指引和官网相关说明，解释链接是一次性凭据且应保密。

## 验收标准

- CLI 使用现有本机邀请接口生成链接，TTL、一次性使用和设备签名约束保持不变。
- 链接片段不出现在官网 HTTP 请求、服务端访问日志或任何分析请求中。
- 已安装且域名关联有效时，Android 可从 HTTPS App Link 取得载荷并进入现有配对流程。
- 未验证 App Link 或没有已安装 App 时，官网回退页能给出明确的手动打开或安装指引。
- 链接过期或已使用时，App 显示现有的配对失效恢复提示，并要求主机生成新邀请。
- Ragent App 不在设备上时，短码不能替代链接完成配对；用户必须安装 App 后重新打开有效链接。

## 相关现有代码

- CLI 配对命令：`lib/pair-command.mjs`
- Android 自定义 scheme 声明：`android/app/src/main/AndroidManifest.xml`
- Android 配对深链入口：`android/app/src/main/java/com/andysagent/ragent/MainActivity.kt`
- Android URI 解析及兑换流程：`android/core/auth/src/main/kotlin/com/andysagent/ragent/core/auth/PairingAuthenticator.kt`
- 邀请令牌、短码和 TTL：`chat/trusted-devices.mjs`
