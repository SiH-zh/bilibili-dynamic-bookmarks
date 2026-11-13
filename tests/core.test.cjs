'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LOOKBACK, pickerValue, pickerBounds, parsePicker, parseTimestamp, formatTime, recordMeta, normalizeStore, addBookmark, removeBookmarks, nearest, classify } = require('../bilibili-dynamic-bookmarks.user.js');
const make = (id = '1270165298557747203', ts = 1794561600) => ({ id, ts, title: '视频标题', author: '作者', bvid: 'BV1SgWi6yEjJ' });

test('日期选择固定为北京时间，跨月及分钟边界换算正确', () => {
  const now = Date.UTC(2026, 0, 31, 16, 8, 35) / 1000;
  assert.equal(pickerValue(now), '2026-02-01T00:08');
  assert.equal(parsePicker('2026-02-01T00:08', now), now - 35);
  const bounds = pickerBounds(now);
  assert.equal(bounds.max, '2026-02-01T00:08');
  assert.ok(parsePicker(bounds.min, now) >= now - LOOKBACK);
  assert.throws(() => parsePicker(pickerValue(parsePicker(bounds.min, now) - 60), now), /最近10天/);
});
test('日期选择拒绝未来、超过十天及非法日期，不依赖浏览器输入限制', () => {
  const now = Date.UTC(2026, 2, 1, 12) / 1000;
  assert.equal(parsePicker(pickerValue(now - LOOKBACK), now), now - LOOKBACK);
  assert.throws(() => parsePicker(pickerValue(now + 60), now), /未来/);
  assert.throws(() => parsePicker('2026-02-30T20:00', now), /有效/);
  assert.throws(() => parsePicker('', now), /有效/);
  assert.throws(() => parsePicker('2026-03-01T24:00', now), /有效/);
});
test('按时间定位可匹配相同秒数或列表最新视频，不改变唯一标识定位规则', () => {
  const rows = [make('1', 1100), make('2', 900)];
  assert.equal(classify(rows, { mode: 'time', ts: 1100 }).kind, 'exact');
  assert.equal(classify(rows, { mode: 'time', ts: 1200 }).kind, 'time-ready');
  assert.equal(classify(rows, make('9', 1200)).kind, 'incomplete');
});

test('固定北京时间并保留秒数及跨年年份', () => {
  const ts = Date.UTC(2025, 11, 31, 16, 8, 35) / 1000;
  assert.equal(formatTime(ts, true), '2026年1月1日 00:08:35');
  assert.equal(formatTime(ts), '1月1日 00:08:35');
  assert.equal(formatTime(undefined), '时间数据不可用');
});
test('读取当前动态时间，不误用转发原动态或模糊时间', () => {
  const meta = recordMeta({ id_str: make().id, modules: { module_author: { pub_ts: 1000, name: '甲', pub_time: '昨天' }, module_dynamic: { major: { archive: { title: '乙' } } } }, orig: { modules: { module_author: { pub_ts: 100 } } } });
  assert.equal(meta.ts, 1000);
  assert.equal(meta.id, make().id);
  assert.equal(recordMeta({ id_str: 1270165298557747203 }), null);
});
test('兼容实际网页的字符串秒级时间戳，并拒绝模糊时间和非整数', () => {
  assert.equal(parseTimestamp('1794575557'), 1794575557);
  assert.equal(parseTimestamp(1794575557), 1794575557);
  for (const value of ['昨天', '1分钟前', '', '1.5', '1e9', ' 1000 ', '1794575557000', null, undefined, NaN, Infinity, -1]) {
    assert.equal(parseTimestamp(value), null, `应拒绝：${String(value)}`);
  }
  const meta = recordMeta({ id_str: '1270165298557747203', modules: { module_author: { pub_ts: '1794575557' }, module_dynamic: { major: { archive: { title: '字符串时间视频' } } } } });
  assert.equal(meta.ts, 1794575557);
});
test('大整数动态标识按字符串保存，多标记去重且不覆盖原标记时间', () => {
  const first = addBookmark(null, make(), 100);
  const again = addBookmark(first, make(), 200);
  assert.equal(again.bookmarks.length, 1);
  assert.equal(again.bookmarks[0].markedAt, 100);
  const next = addBookmark(again, make('1270165298557747204'), 300);
  assert.equal(next.bookmarks.length, 2);
  assert.equal(next.bookmarks[0].id, '1270165298557747204');
});
test('批量删除仅删除选中标记且不改变输入对象', () => {
  const raw = addBookmark(addBookmark(null, make('1')), make('2'));
  assert.equal(removeBookmarks(raw, new Set(['1'])).bookmarks[0].id, '2');
  assert.equal(raw.bookmarks.length, 2);
  assert.equal(removeBookmarks(raw, new Set(['1', '2'])).bookmarks.length, 0);
});
test('损坏、未来版本及重复标识的数据拒绝写入', () => {
  assert.throws(() => normalizeStore({ schemaVersion: 2, bookmarks: [] }), /不兼容/);
  assert.throws(() => normalizeStore({ schemaVersion: 1, bookmarks: [{ id: '1' }] }), /损坏/);
  assert.throws(() => normalizeStore({ schemaVersion: 1, bookmarks: [{ ...make('1'), markedAt: 1 }, { ...make('1'), markedAt: 2 }] }), /损坏/);
});
test('同一秒的两个动态必须比较唯一标识', () => {
  assert.equal(classify([make('1', 1000)], make('2', 1000)).kind, 'incomplete');
  assert.equal(classify([make('1', 1000)], make('1', 1000)).kind, 'exact');
});
test('附近候选不依赖卡片顺序，时间差相同时优先较早投稿', () => {
  assert.equal(nearest([make('1', 1100), make('2', 900), make('3', 500)], make('9', 1000)).id, '2');
  assert.equal(classify([make('1', 1100), make('2', 900)], make('9', 1000)).kind, 'covered');
});
test('历史提前结束但未覆盖目标时间，不能判定目标消失', () => {
  assert.equal(classify([make('1', 1100)], make('9', 1000), true).kind, 'incomplete');
  assert.equal(classify([make('1', 900)], make('9', 1000), true).kind, 'end');
});
test('中间出现一条很旧的乱序动态，不代表已经加载到目标附近', () => {
  assert.equal(classify([make('1', 1100), make('2', 100), make('3', 1050)], make('9', 1000)).kind, 'incomplete');
});
