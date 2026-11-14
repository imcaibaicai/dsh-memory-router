// dsh-memory-router — 设置页（browser half）
//
// 挂载点：slot `settings.section`（list），注册 id `memory-router`。
// 与 host 半通信走同源 fetch：/dsh-memory-router/{summary,notes,note,preview,forget}
// （按路径分端点，不用查询串做分发。）
//
// ⚠️ 样式必须在【工厂期同步注入】并**自己预打归属标记**（data-plugin + data-plugin-css）。
// 依据：dsh-client-modules 的 claimStyles(id) 在 factory 返回后同步认领所有
// `style:not([data-plugin])`；落在窗口之外的裸 <style> 会被随后加载的插件"偷走"并打上它的标记，
// 那个插件一热重载就把它连带删掉，而本插件不会重新 materialize，永远补不回来。
// 见 2026-10-11 dsh-core-memory 的整页样式退化事故。
window.__ModuleLoader__.load({
	id: 'dsh-memory-router',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		var React = require('react');
		var h = React.createElement;

		var STYLE_KEY = 'dsh-memory-router';
		var BASE = '/dsh-memory-router/';

		var CSS = [
			// 页面容器
			'.memr-page{display:flex;flex-direction:column;gap:16px;padding:2px 2px 28px;box-sizing:border-box;max-width:760px}',
			'.memr-page *{box-sizing:border-box}',
			'.memr-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);margin:0}',
			'.memr-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.6;margin-top:4px;word-break:break-all}',
			// 卡片
			'.memr-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
			'.memr-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
			'.memr-card-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);letter-spacing:.01em}',
			'.memr-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.65}',
			// 数字格
			'.memr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px}',
			'.memr-stat{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-base,transparent)}',
			'.memr-stat-k{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);letter-spacing:.04em}',
			'.memr-stat-v{font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums;margin-top:3px}',
			'.memr-stat-x{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);margin-top:2px}',
			// 预算条
			'.memr-bar{height:8px;border-radius:999px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.18));overflow:hidden;display:flex}',
			'.memr-bar > i{display:block;height:100%}',
			'.memr-bar-core{background:var(--dsw-alias-brand-primary,#4a7dff)}',
			'.memr-bar-index{background:var(--dsw-alias-state-success-primary,#30a46c)}',
			'.memr-bar-over{background:var(--dsw-alias-state-error-primary,#e5484d)}',
			'.memr-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}',
			'.memr-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}',
			// 表单
			'.memr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
			'.memr-field{display:flex;flex-direction:column;gap:4px}',
			'.memr-field > span{font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}',
			'.memr-input,.memr-select{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);padding:5px 9px;font-size:12px;font-family:inherit;transition:border-color .14s ease}',
			'.memr-input:focus,.memr-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
			'.memr-input.wide{min-width:220px;flex:1}',
			'.memr-input.num{width:88px;font-variant-numeric:tabular-nums}',
			'.memr-btn{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:5px 13px;font-size:12px;cursor:pointer;transition:background .14s ease,border-color .14s ease;font-family:inherit}',
			'.memr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}',
			'.memr-btn.primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4a7dff);color:#fff}',
			'.memr-btn.danger{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:currentColor}',
			'.memr-btn:disabled{opacity:.45;cursor:default}',
			'.memr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:1px}',
			// 记忆列表
			'.memr-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:10px;overflow:hidden}',
			'.memr-item{border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));padding:10px 12px;display:flex;flex-direction:column;gap:5px}',
			'.memr-item:first-child{border-top:0}',
			'.memr-item.off{opacity:.55}',
			'.memr-item-t{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);line-height:1.45}',
			'.memr-item-m{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums;word-break:break-all}',
			'.memr-item-s{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.55}',
			'.memr-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));color:var(--dsw-alias-label-secondary,inherit);margin-right:4px}',
			'.memr-pre{margin:0;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px;padding:10px 12px;max-height:340px;overflow:auto;color:var(--dsw-alias-label-primary,inherit);font-family:ui-monospace,Menlo,Consolas,monospace}',
			// 状态
			'.memr-err{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11.5px;line-height:1.6}',
			'.memr-ok{color:var(--dsw-alias-state-success-primary,#30a46c);font-size:11.5px;line-height:1.6}',
			'.memr-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);padding:14px;text-align:center}',
			'.memr-act{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}',
		].join('');

		/** 幂等地把样式表挂进 document.head（工厂期一次，apply 期兜一次）。 */
		function installStyles() {
			if (typeof document === 'undefined') return;
			var selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_KEY) + ']';
			if (document.querySelector(selector) !== null) return;
			var style = document.createElement('style');
			style.dataset.plugin = STYLE_KEY;      // 归属标记：内核凭它认领与清理，绝不外借
			style.dataset.pluginCss = STYLE_KEY;
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		installStyles();

		// ── 数据访问 ──────────────────────────────────────────────
		function api(path, params) {
			var qs = '';
			if (params) {
				var parts = [];
				for (var key in params) {
					if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null && params[key] !== '') {
						parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
					}
				}
				if (parts.length > 0) qs = '?' + parts.join('&');
			}
			return fetch(BASE + path + qs, { headers: { accept: 'application/json' } }).then(function (response) {
				return response.json().then(function (json) {
					if (!response.ok) throw new Error((json && json.error) ? json.error : ('HTTP ' + response.status));
					return json;
				});
			});
		}
		function post(path, body) {
			return fetch(BASE + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
			}).then(function (response) {
				return response.json().then(function (json) {
					if (!response.ok) throw new Error((json && json.error) ? json.error : ('HTTP ' + response.status));
					return json;
				});
			});
		}

		// ── 展示辅助 ──────────────────────────────────────────────
		function pct(part, whole) { return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0; }
		function fmtDate(value) { return String(value || '').slice(0, 16).replace('T', ' '); }
		function fmtSize(bytes) {
			var n = Number(bytes) || 0;
			return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
		}

		function Stat(props) {
			return h('div', { className: 'memr-stat' },
				h('div', { className: 'memr-stat-k' }, props.k),
				h('div', { className: 'memr-stat-v' }, props.v),
				props.x ? h('div', { className: 'memr-stat-x' }, props.x) : null);
		}

		function MemorySection() {
			var summaryState = React.useState(null);
			var summary = summaryState[0], setSummary = summaryState[1];
			var errorState = React.useState(null);
			var error = errorState[0], setError = errorState[1];
			var noticeState = React.useState(null);
			var notice = noticeState[0], setNotice = noticeState[1];
			var busyState = React.useState(false);
			var busy = busyState[0], setBusy = busyState[1];

			// 记忆浏览
			var queryState = React.useState('');
			var query = queryState[0], setQuery = queryState[1];
			var scopeState = React.useState('all');
			var scope = scopeState[0], setScope = scopeState[1];
			var rowsState = React.useState(null);
			var rows = rowsState[0], setRows = rowsState[1];
			var openState = React.useState({});
			var opened = openState[0], setOpened = openState[1];

			// 预算模拟
			var simState = React.useState(null);
			var sim = simState[0], setSim = simState[1];

			function loadSummary() {
				return api('summary').then(function (data) { setSummary(data); setError(null); }, function (e) { setError(String(e.message || e)); });
			}
			function loadRows(nextQuery, nextScope) {
				return api('notes', { query: nextQuery || '', scope: nextScope || 'all', limit: 60 }).then(function (data) {
					setRows(data);
				}, function (e) { setError(String(e.message || e)); });
			}
			React.useEffect(function () {
				loadSummary().then(function () { return loadRows('', 'all'); });
			}, []);

			function toggleNote(id) {
				if (opened[id] !== undefined) {
					var copy = { ...opened };
					delete copy[id];
					setOpened(copy);
					return;
				}
				api('note', { id: id }).then(function (note) {
					var copy = { ...opened };
					copy[id] = note;
					setOpened(copy);
				}, function (e) { setError(String(e.message || e)); });
			}

			function forget(id, title) {
				if (typeof window !== 'undefined' && window.confirm && !window.confirm('确定把「' + title + '」标记为失效？\n文件会保留（可追溯），只是不再注入与列出。')) return;
				setBusy(true);
				post('forget', { id: id, mode: 'soft' }).then(function (result) {
					setNotice(result.message || '已标记失效');
					setError(null);
					return loadSummary().then(function () { return loadRows(query, scope); });
				}, function (e) { setError(String(e.message || e)); }).then(function () { setBusy(false); });
			}

			function runPreview(nextCore, nextIndex, nextLines) {
				var core = (nextCore !== undefined ? nextCore : (sim && sim.core)) || (summary && summary.budget.coreBudgetChars);
				var index = (nextIndex !== undefined ? nextIndex : (sim && sim.index)) || (summary && summary.budget.indexBudgetChars);
				var lines = (nextLines !== undefined ? nextLines : (sim && sim.lines)) || (summary && summary.budget.indexMaxLines);
				return api('preview', { core: core, index: index, lines: lines }).then(function (data) {
					setSim({ core: core, index: index, lines: lines, chars: data.chars, stats: data.stats, text: data.text, showText: sim && sim.showText });
				}, function (e) { setError(String(e.message || e)); });
			}

			var children = [];

			children.push(h('div', { key: 'head' },
				h('h3', { className: 'memr-title' }, '跨会话记忆'),
				h('div', { className: 'memr-sub' },
					'分层披露：核心记忆 + 归档索引常驻注入；每轮按话题自动召回命中正文；正文按需检索。'
					+ (summary ? '　记忆库：' + summary.dir : ''))));

			if (error !== null) children.push(h('div', { className: 'memr-err', key: 'err' }, '出错：' + error));
			if (notice !== null) children.push(h('div', { className: 'memr-ok', key: 'ok' }, notice));

			// ① 概览
			if (summary !== null) {
				var budgetTotal = summary.budget.coreBudgetChars + summary.budget.indexBudgetChars;
				var coreChars = summary.l0.coreChars;
				var indexChars = Math.max(0, summary.l0.chars - coreChars);
				var overviewChildren = [
					h('div', { className: 'memr-card-head', key: 'h' },
						h('div', { className: 'memr-card-title' }, '概览'),
						h('button', { className: 'memr-btn', key: 'r', onClick: function () { loadSummary(); loadRows(query, scope); }, disabled: busy }, '刷新')),
					h('div', { className: 'memr-stats', key: 's' },
						h(Stat, { key: 'a', k: '归档记忆', v: summary.notes, x: fmtSize(summary.bytes) + ' 正文' }),
						h(Stat, { key: 'b', k: '已失效', v: summary.superseded, x: '保留可追溯' }),
						h(Stat, { key: 'c', k: '从未命中', v: summary.cold, x: '超过 ' + summary.budget.coldDays + ' 天则降级出索引' }),
						h(Stat, { key: 'd', k: '常驻注入', v: summary.l0.chars, x: '预算 ' + budgetTotal + ' 字符' }),
						h(Stat, { key: 'e', k: '核心记忆', v: summary.core.rawChars, x: summary.core.sections.length + ' 个分节' })),
					h('div', { key: 'bar' },
						h('div', { className: 'memr-bar' },
							h('i', { className: 'memr-bar-core', style: { width: pct(coreChars, budgetTotal) + '%' } }),
							h('i', { className: 'memr-bar-index', style: { width: pct(indexChars, budgetTotal) + '%' } })),
						h('div', { className: 'memr-legend', style: { marginTop: '8px' } },
							h('span', null, h('i', { className: 'memr-bar-core' }), '核心 ' + coreChars + ' 字符'),
							h('span', null, h('i', { className: 'memr-bar-index' }), '索引 ' + indexChars + ' 字符'),
							h('span', null, '索引列出 ' + summary.l0.indexListed + '/' + summary.l0.indexTotal + ' 行'),
							summary.l0.truncated > 0 ? h('span', null, '预算外 ' + summary.l0.truncated + ' 条') : null,
							summary.l0.croppedSections > 0 ? h('span', null, '裁剪分节 ' + summary.l0.croppedSections + ' 个') : null)),
					h('div', { className: 'memr-hint', key: 'sc' },
						'作用域分布：' + Object.keys(summary.byScope).map(function (key) { return key + '=' + summary.byScope[key]; }).join('　')
						+ '　｜　自动召回：' + (summary.budget.autoRecall ? '开（每轮最多 ' + summary.budget.recallTopK + ' 条，通道 ' + summary.budget.recallChannel + '）' : '关')),
				];
				children.push(h('div', { className: 'memr-card', key: 'overview' }, overviewChildren));

				// 核心记忆分节
				if (summary.core.sections.length > 0) {
					children.push(h('div', { className: 'memr-card', key: 'core' },
						h('div', { className: 'memr-card-title' }, '核心记忆分节（超预算时按 prio 从大到小保留）'),
						h('div', { className: 'memr-list' }, summary.core.sections.map(function (section, i) {
							return h('div', { className: 'memr-item', key: i },
								h('div', { className: 'memr-item-t' }, '## ' + section.title),
								h('div', { className: 'memr-item-m' }, 'prio=' + section.prio + '　' + section.chars + ' 字符'));
						})),
						h('div', { className: 'memr-hint' }, '改分节用模型工具 mem_edit_core；超预算的部分会在注入时被裁掉（磁盘全文始终完整）。')));
				}
			}

			// ② 预算模拟
			if (summary !== null) {
				var simCore = (sim && sim.core) || summary.budget.coreBudgetChars;
				var simIndex = (sim && sim.index) || summary.budget.indexBudgetChars;
				var simLines = (sim && sim.lines) || summary.budget.indexMaxLines;
				children.push(h('div', { className: 'memr-card', key: 'sim' },
					h('div', { className: 'memr-card-head' },
						h('div', { className: 'memr-card-title' }, '预算模拟（不影响真实配置）'),
						h('button', {
							className: 'memr-btn primary', key: 'go', disabled: busy,
							onClick: function () { setBusy(true); runPreview(simCore, simIndex, simLines).then(function () { setBusy(false); }); },
						}, '试算')),
					h('div', { className: 'memr-row' },
						h('label', { className: 'memr-field' }, h('span', null, '核心预算(字符)'),
							h('input', {
								className: 'memr-input num', type: 'number', min: '200', step: '500', value: simCore,
								onChange: function (e) { setSim({ ...(sim || {}), core: Number(e.target.value), index: simIndex, lines: simLines }); },
							})),
						h('label', { className: 'memr-field' }, h('span', null, '索引预算(字符)'),
							h('input', {
								className: 'memr-input num', type: 'number', min: '0', step: '500', value: simIndex,
								onChange: function (e) { setSim({ ...(sim || {}), core: simCore, index: Number(e.target.value), lines: simLines }); },
							})),
						h('label', { className: 'memr-field' }, h('span', null, '索引行数上限'),
							h('input', {
								className: 'memr-input num', type: 'number', min: '0', step: '5', value: simLines,
								onChange: function (e) { setSim({ ...(sim || {}), core: simCore, index: simIndex, lines: Number(e.target.value) }); },
							}))),
					sim !== null && sim.stats ? h('div', { className: 'memr-hint' },
						'这一档会注入 ' + sim.chars + ' 字符：核心 ' + sim.stats.coreChars + ' 字符'
						+ '（裁剪 ' + sim.stats.croppedSections + ' 个分节）　索引列出 ' + sim.stats.indexListed + '/' + sim.stats.indexTotal + ' 行'
						+ '　未列出 ' + (sim.stats.truncated + sim.stats.cold + sim.stats.otherScope) + ' 条') : null,
					sim !== null && sim.text ? h('div', null,
						h('button', {
							className: 'memr-btn',
							onClick: function () { setSim({ ...sim, showText: !sim.showText }); },
						}, sim.showText ? '收起注入全文' : '查看注入全文'),
						sim.showText ? h('pre', { className: 'memr-pre', style: { marginTop: '10px' } }, sim.text) : null) : null,
					h('div', { className: 'memr-hint' }, '真实预算写在 profile 的 cordis.patch.yml 里（本插件的 config）；改完重启生效。这里的试算只是让你看到取舍，不会写盘。')));
			}

			// ③ 记忆浏览
			var scopeOptions = [{ value: 'all', label: '全部作用域' }, { value: 'global', label: '仅全局' }];
			if (summary !== null) {
				summary.scopes.forEach(function (value) {
					if (value !== 'global') scopeOptions.push({ value: value, label: value });
				});
			}
			children.push(h('div', { className: 'memr-card', key: 'browse' },
				h('div', { className: 'memr-card-head' },
					h('div', { className: 'memr-card-title' }, '记忆浏览'
						+ (rows !== null ? '（' + rows.rows.length + ' / 共 ' + rows.total + ' 条）' : '')),
					h('div', { className: 'memr-row', key: 'c' },
						h('input', {
							className: 'memr-input wide', placeholder: '关键词检索（中文按单字+二字组，回车执行）', value: query,
							onChange: function (e) { setQuery(e.target.value); },
							onKeyDown: function (e) { if (e.key === 'Enter') { setBusy(true); loadRows(query, scope).then(function () { setBusy(false); }); } },
						}),
						h('select', {
							className: 'memr-select', value: scope,
							onChange: function (e) { setScope(e.target.value); setBusy(true); loadRows(query, e.target.value).then(function () { setBusy(false); }); },
						}, scopeOptions.map(function (option) { return h('option', { key: option.value, value: option.value }, option.label); })),
						h('button', {
							className: 'memr-btn', disabled: busy,
							onClick: function () { setBusy(true); loadRows(query, scope).then(function () { setBusy(false); }); },
						}, '检索'))),
				rows === null ? h('div', { className: 'memr-empty' }, '加载中…')
					: rows.rows.length === 0 ? h('div', { className: 'memr-empty' }, '没有匹配的记忆')
						: h('div', { className: 'memr-list' }, rows.rows.map(function (row) {
							var note = opened[row.id];
							var itemChildren = [
								h('div', { className: 'memr-item-t', key: 't' }, row.title),
								h('div', { className: 'memr-item-m', key: 'm' },
									'[' + row.id + ']　' + (row.scope || 'global')
									+ '　命中 ' + row.hits + (row.score !== undefined ? '　相关度 ' + row.score : '')
									+ '　' + fmtDate(row.created)
									+ (row.status === 'superseded' ? '　⚠ 已失效' : '')
									+ '　' + fmtSize(row.chars)),
							];
							if (row.summary && row.summary !== row.title) itemChildren.push(h('div', { className: 'memr-item-s', key: 's' }, row.summary));
							if (row.tags && row.tags.length > 0) {
								itemChildren.push(h('div', { key: 'g' }, row.tags.slice(0, 6).map(function (tag, i) {
									return h('span', { className: 'memr-tag', key: i }, tag);
								})));
							}
							itemChildren.push(h('div', { className: 'memr-row', key: 'a' },
								h('button', { className: 'memr-btn', onClick: function () { toggleNote(row.id); } }, note ? '收起正文' : '查看正文'),
								row.status !== 'superseded' ? h('button', {
									className: 'memr-btn danger', disabled: busy,
									onClick: function () { forget(row.id, row.title); },
								}, '标记失效') : null));
							if (note) itemChildren.push(h('pre', { className: 'memr-pre', key: 'b' }, note.body || '（正文为空）'));
							return h('div', { className: 'memr-item' + (row.status === 'superseded' ? ' off' : ''), key: row.id }, itemChildren);
						})),
				h('div', { className: 'memr-hint' }, '这里只读与「标记失效」；写记忆仍由模型用 mem_save 完成（写入时会给你摘要、关键词与去重提示）。')));

			// ④ 最近活动
			if (summary !== null && summary.recent) {
				var lines = [];
				if (summary.recent.l0) {
					lines.push('L0 注入：' + summary.recent.l0.chars + ' 字符，列出 ' + summary.recent.l0.indexListed + ' 行（'
						+ fmtDate(summary.recent.l0.at) + '）');
				}
				if (summary.recent.recall) {
					lines.push('自动召回：' + summary.recent.recall.chars + ' 字符、命中 ' + ((summary.recent.recall.ids || []).length) + ' 条（'
						+ fmtDate(summary.recent.recall.at) + '）'
						+ ((summary.recent.recall.ids || []).length > 0 ? ' → ' + summary.recent.recall.ids.join('、') : ''));
				}
				var totals = summary.recent.totals || {};
				lines.push('累计：L0 注入 ' + (totals.l0 || 0) + ' 次　自动召回 ' + (totals.recall || 0) + ' 次　写入 ' + (totals.saves || 0) + ' 次　检索 ' + (totals.searches || 0) + ' 次');
				children.push(h('div', { className: 'memr-card', key: 'act' },
					h('div', { className: 'memr-card-title' }, '最近活动（记账）'),
					h('div', { className: 'memr-act' }, lines.map(function (line, i) { return h('div', { key: i }, line); })),
					h('div', { className: 'memr-hint' }, '业界没有公开的注入预算标准值，所以调预算的依据就是这份记账。')));
			}

			return h('div', { className: 'memr-page' }, children);
		}

		exports.inject = ['slots'];
		exports.apply = function apply(ctx) {
			var slots = ctx.get('slots');
			if (slots === undefined) return;
			// 双保险：万一 fiber 存活期间样式被其它清理路径扫掉，apply 时补回（幂等）。
			installStyles();
			ctx.effect(function () {
				return slots.inject('settings.section', function () {
					return slots.register(
						{ name: 'settings.section', id: 'memory-router', order: 18, label: '跨会话记忆' },
						MemorySection
					);
				});
			}, 'dsh-memory-router: memory settings section');
		};
		return module.exports;
	},
});
