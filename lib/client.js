/**
 * dsh-tab-groups · browser half.
 *
 * A self-contained status chip in the DSH Web GUI that talks to the companion
 * browser extension over Chromium's `externally_connectable` bridge.
 *
 * Why a floating chip instead of an official settings slot: this half must keep
 * working when the extension is NOT installed — that is precisely the state it
 * exists to explain — and it must not depend on a slot id or a service shape
 * that a DSH upgrade can move. It owns one shadow-DOM host, so DSH's CSS cannot
 * reach it and its CSS cannot reach DSH.
 *
 * There is no build step: this file is the shipped artifact. It follows the Web
 * GUI module-loader contract — the loader calls the factory once and takes the
 * exports as the client module (`apply`, `inject`).
 */

window.__ModuleLoader__.load({
	id: 'dsh-tab-groups',
	factory: () => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const TAG = '[dsh-tab-groups]'

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

		/**
		 * Register the chip on the running GUI.
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
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

		/** No official DSH service is needed: the chip is self-contained. */
		const inject = []

		exports.apply = apply
		exports.inject = inject
		exports.EXTENSION_ID = EXTENSION_ID
		return module.exports
	},
})
