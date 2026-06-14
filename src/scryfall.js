// src/scryfall.js
const CACHE = {}
const QUEUE = new Set()

export async function fetchCard(name) {
  const key = name.toLowerCase().trim()
  if (CACHE[key]) return CACHE[key]
  if (QUEUE.has(key)) {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (CACHE[key]) { clearInterval(check); resolve(CACHE[key]) }
        else if (!QUEUE.has(key)) { clearInterval(check); resolve(null) }
      }, 100)
    })
  }
  QUEUE.add(key)
  try {
    await new Promise(r => setTimeout(r, 60))
    const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
    if (!res.ok) { QUEUE.delete(key); return null }
    const d = await res.json()
    const card = normalizeScryfall(d)
    CACHE[key] = card
    CACHE[d.name.toLowerCase()] = card
    QUEUE.delete(key)
    return card
  } catch {
    QUEUE.delete(key)
    return null
  }
}

export async function searchCards(query) {
  try {
    const res = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=name&unique=cards`)
    if (!res.ok) return []
    const d = await res.json()
    return (d.data || []).map(normalizeScryfall)
  } catch { return [] }
}

export function normalizeScryfall(d) {
  const face0 = d.card_faces?.[0]
  return {
    name: d.name,
    type_line: d.type_line || face0?.type_line || '',
    mana_cost: d.mana_cost || face0?.mana_cost || '',
    oracle_text: d.oracle_text || face0?.oracle_text || '',
    image_uri: d.image_uris?.normal || face0?.image_uris?.normal || '',
    image_small: d.image_uris?.small || face0?.image_uris?.small || '',
    pt: (d.power != null && d.toughness != null) ? `${d.power}/${d.toughness}` : '',
    loyalty: d.loyalty || '',
    cmc: d.cmc || 0,
    colors: d.colors || face0?.colors || [],
    rarity: d.rarity || '',
    set: d.set || '',
  }
}

export function inferZone(type_line = '') {
  const t = type_line.toLowerCase()
  if (t.includes('land')) return 'land'
  if (t.includes('creature')) return 'creature'
  if (t.includes('instant') || t.includes('sorcery')) return 'spell'
  if (t.includes('planeswalker')) return 'planeswalker'
  return 'other'
}

export async function prefetchDeck(deckList, onProgress) {
  const names = [...new Set(deckList.map(e => e.name))]
  let done = 0
  for (const name of names) {
    await fetchCard(name)
    done++
    onProgress?.(done, names.length)
  }
}
