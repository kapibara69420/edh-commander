// src/scryfall.js
//
// All outbound Scryfall calls share ONE rate-limited queue so that
// background art prefetching, deck-builder search, token search, and
// conjure search can never collectively exceed Scryfall's documented
// limit of 2 requests/second on /cards/search and /cards/named.
// Exceeding that limit returns HTTP 429, which can surface in the
// browser as a generic "fetch failed" / network error.

const CACHE = {}
const NAME_QUEUE = new Set()

// ── Shared rate-limited request queue ──
// Every Scryfall fetch (named lookup OR search) goes through here,
// spaced at least 350ms apart (well under the 500ms/2-per-second cap,
// leaving headroom for jitter and concurrent tabs).
let _lastRequestAt = 0
const MIN_GAP_MS = 350
let _chain = Promise.resolve()

function throttledFetch(url, options) {
  _chain = _chain.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, _lastRequestAt + MIN_GAP_MS - now)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    _lastRequestAt = Date.now()
  })
  return _chain.then(() => fetchWithRetry(url, options))
}

// Retries once on 429 (rate limited) after waiting, and surfaces a
// clear Error (with status) on real failures instead of swallowing
// them into a generic network error.
async function fetchWithRetry(url, options, attempt = 0) {
  let res
  try {
    res = await fetch(url, options)
  } catch (err) {
    // True network/CORS failure (offline, blocked, DNS, etc.)
    throw new Error('NETWORK_ERROR: ' + (err?.message || 'fetch failed'))
  }
  if (res.status === 429 && attempt < 2) {
    // Rate limited — back off and retry
    await new Promise(r => setTimeout(r, 600 * (attempt + 1)))
    return fetchWithRetry(url, options, attempt + 1)
  }
  return res
}

export async function fetchCard(name) {
  const key = name.toLowerCase().trim()
  if (CACHE[key]) return CACHE[key]
  if (NAME_QUEUE.has(key)) {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (CACHE[key]) { clearInterval(check); resolve(CACHE[key]) }
        else if (!NAME_QUEUE.has(key)) { clearInterval(check); resolve(null) }
      }, 100)
    })
  }
  NAME_QUEUE.add(key)
  try {
    const res = await throttledFetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
    if (!res.ok) { NAME_QUEUE.delete(key); return null }
    const d = await res.json()
    const card = normalizeScryfall(d)
    CACHE[key] = card
    CACHE[d.name.toLowerCase()] = card
    NAME_QUEUE.delete(key)
    return card
  } catch {
    NAME_QUEUE.delete(key)
    return null
  }
}

// General card search (deck builder, conjure). Throws on real failure
// so callers can show a specific message instead of a generic one.
export async function searchCards(query, opts = {}) {
  const { unique = 'cards', order = 'name' } = opts
  const res = await throttledFetch(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=${order}&unique=${unique}`
  )
  if (res.status === 404) return []   // Scryfall returns 404 for "no matches" — not an error
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`SCRYFALL_${res.status}: ${body?.details || res.statusText}`)
  }
  const d = await res.json()
  return (d.data || []).map(normalizeScryfall)
}

// Token-specific search: tries `t:token <query>` first, and if Scryfall
// returns no matches, retries with the broader `is:token` syntax before
// giving up — some token names don't match well under `t:token`.
export async function searchTokens(query) {
  const attempts = [
    `${query} t:token`,
    `${query} is:token`,
  ]
  let lastErr = null
  for (const q of attempts) {
    try {
      const res = await throttledFetch(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name&unique=art`
      )
      if (res.status === 404) continue  // no matches for this attempt, try next
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        lastErr = new Error(`SCRYFALL_${res.status}: ${body?.details || res.statusText}`)
        continue
      }
      const d = await res.json()
      if (d.data?.length) return d.data
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) throw lastErr
  return []
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
