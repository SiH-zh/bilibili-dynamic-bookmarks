'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createApp, addBookmark, LOOKBACK, pickerValue, pickerBounds } = require('../bilibili-dynamic-bookmarks.user.js');
const meta = (id, ts = 1000) => ({ id, ts, title: `视频${id}`, author: '测试作者', bvid: 'BV1SgWi6yEjJ' });
const raw = m => ({ id_str: m.id, modules: { module_author: { pub_ts: m.ts, name: m.author }, module_dynamic: { major: { archive: { title: m.title, bvid: m.bvid } } } } });

function fixture(t, metas = [meta('1', 1100), meta('2', 900)], timing = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div class="bili-dyn-list"><div class="bili-dyn-list__items"></div></div><aside class="right"><section id="hot">热搜模块</section></aside></body></html>', { url: 'https://t.bilibili.com/?tab=video' });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = 'true'; };
  w.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const store = new Map(); const listeners = new Map(); let lid = 0;
  const storage = { get: k => structuredClone(store.get(k) ?? null), set: (k, v) => store.set(k, structuredClone(v)), listen: (k, fn) => { listeners.set(++lid, {k, fn}); return lid; }, unlisten: id => listeners.delete(id) };
  const root = w.document.querySelector('.bili-dyn-list');
  const vm = { list: metas.map(raw), user: { mid: 123 }, status: 'FETCHED', offset: 'initial', loadmore() { vm.status = 'NO_MORE'; } };
  root.__vue__ = vm;
  function appendCard(m) {
    const c = w.document.createElement('div'); c.className = 'bili-dyn-list__item'; c.dataset.did = m.id;
    c.innerHTML = '<div class="bili-dyn-item"><div class="bili-dyn-item__header"><div class="bili-dyn-time">昨天 · 投稿了视频</div><div class="bili-cascader-options"></div></div><a class="bili-dyn-card-video"></a></div>';
    root.querySelector('.bili-dyn-list__items').append(c); return c;
  }
  metas.forEach(appendCard);
  const app = createApp(w, storage, { poll: 2, pageDelay: 0, requestTimeout: 30, maxRetries: 0, maxPages: 4, ...timing }).start();
  t.after(() => { app.dispose(); dom.window.close(); });
  const click = text => {
    const b = [...w.document.querySelectorAll('button')].find(e => e.textContent === text);
    assert.ok(b, `应存在按钮：${text}`);
    if (b.closest('#bdb-content')?.hidden) w.document.querySelector('.bdb-collapse-toggle').click();
    b.click();
  };
  return { w, doc: w.document, store, storage, app, vm, appendCard, click };
}

