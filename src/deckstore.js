// src/deckstore.js
const STORAGE_KEY = 'edh_decks_v3'

export function loadDecks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}

export function saveDeck(deck) {
  const decks = loadDecks()
  const idx = decks.findIndex(d => d.id === deck.id)
  const updated = { ...deck, updatedAt: Date.now() }
  if (idx >= 0) decks[idx] = updated; else decks.push(updated)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(decks))
  return updated
}

export function deleteDeck(id) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(loadDecks().filter(d => d.id !== id)))
}

export function exportDeckFile(deck) {
  const lines = [`// ${deck.name}`]
  if (deck.commanders?.length) {
    lines.push(`// Commander: ${deck.commanders.map(c => c.name).join(' / ')}`, '')
    lines.push(`// Commander (${deck.commanders.length})`)
    deck.commanders.forEach(c => lines.push(`1 ${c.name}`))
    lines.push('')
  }
  const groups = groupByType(deck.cards)
  for (const [section, cards] of Object.entries(groups)) {
    if (!cards.length) continue
    lines.push(`// ${section} (${cards.reduce((a, c) => a + c.qty, 0)})`)
    cards.forEach(c => lines.push(`${c.qty} ${c.name}`))
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${deck.name.replace(/\s+/g, '_')}.txt`; a.click()
  URL.revokeObjectURL(url)
}

export function importDeckFile(onDeck) {
  const input = document.createElement('input')
  input.type = 'file'; input.accept = '.txt,.dec,.csv'
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => onDeck(parseDeckText(ev.target.result, file.name.replace(/\.\w+$/, '')))
    reader.readAsText(file)
  }
  input.click()
}

export function parseDeckText(text, defaultName = 'Imported Deck') {
  const lines = text.split('\n')
  const cards = [], commanders = []
  let name = defaultName, currentSection = null, sawCmdSection = false

  for (let raw of lines) {
    let ln = raw.trim()
    if (!ln) { currentSection = null; continue }

    if (ln.startsWith('//') || ln.startsWith('#')) {
      const mName = ln.match(/\/\/\s*(Name|Deck):\s*(.+)/i)
      if (mName) { name = mName[2].trim(); continue }
      const mCmd = ln.match(/\/\/\s*Commander:\s*(.+)/i)
      if (mCmd) {
        sawCmdSection = true
        mCmd[1].split('/').forEach(n => { const nm = n.trim(); if (nm) commanders.push({ qty:1, name:nm, isCommander:true }) })
        continue
      }
      if (/commander/i.test(ln)) { currentSection = 'commander'; sawCmdSection = true; continue }
      currentSection = null; continue
    }

    if (/^commander\b/i.test(ln) && ln.length < 20) { currentSection = 'commander'; sawCmdSection = true; continue }
    if (/^(creatures?|instants?|sorceries|sorcery|enchantments?|artifacts?|planeswalkers?|lands?|other|battles?)\b/i.test(ln) && ln.length < 24) { currentSection = null; continue }

    const m = ln.match(/^(\d+)x?\s+(.+)$/)
    let qty = 1, cardName = ''
    if (m) { qty = parseInt(m[1]); cardName = m[2].split('(')[0].split('//')[0].trim() }
    else if (/^[A-Z]/.test(ln)) { cardName = ln.split('(')[0].split('//')[0].trim() }
    if (!cardName) continue

    if (currentSection === 'commander') commanders.push({ qty, name: cardName, isCommander: true })
    else cards.push({ qty, name: cardName })
  }

  if (!sawCmdSection && commanders.length === 0 && cards.length > 0) {
    const first = cards.shift()
    commanders.push({ qty:1, name:first.name, isCommander:true })
  }

  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2), name, commanders, cards, updatedAt: Date.now() }
}

export function groupByType(cards) {
  const groups = { Creatures:[], Instants:[], Sorceries:[], Enchantments:[], Artifacts:[], Planeswalkers:[], Lands:[], Other:[] }
  for (const c of cards) {
    const t = (c.type_line || '').toLowerCase()
    if (t.includes('land')) { groups.Lands.push(c); continue }
    if (t.includes('creature')) { groups.Creatures.push(c); continue }
    if (t.includes('instant')) { groups.Instants.push(c); continue }
    if (t.includes('sorcery')) { groups.Sorceries.push(c); continue }
    if (t.includes('enchantment')) { groups.Enchantments.push(c); continue }
    if (t.includes('artifact')) { groups.Artifacts.push(c); continue }
    if (t.includes('planeswalker')) { groups.Planeswalkers.push(c); continue }
    groups.Other.push(c)
  }
  return groups
}

export function newDeck(name = 'New Deck') {
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2), name, commanders:[], cards:[], updatedAt: Date.now() }
}

export function buildLibrary(deck, idCounter) {
  let id = idCounter || 0
  const lib = [], cmdZone = []
  const make = entry => ({
    id: ++id, name: entry.name, type_line: entry.type_line||'', mana_cost: entry.mana_cost||'',
    oracle_text: entry.oracle_text||'', image_uri: entry.image_uri||'', pt: entry.pt||'',
    loyalty: entry.loyalty||'', tapped: false, summoningSick: false, counters: {},
    token: false, isCommander: !!entry.isCommander, commanderTax: entry.isCommander ? 0 : undefined,
  })
  for (const e of (deck.commanders||[])) for (let i=0;i<(e.qty||1);i++) cmdZone.push(make(e))
  for (const e of (deck.cards||[])) for (let i=0;i<(e.qty||1);i++) lib.push(make(e))
  for (let i=lib.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1));[lib[i],lib[j]]=[lib[j],lib[i]] }
  return { library: lib, commandZone: cmdZone, nextId: id }
}
