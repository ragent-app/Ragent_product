#!/usr/bin/env node
import assert from 'assert/strict';

import { resolvePushSendOptions } from '../chat/push.mjs';

const defaultOptions = resolvePushSendOptions({});
assert.equal(defaultOptions.timeout, 5000, 'push send should default to a bounded timeout');
assert.equal('proxy' in defaultOptions, false, 'push send should not force a proxy when none is configured');

const explicitProxy = resolvePushSendOptions({
  RAGENT_PUSH_PROXY: 'http://127.0.0.1:7890',
  https_proxy: 'http://127.0.0.1:9999',
});
assert.equal(explicitProxy.proxy, 'http://127.0.0.1:7890', 'explicit push proxy should win over generic proxy envs');

const httpsProxy = resolvePushSendOptions({ https_proxy: 'http://127.0.0.1:7890' });
assert.equal(httpsProxy.proxy, 'http://127.0.0.1:7890', 'lowercase https_proxy should be honored');

const httpProxy = resolvePushSendOptions({ HTTP_PROXY: 'http://127.0.0.1:7890' });
assert.equal(httpProxy.proxy, 'http://127.0.0.1:7890', 'uppercase HTTP_PROXY should be honored as a fallback');

const socksOnly = resolvePushSendOptions({ all_proxy: 'socks5://127.0.0.1:7890' });
assert.equal('proxy' in socksOnly, false, 'all_proxy alone should not be passed to web-push as an HTTP proxy');

console.log('test-push-proxy-config: ok');
