/*global Ultraviolet*/
// dao-relay · Ultraviolet 配置 (本源重构 · SW 客户端代理引擎)
//   prefix = /uv/service/ : 被代理内容的同源前缀 (SW scope=/uv/ 覆盖之)。
//   传输层 = bare-as-module3 (Bare v3 · 纯 HTTP) → 本 Worker 的 /bare/v3/ 端点。
//   资源加载/JS 改写全部在【用户浏览器的 Service Worker】内完成 = 充分调用浏览器本源资源;
//   Worker 只当极薄传输 + (Devin)认证注入层。
self.__uv$config = {
  prefix: "/uv/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv/uv.config.js",
  sw: "/uv/uv.sw.js",
};
