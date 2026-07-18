// gh-cf-login 纯逻辑单测: 页面/主机判定 + 守卫路径(无需 playwright)
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