test('独立侧栏模块、精确时间与原生菜单标记入口', t => {
  const f = fixture(t);
  assert.equal(f.doc.querySelector('#bdb-panel').parentElement.tagName, 'ASIDE');
  assert.equal(f.doc.querySelector('#hot #bdb-panel'), null);
  assert.equal(f.doc.querySelectorAll('.bdb-exact').length, 2);
  assert.equal(f.doc.querySelectorAll('.bdb-menu-item').length, 2);
  f.app.scan(); f.app.scan();
  assert.equal(f.doc.querySelectorAll('.bdb-exact').length, 2);
  f.click('标记此视频');
  assert.equal(f.app.getState().data.bookmarks[0].id, '1');
  assert.match(f.doc.querySelector('.bdb-list').textContent, /视频1/);
});
test('全选、取消全选与多选删除', t => {
  const f = fixture(t);
  f.click('展开的悬浮模块');
  f.doc.querySelectorAll('.bdb-menu-item').forEach(b => b.click());
  const all = f.doc.querySelector('.bdb-selectall input'); all.click();
  assert.equal(f.doc.querySelectorAll('.bdb-row input:checked').length, 2);
  all.click(); assert.equal(f.doc.querySelectorAll('.bdb-row input:checked').length, 0);
  f.doc.querySelector('.bdb-row input').click(); f.click('删除所选（1）');
  assert.equal(f.app.getState().data.bookmarks.length, 1);
});
test('多个标记先选目标，单行返回直接定位', async t => {
  const f = fixture(t);
  f.doc.querySelectorAll('.bdb-menu-item').forEach(b => b.click());
  f.click('回到视频');
  assert.match(f.doc.querySelector('[role=dialog]').textContent, /选择要返回的视频/);
  assert.equal(f.doc.querySelectorAll('.bdb-choice').length, 2);
  f.click('关闭'); f.click('返回视频');
  assert.equal(f.doc.querySelectorAll('.bdb-highlight').length, 1);
});
test('刷新重建后保留标记，切换账号分开保存', t => {
  const f = fixture(t); f.click('标记此视频');
  const saved = f.store.get('bdb.v1.account.123');
  assert.equal(saved.bookmarks.length, 1);
  f.vm.user.mid = 456; f.app.scan(); assert.equal(f.app.getState().data.bookmarks.length, 0);
  f.vm.user.mid = 123; f.app.scan(); assert.equal(f.app.getState().data.bookmarks.length, 1);
  f.app.dispose();
  const restarted = createApp(f.w, f.storage).start();
  t.after(() => restarted.dispose());
  assert.equal(restarted.getState().data.bookmarks[0].id, '1');
});
test('瀑布流追加目标后按唯一标识定位', async t => {
  const f = fixture(t, [meta('1', 1100)]);
  f.vm.loadmore = () => { f.vm.status = 'LOADING'; f.w.setTimeout(() => { f.vm.list.push(raw(meta('9', 1000))); f.appendCard(meta('9', 1000)); f.vm.status = 'FETCHED'; f.vm.offset = 'next'; }, 3); };
  await f.app.restore(meta('9', 1000));
  assert.equal(f.doc.querySelector('[data-did="9"]').dataset.scrolled, 'true');
  assert.match(f.app.getState().status, /已回到标记视频/);
});
test('失踪目标在覆盖范围内定位附近，保留原标记且不误称确定删除', async t => {
  const f = fixture(t); const bookmark = meta('9', 1000);
  f.storage.set('bdb.v1.account.123', addBookmark(null, bookmark));
  await f.app.restore(bookmark);
  assert.equal(f.doc.querySelector('[data-did="2"]').dataset.scrolled, 'true');
  assert.match(f.doc.querySelector('[role=dialog]').textContent, /可能已失效/);
  assert.equal(f.storage.get('bdb.v1.account.123').bookmarks[0].id, '9');
});
test('时间范围已覆盖仍多加载一批，处理乱序目标', async t => {
  const f = fixture(t); let loads = 0;
  f.vm.loadmore = () => { loads++; f.vm.list.push(raw(meta('9', 1000))); f.appendCard(meta('9', 1000)); f.vm.offset = 'next'; };
  await f.app.restore(meta('9', 1000));
  assert.equal(loads, 1); assert.match(f.app.getState().status, /已回到标记视频/);
  assert.equal(f.doc.querySelector('[role=dialog]'), null);
});
test('网络超时只报告查找中断，不显示视频失效弹窗', async t => {
  const f = fixture(t, [meta('1', 1100)]); f.vm.loadmore = () => { f.vm.status = 'LOADING'; };
  await f.app.restore(meta('9', 1000));
  assert.match(f.app.getState().status, /超时/);
  assert.equal(f.doc.querySelector('[role=dialog]'), null);
});
test('历史未覆盖、网页报错及不可见目标不误报删除', async t => {
  const f = fixture(t, [meta('1', 1100)]);
  await f.app.restore(meta('9', 1000)); assert.match(f.app.getState().status, /尚未覆盖/);
  f.vm.status = 'ERROR'; await f.app.restore(meta('9', 1000)); assert.match(f.app.getState().status, /连续加载失败/);
  f.doc.querySelector('.bili-dyn-card-video').remove();
  await f.app.restore(meta('1', 1100)); assert.match(f.app.getState().status, /过滤、折叠或不可见/);
  assert.equal(f.doc.querySelector('[role=dialog]'), null);
});
test('停止定位后不再定位或弹出失效提醒', async t => {
  const f = fixture(t, [meta('1', 1100)]); f.vm.loadmore = () => { f.vm.status = 'LOADING'; };
  const job = f.app.restore(meta('9', 1000)); f.app.cancel(); await job;
  assert.match(f.app.getState().status, /已停止/); assert.equal(f.app.getState().running, false);
});
test('切换页面清理入口与时间，不干扰其他分区', t => {
  const f = fixture(t); f.w.history.pushState({}, '', '/?tab=all'); f.app.scan();
  assert.equal(f.doc.querySelector('#bdb-panel'), null); assert.equal(f.doc.querySelector('.bdb-exact'), null);
});
test('不把视频标题当作网页标记解析', t => {
  const f = fixture(t); const x = raw({ ...meta('3'), title: '<img src=x onerror=alert(1)>' });
  f.vm.list.push(x); f.appendCard(meta('3')); f.app.scan();
  [...f.doc.querySelectorAll('.bdb-menu-item')].at(-1).click();
  assert.equal(f.doc.querySelector('.bdb-list img'), null);
  assert.match(f.doc.querySelector('.bdb-list').textContent, /<img/);
});
test('网页卡片没有动态编号属性时仍可从组件数据读取', t => {
  const f = fixture(t);
  const card = f.doc.querySelector('[data-did="1"]');
  card.removeAttribute('data-did'); delete card.dataset.bdbId;
  card.querySelector('.bili-dyn-item').__vue__ = { data: raw(meta('1', 1100)) };
  card.querySelector('.bdb-exact').remove(); card.querySelector('.bdb-menu-item').remove();
  f.app.scan(); assert.equal(card.dataset.bdbId, '1'); assert.ok(card.querySelector('.bdb-exact'));
  card.querySelector('.bdb-menu-item').click(); assert.equal(f.app.getState().data.bookmarks[0].id, '1');
});
test('三点菜单延迟出现时补入标记，不改变网站原有菜单项', t => {
  const f = fixture(t); const card = f.doc.querySelector('[data-did="1"]');
  card.querySelector('.bili-cascader-options').remove(); f.app.scan();
  const menu = f.doc.createElement('div'); menu.className = 'bili-cascader-options';
  menu.textContent = '原有举报入口'; card.querySelector('.bili-dyn-item__header').append(menu); f.app.scan();
  assert.match(menu.textContent, /原有举报入口/); assert.ok(menu.querySelector('.bdb-menu-item'));
});
test('从真实脚本入口启动时读取油猴存储并注入界面', t => {
  const fs = require('node:fs');
  const f = fixture(t); f.app.dispose();
  const script = fs.readFileSync(require.resolve('../bilibili-dynamic-bookmarks.user.js'), 'utf8');
  // 新页面上下文模拟真实油猴入口，脚本中不增加专用测试开关。
  const dom = new JSDOM(f.doc.documentElement.outerHTML, { url: 'https://t.bilibili.com/?tab=video', runScripts: 'outside-only' });
  const w = dom.window; const values = new Map();
  w.unsafeWindow = w; w.GM_getValue = k => values.get(k) ?? null; w.GM_setValue = (k, v) => values.set(k, v);
  w.GM_addValueChangeListener = () => 1; w.GM_removeValueChangeListener = () => {};
  w.document.querySelector('.bili-dyn-list').__vue__ = f.vm;
  w.eval(script);
  assert.ok(w.document.querySelector('#bdb-panel'));
  w.document.querySelector('.bdb-menu-item').click();
  assert.equal(values.get('bdb.v1.account.123').bookmarks[0].id, '1');
  t.after(() => { w.dispatchEvent(new w.PageTransitionEvent('pagehide')); dom.window.close(); });
});
test('实际网页的字符串时间戳可同时生成精确时间和三点菜单标记入口', t => {
  const f = fixture(t);
  f.vm.list.forEach(r => { r.modules.module_author.pub_ts = String(r.modules.module_author.pub_ts); });
  f.doc.querySelectorAll('.bdb-exact,.bdb-menu-item').forEach(e => e.remove());
  f.app.scan();
  assert.equal(f.doc.querySelectorAll('.bdb-exact').length, 2);
  assert.equal(f.doc.querySelectorAll('.bdb-menu-item').length, 2);
  f.click('标记此视频');
  assert.equal(typeof f.app.getState().data.bookmarks[0].ts, 'number');
  assert.equal(f.app.getState().data.bookmarks[0].id, '1');
});
test('保留热搜原生吸顶与文档结构，标记模块在其下方独立吸顶', t => {
  const f = fixture(t);
  const right = f.doc.querySelector('aside.right'), hot = f.doc.querySelector('#hot');
  hot.className = 'sticky'; hot.style.position = 'sticky'; hot.style.top = '72px';
  hot.getBoundingClientRect = () => ({ height: 300 });
  const originalStyle = hot.getAttribute('style'), originalClasses = right.className;
  f.app.scan();
  assert.equal(f.w.getComputedStyle(f.doc.querySelector('#bdb-panel')).position, 'sticky');
  assert.equal(f.doc.querySelector('#bdb-panel').style.top, '384px');
  assert.equal(f.w.getComputedStyle(hot).position, 'sticky');
  assert.equal(hot.getAttribute('style'), originalStyle);
  assert.equal(hot.parentElement, right);
  assert.equal(right.className, originalClasses);
  hot.getBoundingClientRect = () => ({ height: 350 });
  f.w.dispatchEvent(new f.w.Event('resize'));
  assert.equal(f.doc.querySelector('#bdb-panel').style.top, '434px');
  f.w.history.pushState({}, '', '/?tab=all'); f.app.scan();
  assert.equal(hot.getAttribute('style'), originalStyle);
  assert.equal(right.className, originalClasses);
});
test('卡片、标记列表与选择窗口统一使用简洁的时分秒格式', t => {
  const f = fixture(t);
  assert.match(f.doc.querySelector('.bdb-exact').textContent, /\d+月\d+日 \d{2}:\d{2}:\d{2}/);
  f.doc.querySelectorAll('.bdb-menu-item').forEach(b => b.click());
  assert.match(f.doc.querySelector('.bdb-row time').textContent, /年\d+月\d+日 \d{2}:\d{2}:\d{2}/);
  f.click('回到视频');
  assert.match(f.doc.querySelector('.bdb-choice').textContent, /\d+月\d+日 \d{2}:\d{2}:\d{2}/);
});
test('模块内日期时间输入可直接提交，不要求存在标记且不会写入标记存储', async t => {
  const now = Math.floor(Date.now() / 60000) * 60;
  const f = fixture(t, [meta('1', now - 120), meta('2', now - 240)]);
  const input = f.doc.querySelector('#bdb-target-time');
  assert.equal(input.type, 'datetime-local'); assert.equal(input.step, '60');
  assert.equal(input.min, pickerBounds().min); assert.equal(input.max, pickerBounds().max);
  input.value = pickerValue(now);
  f.click('回到该时间');
  assert.match(f.app.getState().status, /已定位到所选时间附近/);
  assert.equal(f.doc.querySelector('[data-did="1"]').dataset.scrolled, 'true');
  assert.equal(f.storage.get('bdb.v1.account.123'), null);
  assert.equal(f.doc.querySelector('[role=dialog]'), null);
});
test('按时间分页查找最近候选，避免弹出标记失效提醒', async t => {
  const target = Math.floor(Date.now() / 60000) * 60 - 600;
  const f = fixture(t, [meta('1', target + 120)]);
  f.vm.loadmore = () => { f.vm.list.push(raw(meta('2', target - 60))); f.appendCard(meta('2', target - 60)); f.vm.offset = 'next'; f.vm.status = 'NO_MORE'; };
  await f.app.restoreAtTime(pickerValue(target));
  assert.match(f.app.getState().status, /相差约 1 分钟/);
  assert.equal(f.doc.querySelector('[data-did="2"]').dataset.scrolled, 'true');
  assert.equal(f.doc.querySelector('[role=dialog]'), null);
});
test('超过十天、未来及空时间均在加载前拦截', async t => {
  const now = Math.floor(Date.now() / 1000), f = fixture(t);
  let loads = 0; f.vm.loadmore = () => { loads++; };
  await f.app.restoreAtTime(pickerValue(now - LOOKBACK - 120)); assert.match(f.app.getState().status, /最近10天/);
  await f.app.restoreAtTime(pickerValue(now + 120)); assert.match(f.app.getState().status, /未来/);
  await f.app.restoreAtTime(''); assert.match(f.app.getState().status, /有效/);
  assert.equal(loads, 0); assert.equal(f.app.getState().running, false);
});
test('按时间查找达到卡片数量上限后停止追加，不假装定位成功', async t => {
  const target = Math.floor(Date.now() / 60000) * 60 - 600;
  const f = fixture(t, [meta('1', target + 300), meta('2', target + 180)], { timeMaxItems: 2 });
  let loads = 0; f.vm.loadmore = () => { loads++; };
  await f.app.restoreAtTime(pickerValue(target));
  assert.equal(loads, 0); assert.match(f.app.getState().status, /加载上限/);
  assert.equal(f.doc.querySelector('.bdb-highlight'), null);
});
test('按时间查找达到批次上限后停止发出后续请求', async t => {
  const target = Math.floor(Date.now() / 60000) * 60 - 600;
  const f = fixture(t, [meta('1', target + 300)], { timeMaxPages: 1 });
  let loads = 0;
  f.vm.loadmore = () => { loads++; f.vm.list.push(raw(meta('2', target + 180))); f.appendCard(meta('2', target + 180)); f.vm.offset = 'next'; };
  await f.app.restoreAtTime(pickerValue(target));
  assert.equal(loads, 1); assert.match(f.app.getState().status, /加载上限/);
  assert.equal(f.doc.querySelector('.bdb-highlight'), null);
});
test('达到十天边界不再追加更早批次，候选始终在十天以内', async t => {
  const now = Math.floor(Date.now() / 1000), target = Math.ceil((now - LOOKBACK) / 60) * 60;
  const f = fixture(t, [meta('1', target + 120), meta('2', now - LOOKBACK - 120)]);
  let loads = 0; f.vm.loadmore = () => { loads++; };
  await f.app.restoreAtTime(pickerValue(target));
  assert.equal(loads, 0); assert.equal(f.doc.querySelector('[data-did="1"]').dataset.scrolled, 'true');
  assert.equal(f.doc.querySelector('[data-did="2"]').dataset.scrolled, undefined);
});
test('按时间查找等待期间也执行总时长上限，停止按钮与输入入口恢复可用', async t => {
  const target = Math.floor(Date.now() / 60000) * 60 - 600;
  const f = fixture(t, [meta('1', target + 300)], { timeMaxDuration: 5 });
  f.vm.loadmore = () => { f.vm.status = 'LOADING'; };
  await f.app.restoreAtTime(pickerValue(target));
  assert.match(f.app.getState().status, /2分钟上限/);
  assert.equal(f.app.getState().running, false);
  assert.equal(f.doc.querySelector('.bdb-time-form button').disabled, false);
});
test('新增日期限制不影响旧标记返回十天以前的已加载视频', async t => {
  const old = Math.floor(Date.now() / 1000) - LOOKBACK - 86400;
  const f = fixture(t, [meta('1', old)]);
  await f.app.restore(meta('1', old)); assert.match(f.app.getState().status, /已回到标记视频/);
});
test('默认收起为单行标题栏，保留吸顶且没有拖动入口', t => {
  const f = fixture(t), panel = f.doc.querySelector('#bdb-panel');
  const content = f.doc.querySelector('#bdb-content'), toggle = panel.querySelector('.bdb-collapse-toggle');
  assert.equal(panel.querySelector('h2').textContent, '视频标记');
  assert.equal(toggle.textContent, '展开的悬浮模块');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), content.id);
  assert.equal(content.hidden, true);
  assert.equal(f.w.getComputedStyle(content).display, 'none');
  assert.equal(f.w.getComputedStyle(panel).position, 'sticky');
  assert.equal(panel.draggable, false);
  assert.equal(f.store.size, 0);
});
test('展开与收起保留书签、选择时间及勾选状态，不因扫描或新增标记自动展开', t => {
  const f = fixture(t), content = f.doc.querySelector('#bdb-content');
  f.click('展开的悬浮模块');
  assert.equal(content.hidden, false);
  assert.equal(f.doc.querySelector('.bdb-collapse-toggle').getAttribute('aria-expanded'), 'true');
  f.click('标记此视频');
  const input = f.doc.querySelector('#bdb-target-time'), chosen = pickerValue(Math.floor(Date.now() / 1000) - 120);
  input.value = chosen;
  f.doc.querySelector('.bdb-row input').click();
  const saved = structuredClone(f.storage.get('bdb.v1.account.123'));
  f.click('收起'); f.app.scan();
  assert.equal(content.hidden, true);
  assert.deepEqual(f.storage.get('bdb.v1.account.123'), saved);
  f.doc.querySelectorAll('.bdb-menu-item')[1].click();
  assert.equal(content.hidden, true);
  f.click('展开的悬浮模块');
  assert.equal(input.value, chosen);
  assert.equal(f.doc.querySelectorAll('.bdb-row input:checked').length, 1);
  assert.equal(f.app.getState().data.bookmarks.length, 2);
});
test('重新创建页面实例默认折叠，已有书签保持不变', t => {
  const f = fixture(t); f.click('展开的悬浮模块'); f.click('标记此视频');
  f.app.dispose();
  const next = createApp(f.w, f.storage).start(); t.after(() => next.dispose());
  assert.equal(f.doc.querySelector('#bdb-content').hidden, true);
  assert.equal(f.doc.querySelector('.bdb-collapse-toggle').textContent, '展开的悬浮模块');
  assert.equal(next.getState().data.bookmarks[0].id, '1');
});
test('收起不取消正在进行的定位，重新展开仍可停止', async t => {
  const f = fixture(t, [meta('1', 1100)]);
  f.click('展开的悬浮模块'); f.vm.loadmore = () => { f.vm.status = 'LOADING'; };
  const job = f.app.restore(meta('9', 1000));
  f.click('收起');
  assert.equal(f.app.getState().running, true);
  assert.equal(f.doc.querySelector('#bdb-content').hidden, true);
  f.click('展开的悬浮模块'); f.click('停止定位'); await job;
  assert.equal(f.app.getState().running, false);
  assert.match(f.app.getState().status, /已停止/);
});
