/** Options page: edit the config, preview what it matches right now. */

import { DEFAULT_CONFIG, GROUP_COLORS, normalizeConfig } from './config.js'
import { isDshTab } from './rules.js'

const CONFIG_KEY = 'config'

const el = (id) => document.getElementById(id)

const fields = {
  enabled: el('enabled'),
  groupTitle: el('groupTitle'),
  groupColor: el('groupColor'),
  enforceAppearance: el('enforceAppearance'),
  collapseGroup: el('collapseGroup'),
  matchTitles: el('matchTitles'),
  matchTitlePrefix: el('matchTitlePrefix'),
  matchOrigins: el('matchOrigins'),
  matchAnyLocalhostPort: el('matchAnyLocalhostPort'),
  moveFromOtherGroups: el('moveFromOtherGroups'),
  skipPinned: el('skipPinned'),
}

const statusEl = el('status')
const previewEl = el('preview')
const form = el('form')

for (const color of GROUP_COLORS) {
  const option = document.createElement('option')
  option.value = color
  option.textContent = color
  fields.groupColor.append(option)
}

function setStatus(text, kind = '') {
  statusEl.textContent = text
  statusEl.className = `status ${kind}`.trim()
}

function readForm() {
  return normalizeConfig({
    enabled: fields.enabled.checked,
    groupTitle: fields.groupTitle.value,
    groupColor: fields.groupColor.value,
    enforceAppearance: fields.enforceAppearance.checked,
    collapseGroup: fields.collapseGroup.checked,
    matchTitles: fields.matchTitles.value,
    matchTitlePrefix: fields.matchTitlePrefix.checked,
    matchOrigins: fields.matchOrigins.value,
    matchAnyLocalhostPort: fields.matchAnyLocalhostPort.checked,
    moveFromOtherGroups: fields.moveFromOtherGroups.checked,
    skipPinned: fields.skipPinned.checked,
  })
}

function writeForm(config) {
  fields.enabled.checked = config.enabled
  fields.groupTitle.value = config.groupTitle
  fields.groupColor.value = config.groupColor
  fields.enforceAppearance.checked = config.enforceAppearance
  fields.collapseGroup.checked = config.collapseGroup
  fields.matchTitles.value = config.matchTitles.join('\n')
  fields.matchTitlePrefix.checked = config.matchTitlePrefix
  fields.matchOrigins.value = config.matchOrigins.join('\n')
  fields.matchAnyLocalhostPort.checked = config.matchAnyLocalhostPort
  fields.moveFromOtherGroups.checked = config.moveFromOtherGroups
  fields.skipPinned.checked = config.skipPinned
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY)
  return normalizeConfig(stored?.[CONFIG_KEY] ?? DEFAULT_CONFIG)
}

/** Live preview against the tabs that exist right now, plus a short reason. */
async function renderPreview() {
  const config = readForm()
  let tabs
  let groups
  try {
    ;[tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})])
  } catch (error) {
    previewEl.textContent = `无法读取标签页：${error?.message ?? error}`
    return
  }
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const hits = tabs.filter((tab) => isDshTab(tab, config))

  if (hits.length === 0) {
    previewEl.textContent = '没有命中任何标签页。'
    return
  }

  const rows = hits.map((tab) => {
    const title = (tab.title || '(标题未加载)').slice(0, 80)
    let origin = ''
    try {
      origin = new URL(tab.pendingUrl || tab.url || '').origin
    } catch {
      origin = tab.url || ''
    }
    const group = tab.groupId != null && tab.groupId >= 0 ? groupById.get(tab.groupId) : undefined
    const where = group ? `已在分组「${group.title || '(未命名)'}」中` : '未分组'
    const pinned = tab.pinned ? '（固定标签页，跳过）' : ''
    return `· ${title} — ${origin} — ${where}${pinned}`
  })

  previewEl.textContent = `命中 ${hits.length} 个：\n${rows.join('\n')}`
}

async function save({ thenGroup }) {
  setStatus('正在保存…')
  const config = readForm()
  const response = await chrome.runtime.sendMessage({ type: 'save-config', config })
  if (!response?.ok) {
    setStatus(`保存失败：${response?.error ?? '未知错误'}`, 'err')
    return
  }
  writeForm(normalizeConfig(response.config))
  await renderPreview()
  if (thenGroup) {
    const grouped = await chrome.runtime.sendMessage({ type: 'reconcile' })
    if (!grouped?.ok) {
      setStatus(`已保存，但归组失败：${grouped?.error ?? '未知错误'}`, 'err')
      return
    }
    const result = grouped.result ?? {}
    if (result.errors?.length) {
      setStatus(`已保存；归组 ${result.moved ?? 0} 个，${result.errors.length} 处失败`, 'err')
    } else {
      setStatus(`已保存；归组 ${result.moved ?? 0} 个标签页`, 'ok')
    }
    return
  }
  setStatus('已保存', 'ok')
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void save({ thenGroup: false })
})

el('group-now').addEventListener('click', () => {
  void save({ thenGroup: true })
})

el('reset').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'reset-config' })
  writeForm(normalizeConfig(response?.config ?? DEFAULT_CONFIG))
  await renderPreview()
  setStatus('已恢复默认设置', 'ok')
})

for (const field of Object.values(fields)) {
  field.addEventListener('change', () => void renderPreview())
}

void (async () => {
  writeForm(await loadConfig())
  setStatus('')
  await renderPreview()
})()
