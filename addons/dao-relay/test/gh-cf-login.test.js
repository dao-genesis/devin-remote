// gh-cf-login 纯逻辑单测: 页面/主机判定 + 守卫路径(无需 playwright)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isGithubHost, isGhLoginPage, isGhAuthorizePage, ghCfLoginProvision } from '../gh-cf-login.mjs';

test('isGithubHost: 只认 github.com 及其子域', () => {
  assert.equal(isGithubHost('https://github.com/login'), true);
  assert.equal(isGithubHost('https://github.com/login/oauth/authorize?client_id=x'), true);
  assert.equal(isGithubHost('https://dash.cloudflare.com/login'), false);
  assert.equal(isGithubHost('https://notgithub.com.evil.com/'), false);
  assert.equal(isGithubHost('not a url'), false);
});

test('isGhLoginPage / isGhAuthorizePage: 路径判定', () => {
  assert.equal(isGhLoginPage('https://github.com/login'), true);
  assert.equal(isGhLoginPage('https://github.com/session'), true);
  assert.equal(isGhAuthorizePage('https://github.com/login/oauth/authorize?client_id=cf'), true);
  assert.equal(isGhAuthorizePage('https://github.com/settings/tokens'), false);
  assert.equal(isGhAuthorizePage('https://dash.cloudflare.com/oauth2/auth'), false);
});

test('ghCfLoginProvision: 缺账号/密码 → ok:false 且不启动浏览器', async () => {
  const r = await ghCfLoginProvision({ login: '', pass: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /缺 GitHub 账号或密码/);
});

test('ghCfLoginProvision: 结果对象不回吐敏感原文', async () => {
  const r = await ghCfLoginProvision({ login: 'x', pass: '' });
  assert.equal(r.ok, false);
  const s = JSON.stringify(r);
  assert.ok(!/secretpass|SEEDSEED/i.test(s));
});

test('源级: 浏览器启动 channel 回退(系统 Chrome 起不来→自带 chromium)', () => {
  const src = readFileSync(new URL('../gh-cf-login.mjs', import.meta.url), 'utf8');
  // 无桌面会话/版本不符时系统 Chrome 会秒退, 必须能回退到自带 chromium(channel=null)
  assert.match(src, /opts\.channel \? \[opts\.channel\] : \["chrome", null\]/);
  assert.match(src, /for \(const ch of channels\)/);
  assert.match(src, /ch \? \{ \.\.\.baseOpts, channel: ch \} : \{ \.\.\.baseOpts \}/);
});

test('源级: CF 登录页 Turnstile 人机验证 → needUser(守柔不绕过)', () => {
  const src = readFileSync(new URL('../gh-cf-login.mjs', import.meta.url), 'utf8');
  assert.match(src, /cf-turnstile-response/);
  assert.match(src, /just a moment\|attention required\|checking your browser/i);
  assert.match(src, /challenges\.cloudflare\.com/);
  assert.match(src, /\/cdn-cgi\/challenge/);
  // 命中即交回用户, 不尝试破解
  const seg = src.slice(src.indexOf('cfInterstitial'), src.indexOf('② 点'));
  assert.match(seg, /needUser: true/);
});
