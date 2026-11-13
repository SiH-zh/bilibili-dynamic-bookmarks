'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const script = fs.readFileSync(require.resolve('../bilibili-dynamic-bookmarks.user.js'), 'utf8');
assert.equal(script.match(/@version\s+([^\s]+)/)[1], pkg.version, '脚本头版本必须与项目版本一致');
assert.equal(script.match(/const VERSION = '([^']+)'/)[1], pkg.version, '界面版本必须与项目版本一致');
assert.equal(lock.version, pkg.version, '依赖锁文件版本必须与项目版本一致');
assert.equal(lock.packages[''].version, pkg.version, '锁文件根项目版本必须一致');
assert.equal(script.match(/@name\s+([^\r\n]+)/)[1].trim(), pkg.description, '脚本中文名称必须与项目说明一致');
for (const field of ['updateURL', 'downloadURL']) {
  const value = script.match(new RegExp('@' + field + '\\s+([^\\s]+)'))?.[1];
  assert.equal(value, 'https://raw.githubusercontent.com/SiH-zh/bilibili-dynamic-bookmarks/main/bilibili-dynamic-bookmarks.user.js', '更新与下载地址必须指向项目主分支脚本');
}
console.log(`版本检查通过：${pkg.version}`);
