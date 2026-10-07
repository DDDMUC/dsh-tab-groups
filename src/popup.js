/** Popup: live status, master switch, and a manual "group them now" button. */

const els = {
  enabled: document.getElementById('enabled'),
  statDsh: document.getElementById('stat-dsh'),
  statPending: document.getElementById('stat-pending'),
  statGroups: document.getElementById('stat-groups'),
  reconcile: document.getElementById('reconcile'),
  options: document.getElementById('open-options'),
  hint: document.getElementById('hint'),
}

function send(message) {
  return chrome.runtime.sendMessage(message)
}

function setHint(text, kind = '') {
  els.hint.textContent = text
  els.hint.className = `hint ${kind}`.trim()
}

function render(state) {
  if (!state?.ok) {
    setHint(`读取失败：${state?.error ?? '未知错误'}`, 'err')
    return
  }
  const { config, summary, lastRun } = state
  els.enabled.checked = config.enabled !== false
  els.statDsh.textContent = config.enabled === false ? '–' : String(summary.matched)
  els.statPending.textContent = config.enabled === false ? '–' : String(summary.pending)
  els.statGroups.textContent = config.enabled === false ? '–' : String(summary.windows)

  if (config.enabled === false) {
    setHint('已停用。打开上面的开关后，DSH 标签页会被自动归组。')
    return
  }
  if (summary.matched === 0) {
    setHint(`当前没有找到 DSH 标签页。\n识别依据：标题为「${config.matchTitles.join(' / ')}」，或来源在 ${config.matchOrigins.join('、') || '（未配置）'} 中。`)
    return
  }
  if (summary.pending === 0) {
    const when = lastRun?.at ? new Date(lastRun.at).toLocaleTimeString() : null
    setHint(`已全部归入「${config.groupTitle}」组${when ? `（最近一次检查 ${when}）` : ''}。`, 'ok')
    return
  }
  setHint(`有 ${summary.pending} 个 DSH 标签页待归组。`)
}

async function refresh() {
  render(await send({ type: 'status' }))
}

els.enabled.addEventListener('change', async () => {
  els.enabled.disabled = true
  const response = await send({ type: 'save-config', config: { enabled: els.enabled.checked } })
  els.enabled.disabled = false
  if (!response?.ok) setHint(`保存失败：${response?.error ?? '未知错误'}`, 'err')
  await refresh()
})

els.reconcile.addEventListener('click', async () => {
  els.reconcile.disabled = true
  setHint('正在归组…')
  const response = await send({ type: 'reconcile' })
  els.reconcile.disabled = false
  if (!response?.ok) {
    setHint(`归组失败：${response?.error ?? '未知错误'}`, 'err')
    return
  }
  const result = response.result ?? {}
  await refresh()
  if (result.errors?.length) {
    setHint(`归组完成，但有 ${result.errors.length} 处失败：\n${result.errors.join('\n')}`, 'err')
  } else {
    setHint(`已归组 ${result.moved ?? 0} 个标签页，涉及 ${result.groups ?? 0} 个窗口。`, 'ok')
  }
})

els.options.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

void refresh()
