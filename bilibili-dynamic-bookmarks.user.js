// ==UserScript==
// @name         哔哩哔哩动态：精确时间与视频标记
// @namespace    urn:bilibili-dynamic-bookmarks
// @version      0.1.0
// @description  动态视频投稿时间精确到秒；多标记、批量删除、加载进度与返回附近视频。
// @match        https://t.bilibili.com/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @license      MIT
// ==/UserScript==

/* SPDX-License-Identifier: MIT */
(function () {
  'use strict';

  const VERSION = '0.1.0';
  const SCHEMA = 1;
  const PREFIX = 'bdb.v1.account.';
  const CARD = '.bili-dyn-list__item';
  const OWN = '#bdb-panel, .bdb-exact, .bdb-menu-item, .bdb-overlay, #bdb-toast';
  const pad = n => String(n).padStart(2, '0');
  const validTime = n => Number.isSafeInteger(n) && n > 0 && n < 100000000000;
  const validId = s => typeof s === 'string' && /^\d{1,30}$/.test(s);

  function formatTime(ts, withYear = false) {
    if (!validTime(ts)) return '时间数据不可用';
    // 固定东八区，不依赖操作系统的地区设置。
    const d = new Date((ts + 8 * 3600) * 1000);
    return `${withYear ? `${d.getUTCFullYear()}年` : ''}${d.getUTCMonth() + 1}月${d.getUTCDate()}日${pad(d.getUTCHours())}点${pad(d.getUTCMinutes())}分${pad(d.getUTCSeconds())}秒`;
  }

  function recordMeta(item) {
    if (!item || !validId(item.id_str)) return null;
    const author = item.modules?.module_author;
    const archive = item.modules?.module_dynamic?.major?.archive;
    const ts = author?.pub_ts;
    if (!validTime(ts) || !archive) return null;
    return {
      id: item.id_str, ts,
      title: String(archive.title || '未命名视频').slice(0, 1000),
      author: String(author.name || '未知作者').slice(0, 200),
      bvid: /^BV[0-9A-Za-z]{10}$/.test(archive.bvid || '') ? archive.bvid : '',
    };
  }

  function normalizeStore(raw) {
    if (raw == null) return { schemaVersion: SCHEMA, bookmarks: [] };
    if (raw.schemaVersion !== SCHEMA || !Array.isArray(raw.bookmarks)) {
      throw new Error('标记数据版本不兼容或数据损坏，已停止写入，避免覆盖原数据。');
    }
    const ids = new Set();
    const bookmarks = raw.bookmarks.map(b => {
      if (!b || !validId(b.id) || !validTime(b.ts) || !Number.isFinite(b.markedAt) ||
          typeof b.title !== 'string' || typeof b.author !== 'string' || ids.has(b.id)) {
        throw new Error('标记数据损坏，已停止写入，避免覆盖原数据。');
      }
      ids.add(b.id);
      return { id: b.id, ts: b.ts, title: b.title.slice(0, 1000), author: b.author.slice(0, 200),
        bvid: /^BV[0-9A-Za-z]{10}$/.test(b.bvid || '') ? b.bvid : '', markedAt: b.markedAt };
    });
    return { schemaVersion: SCHEMA, bookmarks };
  }

  function addBookmark(raw, meta, now = Date.now()) {
    const data = normalizeStore(raw);
    if (!meta || !validId(meta.id) || !validTime(meta.ts)) throw new Error('动态标识或时间不可用，暂时不能标记。');
    if (!data.bookmarks.some(b => b.id === meta.id)) data.bookmarks.unshift({ ...meta, markedAt: now });
    return normalizeStore(data);
  }

  function removeBookmarks(raw, ids) {
    const data = normalizeStore(raw);
    data.bookmarks = data.bookmarks.filter(b => !ids.has(b.id));
    return data;
  }

  function nearest(records, target) {
    return records.reduce((best, r) => {
      if (!best) return r;
      const delta = Math.abs(r.ts - target.ts), previous = Math.abs(best.ts - target.ts);
      return delta < previous || (delta === previous && r.ts < best.ts) ? r : best;
    }, null);
  }

  function classify(records, target, exhausted = false) {
    const exact = records.find(r => r.id === target.id);
    if (exact) return { kind: 'exact', record: exact };
    if (!records.length) return { kind: 'incomplete' };
    const oldest = Math.min(...records.map(r => r.ts));
    const newest = Math.max(...records.map(r => r.ts));
    // 必须真正覆盖目标时间两侧；时间相同也必须检查标识，而非直接认定同一视频。
    if (records.at(-1).ts < target.ts && newest >= target.ts) return { kind: 'covered', record: nearest(records, target) };
    if (exhausted && oldest <= target.ts) return { kind: 'end', record: nearest(records, target) };
    return { kind: 'incomplete' };
  }

  function createApp(page, storage, timing = {}) {
    const doc = page.document;
    const options = { poll: 250, pageDelay: 1000, requestTimeout: 20000, maxRetries: 2, maxPages: 500, ...timing };
    let panel, statusNode, listNode, stopButton, countNode, deleteButton, allInput, observer;
    let account = null, key = '', listener = null, timer = null, scheduled = null, token = 0;
    let running = false, disposed = false, data = { schemaVersion: SCHEMA, bookmarks: [] };
    let storageError = '', status = '从视频卡片右上角三点菜单添加标记。', overlay = null;
    const selected = new Set();
    const unbind = [];
    const sleep = ms => new Promise(resolve => page.setTimeout(resolve, ms));
    const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
    const enabled = () => page.location.pathname === '/' && new page.URL(page.location.href).searchParams.get('tab') === 'video';

    function element(tag, className, text) {
      const el = doc.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function button(text, fn, className = '') {
      const b = element('button', className, text);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    }
    function listVm() {
      const root = doc.querySelector('.bili-dyn-list');
      let vm = root?.__vue__;
      for (let i = 0; vm && i < 5; i++, vm = vm.$parent) {
        if (Array.isArray(vm.list) && typeof vm.loadmore === 'function') return vm;
      }
      return null;
    }
    function rawRecords() { return listVm()?.list || []; }
    function records() { return rawRecords().map(recordMeta).filter(Boolean); }
    function cardFor(id) {
      return [...doc.querySelectorAll(CARD)].find(c => c.getAttribute('data-did') === id || c.dataset.bdbId === id);
    }
    function cardMeta(card, byId) {
      const id = card.getAttribute('data-did');
      if (id && byId.has(id)) return byId.get(id);
      const vm = card.querySelector('.bili-dyn-item')?.__vue__;
      return recordMeta(vm?.data || vm?.$props?.data);
    }
    function report(text) {
      status = text;
      setText(statusNode, text);
    }
    function toast(text) {
      let el = doc.getElementById('bdb-toast');
      if (!el) { el = element('div', '', ''); el.id = 'bdb-toast'; el.setAttribute('role', 'status'); doc.body.append(el); }
      setText(el, text);
      page.setTimeout(() => { if (el.textContent === text) el.remove(); }, 4500);
    }
    function read() {
      try { data = normalizeStore(storage.get(key)); storageError = ''; }
      catch (e) { storageError = e.message; data = { schemaVersion: SCHEMA, bookmarks: [] }; report(storageError); }
    }
    function mutate(fn) {
      if (!account || storageError) return toast(storageError || '请先登录，等待账号数据加载。');
      try {
        // 每次操作重新读取，减少多个标签页之间覆盖旧数据的机会。
        const next = fn(storage.get(key));
        storage.set(key, next);
        data = next;
        render();
        schedule();
        return true;
      } catch (e) { toast(`保存标记失败：${e.message}`); return false; }
    }
    function switchAccount(uid) {
      if (uid === account) return;
      cancel(false);
      closeDialog();
      if (listener != null) storage.unlisten?.(listener);
      account = uid; key = PREFIX + uid; selected.clear(); listener = null;
      storageError = '';
      if (uid) {
        read();
        if (storage.listen) listener = storage.listen(key, () => {
          read();
          const ids = new Set(data.bookmarks.map(b => b.id));
          for (const id of selected) if (!ids.has(id)) selected.delete(id);
          render(); schedule();
        });
      } else data = { schemaVersion: SCHEMA, bookmarks: [] };
      if (!storageError) report(uid ? '从视频卡片右上角三点菜单添加标记。' : '请先登录，等待账号数据加载后使用标记。');
      render();
    }
    function updateSelection() {
      if (!allInput) return;
      const n = data.bookmarks.length;
      allInput.checked = n > 0 && selected.size === n;
      allInput.indeterminate = selected.size > 0 && selected.size < n;
      allInput.disabled = !n;
      deleteButton.disabled = !selected.size || !!storageError;
      deleteButton.textContent = selected.size ? `删除所选（${selected.size}）` : '删除所选';
    }
    function deleteIds(ids) {
      if (mutate(raw => removeBookmarks(raw, ids))) {
        ids.forEach(id => selected.delete(id));
        render(); toast(`已删除 ${ids.size} 条标记`);
      }
    }
    function render() {
      if (!panel) return;
      countNode.textContent = `共 ${data.bookmarks.length} 个标记`;
      listNode.replaceChildren();
      if (!data.bookmarks.length) listNode.append(element('p', 'bdb-muted', '暂无标记。打开视频卡片的三点菜单即可添加。'));
      for (const b of data.bookmarks) {
        const row = element('div', 'bdb-row');
        const check = element('input'); check.type = 'checkbox'; check.checked = selected.has(b.id);
        check.setAttribute('aria-label', `选择标记：${b.title}`);
        check.addEventListener('change', () => { check.checked ? selected.add(b.id) : selected.delete(b.id); updateSelection(); });
        const body = element('div', 'bdb-row-body');
        const title = element('div', 'bdb-title', b.title); title.title = b.title;
        body.append(title, element('div', 'bdb-muted', b.author), element('time', 'bdb-muted', formatTime(b.ts, true)));
        const actions = element('div', 'bdb-actions');
        actions.append(button('返回视频', () => restore(b)), button('删除标记', () => deleteIds(new Set([b.id])), 'bdb-danger'));
        body.append(actions); row.append(check, body); listNode.append(row);
      }
      updateSelection();
      stopButton.hidden = !running;
      setText(statusNode, status);
    }
    function mount() {
      if (panel?.isConnected) return;
      const right = doc.querySelector('aside.right');
      if (!right) return;
      if (!panel) {
        panel = element('section'); panel.id = 'bdb-panel'; panel.setAttribute('aria-label', '视频标记');
        const head = element('div', 'bdb-head');
        head.append(element('h2', '', '视频标记'), element('span', 'bdb-version', `版本 ${VERSION}`));
        countNode = element('div', 'bdb-muted');
        const actions = element('div', 'bdb-actions');
        actions.append(button('回到视频', chooseTarget, 'bdb-primary'));
        stopButton = button('停止定位', () => cancel()); stopButton.hidden = true; actions.append(stopButton);
        const manage = element('div', 'bdb-actions'); const label = element('label', 'bdb-selectall');
        allInput = element('input'); allInput.type = 'checkbox';
        allInput.addEventListener('change', () => {
          selected.clear(); if (allInput.checked) data.bookmarks.forEach(b => selected.add(b.id)); render();
        });
        label.append(allInput, doc.createTextNode('全选'));
        deleteButton = button('删除所选', () => deleteIds(new Set(selected)), 'bdb-danger'); manage.append(label, deleteButton);
        listNode = element('div', 'bdb-list');
        statusNode = element('div', 'bdb-status'); statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
        panel.append(head, countNode, actions, manage, listNode, statusNode);
      }
      // 与热搜并列的独立模块，不向热搜组件内部插入内容。
      right.append(panel); render();
    }
    function closeDialog() { overlay?.remove(); overlay = null; }
    function dialog(title, text, choices = []) {
      closeDialog();
      const previousFocus = doc.activeElement;
      overlay = element('div', 'bdb-overlay');
      const box = element('div', 'bdb-dialog'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      const heading = element('h2', '', title); heading.id = 'bdb-dialog-title'; box.setAttribute('aria-labelledby', heading.id);
      box.append(heading, element('p', '', text));
      const close = button('关闭', () => { closeDialog(); previousFocus?.focus?.(); });
      for (const c of choices) box.append(button(`${c.title}\n${c.author} · ${formatTime(c.ts, true)}`, () => { closeDialog(); restore(c); }, 'bdb-choice'));
      box.append(close); overlay.append(box); doc.body.append(overlay); close.focus();
    }
    function chooseTarget() {
      if (running) return toast('正在定位，请先停止当前定位。');
      if (storageError) return dialog('无法读取标记', storageError);
      if (!data.bookmarks.length) return toast('请先从视频卡片的三点菜单添加标记。');
      if (data.bookmarks.length === 1) return restore(data.bookmarks[0]);
      dialog('选择要返回的视频', '请选择一个标记开始定位。勾选框仅用于批量删除。', data.bookmarks);
    }
    function cancel(notify = true) {
      token++; running = false;
      if (stopButton) stopButton.hidden = true;
      if (notify) report('已停止定位，标记仍然保留。');
    }
    function focusCard(meta) {
      const card = cardFor(meta.id);
      if (!card || !card.querySelector('.bili-dyn-card-video') || !card.getClientRects().length) return false;
      doc.querySelectorAll('.bdb-highlight').forEach(c => c.classList.remove('bdb-highlight'));
      card.classList.add('bdb-highlight');
      card.style.scrollMarginTop = '88px';
      card.scrollIntoView({ block: 'start', behavior: 'instant' });
      page.setTimeout(() => card.classList.remove('bdb-highlight'), 10000);
      return true;
    }
    async function restore(target) {
      if (!account) return toast('请先登录，等待账号数据加载。');
      if (running) return toast('正在定位，请先停止当前定位。');
      if (!enabled()) return;
      running = true; const mine = ++token, uid = account;
      const live = () => !disposed && running && mine === token && enabled() && account === uid;
      let pages = 0, crossed = false, retries = 0;
      render();
      report(`正在加载视频……\n目标：${target.title}`);
      try {
        while (live()) {
          scan();
          const vm = listVm();
          if (!vm) throw new Error('未读取到网页动态数据，可能是网站结构发生变化。请刷新后重试。');
          if (vm.user?.mid && String(vm.user.mid) !== uid) throw new Error('登录账号发生变化，已停止定位。');
          const current = records(), end = ['NO_MORE', 'EMPTY'].includes(vm.status);
          const decision = classify(current, target, end);
          if (decision.kind === 'exact') {
            if (!focusCard(decision.record)) {
              throw new Error('目标动态已加载，但视频卡片被过滤、折叠或不可见。请检查其他脚本及动态过滤设置。');
            }
            report(`已回到标记视频：${target.title}`); return;
          }
          const oldest = current.length ? Math.min(...current.map(r => r.ts)) : null;
          report(`正在加载视频……已追加 ${pages} 批\n${oldest ? `已加载至：${formatTime(oldest, true)}` : '正在等待视频时间数据'}\n目标：${formatTime(target.ts, true)}`);
          // 覆盖时间两侧后再取一批，减少边界相同秒数、少量乱序带来的误判。
          if ((decision.kind === 'covered' && (crossed || end)) || decision.kind === 'end') {
            const cardMap = new Map([...doc.querySelectorAll(CARD)].map(c => [c.getAttribute('data-did') || c.dataset.bdbId, c]));
            const visible = current.filter(r => {
              const c = cardMap.get(r.id); return c?.querySelector('.bili-dyn-card-video') && c.getClientRects().length;
            });
            const candidate = nearest(visible, target);
            if (!candidate || !focusCard(candidate)) throw new Error('目标附近没有可见的视频卡片，可能被页面过滤。');
            report(`未找到原动态，已回到附近视频：${candidate.title}`);
            dialog('未找到原标记的视频', `该视频可能已失效、被删除，或已从当前动态列表消失。已定位到当前已加载范围内投稿时间最接近的可见视频「${candidate.title}」（${formatTime(candidate.ts, true)}），请自行确认。原标记仍然保留。`);
            return;
          }
          if (end) throw new Error('已到达网页当前可提供的历史末尾，尚未覆盖标记时间，无法完成查找。不能据此判断视频已删除。');
          if (pages >= options.maxPages) throw new Error(`已追加 ${options.maxPages} 批，达到本次定位上限。可再次点击返回继续查找，原标记仍然保留。`);
          if (vm.status === 'ERROR') {
            if (retries++ >= options.maxRetries) throw new Error('网页连续加载失败，已停止定位。请稍后重试，不能据此判断视频已删除。');
            report(`加载失败，正在重试（${retries}/${options.maxRetries}）……\n${oldest ? `已加载至：${formatTime(oldest, true)}` : ''}`);
            await sleep(Math.max(1000, options.poll));
            if (!live()) return;
          }
          const signature = () => `${vm.list.length}:${vm.offset || ''}:${vm.list.at(-1)?.id_str || ''}`;
          const before = signature();
          const wasCovered = decision.kind === 'covered';
          if (pages && options.pageDelay) { await sleep(options.pageDelay); if (!live()) return; }
          if (vm.status !== 'LOADING') {
            // 调用网页现有的加载方法，不另建接口请求或修改分页游标。
            const request = vm.loadmore();
            if (request?.catch) request.catch(() => {});
          }
          const started = Date.now(); let advanced = false;
          while (live()) {
            await sleep(options.poll);
            if (!live()) return;
            if (listVm() !== vm) throw new Error('动态列表已切换，定位已停止，请在视频投稿页重新操作。');
            if (signature() !== before) advanced = true;
            if (vm.status !== 'LOADING' && (advanced || ['ERROR', 'NO_MORE', 'EMPTY'].includes(vm.status))) break;
            if (Date.now() - started > options.requestTimeout) throw new Error('等待网页加载超时，已停止定位。网络恢复后可再次尝试，原标记仍然保留。');
            if ((Date.now() - started) > 5000) report(`正在等待网页响应……已等待 ${Math.floor((Date.now() - started) / 1000)} 秒\n${oldest ? `已加载至：${formatTime(oldest, true)}` : ''}`);
          }
          if (advanced) { pages++; retries = 0; crossed = wasCovered; }
        }
      } catch (e) { if (live()) { report(e.message); toast(e.message); } }
      finally { if (mine === token) { running = false; if (stopButton) stopButton.hidden = true; } }
    }
    function scan() {
      scheduled = null;
      if (disposed) return;
      if (!enabled()) {
        if (running) cancel(false);
        closeDialog(); panel?.remove();
        doc.querySelectorAll('.bdb-exact, .bdb-menu-item').forEach(e => e.remove());
        doc.querySelectorAll('.bdb-time, .bdb-highlight').forEach(e => e.classList.remove('bdb-time', 'bdb-highlight'));
        return;
      }
      mount();
      const vm = listVm();
      const uid = vm?.user?.mid != null ? String(vm.user.mid) : '';
      switchAccount(validId(uid) && uid !== '0' ? uid : '');
      if (!vm) {
        report('正在等待网页动态数据；若长时间无变化，请刷新或检查页面兼容性。');
        return;
      }
      const byId = new Map(records().map(r => [r.id, r]));
      for (const card of doc.querySelectorAll(CARD)) {
        const meta = cardMeta(card, byId);
        if (!meta) continue;
        card.dataset.bdbId = meta.id;
        const time = card.querySelector('.bili-dyn-item__header .bili-dyn-time');
        if (time) {
          let exact = time.querySelector('.bdb-exact');
          if (!exact) { exact = element('span', 'bdb-exact'); time.append(exact); }
          const nowYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear();
          const year = new Date((meta.ts + 8 * 3600) * 1000).getUTCFullYear();
          setText(exact, ` · ${formatTime(meta.ts, nowYear !== year)}`);
          exact.title = `当前动态投稿时间（北京时间）：${formatTime(meta.ts, true)}`;
          if (!time.classList.contains('bdb-time')) time.classList.add('bdb-time');
        }
        const menu = card.querySelector('.bili-dyn-item__header .bili-cascader-options');
        if (menu) {
          let item = menu.querySelector('.bdb-menu-item');
          if (!item) {
            item = button('', e => {
              e.preventDefault(); e.stopPropagation();
              const current = records().find(r => r.id === card.dataset.bdbId);
              if (!current) return toast('暂时无法读取该视频的数据，请稍后重试。');
              if (mutate(raw => addBookmark(raw, current))) toast('已保存视频标记');
            }, 'bili-cascader-options__item bdb-menu-item');
            menu.append(item);
          }
          const marked = data.bookmarks.some(b => b.id === meta.id);
          setText(item, marked ? '已标记此视频' : '标记此视频');
          item.disabled = marked || !account || !!storageError;
        }
      }
      if (vm && !byId.size && vm.list.length) report('暂未取得可用的视频时间数据，可能需要适配新版网页。');
    }
    function schedule() {
      if (!disposed && scheduled == null) scheduled = page.setTimeout(scan, 180);
    }
    function onKey(e) {
      if (!overlay) return;
      if (e.key === 'Escape') { closeDialog(); return; }
      if (e.key === 'Tab') {
        const buttons = [...overlay.querySelectorAll('button')], first = buttons[0], last = buttons.at(-1);
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    function start() {
      const style = element('style'); style.id = 'bdb-style'; style.textContent = CSS;
      doc.head.append(style);
      observer = new page.MutationObserver(changes => {
        if (changes.some(m => {
          const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          if (target?.closest(OWN)) return false;
          return m.type === 'characterData' || [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType !== 1 || !n.matches?.(OWN));
        })) schedule();
      });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      doc.addEventListener('keydown', onKey);
      unbind.push(() => doc.removeEventListener('keydown', onKey));
      timer = page.setInterval(scan, 2000);
      scan();
      return api;
    }
    function dispose() {
      disposed = true; cancel(false); observer?.disconnect();
      page.clearInterval(timer); page.clearTimeout(scheduled);
      if (listener != null) storage.unlisten?.(listener);
      unbind.forEach(fn => fn()); closeDialog(); panel?.remove();
      doc.querySelectorAll('.bdb-exact, .bdb-menu-item, #bdb-style, #bdb-toast').forEach(e => e.remove());
      doc.querySelectorAll('.bdb-time, .bdb-highlight').forEach(e => e.classList.remove('bdb-time', 'bdb-highlight'));
    }
    const api = { start, scan, restore, cancel, dispose, getState: () => ({ account, data, running, status }) };
    return api;
  }

  const CSS = `
    #bdb-panel {box-sizing:border-box;background:var(--bg1,#fff);color:var(--text1,#18191c);border:1px solid var(--line_regular,#e3e5e7);border-radius:8px;margin-top:12px;padding:16px;width:100%;font:13px/1.6 system-ui,sans-serif;text-align:left}
    #bdb-panel *, .bdb-dialog * {box-sizing:border-box}
    .bdb-head {display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
    #bdb-panel h2,.bdb-dialog h2 {font-size:16px;font-weight:600;margin:0}
    .bdb-version,.bdb-muted {font-size:12px;color:var(--text3,#9499a0);overflow-wrap:anywhere}
    .bdb-actions {display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:10px 0}
    #bdb-panel button,.bdb-dialog button {font:inherit;cursor:pointer;border:1px solid var(--line_regular,#d9dce1);border-radius:5px;padding:4px 9px;background:var(--bg1,#fff);color:var(--text1,#18191c)}
    #bdb-panel button:hover,.bdb-dialog button:hover {border-color:#00aeec;color:#00aeec}
    #bdb-panel button:disabled {opacity:.5;cursor:default}
    #bdb-panel .bdb-primary {background:#00aeec;border-color:#00aeec;color:#fff}
    #bdb-panel .bdb-danger {color:#d64f62}
    .bdb-selectall {display:flex;align-items:center;gap:5px;cursor:pointer}
    #bdb-panel input {accent-color:#00aeec}
    .bdb-list {max-height:360px;overflow-y:auto;overscroll-behavior:contain}
    .bdb-row {display:flex;align-items:flex-start;gap:8px;padding:12px 0;border-top:1px solid var(--line_regular,#eee)}
    .bdb-row>input {margin-top:5px;flex:none}
    .bdb-row-body {min-width:0;flex:1}
    .bdb-title {font-weight:500;overflow-wrap:anywhere}
    .bdb-row .bdb-actions {margin:7px 0 0}
    .bdb-status {white-space:pre-line;border-top:1px solid var(--line_regular,#eee);padding-top:10px;font-size:12px;overflow-wrap:anywhere}
    .bdb-time.bili-ellipsis {white-space:normal!important;overflow:visible!important;text-overflow:clip!important}
    .bdb-exact {color:var(--text2,#61666d);white-space:nowrap}
    .bdb-menu-item {display:block;width:100%;text-align:left;background:none;border:0;font:inherit;color:inherit;cursor:pointer;padding:10px 16px;white-space:nowrap}
    .bdb-menu-item:hover {background:var(--bg2,#f1f2f3);color:#00aeec}
    .bdb-menu-item:disabled {color:var(--text3,#9499a0);cursor:default}
    .bdb-highlight {outline:3px solid #00aeec!important;outline-offset:4px;border-radius:6px}
    .bdb-overlay {position:fixed;inset:0;z-index:100001;background:#0007;display:flex;align-items:center;justify-content:center;padding:24px}
    .bdb-dialog {background:var(--bg1,#fff);color:var(--text1,#18191c);border-radius:12px;padding:24px;width:520px;max-width:100%;max-height:80vh;overflow:auto;font:14px/1.7 system-ui,sans-serif}
    .bdb-dialog p {white-space:pre-line;overflow-wrap:anywhere;margin:14px 0}
    .bdb-dialog .bdb-choice {display:block;width:100%;text-align:left;white-space:pre-line;overflow-wrap:anywhere;margin:10px 0}
    #bdb-toast {position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:100002;max-width:85vw;background:#202124ed;color:white;padding:12px 18px;border-radius:8px;font:14px/1.6 system-ui,sans-serif}
    #bdb-panel [hidden] {display:none!important}
  `;

  const exported = { VERSION, SCHEMA, formatTime, recordMeta, normalizeStore, addBookmark, removeBookmarks, nearest, classify, createApp };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = exported;
    return;
  }
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  if (page.document.getElementById('bdb-style')) return;
  const storage = {
    get: key => GM_getValue(key, null), set: (key, value) => GM_setValue(key, value),
    listen: (key, fn) => GM_addValueChangeListener(key, fn),
    unlisten: id => GM_removeValueChangeListener(id),
  };
  const app = createApp(page, storage).start();
  page.addEventListener('pagehide', event => { if (event.persisted) app.cancel(false); else app.dispose(); });
  page.addEventListener('pageshow', event => { if (event.persisted) app.scan(); });
})();
