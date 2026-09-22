import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessTtlSeconds,
  buildRefreshCookie,
  clampAccessTtlSeconds,
  clampRefreshTtlDays,
  createRefreshToken,
  hashRefreshToken,
  parseCookieHeader,
  readRefreshToken,
  refreshCookieName,
  secureCookieForRequest
} from '../src/auth-session.js';

test('access token lifetime is always capped at fifteen minutes',()=>{
  assert.equal(clampAccessTtlSeconds(43200),900);
  assert.equal(clampAccessTtlSeconds(900),900);
  assert.equal(clampAccessTtlSeconds(300),300);
  assert.equal(clampAccessTtlSeconds(1),60);
  assert.equal(accessTtlSeconds({AUTH_ACCESS_TTL_SECONDS:'7200'}),900);
});

test('refresh lifetime is bounded and defaults to seven days',()=>{
  assert.equal(clampRefreshTtlDays(undefined),7);
  assert.equal(clampRefreshTtlDays(90),30);
  assert.equal(clampRefreshTtlDays(0),1);
});

test('refresh token is opaque and only its hash is suitable for persistence',()=>{
  const token=createRefreshToken();
  const other=createRefreshToken();
  assert.match(token,/^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(token,other);
  const hash=hashRefreshToken(token);
  assert.match(hash,/^[a-f0-9]{64}$/);
  assert.notEqual(hash,token);
  assert.equal(hashRefreshToken(token),hash);
});

test('refresh cookie is HttpOnly, SameSite=Lax and can be cleared',()=>{
  const env={AUTH_REFRESH_COOKIE_NAME:'profi24_refresh',AUTH_REFRESH_TTL_DAYS:'7'};
  const cookie=buildRefreshCookie('secret-token',{env,secure:true,maxAgeSeconds:3600});
  assert.match(cookie,/^profi24_refresh=secret-token;/);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/SameSite=Lax/);
  assert.match(cookie,/Path=\//);
  assert.match(cookie,/Max-Age=3600/);
  assert.match(cookie,/Secure/);
  assert.equal(readRefreshToken('foo=bar; profi24_refresh=secret-token',env),'secret-token');
  const cleared=buildRefreshCookie('',{env,clear:true});
  assert.match(cleared,/Max-Age=0/);
  assert.match(cleared,/Expires=Thu, 01 Jan 1970/);
});

test('cookie parsing is defensive and cookie security follows proxy protocol',()=>{
  assert.deepEqual(parseCookieHeader('a=1; encoded=hello%20world'),{a:'1',encoded:'hello world'});
  assert.equal(refreshCookieName({AUTH_REFRESH_COOKIE_NAME:'bad name'}),'profi24_refresh');
  assert.equal(secureCookieForRequest({protocol:'http',headers:{'x-forwarded-proto':'https'}},{}),true);
  assert.equal(secureCookieForRequest({protocol:'https',headers:{}},{AUTH_COOKIE_SECURE:'false'}),false);
});
