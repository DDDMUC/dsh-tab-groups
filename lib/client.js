/**
 * dsh-tab-groups · browser half.
 *
 * Two seats in the DSH Web GUI, both talking to the companion browser extension
 * over Chromium's `externally_connectable` bridge:
 *
 *   1. an official **settings section** (设置 → DSH 标签页), registered through
 *      `ctx.slots.inject('settings.section', …)` — the place the DSH ecosystem
 *      puts a plugin's own controls, and the place people look for them;
 *   2. a small floating **status chip**, which exists because the settings
 *      section is useless in the one state that matters most: when the
 *      extension is not installed yet, or has just gone away. The chip is
 *      visible from the conversation and opens itself with the install guide.
 *      It stays out of the way otherwise (a lone status dot, hideable for the
 *      current page load).
 *
 * There is no build step: this file is the shipped artifact. It follows the Web
 * GUI module-loader contract — the loader calls the factory once and takes the
 * exports as the client module (`apply`, `inject`).
 */

window.__ModuleLoader__.load({
	id: 'dsh-tab-groups',
	// The loader hands the factory a `require` resolving the shell's externals —
	// that is how a no-build client half gets React (see dsh-free-search).
	//
	// If anything in here throws, the shell reports only a bare
	// "web boot: 1 entry did not activate / dsh-tab-groups: failed" and swallows
	// the cause, so the risky steps (React, the slots registry) are guarded.
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const TAG = '[dsh-tab-groups]'

		/**
		 * React, when the shell exposes it.
		 *
		 * Only the settings section needs it; the chip is plain DOM. If the
		 * external is missing (an older shell, a changed module id) the section
		 * is simply not registered and the chip still works — a plugin must
		 * degrade, not explode.
		 */
		const React = (() => {
			try {
				return typeof require === 'function' ? require('react') : null
			} catch {
				return null
			}
		})()

		/**
		 * The companion extension's id.
		 *
		 * Pinned by the `key` field in the extension manifest (see
		 * `tools/make-key.mjs`), so it does not depend on where the extension
		 * folder lives. `test/pairing.test.mjs` asserts this literal, the
		 * manifest key and `src/extension-id.js` all agree.
		 */
		const EXTENSION_ID = 'pnncehmieeobfabnbdepbldiknndjbhl'

		/** Protocol version this half speaks. */
		const PROTOCOL_VERSION = 1

		/**
		 * Fixed mirror directory the host half maintains — it resolves `$DSH_HOME`
		 * (default `~/.dsh`), which a page cannot read, so the guide names the
		 * default and mentions the override.
		 */
		const INSTALL_DIR = '~/.dsh/dsh-tab-groups-extension'

		const HOST_ID = 'dsh-tab-groups-bridge'
		const COLLAPSE_KEY = 'dsh-tab-groups:collapsed'
		const POLL_MS = 15000
		const CALL_TIMEOUT_MS = 3000

		// ------------------------------------------------------------------
		// bridge: Chromium injects `chrome.runtime` into a page only when some
		// installed extension lists that page's origin in `externally_connectable`.
		// So "is chrome.runtime there?" *is* "is the extension installed?" — no
		// probing of extension URLs, no manifest hacks, no permissions.
		// ------------------------------------------------------------------

		/** @returns {object|null} the page-visible chrome.runtime API, if any. */
		function bridge() {
			const api = typeof globalThis.chrome === 'object' && globalThis.chrome !== null ? globalThis.chrome : null
			const runtime = api !== null && typeof api.runtime === 'object' ? api.runtime : null
			if (runtime === null || typeof runtime.sendMessage !== 'function') return null
			return runtime
		}

		/**
		 * Send one message to the extension.
		 *
		 * Never rejects: every failure mode (no bridge, no listener, timeout,
		 * an extension that answers with garbage) resolves to `{ok:false}`.
		 *
		 * @param {object} payload
		 * @param {number} [timeoutMs]
		 * @returns {Promise<object>}
		 */
		function call(payload, timeoutMs = CALL_TIMEOUT_MS) {
			return new Promise((resolve) => {
				const runtime = bridge()
				if (runtime === null) {
					resolve({ ok: false, error: 'no-bridge' })
					return
				}
				let settled = false
				const finish = (value) => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					resolve(value)
				}
				const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
				try {
					runtime.sendMessage(EXTENSION_ID, payload, (response) => {
						// Reading lastError is what keeps Chromium from logging an
						// unchecked-runtime-error warning when nothing answered.
						const failure = runtime.lastError
						if (failure) {
							finish({ ok: false, error: String(failure.message ?? failure) })
							return
						}
						finish(response !== undefined && response !== null ? response : { ok: false, error: 'empty-response' })
					})
				} catch (error) {
					finish({ ok: false, error: String(error?.message ?? error) })
				}
			})
		}

		const escapeHtml = (value) =>
			String(value ?? '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')

		const COLOR_LABELS = {
			grey: '灰',
			blue: '蓝',
			red: '红',
			yellow: '黄',
			green: '绿',
			pink: '粉',
			purple: '紫',
			cyan: '青',
			orange: '橙',
		}

		/** Markup of the chip and its panel, styled inside a shadow root. */
		const STYLES = `
			:host { all: initial; }
			.wrap {
				position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
				font: 12px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
				color: #1c1f23;
			}
			.chip {
				display: flex; align-items: center; gap: 6px;
				background: #fff; border: 1px solid #e4e6eb; border-radius: 999px;
				padding: 5px 11px 5px 9px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.12);
				user-select: none;
			}
			.chip:hover { border-color: #2f6bff; }
			/* Collapsed: a lone status dot. Expanded: the labelled pill. */
			.wrap.collapsed .chip { padding: 6px; }
			.wrap.collapsed .chip .label { display: none; }
			/* Hidden: gone for this page load (never persisted — see createChip). */
			.wrap.hidden { display: none; }
			.dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa1ab; flex: none; }
			.dot.ready { background: #22c55e; }
			.dot.missing { background: #f59e0b; }
			.dot.off { background: #9aa1ab; }
			.panel {
				width: 288px; margin-bottom: 8px; background: #fff; color: #1c1f23;
				border: 1px solid #e4e6eb; border-radius: 10px; padding: 12px;
				box-shadow: 0 6px 24px rgba(0,0,0,.16);
			}
			.panel[hidden] { display: none; }
			.title { font-weight: 600; font-size: 13px; margin: 0 0 8px; }
			.muted { color: #6b7280; }
			.err { color: #c0392b; }
			.ok { color: #1f9254; }
			ol { margin: 6px 0 8px; padding-left: 18px; }
			li { margin-bottom: 6px; }
			code {
				display: block; margin: 4px 0; padding: 5px 7px; background: #f6f7f9;
				border: 1px solid #e4e6eb; border-radius: 6px; word-break: break-all;
				font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
			}
			.row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
			.row > * { flex: 1; }
			button {
				font: inherit; color: #1c1f23; background: #f6f7f9; border: 1px solid #e4e6eb;
				border-radius: 7px; padding: 5px 10px; cursor: pointer;
			}
			button:hover { border-color: #2f6bff; }
			button.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; font-weight: 600; }
			button:disabled { opacity: .5; cursor: default; }
			input[type="text"], select {
				font: inherit; padding: 4px 7px; border: 1px solid #e4e6eb; border-radius: 6px;
				background: #f6f7f9; color: inherit; width: 100%;
			}
			label.inline { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
			label.inline input { flex: none; }
			.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
			.kv { display: flex; justify-content: space-between; gap: 8px; margin: 3px 0; }
			.kv b { font-weight: 600; }
			@media (prefers-color-scheme: dark) {
				.wrap { color: #e8eaed; }
				.chip, .panel { background: #17191d; border-color: #2c3038; }
				code, button, input[type="text"], select { background: #1f222a; border-color: #2c3038; color: #e8eaed; }
				.muted { color: #9aa1ab; }
				.ok { color: #4ade80; }
				.err { color: #f87171; }
			}
		`

		const SHELL = `
			<div class="panel" hidden></div>
			<div class="chip"><span class="dot"></span><span class="label">DSH 分组</span></div>
		`

		/**
		 * Build the chip host and return handles for driving it.
		 *
		 * The chip has three visible states, because the GUI corner is not ours to
		 * occupy permanently:
		 *
		 *   - expanded  the panel is open (guidance, or the user asked for status)
		 *   - collapsed a single status dot (the default once the extension is
		 *               connected — small enough to ignore, still one click away)
		 *   - hidden    nothing at all, for this page load only. Hiding is
		 *               deliberately *not* persisted: the chip is the plugin's only
		 *               surface, so a sticky hide would be a trap. A reload brings
		 *               it back, and a lost extension brings it back on its own.
		 *
		 * @param {Document} doc
		 * @returns {object|null} handles, or null when the DOM refuses.
		 */
		function createChip(doc) {
			if (doc === null || doc === undefined || typeof doc.createElement !== 'function') return null
			const existing = doc.getElementById(HOST_ID)
			if (existing !== null) existing.remove()

			const host = doc.createElement('div')
			host.id = HOST_ID
			const shadow = host.attachShadow({ mode: 'open' })
			const style = doc.createElement('style')
			style.textContent = STYLES
			const wrap = doc.createElement('div')
			wrap.className = 'wrap'
			wrap.innerHTML = SHELL
			shadow.append(style, wrap)
			doc.body.append(host)

			const chip = shadow.querySelector('.chip')
			const dot = shadow.querySelector('.dot')
			const panel = shadow.querySelector('.panel')

			let collapsed = true
			try {
				// Absent key means "never chose" → collapsed dot, not a 100px pill.
				collapsed = globalThis.localStorage?.getItem(COLLAPSE_KEY) !== '0'
			} catch {
				collapsed = true
			}
			let hidden = false

			const setCollapsed = (value, { persist = true } = {}) => {
				collapsed = value
				panel.hidden = value
				wrap.classList.toggle('collapsed', value)
				if (!persist) return
				try {
					globalThis.localStorage?.setItem(COLLAPSE_KEY, value ? '1' : '0')
				} catch {
					// A profile that refuses localStorage still gets the chip.
				}
			}
			const setHidden = (value) => {
				hidden = value
				wrap.classList.toggle('hidden', value)
				if (value) setCollapsed(true)
			}
			setCollapsed(collapsed)
			chip.addEventListener('click', () => {
				setHidden(false)
				setCollapsed(!collapsed)
			})

			return {
				host,
				shadow,
				panel,
				dot,
				/** Reveal the panel without touching the stored preference. */
				expand: () => setCollapsed(false, { persist: false }),
				collapse: () => setCollapsed(true),
				setHidden,
				isOpen: () => !collapsed,
				isHidden: () => hidden,
				remove: () => {
					try {
						host.remove()
					} catch {
						// Disposal is best effort.
					}
				},
			}
		}

		/** Render the "extension not detected" guide. */
		function renderGuide(ui, detail) {
			ui.dot.className = 'dot missing'
			// The guide is the one state that must be readable without a click, and
			// it must not overwrite the user's collapse preference.
			ui.expand()
			ui.panel.innerHTML = `
				<p class="title">配套浏览器扩展还没装上</p>
				<p class="muted">分组动作只能由浏览器扩展执行——DSH 页面拿不到标签组 API。装好它的这一半，芯片会立即变绿。</p>
				<ol>
					<li>地址栏打开 <code>edge://extensions</code>（Chrome 是 <code>chrome://extensions</code>），打开左下角「开发人员模式」。</li>
					<li>点「加载解压缩的扩展」，选择下面这个目录（Finder 里按 <code>Cmd+Shift+G</code> 粘贴路径）：</li>
				</ol>
				<code>${escapeHtml(INSTALL_DIR)}</code>
				<p class="muted" style="margin-top:2px">（如果你设过 <code>DSH_HOME</code>，镜像目录就在 <code>$DSH_HOME</code> 下，同名。）</p>
				<div class="row">
					<button data-act="copy">复制路径</button>
					<button data-act="recheck" class="primary">重新检测</button>
				</div>
				<p class="muted" style="margin-top:8px">检测方式：Chromium 只有在扩展声明了 <code>externally_connectable</code> 时才向本页面注入 <code>chrome.runtime</code>。</p>
				${detail ? `<p class="err" style="margin-top:6px">${escapeHtml(detail)}</p>` : ''}
				<p class="muted" data-role="note"></p>
			`
		}

		/** Render the live control panel. */
		function renderControls(ui, status) {
			ui.dot.className = status.enabled ? 'dot ready' : 'dot off'
			const lastRun = status.lastRun
			const when = lastRun?.at ? new Date(lastRun.at).toLocaleTimeString() : null
			const colorOptions = Object.keys(COLOR_LABELS)
				.map(
					(color) =>
						`<option value="${color}"${color === status.groupColor ? ' selected' : ''}>${COLOR_LABELS[color]}</option>`,
				)
				.join('')

			ui.panel.innerHTML = `
				<p class="title">DSH 标签页自动分组</p>
				<p class="muted">扩展 v${escapeHtml(status.version)} · 协议 v${PROTOCOL_VERSION}</p>
				<label class="inline"><input type="checkbox" data-field="enabled"${status.enabled ? ' checked' : ''} /><span>启用自动归组</span></label>
				<label class="inline"><input type="checkbox" data-field="dedicatedWindow"${status.dedicatedWindow ? ' checked' : ''} /><span>收进专属窗口</span></label>
				<div class="grid">
					<input type="text" data-field="groupTitle" value="${escapeHtml(status.groupTitle)}" placeholder="组名" />
					<select data-field="groupColor">${colorOptions}</select>
				</div>
				<div class="kv"><span class="muted">命中的 DSH 标签页</span><b>${status.matched}</b></div>
				<div class="kv"><span class="muted">待归组</span><b>${status.pending}</b></div>
				<div class="kv"><span class="muted">上次运行</span><b>${when ? `${escapeHtml(when)} · 归组 ${lastRun.moved}` : '—'}</b></div>
				${lastRun?.errors?.length ? `<p class="err">${escapeHtml(lastRun.errors.join('；'))}</p>` : ''}
				<div class="row">
					<button data-act="reconcile" class="primary">立即归组</button>
					<button data-act="refresh">刷新</button>
					<button data-act="hide" title="本次页面加载内隐藏，刷新即恢复">隐藏</button>
				</div>
				<p class="muted" style="margin-top:8px" data-role="note"></p>
			`
		}

		/* ------------------------------------------------ settings section ---- */

		/** Inline styles, so the card needs nothing from the shell's stylesheet. */
		const S = {
			card: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 8px' },
			head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
			title: { fontSize: '15px', fontWeight: 600, margin: 0 },
			muted: { color: 'var(--dsh-text-secondary, #6e6e73)', fontSize: '13px', margin: 0 },
			err: { color: '#c0392b', fontSize: '13px', margin: 0 },
			ok: { color: '#1f9254', fontSize: '13px', margin: 0 },
			row: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
			check: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '14px', cursor: 'pointer' },
			input: {
				font: 'inherit',
				padding: '5px 9px',
				border: '1px solid rgba(127,127,127,.35)',
				borderRadius: '7px',
				background: 'transparent',
				color: 'inherit',
				width: '180px',
			},
			button: {
				font: 'inherit',
				padding: '6px 12px',
				border: '1px solid rgba(127,127,127,.35)',
				borderRadius: '7px',
				background: 'transparent',
				color: 'inherit',
				cursor: 'pointer',
			},
			primary: {
				font: 'inherit',
				padding: '6px 12px',
				border: '1px solid #2f6bff',
				borderRadius: '7px',
				background: '#2f6bff',
				color: '#fff',
				fontWeight: 600,
				cursor: 'pointer',
			},
			code: {
				display: 'block',
				padding: '6px 8px',
				border: '1px solid rgba(127,127,127,.28)',
				borderRadius: '7px',
				background: 'rgba(127,127,127,.10)',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: '12px',
				wordBreak: 'break-all',
			},
			stats: { display: 'flex', gap: '20px', fontSize: '13px', flexWrap: 'wrap' },
		}

		/**
		 * The plugin's own settings page (设置 → DSH 标签页).
		 *
		 * Same controls as the chip, seated where the DSH ecosystem expects a
		 * plugin's settings to live. Everything is driven by the same
		 * `status` / `set-config` / `reconcile` protocol the chip uses.
		 */
		function SettingsSection() {
			const h = React.createElement
			const [phase, setPhase] = React.useState('loading')
			const [status, setStatus] = React.useState(null)
			const [detail, setDetail] = React.useState(null)
			const [note, setNote] = React.useState(null)
			const [busy, setBusy] = React.useState(false)

			const refresh = React.useCallback(async () => {
				const response = await call({ type: 'status' })
				if (!response.ok) {
					setPhase('missing')
					setDetail(response.error)
					setStatus(null)
					return response
				}
				setPhase('ready')
				setDetail(null)
				setStatus(response)
				return response
			}, [])

			React.useEffect(() => {
				void refresh()
			}, [refresh])

			// The extension's service worker sleeps when idle (MV3) and may
			// simply not be installed yet, so a single probe on mount is not
			// enough: without this the card can sit on a wrong "未检测到扩展"
			// for as long as the page is open. The chip polls for the same
			// reason.
			React.useEffect(() => {
				const timer = setInterval(() => void refresh(), POLL_MS)
				return () => clearInterval(timer)
			}, [refresh])

			const write = async (patch) => {
				setBusy(true)
				const response = await call({ type: 'set-config', config: patch })
				if (!response.ok) {
					setNote({ text: `保存失败：${response.error}`, bad: true })
					setBusy(false)
					return
				}
				await refresh()
				setBusy(false)
				setNote({ text: '已保存', bad: false })
				setTimeout(() => setNote(null), 4000)
			}

			const groupNow = async () => {
				setBusy(true)
				setNote({ text: '正在归组…', bad: false })
				const result = await call({ type: 'reconcile' })
				await refresh()
				setBusy(false)
				if (!result.ok) {
					setNote({ text: `归组失败：${result.error}`, bad: true })
					return
				}
				setNote({
					text: result.errors?.length
						? `归组 ${result.moved} 个，${result.errors.length} 处失败`
						: `已归组 ${result.moved} 个标签页`,
					bad: Boolean(result.errors?.length),
				})
			}

			const copyPath = async () => {
				try {
					await navigator.clipboard.writeText(INSTALL_DIR)
					setNote({ text: '已复制。到「加载解压缩的扩展」里选中它。', bad: false })
				} catch {
					setNote({ text: '复制失败，请手动输入上面的路径', bad: true })
				}
			}

			const children = [
				h(
					'div',
					{ key: 'head', style: S.head },
					h('p', { style: S.title }, 'DSH 标签页自动分组'),
					h(
						'p',
						{ style: S.muted },
						phase === 'ready'
							? `扩展 v${status.version} · 协议 v${status.protocol}`
							: phase === 'missing'
								? '未检测到配套浏览器扩展'
								: '正在检测…',
					),
				),
			]

			if (phase === 'missing') {
				children.push(
					h(
						'div',
						{ key: 'guide', style: S.card },
						h(
							'p',
							{ style: S.muted },
							'分组动作只能由浏览器扩展执行——DSH 页面拿不到标签组 API。装好它的这一半，本页会立即变成已连接。',
						),
						h(
							'ol',
							{ style: { margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: 1.7 } },
							h('li', null, '地址栏打开 edge://extensions（Chrome 是 chrome://extensions），打开左下角「开发人员模式」。'),
							h('li', null, '点「加载解压缩的扩展」，选择下面这个目录。'),
						),
						h('code', { style: S.code }, INSTALL_DIR),
						h(
							'div',
							{ style: S.row },
							h('button', { style: S.button, onClick: copyPath }, '复制路径'),
							h('button', { style: S.primary, onClick: () => void refresh() }, '重新检测'),
						),
						detail ? h('p', { style: S.err }, `扩展没有响应：${detail}`) : null,
					),
				)
			}

			if (phase === 'ready') {
				children.push(
					h(
						'label',
						{ key: 'enabled', style: S.check },
						h('input', {
							type: 'checkbox',
							checked: status.enabled,
							disabled: busy,
							onChange: (event) => void write({ enabled: event.target.checked }),
						}),
						'启用自动归组',
					),
					h(
						'label',
						{ key: 'window', style: S.check },
						h('input', {
							type: 'checkbox',
							checked: status.dedicatedWindow,
							disabled: busy,
							onChange: (event) => void write({ dedicatedWindow: event.target.checked }),
						}),
						'把所有 DSH 标签页收进一个专属窗口（该窗口里只有 DSH 标签页）',
					),
					h(
						'div',
						{ key: 'appearance', style: S.row },
						h('input', {
							type: 'text',
							style: S.input,
							defaultValue: status.groupTitle,
							disabled: busy,
							'aria-label': '组名',
							onBlur: (event) => void write({ groupTitle: event.target.value }),
						}),
						h(
							'select',
							{
								style: S.input,
								value: status.groupColor,
								disabled: busy,
								'aria-label': '组颜色',
								onChange: (event) => void write({ groupColor: event.target.value }),
							},
							...Object.keys(COLOR_LABELS).map((color) =>
								h('option', { key: color, value: color }, COLOR_LABELS[color]),
							),
						),
					),
					h(
						'div',
						{ key: 'stats', style: S.stats },
						h('span', null, `命中的 DSH 标签页 ${status.matched}`),
						h('span', null, `待归组 ${status.pending}`),
						h('span', null, `待处理窗口 ${status.windows}`),
					),
					h(
						'div',
						{ key: 'actions', style: S.row },
						h('button', { style: S.primary, disabled: busy, onClick: () => void groupNow() }, '立即归组'),
						h('button', { style: S.button, disabled: busy, onClick: () => void refresh() }, '刷新'),
					),
				)
			}

			children.push(
				h(
					'p',
					{ key: 'note', style: note?.bad ? S.err : S.ok },
					note?.text ?? '',
				),
			)

			return h('div', { style: S.card, 'data-dsh-tab-groups-section': '1' }, ...children)
		}

		/**
		 * Seat the settings section, if the shell exposes both the slot registry
		 * and React. Failure here must never take the chip down with it.
		 */
		function registerSettingsSection(ctx) {
			if (React === null) return
			try {
				if (typeof ctx?.slots?.inject !== 'function') return
			// `inject` itself can throw when the shell does not declare the slot
			// (a trimmed composition, or a DSH upgrade that moved it). That must
			// not take `apply` — and with it the chip — down.
			try {
				ctx.slots.inject('settings.section', () => {
				try {
					const unregister = ctx.slots.register(
						{
							name: 'settings.section',
							id: 'dsh-tab-groups',
							order: 60,
							label: () => 'DSH 标签页',
						},
						SettingsSection,
					)
					return () => {
						try {
							unregister()
						} catch {
							// Teardown races are not our problem.
						}
					}
					} catch (error) {
						console.warn(TAG, '设置分区注册失败，芯片仍然可用', error)
						return () => {}
					}
				})
			} catch (error) {
				console.warn(TAG, '该校没有 settings.section 这个 slot，跳过设置分区', error)
			}
			} catch (error) {
				console.warn(TAG, '拿不到 slots 服务，跳过设置分区（芯片仍然可用）', error)
			}
		}

		/**
		 * Register the chip on the running GUI.
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			registerSettingsSection(ctx)
			ctx.effect(() => {
				if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
				const ui = createChip(document)
				if (ui === null) return () => {}

				let disposed = false
				let ready = false
				/** @type {object|null} */
				let status = null

				const note = (text, kind = '') => {
					const target = ui.shadow.querySelector('[data-role="note"]')
					if (target === null) return
					target.className = kind === '' ? 'muted' : kind
					target.textContent = text
				}

				const render = () => {
					if (disposed) return
					if (status === null) renderGuide(ui, null)
					else renderControls(ui, status)
				}

				/** Ask the extension for its status; drives the whole chip state. */
				const refresh = async () => {
					const response = await call({ type: 'status' })
					if (disposed) return response
					if (!response.ok) {
						// Only explain the disconnect when we had actually been
						// connected — on a fresh page the plain guide is the message.
						const wasReady = ready
						ready = false
						status = null
						// A hidden chip must never swallow the guide: if the extension
						// goes away, the chip comes back and opens itself.
						ui.setHidden(false)
						renderGuide(ui, wasReady ? `扩展没有响应：${response.error}` : null)
						return response
					}
					ready = true
					status = response
					render()
					return response
				}

				ui.panel.addEventListener('click', (event) => {
					const target = event.target
					if (!(target instanceof Element)) return
					const button = target.closest('button[data-act]')
					if (button === null) return
					const act = button.getAttribute('data-act')

					if (act === 'copy') {
						void (async () => {
							try {
								await navigator.clipboard.writeText(INSTALL_DIR)
								note('已复制。到「加载解压缩的扩展」里选中它。')
							} catch {
								note('复制失败，请手动输入上面的路径', 'err')
							}
						})()
						return
					}

					if (act === 'hide') {
						// Deliberately not persisted: the chip is the plugin's only
						// surface, so a sticky hide would leave no way back in.
						ui.setHidden(true)
						return
					}

					if (act === 'recheck' || act === 'refresh') {
						button.disabled = true
						note('正在检测…')
						void refresh().then(() => {
							if (disposed) return
							note(status === null ? '仍然没有检测到扩展' : '已连接', status === null ? 'err' : 'ok')
						})
						return
					}

					if (act === 'reconcile') {
						button.disabled = true
						note('正在归组…')
						void call({ type: 'reconcile' }).then(async (result) => {
							if (disposed) return
							if (!result.ok) {
								note(`归组失败：${result.error}`, 'err')
								return
							}
							// Refresh *before* writing the note: re-rendering the
							// panel replaces the DOM node the note lives in.
							await refresh()
							if (result.errors?.length) note(`归组 ${result.moved} 个，${result.errors.length} 处失败`, 'err')
							else note(`已归组 ${result.moved} 个标签页`, 'ok')
						})
					}
				})

				const save = (patch) => {
					void call({ type: 'set-config', config: patch }).then(async (result) => {
						if (disposed) return
						if (!result.ok) {
							note(`保存失败：${result.error}`, 'err')
							return
						}
						await refresh()
						note('已保存', 'ok')
					})
				}

				ui.panel.addEventListener('change', (event) => {
					const target = event.target
					if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return
					const field = target.getAttribute('data-field')
					if (field === null) return
					if (field === 'enabled') save({ enabled: target.checked })
					else if (field === 'dedicatedWindow') save({ dedicatedWindow: target.checked })
					else if (field === 'groupTitle') save({ groupTitle: target.value })
					else if (field === 'groupColor') save({ groupColor: target.value })
				})

				void refresh()

				// A light poll keeps the counts honest while the GUI stays open,
				// and notices an extension that was installed after this page loaded.
				const timer = setInterval(() => {
					if (!disposed && ui.isOpen()) void refresh()
				}, POLL_MS)

				return () => {
					disposed = true
					clearInterval(timer)
					ui.remove()
				}
			}, 'tab-groups: GUI bridge chip')
		}

		/**
		 * `slots` carries the settings-section registry. cordis refuses to hand a
		 * service to a plugin that never asked for it, so this must be declared —
		 * and this shell accepts only the array form (`{ optional: [...] }` is
		 * read as a service literally named "optional").
		 *
		 * It is genuinely required: the section cannot exist without a slot
		 * registry. The chip itself needs no service at all, which is checked by
		 * the mount test's trimmed composition.
		 */
		const inject = ['slots']

		exports.apply = apply
		exports.inject = inject
		exports.EXTENSION_ID = EXTENSION_ID
		return module.exports
	},
})
