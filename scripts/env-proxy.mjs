// Preloaded by scripts/with-env.mjs: makes Node's fetch (and the Anthropic SDK, which uses it) honour
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY like curl does. Node 22 ignores them by default.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) setGlobalDispatcher(new EnvHttpProxyAgent())
