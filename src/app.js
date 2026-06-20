// ╔══════════════════════════════════════════════════════════════════╗
// ║  EDH Commander Online — Full App                                 ║
// ║  Real-time multiplayer MTG Commander client                      ║
// ╚══════════════════════════════════════════════════════════════════╝
import { createClient } from '@supabase/supabase-js'
import { fetchCard, searchCards, searchTokens, prefetchDeck, inferZone } from './scryfall.js'
import { loadDecks, saveDeck, deleteDeck, exportDeckFile, importDeckFile,
         parseDeckText, groupByType, newDeck, buildLibrary } from './deckstore.js'

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const S = {
  screen: 'lobby',        // lobby | deckbuilder | waiting | game
  playerId: null,
  roomId: null,
  ws: null,
  gs: null,               // game state from server
  myName: '',
  myColor: '#3a7acc',
  myDeck: null,
  startLife: 40,
  chatOpen: false,
  modal: null,            // { type: 'card'|'zone'|'search'|'counters', ...data }
  cardIdCounter: 0,
  db: { activeDeckId: null, tab: 'list' },
  cardScale: parseFloat(localStorage.getItem('edh_card_scale') || '1'),
  viewingPlayer: null,    // null = my board, playerId = viewing that opponent's board
}

const COLORS = ['#3a7acc','#d44040','#35955a','#c8952a','#7a48c0','#289888','#cc6633']

// The "room creator" is whoever has the LOWEST playerId. Since playerId starts
// with Date.now().toString(36), the lowest id = earliest joiner. This is computed
// fresh from current playerOrder so every client agrees, regardless of the order
// in which they personally discovered other players.
function getCreatorId(gs) {
  if (!gs?.playerOrder?.length) return null
  return [...gs.playerOrder].sort()[0]
}
let lobbyColorIdx = 0

// Standard counter types offered as quick buttons
const COUNTER_PRESETS = [
  { key:'+1/+1', label:'+1/+1' },
  { key:'-1/-1', label:'-1/-1' },
  { key:'loyalty', label:'Loyalty' },
  { key:'charge', label:'Charge' },
  { key:'shield', label:'Shield' },
  { key:'stun', label:'Stun' },
  { key:'flying', label:'Flying' },
]

// ─────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────
let $root
export function App() {
  $root = document.createElement('div')
  $root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;'
  const urlRoom = new URLSearchParams(location.search).get('room')
  if (urlRoom) S.roomId = urlRoom
  R()
  return $root
}

function R() {
  hideHandPreview()  // never leave a floating card preview pointing at a stale DOM node
  $root.innerHTML = ''
  if (S.screen === 'lobby')       $root.appendChild(buildLobby())
  if (S.screen === 'deckbuilder') $root.appendChild(buildDeckBuilder())
  if (S.screen === 'waiting')     $root.appendChild(buildWaiting())
  if (S.screen === 'game')        { $root.appendChild(buildGame()); $root.appendChild(buildChat()) }
  $root.appendChild(buildCtx())
  $root.appendChild(buildToasts())
  if (S.modal) $root.appendChild(buildModal())
}

// gentleR: used when a PEER action arrives — updates opponent panels and
// game state visuals WITHOUT destroying our open modal, context menu, or
// card detail popup. Only rebuilds the parts that show other players.
function gentleR() {
  if (S.screen !== 'game' || !S.gs) { R(); return }
  // Re-render only opponent column and chat — leave my battlefield/modal alone
  try {
    const gs = S.gs
    const me = gs.players[S.playerId]
    const opponents = gs.playerOrder.filter(id=>id!==S.playerId).map(id=>gs.players[id]).filter(Boolean)
    const gameEl = document.querySelector('.game-screen')
    if (!gameEl) { R(); return }
    // Update opponent column
    const oppsEl = gameEl.querySelector('#g-opps')
    if (oppsEl) renderOpponents(gameEl, opponents, gs)
    // Update chat
    refreshChat()
    // Update turn pill and phase bar (non-destructive text updates)
    const activeId = gs.playerOrder[gs.activePlayerIdx]
    const ap = gs.players[activeId]
    const turnEl = gameEl.querySelector('.turn-pill')
    if (turnEl) turnEl.innerHTML = `Turn <b>${gs.turn}</b> · <b style="color:${ap?.color||'var(--gold2)'}">${esc(ap?.name||'?')}</b>`
    gameEl.querySelectorAll('.ph').forEach(b => b.classList.toggle('on', b.dataset.ph === gs.phase))
  } catch(e) {
    // Fallback to full rerender if partial update fails
    R()
  }
}

// ═══════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════
function buildLobby() {
  const decks = loadDecks()
  const el = div('screen-lobby screen active')
  el.innerHTML = `
    <div class="lobby-logo">⚔ EDH Commander Online
      <small>Real-time multiplayer · Commander Format</small>
    </div>

    <div class="lcard">
      <h2>Your Info</h2>
      <div class="fgrp"><label>Name</label>
        <input id="l-name" maxlength="24" placeholder="Your name" value="${esc(S.myName)}" /></div>
      <div class="fgrp"><label>Color</label>
        <div id="l-colors" class="color-picker">
          ${COLORS.map((c,i)=>`<div class="cdot${i===lobbyColorIdx?' sel':''}" style="background:${c}" data-i="${i}" data-c="${c}"></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="lcard">
      <h2>Deck</h2>
      ${decks.length ? `<div class="fgrp"><label>Saved Decks</label>
        <select id="l-deck-sel">
          <option value="">— paste below instead —</option>
          ${decks.map(d=>`<option value="${d.id}">${esc(d.name)} (${(d.commanders?.length||0)} cmd, ${d.cards.reduce((a,c)=>a+c.qty,0)} cards)</option>`).join('')}
        </select></div>` : ''}
      <div class="fgrp"><label>Commander(s) — one per line</label>
        <textarea id="l-cmd" style="height:50px" placeholder="Atraxa, Praetors' Voice&#10;(2nd line for partner commanders)"></textarea>
      </div>
      <div class="fgrp"><label>Rest of Deck (99 cards)</label>
        <textarea id="l-deck" placeholder="1 Sol Ring&#10;1 Command Tower&#10;1 Arcane Signet&#10;...&#10;&#10;Moxfield / Archidekt / plain &quot;1 Card Name&quot; format.&#10;If your pasted list already has a // Commander section, you can leave the Commander box above empty."></textarea>
      </div>
      <button class="ghost-btn" id="l-open-db">📋 Open Deck Builder</button>
    </div>

    <div class="lcard">
      <h2>Game Room</h2>
      <div class="fgrp"><label>Room Code</label>
        <div class="row-gap">
          <input id="l-room" maxlength="28" placeholder="e.g. fireball42" value="${esc(S.roomId||'')}" />
          <button class="ghost-btn" id="l-gen">Generate</button>
        </div>
      </div>
      <div id="l-link-wrap" class="fgrp" style="display:none">
        <label>Share link</label>
        <div class="link-box" id="l-link"></div>
      </div>
      <div class="fgrp"><label>Starting Life</label>
        <div class="row-gap">
          <button class="sel-btn${S.startLife===40?' on':''}" data-life="40">40</button>
          <button class="sel-btn${S.startLife===20?' on':''}" data-life="20">20</button>
        </div>
      </div>
      <button class="big-btn" id="l-join">▶ Join / Start Game</button>
      <div class="lobby-note">Share the room code with friends — everyone opens this app and enters the same code.</div>
    </div>
  `
  el.querySelectorAll('.cdot').forEach(d => d.addEventListener('click', () => {
    el.querySelectorAll('.cdot').forEach(x=>x.classList.remove('sel'))
    d.classList.add('sel')
    lobbyColorIdx = +d.dataset.i
    S.myColor = d.dataset.c
  }))
  S.myColor = COLORS[lobbyColorIdx]

  el.querySelectorAll('.sel-btn').forEach(b => b.addEventListener('click', () => {
    el.querySelectorAll('.sel-btn').forEach(x=>x.classList.remove('on'))
    b.classList.add('on')
    S.startLife = +b.dataset.life
  }))

  const roomIn = el.querySelector('#l-room')
  roomIn.addEventListener('input', () => { S.roomId = roomIn.value.trim(); updateLink(el) })
  if (S.roomId) updateLink(el)

  el.querySelector('#l-gen').addEventListener('click', () => {
    const w=['sword','goblin','island','dragon','elf','bolt','storm','plains','forest','swamp']
    const code = w[Math.floor(Math.random()*w.length)] + Math.floor(10+Math.random()*90)
    roomIn.value = code; S.roomId = code; updateLink(el)
  })

  el.querySelector('#l-deck-sel')?.addEventListener('change', e => {
    if (!e.target.value) return
    const d = decks.find(x=>x.id===e.target.value)
    if (d) {
      S.myDeck = d
      el.querySelector('#l-cmd').value = (d.commanders||[]).map(c=>c.name).join('\n')
      el.querySelector('#l-deck').value = d.cards.map(c=>`${c.qty} ${c.name}`).join('\n')
    }
  })

  el.querySelector('#l-open-db').addEventListener('click', () => { S.screen='deckbuilder'; R() })

  el.querySelector('#l-join').addEventListener('click', () => {
    const name = el.querySelector('#l-name').value.trim()
    const room = el.querySelector('#l-room').value.trim()
    const cmdTxt = el.querySelector('#l-cmd').value.trim()
    const deckTxt = el.querySelector('#l-deck').value.trim()
    if (!name) return toast('Enter your name','warn')
    if (!room) return toast('Enter a room code','warn')
    if (!deckTxt && !cmdTxt && !S.myDeck) return toast('Paste a deck list','warn')

    S.myName = name; S.roomId = room

    if (deckTxt || cmdTxt) {
      // Combine commander box + deck box into one parse, with explicit commander section
      let combined = ''
      if (cmdTxt) {
        combined += '// Commander\n' + cmdTxt.split('\n').map(l=>l.trim()).filter(Boolean)
          .map(l => /^\d/.test(l) ? l : '1 '+l).join('\n') + '\n\n'
      }
      combined += deckTxt
      S.myDeck = parseDeckText(combined, name+"'s Deck")
    }
    startGame()
  })
  return el
}

function updateLink(el) {
  if (!S.roomId) { el.querySelector('#l-link-wrap').style.display='none'; return }
  const url = `${location.origin}${location.pathname}?room=${S.roomId}`
  el.querySelector('#l-link-wrap').style.display = ''
  const lb = el.querySelector('#l-link')
  lb.textContent = url
  lb.onclick = () => { navigator.clipboard?.writeText(url); toast('Copied!','good') }
  history.replaceState({},'',`?room=${S.roomId}`)
}

// ═══════════════════════════════════════════════════════════
// DECK BUILDER
// ═══════════════════════════════════════════════════════════
function buildDeckBuilder() {
  const decks = loadDecks()
  if (!S.db.activeDeckId && decks.length) S.db.activeDeckId = decks[0].id
  const activeDeck = decks.find(d=>d.id===S.db.activeDeckId)

  const el = div('screen-deckbuilder screen active')
  el.innerHTML = `
    <!-- SIDEBAR -->
    <div class="db-sidebar">
      <div class="db-sh">
        <span style="font-size:.9rem;font-weight:700;color:var(--gold)">My Decks</span>
        <button class="ghost-btn" id="db-new">+ New</button>
      </div>
      <div class="db-list" id="db-list"></div>
      <div class="db-sf">
        <button class="ghost-btn w100" id="db-import">📥 Import .txt</button>
        <button class="ghost-btn w100 gold" id="db-back">← Back to Lobby</button>
      </div>
    </div>

    <!-- MAIN -->
    <div class="db-main">
      <div class="db-topbar">
        <input id="db-name" type="text" placeholder="Deck name" style="width:180px" value="${esc(activeDeck?.name||'')}" />
        <button class="ghost-btn" id="db-save">💾 Save</button>
        <button class="ghost-btn" id="db-export">📤 Export .txt</button>
        <button class="ghost-btn gold" id="db-use">▶ Use this deck</button>
      </div>
      <div class="db-body">

        <!-- Search col -->
        <div class="db-search-col">
          <div class="db-search-hdr">
            <input id="db-sq" class="db-si" placeholder="Search Scryfall…" />
            <button class="db-sbtn" id="db-sgo">Search</button>
          </div>
          <div class="db-sr" id="db-sr">
            <div class="empty-hint">Search for cards. Use "+ Deck" to add to the 99, "+ Cmd" to set as Commander.</div>
          </div>
        </div>

        <!-- Preview col -->
        <div class="db-preview" id="db-preview">
          <div class="empty-hint">Select a card to preview</div>
        </div>

        <!-- Deck list col -->
        <div class="db-dl-col">
          <div class="db-dl-hdr">
            <span id="db-dl-title" style="font-size:.85rem;font-weight:600">${esc(activeDeck?.name||'No deck selected')}</span>
            <span id="db-dl-count" style="font-size:.72rem;color:var(--text3)">${activeDeck?.cards.reduce((a,c)=>a+c.qty,0)||0}/99</span>
            <div style="margin-left:auto;display:flex;gap:.3rem">
              <button class="ghost-btn${S.db.tab==='list'?' gold':''}" onclick="window._dbTab('list')">List</button>
              <button class="ghost-btn${S.db.tab==='paste'?' gold':''}" onclick="window._dbTab('paste')">Paste</button>
            </div>
          </div>
          <div class="db-dl-body" id="db-dl-body"></div>
        </div>
      </div>
    </div>
  `

  renderDbSidebar(el, decks)
  renderDbList(el, activeDeck)

  el.querySelector('#db-new').addEventListener('click', () => {
    const d = newDeck(); saveDeck(d); S.db.activeDeckId=d.id; S.screen='deckbuilder'; R()
  })
  el.querySelector('#db-import').addEventListener('click', () => {
    importDeckFile(d => { saveDeck(d); S.db.activeDeckId=d.id; S.screen='deckbuilder'; R(); toast('Imported!','good') })
  })
  el.querySelector('#db-back').addEventListener('click', () => { S.screen='lobby'; R() })
  el.querySelector('#db-save').addEventListener('click', () => dbSave(el))
  el.querySelector('#db-export').addEventListener('click', () => { dbSave(el); exportDeckFile(loadDecks().find(d=>d.id===S.db.activeDeckId)||{name:'deck',cards:[],commanders:[]}) })
  el.querySelector('#db-use').addEventListener('click', () => {
    dbSave(el)
    const d = loadDecks().find(x=>x.id===S.db.activeDeckId)
    if (!d) return toast('No deck selected','warn')
    if (!d.commanders?.length) return toast('Add a Commander first','warn')
    S.myDeck=d; S.screen='lobby'; R(); toast('Using: '+d.name,'good')
  })

  const sqEl = el.querySelector('#db-sq')
  el.querySelector('#db-sgo').addEventListener('click', () => dbSearch(el))
  sqEl.addEventListener('keydown', e => e.key==='Enter' && dbSearch(el))

  window._dbTab = tab => { S.db.tab=tab; S.screen='deckbuilder'; R() }
  return el
}

function renderDbSidebar(el, decks) {
  const list = el.querySelector('#db-list')
  list.innerHTML = decks.map(d => `
    <div class="db-item${d.id===S.db.activeDeckId?' active':''}" data-id="${d.id}">
      <span class="dbi-name">${esc(d.name)}</span>
      <span class="dbi-n">${d.cards.reduce((a,c)=>a+c.qty,0)}</span>
      <button class="dbi-del" data-del="${d.id}">✕</button>
    </div>`).join('')
  list.querySelectorAll('.db-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.dataset.del) {
        if (!confirm('Delete deck?')) return
        deleteDeck(e.target.dataset.del)
        const remaining = loadDecks()
        S.db.activeDeckId = remaining[0]?.id || null
        S.screen='deckbuilder'; R(); return
      }
      S.db.activeDeckId = item.dataset.id; S.screen='deckbuilder'; R()
    })
  })
}

function renderDbList(el, deck) {
  const body = el.querySelector('#db-dl-body'); if (!body) return
  if (!deck) { body.innerHTML='<div class="empty-hint">Select or create a deck.</div>'; return }

  if (S.db.tab === 'paste') {
    const cmdText = (deck.commanders||[]).map(c=>c.name).join('\n')
    body.innerHTML = `<div style="padding:.5rem;display:flex;flex-direction:column;gap:.5rem;height:100%">
      <div>
        <label style="font-size:.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:.07em">Commander(s)</label>
        <textarea class="db-paste-ta" id="db-cmd-ta" style="height:50px">${esc(cmdText)}</textarea>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;min-height:0">
        <label style="font-size:.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:.07em">Deck (99)</label>
        <textarea class="db-paste-ta" id="db-paste-ta" style="flex:1">${deck.cards.map(c=>`${c.qty} ${c.name}`).join('\n')}</textarea>
      </div>
      <button class="ghost-btn gold w100" id="db-paste-apply">Apply</button>
    </div>`
    body.querySelector('#db-paste-apply').addEventListener('click', () => {
      const cmdTxt = body.querySelector('#db-cmd-ta').value.trim()
      const deckTxt = body.querySelector('#db-paste-ta').value
      let combined = ''
      if (cmdTxt) combined += '// Commander\n' + cmdTxt.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>/^\d/.test(l)?l:'1 '+l).join('\n') + '\n\n'
      combined += deckTxt
      const parsed = parseDeckText(combined, deck.name)
      deck.commanders = parsed.commanders
      deck.cards = parsed.cards
      saveDeck(deck); S.screen='deckbuilder'; R()
    })
    return
  }

  // List view: commander section + grouped 99
  let html = ''
  if (deck.commanders?.length) {
    html += `<div class="db-sec cmd-sec">👑 Commander <span>${deck.commanders.length}</span></div>`
    deck.commanders.forEach(c => {
      html += `<div class="db-ce cmd-ce" data-name="${esc(c.name)}" data-cmd="1">
        <span class="dce-q">1</span>
        <span class="dce-n">${esc(c.name)}</span>
        <span class="dce-c">${c.mana_cost||''}</span>
        <button class="dce-del" data-rmvcmd="${esc(c.name)}">✕</button>
      </div>`
    })
  }
  const groups = groupByType(deck.cards)
  for (const [sec, cards] of Object.entries(groups)) {
    if (!cards.length) continue
    html += `<div class="db-sec">${sec} <span>${cards.reduce((a,c)=>a+c.qty,0)}</span></div>`
    cards.forEach(c => {
      html += `<div class="db-ce" data-name="${esc(c.name)}">
        <span class="dce-q">${c.qty}</span>
        <span class="dce-n">${esc(c.name)}</span>
        <span class="dce-c">${c.mana_cost||''}</span>
        <button class="dce-del" data-rmv="${esc(c.name)}">✕</button>
      </div>`
    })
  }
  body.innerHTML = html || '<div class="empty-hint">Search for cards to add them. Set a Commander first!</div>'

  body.querySelectorAll('.db-ce').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.dataset.rmvcmd) {
        deck.commanders = deck.commanders.filter(c=>c.name!==e.target.dataset.rmvcmd)
        saveDeck(deck); S.screen='deckbuilder'; R(); return
      }
      if (e.target.dataset.rmv) {
        const nm = e.target.dataset.rmv
        const ci = deck.cards.findIndex(c=>c.name===nm)
        if (ci>=0) { deck.cards[ci].qty>1 ? deck.cards[ci].qty-- : deck.cards.splice(ci,1); saveDeck(deck); S.screen='deckbuilder'; R() }
        return
      }
      dbPreview(el, row.dataset.name)
    })
  })
}

function dbPreview(el, name) {
  const pv = el.querySelector('#db-preview'); if (!pv) return
  pv.innerHTML = '<div class="empty-hint">Loading…</div>'
  fetchCard(name).then(c => {
    if (!c) { pv.innerHTML='<div class="empty-hint">Not found</div>'; return }
    pv.innerHTML = `
      ${c.image_uri?`<img src="${c.image_uri}" style="width:185px;border-radius:8px" />`:
        `<div style="padding:.5rem;font-size:.8rem;color:var(--text)">${esc(c.name)}</div>`}
      <div style="font-size:.75rem;color:var(--text2);text-align:center;line-height:1.5;padding:0 .3rem">
        <b>${esc(c.name)}</b><br>
        <span style="color:var(--text3)">${esc(c.type_line)}</span><br>
        ${c.mana_cost?`<span style="color:var(--gold)">${esc(c.mana_cost)}</span><br>`:''}
        ${esc(c.oracle_text)}
        ${c.pt?`<br><b>${esc(c.pt)}</b>`:''}
      </div>`
  })
}

async function dbSearch(el) {
  const q = el.querySelector('#db-sq').value.trim(); if (!q) return
  const sr = el.querySelector('#db-sr')
  sr.innerHTML = '<div class="empty-hint">Searching…</div>'
  let results = []
  try {
    results = await searchCards(q)
  } catch (err) {
    console.error('Deck search failed:', err)
    const msg = (err?.message || '').includes('NETWORK_ERROR')
      ? 'Network error — check your internet connection.'
      : (err?.message || '').includes('SCRYFALL_429')
        ? 'Scryfall rate limit hit — wait a few seconds and try again.'
        : 'Search failed: ' + (err?.message || 'unknown error')
    sr.innerHTML = '<div class="empty-hint">'+esc(msg)+'</div>'
    return
  }
  if (!results.length) { sr.innerHTML='<div class="empty-hint">No results.</div>'; return }
  sr.innerHTML = results.slice(0,25).map(c=>`
    <div class="db-rrow" data-name="${esc(c.name)}">
      ${c.image_small?`<img class="db-rimg" src="${c.image_small}" loading="lazy" />`:'<div class="db-rimg"></div>'}
      <div class="db-rinfo">
        <div class="db-rname">${esc(c.name)}</div>
        <div class="db-rtype">${esc(c.type_line)} ${esc(c.mana_cost||'')}</div>
      </div>
      <div class="db-radd-grp">
        <button class="db-radd" data-addcmd="${esc(c.name)}" title="Set as Commander">+ Cmd</button>
        <button class="db-radd" data-add="${esc(c.name)}" title="Add to deck">+ Deck</button>
      </div>
    </div>`).join('')
  sr.querySelectorAll('.db-rrow').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.dataset.addcmd) {
        const nm = e.target.dataset.addcmd
        const deck = loadDecks().find(d=>d.id===S.db.activeDeckId)
        if (!deck) return toast('Select a deck first','warn')
        const found = results.find(c=>c.name===nm)
        if (!deck.commanders) deck.commanders=[]
        if (!deck.commanders.find(c=>c.name===nm)) {
          deck.commanders.push({qty:1,name:nm,isCommander:true,type_line:found?.type_line||'',mana_cost:found?.mana_cost||'',image_uri:found?.image_uri||'',pt:found?.pt||''})
        }
        saveDeck(deck); renderDbList(el, deck)
        toast('Commander set: '+nm,'good'); e.stopPropagation(); return
      }
      if (e.target.dataset.add) {
        const nm = e.target.dataset.add
        const deck = loadDecks().find(d=>d.id===S.db.activeDeckId)
        if (!deck) return toast('Select a deck first','warn')
        const found = results.find(c=>c.name===nm)
        const ex = deck.cards.find(c=>c.name===nm)
        if (ex) ex.qty++
        else deck.cards.push({qty:1,name:nm,type_line:found?.type_line||'',mana_cost:found?.mana_cost||'',image_uri:found?.image_uri||'',pt:found?.pt||''})
        saveDeck(deck); renderDbList(el, deck)
        toast('Added: '+nm,'good'); e.stopPropagation(); return
      }
      dbPreview(el, row.dataset.name)
    })
  })
}

function dbSave(el) {
  const deck = loadDecks().find(d=>d.id===S.db.activeDeckId); if (!deck) return
  const n = el.querySelector('#db-name')?.value.trim(); if (n) deck.name=n
  saveDeck(deck); toast('Saved!','good')
}

// ═══════════════════════════════════════════════════════════
// NETWORKING — Supabase Realtime Broadcast (no server needed)
// All players subscribe to the same channel (room code).
// Every game action is broadcast to all peers who apply it
// locally. On join, REQ_ANNOUNCE causes existing players to
// reply with full state so latecomers sync up instantly.
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  || ''
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON || ''

let _supabase = null
let _channel  = null

function getSupabase() {
  if (!_supabase && SUPABASE_URL && SUPABASE_ANON) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_ANON)
  }
  return _supabase
}

function startGame() {
  S.playerId = 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2)
  const { library: lib, commandZone, nextId } = buildLibrary(S.myDeck, S.cardIdCounter)
  S.cardIdCounter = nextId

  S.gs = makeLocalState(lib, commandZone)
  S.screen = 'waiting'
  R()

  prefetchDeck([...(S.myDeck.commanders||[]), ...S.myDeck.cards], (done,total) => {
    if (done===total) { R(); toast('All card art loaded','good') }
  })

  const sb = getSupabase()
  if (!sb) {
    toast('Solo mode — add Supabase keys to play online','warn')
    return
  }

  if (_channel) { sb.removeChannel(_channel); _channel = null }

  _channel = sb.channel('edh:'+S.roomId, {
    config: { broadcast: { self: false, ack: false } }
  })

  _channel
    .on('broadcast', { event: 'game' }, ({ payload }) => {
      handlePeerMsg(payload)
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        // Tell everyone we joined (sends our full player state)
        netSend({ type:'ANNOUNCE',
          playerId:S.playerId, name:S.myName, color:S.myColor,
          deckList:lib, commandZone:commandZone, startLife:S.startLife,
          creatorId: S.gs?.creatorId })
        // Ask everyone already in the room to re-announce themselves to us
        netSend({ type:'REQ_ANNOUNCE', fromId:S.playerId })
        sysMsg(S.myName+' joined')
        toast('Connected! Room code: '+S.roomId,'good')
        R()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        toast('Connection error — check Supabase keys in GitHub Secrets','warn')
      }
    })
}

// Send ONLY to peers over the network (does NOT apply locally)
const _sentIds = new Set()  // deduplicate: ignore messages we sent if they somehow echo back
function netSend(msg) {
  if (_channel) {
    const mid = S.playerId + '_' + (++netSend._seq)
    _sentIds.add(mid)
    if (_sentIds.size > 200) {
      const first = _sentIds.values().next().value
      _sentIds.delete(first)
    }
    _channel.send({ type:'broadcast', event:'game', payload:{ ...msg, _from:S.playerId, _mid:mid } })
  }
}
netSend._seq = 0

// send() = apply locally first, then send to all peers
// Used for all game actions (tap, move card, life change, etc.)
function send(msg) {
  applyLocal(msg)
  netSend(msg)
}

// Handle a message that came FROM a peer over the network
function handlePeerMsg(msg) {
  if (!S.gs) return
  if (msg._from === S.playerId) return  // ignore own echoes (safety)
  if (msg._mid && _sentIds.has(msg._mid)) return  // already applied locally

  if (msg.type === 'ANNOUNCE') {
    // A peer announced themselves — register them in our local game state
    const pid = msg.playerId
    if (!pid) return
    if (!S.gs.playerOrder.includes(pid)) S.gs.playerOrder.push(pid)
    const snap = msg.snapshot || {}
    S.gs.players[pid] = {
      id:pid, name:msg.name||'?', color:msg.color||'#888',
      life: typeof snap.life === 'number' ? snap.life : (msg.startLife||40),
      cmdDmg: snap.cmdDmg || {},
      mana: snap.mana || {W:0,U:0,B:0,R:0,G:0,C:0},
      counters: snap.counters || {poison:0,energy:0,exp:0,rad:0},
      hand: snap.hand || [],
      battlefield: snap.battlefield || [],
      graveyard: snap.graveyard || [],
      exile: snap.exile || [],
      commandZone: snap.commandZone || msg.commandZone || [],
      library: msg.deckList || [],
      libraryCount: typeof snap.libraryCount === 'number' ? snap.libraryCount : (msg.deckList||[]).length,
      connected: true,
      ready: snap.ready || false,
    }
    // Sync creatorId from announcer (creator always knows who they are)
    if (msg.creatorId && !S.gs.creatorId) {
      S.gs.creatorId = msg.creatorId
    }
    if (S.gs.started) {
      sysMsg((msg.name||'Someone')+' reconnected')
    } else {
      sysMsg((msg.name||'Someone')+' joined the room')
    }
    R()
    return
  }

  if (msg.type === 'GAME_START') {
    if (S.screen !== 'waiting') return  // already in game
    const gs = S.gs; if (!gs) return
    gs.started = true
    // Use the player ID sent by creator — works regardless of join order
    const spId = msg.startingPlayerId
    gs.activePlayerIdx = spId ? gs.playerOrder.indexOf(spId) : 0
    if (gs.activePlayerIdx < 0) gs.activePlayerIdx = 0
    gs.turn = 1
    gs.phase = 'Untap'
    const startingPlayer = gs.players[gs.playerOrder[gs.activePlayerIdx]]
    S.screen = 'game'
    toast(`Game started! Starting player: ${startingPlayer?.name||'?'}`, 'gold')
    sysMsg(`Game started! Starting player: ${startingPlayer?.name||'?'}`)
    setTimeout(() => send({type:'DRAW', playerId:S.playerId, count:7}), 300)
    R()
    return
  }

  if (msg.type === 'REQ_ANNOUNCE') {
    // A new player is asking us to re-announce — reply with our full current state
    if (msg.fromId === S.playerId) return
    const me = S.gs.players[S.playerId]
    if (!me) return
    netSend({
      type:'ANNOUNCE',
      playerId:S.playerId, name:S.myName, color:S.myColor,
      deckList:me.library, commandZone:me.commandZone, startLife:S.startLife,
      creatorId: S.gs?.creatorId,   // share who the creator is
      snapshot: {
        life:me.life, cmdDmg:me.cmdDmg, mana:me.mana, counters:me.counters,
        hand:me.hand, battlefield:me.battlefield, graveyard:me.graveyard,
        exile:me.exile, commandZone:me.commandZone, libraryCount:me.libraryCount,
        ready:me.ready||false,
      }
    })
    return
  }

  if (msg.type === 'PLAYER_READY') {
    const rp = S.gs?.players?.[msg.playerId]
    if (rp) { rp.ready = true; R() }
    return
  }

  if (msg.type === 'PLAYER_LEFT') {
    const lp = S.gs?.players?.[msg.playerId]
    if (lp) {
      lp.connected = false
      lp.left = true
      sysMsg(`${lp.name} left the game`)
      toast(`${lp.name} left the game`, 'warn')
      R()
    }
    return
  }

  // All other messages are game actions — apply to the sending peer's state
  applyLocal(msg)
}

function makeLocalState(lib, commandZone) {
  const p = {
    id:S.playerId, name:S.myName, color:S.myColor,
    life:S.startLife, cmdDmg:{},
    mana:{W:0,U:0,B:0,R:0,G:0,C:0},
    counters:{poison:0,energy:0,exp:0,rad:0},
    hand:[], battlefield:[], graveyard:[], exile:[],
    commandZone:commandZone, library:lib, libraryCount:lib.length, connected:true,
  }
  return {
    players:{[S.playerId]:p}, playerOrder:[S.playerId],
    turn:1, activePlayerIdx:0, phase:'Untap',
    stack:[], stackCounter:0, chat:[],
    creatorId: S.playerId   // whoever creates the room is the creator
  }
}


function applyLocal(msg) {
  if (!S.gs) return
  const gs=S.gs, me=gs.players[S.playerId]
  if (!me) return
  switch(msg.type) {
    case 'JOIN':
    case 'ANNOUNCE':
    case 'REQ_ANNOUNCE': break  // handled by handlePeerMsg, not applyLocal
    case 'PLAYER_UPDATE': {
      const target = gs.players[msg.playerId]
      if (target) Object.assign(target, msg.patch)
      break
    }
    case 'MOVE_CARD': {
      const actor = gs.players[msg.playerId]; if(!actor) break
      let card=null
      const src = msg.fromZone==='library' ? actor.library : actor[msg.fromZone]
      if (!src) break
      const idx = src.findIndex(c=>c.id===msg.cardId); if(idx<0) break
      card = src.splice(idx,1)[0]
      if (msg.fromZone==='library') actor.libraryCount=actor.library.length
      card.tapped = msg.tapped||false
      const leavingBf = msg.fromZone==='battlefield' && ['graveyard','exile','library_top','library_bottom','library','hand'].includes(msg.toZone)
      if (card.isCommander && leavingBf) card.commanderTax=(card.commanderTax||0)+2
      if (msg.toZone==='library_top') { actor.library.unshift(card); actor.libraryCount=actor.library.length }
      else if (msg.toZone==='library_bottom'||msg.toZone==='library') { actor.library.push(card); actor.libraryCount=actor.library.length }
      else { if(!actor[msg.toZone])actor[msg.toZone]=[]; actor[msg.toZone].push(card) }
      break
    }
    case 'DRAW': {
      const actor = gs.players[msg.playerId]; if(!actor) break
      const n=Math.min(msg.count||1,actor.library.length)
      for(let i=0;i<n;i++){const c=actor.library.shift();if(c){c.tapped=false;actor.hand.push(c)}}
      actor.libraryCount=actor.library.length; break
    }
    case 'SHUFFLE': {
      const actor = gs.players[msg.playerId]; if(!actor) break
      for(let i=actor.library.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[actor.library[i],actor.library[j]]=[actor.library[j],actor.library[i]]}
      break
    }
    case 'TAP_CARD': {
      const actor = gs.players[msg.playerId]; if(!actor) break
      const z=msg.zone||'battlefield'; const c=actor[z]?.find(x=>x.id===msg.cardId); if(c) c.tapped=msg.tapped; break
    }
    case 'CARD_COUNTERS': {
      const z=gs.players[msg.playerId]?.[msg.zone]; if(!z) break
      const c=z.find(x=>x.id===msg.cardId); if(c){ if(!c.counters)c.counters={}; if(msg.value<=0) delete c.counters[msg.counterKey]; else c.counters[msg.counterKey]=msg.value }
      break
    }
    case 'CARD_FIELD': {
      const z=gs.players[msg.playerId]?.[msg.zone]; if(!z) break
      const c=z.find(x=>x.id===msg.cardId); if(c) c[msg.field]=msg.value
      break
    }
    case 'STACK_PUSH': gs.stack.unshift({id:++gs.stackCounter,playerId:msg.playerId,name:msg.name,card:msg.card||null}); break
    case 'STACK_RESOLVE': {
      const item=gs.stack.shift()
      if(item?.card) {
        const caster = gs.players[item.playerId] || me
        const z=inferZone(item.card.type_line||'')
        if(z!=='spell') caster.battlefield.push(item.card)
        else caster.graveyard.push(item.card)
      }
      break
    }
    case 'STACK_COUNTER': gs.stack=gs.stack.filter(s=>s.id!==msg.stackId); break
    case 'GAME_START': {
      gs.started = true
      gs.phase = 'Untap'
      gs.turn = 1
      const spId2 = msg.startingPlayerId
      gs.activePlayerIdx = spId2 ? gs.playerOrder.indexOf(spId2) : (msg.startingIdx||0)
      if (gs.activePlayerIdx < 0) gs.activePlayerIdx = 0
      break
    }
    case 'NEXT_TURN': {
      // Only active player may advance the turn
      if (msg.playerId !== gs.playerOrder[gs.activePlayerIdx]) break
      gs.activePlayerIdx=(gs.activePlayerIdx+1)%gs.playerOrder.length
      if(gs.activePlayerIdx===0) gs.turn++
      gs.phase='Untap'
      // Clear mana for active player
      const active = gs.players[gs.playerOrder[gs.activePlayerIdx]]
      if(active) active.mana={W:0,U:0,B:0,R:0,G:0,C:0}
      break
    }
    case 'PLAYER_READY': {
      const rp = gs.players[msg.playerId]
      if (rp) rp.ready = true
      break
    }
    case 'SET_PHASE': gs.phase=msg.phase; break
    case 'CHAT': { if(!gs.chat)gs.chat=[]; gs.chat.push({id:Date.now(),playerId:msg.playerId,playerName:msg.playerName,text:msg.text,isSystem:!!msg.isSystem}); break }
  }
  // If this action is for another player (peer action), do a gentle update
  // that doesn't destroy our open modal/context menus
  if (msg.playerId && msg.playerId !== S.playerId) {
    if (S.screen === 'waiting') R()  // waiting room always needs full update
    else gentleR()
  } else {
    R()
  }
}

// ═══════════════════════════════════════════════════════════
// WAITING ROOM
// ═══════════════════════════════════════════════════════════
function buildWaiting() {
  const gs = S.gs
  const players = gs ? gs.playerOrder.map(id => gs.players[id]).filter(Boolean) : []
  const me = gs?.players?.[S.playerId]
  const allReady = players.length >= 1 && players.every(p => p.ready)
  const isCreator = getCreatorId(gs) === S.playerId

  const el = div('screen-waiting screen active')
  el.innerHTML = `
    <div class="wait-logo">⚔ EDH Commander Online</div>
    <div class="wait-room">Room: <b>${esc(S.roomId)}</b>
      <span class="wait-link" id="wait-copy-link" title="Click to copy link">📋 Copy invite link</span>
    </div>
    <div class="wait-subtitle">Waiting for players to ready up…</div>

    <div class="wait-players" id="wait-players">
      ${players.map(p => `
        <div class="wait-player">
          <div class="wait-player-header">
            <div class="wp-dot" style="background:${p.color}"></div>
            <span class="wp-name" style="color:${p.color}">${esc(p.name)}</span>
            <span class="wp-status ${p.ready?'ready':'waiting'}">${p.ready?'✓ Ready':'waiting…'}</span>
          </div>
          <div class="wp-commanders">
            ${(p.commandZone||[]).map(c => `
              <div class="wp-cmd">
                ${c.image_uri ? `<img src="${c.image_uri}" class="wp-cmd-img" />` : ''}
                <span class="wp-cmd-name">${esc(c.name)}</span>
              </div>
            `).join('') || '<span class="wp-no-cmd">No commander set</span>'}
          </div>
        </div>
      `).join('')}
      ${players.length === 0 ? '<div class="empty-hint">Connecting…</div>' : ''}
    </div>

    <div class="wait-actions">
      <button class="big-btn${me?.ready?' ready-btn':''}" id="wait-ready" style="max-width:280px">
        ${me?.ready ? '✓ Ready!' : 'Press Ready'}
      </button>
      ${allReady && isCreator ? `<button class="big-btn start-btn" id="wait-start" style="max-width:280px;background:var(--green2);color:#0a1a0a;margin-top:.5rem">▶ Start Game</button>` : ''}
    </div>

    <div class="wait-hint">
      ${players.length === 1 ? 'Share the room code or invite link with your friends.' : ''}
      ${allReady && isCreator ? '🟢 All players ready! Click "Start Game" to begin.' :
        allReady && !isCreator ? '🟢 All ready — waiting for room creator to start.' :
        `${players.filter(p=>p.ready).length}/${players.length} players ready`}
    </div>

    <button class="ghost-btn" id="wait-leave" style="margin-top:1rem">← Leave Room</button>
  `

  // Prefetch commander art while waiting
  players.forEach(p => {
    (p.commandZone||[]).forEach(card => {
      if (!card.image_uri) fetchCard(card.name).then(d => {
        if (d?.image_uri) { card.image_uri = d.image_uri; R() }
      })
    })
  })

  el.querySelector('#wait-copy-link')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${S.roomId}`
    navigator.clipboard?.writeText(url)
    toast('Invite link copied!','good')
  })

  el.querySelector('#wait-ready').addEventListener('click', () => gReady())

  el.querySelector('#wait-start')?.addEventListener('click', () => gStartGame())

  el.querySelector('#wait-leave').addEventListener('click', () => {
    if (_channel) getSupabase()?.removeChannel(_channel); _channel = null
    S.gs = null; S.screen = 'lobby'; R()
  })

  return el
}

function gReady() {
  const me = S.gs?.players?.[S.playerId]
  if (!me) return
  me.ready = true
  send({ type:'PLAYER_READY', playerId:S.playerId })
  toast('You are ready!','good')
  R()
}

function gStartGame() {
  const gs = S.gs; if (!gs) return
  const players = gs.playerOrder.map(id => gs.players[id]).filter(Boolean)
  if (!players.every(p => p.ready)) { toast('Not all players are ready yet','warn'); return }
  // Only room creator (playerOrder[0]) can start
  const creatorId = getCreatorId(gs)
  if (creatorId !== S.playerId) { toast('Only the room creator can start the game','warn'); return }

  // Roll once — send the PLAYER ID (not index) so all peers agree regardless of join order
  const startingPlayer = players[Math.floor(Math.random() * players.length)]
  const startingPlayerId = startingPlayer.id

  netSend({ type:'GAME_START', playerId:S.playerId, startingPlayerId })
  sysMsg(`🎲 Starting player: ${startingPlayer.name}!`)
  toast(`Starting player: ${startingPlayer.name}!`,'gold')

  // Apply locally: find the index of that player in OUR playerOrder
  gs.started = true
  gs.activePlayerIdx = gs.playerOrder.indexOf(startingPlayerId)
  if (gs.activePlayerIdx < 0) gs.activePlayerIdx = 0
  gs.turn = 1
  gs.phase = 'Untap'

  S.screen = 'game'
  setTimeout(() => send({ type:'DRAW', playerId:S.playerId, count:7 }), 300)
  R()
}


function buildGame() {
  const gs=S.gs, me=gs?.players?.[S.playerId]
  if (!gs||!me) return div('','<div style="padding:2rem;color:var(--text3)">Connecting…</div>')

  const activeId = gs.playerOrder[gs.activePlayerIdx]
  const activePlayer = gs.players[activeId]
  const opponents = gs.playerOrder.filter(id=>id!==S.playerId).map(id=>gs.players[id]).filter(Boolean)

  const el = div('game-screen screen active')
  const manyOpps = opponents.length >= 3
  el.innerHTML = `
  <!-- ── TOP BAR ── -->
  <div class="g-topbar">
    <span class="g-logo">⚔ EDH</span>
    <div class="g-phases" id="g-phases">
      ${['Untap','Upkeep','Draw','Main 1','Begin Combat','Attackers','Blockers','Damage','End Combat','Main 2','End Step','Cleanup'].map(p=>
        `<button class="ph${gs.phase===p?' on':''}" data-ph="${p}">${p}</button>`).join('')}
    </div>
    <div class="g-topright">
      <div class="turn-pill">Turn <b>${gs.turn}</b> · <b style="color:${activePlayer?.color||'var(--gold2)'}">${esc(activePlayer?.name||'?')}</b></div>
      <button class="tb primary" id="g-draw">Draw</button>
      <button class="tb${activeId===S.playerId?' primary':' disabled-btn'}" id="g-nextturn" title="${activeId===S.playerId?'End your turn (Space)':'Wait for your turn'}">Next Turn ›</button>
      <button class="tb" id="g-untap">Untap All</button>
      <button class="tb" id="g-chat">💬</button>
      <div class="dice-wrap" id="dice-wrap">
        <button class="tb" id="g-dice">🎲 Roll Dice ▾</button>
        <div class="dice-menu" id="dice-menu">
          <button class="dice-opt" data-sides="4">d4</button>
          <button class="dice-opt" data-sides="6">d6</button>
          <button class="dice-opt" data-sides="8">d8</button>
          <button class="dice-opt" data-sides="10">d10</button>
          <button class="dice-opt" data-sides="12">d12</button>
          <button class="dice-opt" data-sides="20">d20</button>
          <button class="dice-opt" data-sides="100">d100</button>
        </div>
      </div>
      <button class="tb" id="g-coin">🪙 Coin</button>
      <button class="tb red" id="g-quit">Quit</button>
    </div>
  </div>

  <!-- ── BOARD TABS + CARD SIZE ── -->
  <div class="board-tabbar" id="board-tabbar">
    <span class="board-tab-lbl">Viewing:</span>
    <div class="board-tabs" id="board-tabs">
      <button class="board-tab${!S.viewingPlayer?' active':''}" data-pid="me">🧙 My Board</button>
      ${opponents.map(op=>`<button class="board-tab${S.viewingPlayer===op.id?' active':''}" data-pid="${op.id}" style="border-color:${op.color};color:${S.viewingPlayer===op.id?'#160f00':op.color};${S.viewingPlayer===op.id?'background:'+op.color:''}">${esc(op.name)}</button>`).join('')}
    </div>
    <div class="card-size-ctrl">
      <span class="cs-lbl">Card size</span>
      <input type="range" id="card-size-slider" min="0.5" max="2" step="0.05" value="${S.cardScale}" class="cs-slider" />
      <span class="cs-val" id="cs-val">${Math.round(S.cardScale*100)}%</span>
    </div>
  </div>


  <!-- ── BODY ── -->
  <div class="g-body${manyOpps?' many-opps':''}">

    <!-- Opponents: sidebar (≤2) or top row (3+) -->
    <div class="g-opps-wrap" style="position:relative;flex-shrink:0;display:flex;">
      <div class="g-opps${manyOpps?' many-opps':''}" id="g-opps"></div>
      <div class="${manyOpps?'resize-handle-h':'resize-handle-v'}" id="opps-resize"></div>
    </div>

    <!-- CENTER: main play area -->
    <div class="g-center">

      <!-- Unified battlefield -->
      <div class="g-bf" id="g-bf">
        <span class="bf-hint">Battlefield — drag cards here to play</span>
      </div>

      <!-- Bottom strip: GY | Exile | Command | Library | Hand -->
      <div class="g-bottom-strip" id="g-bottom-strip">
        <div class="resize-handle-h" id="bottom-resize"></div>

        <!-- GY -->
        <div class="g-minizone gy-zone" id="g-gy-zone">
          <div class="mz-label">☠ GY <span id="gy-n">${me.graveyard?.length||0}</span></div>
          <div class="mz-cards" id="gy-cards"></div>
          <div class="resize-handle-v" data-mz="gy"></div>
        </div>

        <!-- Exile -->
        <div class="g-minizone exile-zone" id="g-exile-zone">
          <div class="mz-label">✦ Exile <span id="exile-n">${me.exile?.length||0}</span></div>
          <div class="mz-cards" id="exile-cards"></div>
          <div class="resize-handle-v" data-mz="exile"></div>
        </div>

        <!-- Command zone -->
        <div class="g-minizone cmd-zone" id="g-cmd-zone">
          <div class="mz-label">👑 Command <span id="cmd-n">${me.commandZone?.length||0}</span></div>
          <div class="mz-cards" id="cmd-cards"></div>
          <div class="resize-handle-v" data-mz="cmd"></div>
        </div>

        <!-- Library pile -->
        <div class="g-minizone lib-zone" id="g-lib-zone">
          <div class="mz-label">📚 Library <span id="lib-n">${me.libraryCount||me.library?.length||0}</span></div>
          <div class="mz-cards" id="lib-cards"></div>
          <div class="resize-handle-v" data-mz="lib"></div>
        </div>

        <!-- Spacer + hand label -->
        <div class="g-hand-wrap">
          <div class="hand-lbl">Hand</div>
          <div class="g-hand" id="g-hand"></div>
          <span id="hand-n" class="hand-count"></span>
        </div>

      </div>
    </div>

    <!-- RIGHT: my stats panel -->
    <div class="g-stats" id="g-stats">
      <div class="resize-handle-v" id="stats-resize" style="right:auto;left:-4px"></div>
    </div>

  </div>`

  // Phases
  el.querySelector('#g-phases').addEventListener('click', e => {
    const b = e.target.closest('.ph'); if (!b) return
    el.querySelectorAll('.ph').forEach(x=>x.classList.remove('on'))
    b.classList.add('on')
    send({ type:'SET_PHASE', phase:b.dataset.ph })
    sysMsg(`${S.myName} → ${b.dataset.ph}`)
  })

  el.querySelector('#g-draw').addEventListener('click', ()=>gDraw(1))
  el.querySelector('#g-nextturn').addEventListener('click', ()=>gNextTurn())
  el.querySelector('#g-untap').addEventListener('click', ()=>gUntapAll())
  el.querySelector('#g-chat').addEventListener('click', ()=>{ S.chatOpen=!S.chatOpen; R() })
  el.querySelector('#g-dice').addEventListener('click', (e) => {
    e.stopPropagation()
    const menu = el.querySelector('#dice-menu')
    menu.classList.toggle('show')
  })
  el.querySelector('#dice-menu').addEventListener('click', e => {
    const btn = e.target.closest('.dice-opt'); if (!btn) return
    const sides = +btn.dataset.sides
    const r = Math.floor(Math.random()*sides)+1
    sysMsg(`🎲 ${S.myName} rolled d${sides}: ${r}`)
    toast(`d${sides}: ${r}`,'gold')
    el.querySelector('#dice-menu').classList.remove('show')
  })
  document.addEventListener('click', () => el.querySelector('#dice-menu')?.classList.remove('show'))
  el.querySelector('#g-coin').addEventListener('click', ()=>{ const r=Math.random()<.5?'Heads':'Tails'; sysMsg(`🪙 ${S.myName}: ${r}`); toast(r,'gold') })
  el.querySelector('#g-quit').addEventListener('click', ()=>{
    if (!confirm('Leave game? Other players will be notified.')) return
    // Notify peers that we left
    netSend({ type:'PLAYER_LEFT', playerId:S.playerId, name:S.myName })
    if (_channel) getSupabase()?.removeChannel(_channel)
    _channel = null; S.gs = null; S.screen = 'lobby'; R()
  })

  // ── Board tabs (switch between my board and opponent boards) ──
  el.querySelector('#board-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.board-tab'); if (!btn) return
    S.viewingPlayer = btn.dataset.pid === 'me' ? null : btn.dataset.pid
    R()
  })

  // ── Card size slider ──
  el.querySelector('#card-size-slider').addEventListener('input', e => {
    S.cardScale = parseFloat(e.target.value)
    localStorage.setItem('edh_card_scale', S.cardScale)
    el.querySelector('#cs-val').textContent = Math.round(S.cardScale*100)+'%'
    // Re-render just the battlefield without full R() for performance
    const viewing = S.viewingPlayer ? gs.players[S.viewingPlayer] : me
    if (viewing) renderBf(el, viewing, !!S.viewingPlayer)
  })

  // ── Drag & drop: battlefield ──
  const bfEl = el.querySelector('#g-bf')
  bfEl.addEventListener('dragover', e => { e.preventDefault(); bfEl.classList.add('drag-over') })
  bfEl.addEventListener('dragleave', () => bfEl.classList.remove('drag-over'))
  bfEl.addEventListener('drop', e => {
    e.preventDefault(); bfEl.classList.remove('drag-over')
    const id = parseInt(e.dataTransfer.getData('cid'))
    const from = e.dataTransfer.getData('from')
    if (!id || !from) return
    // Calculate drop position relative to battlefield element
    const bfRect2 = bfEl.getBoundingClientRect()
    const dropX = e.clientX - bfRect2.left - 36  // center card on cursor
    const dropY = e.clientY - bfRect2.top  - 50
    const setPos = (card) => { card.bfX = Math.max(0,dropX); card.bfY = Math.max(0,dropY) }
    if (from === 'hand') {
      const card = me.hand?.find(c=>c.id===id)
      if (card) { setPos(card); gPlayCard(card) }
    } else if (from === 'commandZone') {
      const card = me.commandZone?.find(c=>c.id===id)
      if (card) { setPos(card); gCastCommander(card) }
    } else if (from === 'battlefield') {
      // already handled by mousedown drag — nothing to do
    } else {
      // From GY, exile, etc — move to battlefield at drop position
      const actor = me
      const src = actor[from]
      const card = src?.find(c=>c.id===id)
      if (card) { setPos(card); gMoveCard(id, from, 'battlefield') }
    }
  })

  // ── Drag & drop: mini-zones ──
  const wireZoneDrop = (zoneEl, targetZone) => {
    if (!zoneEl) return
    let isDragOver = false
    zoneEl.addEventListener('dragenter', e => { e.preventDefault(); e.stopPropagation(); isDragOver=true; zoneEl.classList.add('drag-over') })
    zoneEl.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); zoneEl.classList.add('drag-over') })
    zoneEl.addEventListener('dragleave', e => { isDragOver=false; setTimeout(()=>{ if(!isDragOver) zoneEl.classList.remove('drag-over') },50) })
    zoneEl.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation()
      isDragOver=false; zoneEl.classList.remove('drag-over')
      const id = parseInt(e.dataTransfer.getData('cid'))
      const from = e.dataTransfer.getData('from')
      if (!id || !from || from === targetZone) return
      gMoveCard(id, from, targetZone)
      sysMsg(`${S.myName}: card → ${targetZone}`)
    })
  }
  wireZoneDrop(el.querySelector('#g-gy-zone'), 'graveyard')
  wireZoneDrop(el.querySelector('#g-exile-zone'), 'exile')
  wireZoneDrop(el.querySelector('#g-cmd-zone'), 'commandZone')

  // ── Drag & drop: hand ──
  const handWrap = el.querySelector('.g-hand-wrap')
  let handDragOver = false
  handWrap.addEventListener('dragenter', e => { e.preventDefault(); handDragOver=true; handWrap.classList.add('drag-over') })
  handWrap.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); handWrap.classList.add('drag-over') })
  handWrap.addEventListener('dragleave', () => { handDragOver=false; setTimeout(()=>{ if(!handDragOver) handWrap.classList.remove('drag-over') },50) })
  handWrap.addEventListener('drop', e => {
    e.preventDefault(); handWrap.classList.remove('drag-over')
    const id = parseInt(e.dataTransfer.getData('cid'))
    const from = e.dataTransfer.getData('from')
    if (!id || !from || from === 'hand') return
    gMoveCard(id, from, 'hand')
    sysMsg(`${S.myName}: card → hand`)
  })

  // ── Resizable panels ──
  wireResize(el.querySelector('#bottom-resize'), 'v-inv', h => {
    document.documentElement.style.setProperty('--bottom-strip-h', `${h}px`)
    // Card height = strip height minus label/padding (about 40px overhead)
    const cardH = Math.max(60, h - 40)
    const cardW = Math.round(cardH * 0.72)  // MTG card ratio ~0.716
    document.documentElement.style.setProperty('--hcard-h', `${cardH}px`)
    document.documentElement.style.setProperty('--hcard-w', `${cardW}px`)
    document.documentElement.style.setProperty('--hcard-overlap', `${Math.round(cardW * 0.25)}px`)
    localStorage.setItem('edh_bottomstrip_h', h)
  }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-strip-h')||'148'), 90, 420)

  wireResize(el.querySelector('#stats-resize'), 'h-rev', w => {
    document.documentElement.style.setProperty('--stats-w', `${w}px`)
    localStorage.setItem('edh_stats_w', w)
  }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--stats-w')||'200'), 140, 400)

  const oppsHandle = el.querySelector('#opps-resize')
  if (oppsHandle) {
    if (manyOpps) {
      wireResize(oppsHandle, 'v', h => {
        document.documentElement.style.setProperty('--opps-h', `${h}px`)
        localStorage.setItem('edh_opps_h', h)
      }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--opps-h')||'165'), 90, 320)
    } else {
      wireResize(oppsHandle, 'h', w => {
        document.documentElement.style.setProperty('--opps-w', `${w}px`)
        localStorage.setItem('edh_opps_w', w)
      }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--opps-w')||'175'), 100, 400)
    }
  }

  el.querySelectorAll('.resize-handle-v[data-mz]').forEach(handle => {
    wireResize(handle, 'h', w => {
      document.documentElement.style.setProperty('--mz-w', `${w}px`)
      localStorage.setItem('edh_mz_w', w)
    }, () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mz-w')||'80'), 50, 200)
  })

  // Restore saved sizes
  restoreSize('--bottom-strip-h','edh_bottomstrip_h')
  // Recompute hcard size from saved strip height
  const savedH = parseInt(localStorage.getItem('edh_bottomstrip_h')||'148')
  const savedCardH = Math.max(60, savedH - 40)
  const savedCardW = Math.round(savedCardH * 0.72)
  document.documentElement.style.setProperty('--hcard-h', `${savedCardH}px`)
  document.documentElement.style.setProperty('--hcard-w', `${savedCardW}px`)
  document.documentElement.style.setProperty('--hcard-overlap', `${Math.round(savedCardW * 0.25)}px`)
  restoreSize('--stats-w','edh_stats_w')
  restoreSize('--opps-h','edh_opps_h')
  restoreSize('--opps-w','edh_opps_w')
  restoreSize('--mz-w','edh_mz_w')

  // Track hovered battlefield card for T key
  let _hoveredCard = null
  el.addEventListener('mouseover', ev => {
    const cardEl = ev.target.closest('.bf-card')
    if (cardEl) {
      const id = parseInt(cardEl.dataset.id)
      const p = S.gs?.players?.[S.playerId]
      _hoveredCard = p?.battlefield?.find(c => c.id === id) || null
    } else {
      _hoveredCard = null
    }
  })

  // Keyboard shortcuts
  document.onkeydown = ev => {
    if (ev.target.tagName==='INPUT'||ev.target.tagName==='TEXTAREA') return
    if (ev.key==='Escape') { S.modal=null; hideCtx(); R() }
    if (ev.key==='d'||ev.key==='D') gDraw(1)
    if (ev.key==='n'||ev.key==='N') gNextTurn()
    if (ev.key===' ') { ev.preventDefault(); gNextTurn() }
    if (ev.key==='u'||ev.key==='U') gUntapAll()
    if ((ev.key==='t'||ev.key==='T') && _hoveredCard) {
      gTapCard(_hoveredCard,'battlefield')
      ev.preventDefault()
    }
  }

  // Determine whose board we're viewing
  const viewedPlayer = S.viewingPlayer ? gs.players[S.viewingPlayer] : me
  const isViewingOpp = !!S.viewingPlayer

  renderBf(el, viewedPlayer || me, isViewingOpp)
  renderMiniZones(el, isViewingOpp ? viewedPlayer : me, isViewingOpp)
  renderHand(el, isViewingOpp ? viewedPlayer : me, isViewingOpp)
  renderOpponents(el, opponents, gs)
  renderStats(el, me, opponents)

  // Show viewing banner when on opponent's board
  if (isViewingOpp && viewedPlayer) {
    const bf = el.querySelector('#g-bf')
    const banner = div('opp-view-banner')
    banner.innerHTML = `👁 Viewing <b style="color:${viewedPlayer.color}">${esc(viewedPlayer.name)}</b>'s board — read only`
    if (bf) bf.prepend(banner)
  }

  return el
}

// ── Battlefield ──
function renderBf(el, me, readOnly=false) {
  const bf = el.querySelector('#g-bf'); if (!bf) return
  bf.innerHTML = ''

  if (!me.battlefield?.length) {
    bf.innerHTML = '<span class="bf-hint">Battlefield — drag cards here to play them</span>'
    return
  }

  // Free-placement: each card has stored x,y or gets auto-placed
  let autoX = 12, autoY = 12
  const bfRect = bf.getBoundingClientRect()
  const cardW = S.cardScale * 72
  const cardH = S.cardScale * 100

  me.battlefield.forEach((card, i) => {
    // Auto-assign position if not set
    if (card.bfX === undefined) {
      card.bfX = autoX
      card.bfY = autoY
      autoX += cardW + 8
      if (autoX + cardW > (bfRect.width||800) - 12) { autoX = 12; autoY += cardH + 8 }
    }
    const el2 = makeBfCardEl(card, readOnly)
    el2.style.position = 'absolute'
    el2.style.left = card.bfX + 'px'
    el2.style.top  = card.bfY + 'px'
    el2.style.width  = cardW + 'px'
    el2.style.height = cardH + 'px'
    if (!readOnly) {
      el2.addEventListener('mousedown', e => {
        if (e.button !== 0) return
        e.stopPropagation(); e.preventDefault()
        const startMouseX = e.clientX, startMouseY = e.clientY
        const startBfX = card.bfX, startBfY = card.bfY
        let moved = false
        // ghost overlay so pointer events don't hit children
        el2.style.opacity = '0.7'
        const onMove = mv => {
          moved = true
          const dx = mv.clientX - startMouseX
          const dy = mv.clientY - startMouseY
          card.bfX = Math.max(0, startBfX + dx)
          card.bfY = Math.max(0, startBfY + dy)
          el2.style.left = card.bfX + 'px'
          el2.style.top  = card.bfY + 'px'
          // Highlight drop zones when hovering over them
          const target = document.elementFromPoint(mv.clientX, mv.clientY)
          document.querySelectorAll('.g-minizone,.g-hand-wrap').forEach(z => z.classList.remove('drag-over'))
          const zone = target?.closest('.g-minizone,.g-hand-wrap')
          if (zone) zone.classList.add('drag-over')
        }
        const onUp = ev => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          el2.style.opacity = ''
          document.querySelectorAll('.g-minizone,.g-hand-wrap').forEach(z => z.classList.remove('drag-over'))
          if (!moved) return
          // Check if dropped on a zone element
          const target = document.elementFromPoint(ev.clientX, ev.clientY)
          const gyZone   = target?.closest('#g-gy-zone')
          const exZone   = target?.closest('#g-exile-zone')
          const cmdZone  = target?.closest('#g-cmd-zone')
          const handZone = target?.closest('.g-hand-wrap')
          if (gyZone)   { gMoveCard(card.id,'battlefield','graveyard'); sysMsg(S.myName+': '+card.name+'→GY'); return }
          if (exZone)   { gMoveCard(card.id,'battlefield','exile');     sysMsg(S.myName+': '+card.name+'→exile'); return }
          if (cmdZone)  { gMoveCard(card.id,'battlefield','commandZone'); return }
          if (handZone) { gMoveCard(card.id,'battlefield','hand');      sysMsg(S.myName+': '+card.name+'→hand'); return }
          // Stayed on battlefield — sync new position
          send({ type:'CARD_FIELD', playerId:S.playerId, cardId:card.id, zone:'battlefield', field:'bfX', value:card.bfX })
          send({ type:'CARD_FIELD', playerId:S.playerId, cardId:card.id, zone:'battlefield', field:'bfY', value:card.bfY })
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
    }
    bf.appendChild(el2)
  })
}

function makeBfCardEl(card, readOnly=false) {
  const el = div('bf-card'+(card.tapped?' tapped':''))
  el.dataset.id = card.id
  if (card.image_uri) {
    el.innerHTML = `<img src="${card.image_uri}" loading="lazy" draggable="false" />`
  } else {
    el.innerHTML = `<div class="card-face">
      <div class="cf-name">${esc(card.name)}</div>
      <div class="cf-type">${esc(card.type_line||'')}</div>
      <div class="cf-cost">${esc(card.mana_cost||'')}</div>
    </div>`
    fetchCard(card.name).then(d=>{ if(d?.image_uri){card.image_uri=d.image_uri;el.innerHTML=`<img src="${d.image_uri}" loading="lazy" draggable="false" />`} })
  }
  const ctrs = Object.entries(card.counters||{}).filter(([,v])=>v)
  if (ctrs.length) el.innerHTML += `<div class="card-badge">${ctrs.map(([k,v])=>counterShort(k,v)).join(' ')}</div>`
  if (card.summoningSick) el.innerHTML += '<div class="card-sick">∑</div>'
  if (card.token) el.innerHTML += '<div class="card-tok">T</div>'

  if (!readOnly) {
    // Left click = tap/untap
    el.addEventListener('click', e=>{
      e.stopPropagation()
      // Only tap if not a drag (mousedown+mouseup without move)
      if (!el._didDrag) gTapCard(card,'battlefield')
      el._didDrag = false
    })
    el.addEventListener('mousedown', ()=>{ el._didDrag=false })
    el.addEventListener('mousemove', ()=>{ el._didDrag=true })
    // Right click = full action menu with card detail
    el.addEventListener('contextmenu', e=>{ e.preventDefault(); showBfCtx(card,e) })
  } else {
    el.addEventListener('click', e=>{ e.stopPropagation(); openCardModal(card,'view') })
  }
  return el
}

function counterShort(key, val) {
  if (key==='+1/+1'||key==='-1/-1') return `${val>0?'+':''}${val}${key.includes('-')?'/-1':'/+1'}`.replace('+1/-1','').slice(0) // fallback
  return `${val}${key.charAt(0).toUpperCase()}`
}

// ── Mini zones (GY, Exile, Command, Library) ──
function renderMiniZones(el, me, readOnly=false) {
  const makeEzCard = (card, zone) => {
    const d = div('ez-card')
    d.draggable = true
    if (card.image_uri) d.innerHTML=`<img src="${card.image_uri}" loading="lazy" draggable="false" />`
    else { d.innerHTML=`<div style="font-size:.48rem;color:var(--text3);text-align:center;padding:2px">${esc(card.name)}</div>`; fetchCard(card.name).then(x=>{ if(x?.image_uri){card.image_uri=x.image_uri;d.innerHTML=`<img src="${x.image_uri}" loading="lazy" draggable="false" />`} }) }
    if (zone==='commandZone' && card.commanderTax) {
      d.innerHTML += `<div class="card-badge cmd-tax">Tax ${card.commanderTax}</div>`
    }
    d.title = card.name
    d.addEventListener('click', ()=>openCardModal(card, zone))
    d.addEventListener('dragstart', e=>{ e.dataTransfer.setData('cid',card.id); e.dataTransfer.setData('from',zone) })
    return d
  }

  const gyEl=el.querySelector('#gy-cards'), gyN=el.querySelector('#gy-n')
  if (gyEl) {
    gyN.textContent=me.graveyard?.length||0
    gyEl.innerHTML=''
    me.graveyard?.slice(-5).forEach(c=>gyEl.appendChild(makeEzCard(c,'graveyard')))
    el.querySelector('#g-gy-zone').addEventListener('click', e=>{ if(e.target.closest('.ez-card')) return; openZoneModal('Graveyard',me.graveyard||[],'graveyard') })
  }

  const exEl=el.querySelector('#exile-cards'), exN=el.querySelector('#exile-n')
  if (exEl) {
    exN.textContent=me.exile?.length||0
    exEl.innerHTML=''
    me.exile?.slice(-5).forEach(c=>exEl.appendChild(makeEzCard(c,'exile')))
    el.querySelector('#g-exile-zone').addEventListener('click', e=>{ if(e.target.closest('.ez-card')) return; openZoneModal('Exile',me.exile||[],'exile') })
  }

  const cmdEl=el.querySelector('#cmd-cards'), cmdN=el.querySelector('#cmd-n')
  if (cmdEl) {
    cmdN.textContent=me.commandZone?.length||0
    cmdEl.innerHTML=''
    me.commandZone?.forEach(c=>cmdEl.appendChild(makeEzCard(c,'commandZone')))
    el.querySelector('#g-cmd-zone').addEventListener('click', e=>{ if(e.target.closest('.ez-card')) return; openZoneModal('Command Zone',me.commandZone||[],'commandZone') })
  }

  const libEl=el.querySelector('#lib-cards'), libN=el.querySelector('#lib-n')
  if (libEl) {
    libN.textContent=me.libraryCount||me.library?.length||0
    libEl.innerHTML=''
    const pile = div('ez-card lib-pile')
    pile.innerHTML=`<span>${me.libraryCount||me.library?.length||0}</span>`
    pile.addEventListener('click', e => {
      if (e.shiftKey || e.ctrlKey || e.altKey) { showLibMenu(); return }
      // Single click = draw 1 card
      gDraw(1)
    })
    pile.addEventListener('contextmenu', e => { e.preventDefault(); showLibMenu() })
    libEl.appendChild(pile)
  }
}

// ── Hand ──
// MTG card back image (official Scryfall asset)
const CARD_BACK = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 140'><rect width='100' height='140' rx='6' fill='%231a1a2e'/><rect x='4' y='4' width='92' height='132' rx='5' fill='none' stroke='%234a3080' stroke-width='1.5'/><rect x='8' y='8' width='84' height='124' rx='4' fill='%2316213e'/><circle cx='50' cy='70' r='30' fill='none' stroke='%236a3090' stroke-width='1'/><circle cx='50' cy='70' r='22' fill='none' stroke='%236a3090' stroke-width='.8'/><polygon points='50,45 72,62 63,87 37,87 28,62' fill='none' stroke='%238844bb' stroke-width='1.2'/><circle cx='50' cy='70' r='6' fill='%236a3090' opacity='.8'/><text x='50' y='20' text-anchor='middle' fill='%238844bb' font-size='7' font-family='serif' opacity='.7'>MAGIC</text></svg>`

function renderHand(el, me, readOnly=false) {
  const handEl=el.querySelector('#g-hand'), countEl=el.querySelector('#hand-n')
  if (!handEl) return
  handEl.innerHTML=''

  if (readOnly) {
    // Opponent's hand — show card backs only, count is real
    const count = me.hand?.length || 0
    for (let i = 0; i < count; i++) {
      const d = div('hcard opp-hand-card')
      d.innerHTML = `<img src="${CARD_BACK}" loading="lazy" draggable="false" />`
      d.title = 'Opponent hand card'
      handEl.appendChild(d)
    }
    if (countEl) countEl.textContent = `${count} cards (opponent)`
    return
  }

  me.hand?.forEach(card=>{
    const d = div('hcard')
    d.draggable = true
    if (card.image_uri) d.innerHTML=`<img src="${card.image_uri}" loading="lazy" draggable="false" />`
    else { d.innerHTML=`<div class="card-face"><div class="cf-name">${esc(card.name)}</div><div class="cf-type">${esc(card.type_line||'')}</div><div class="cf-cost">${esc(card.mana_cost||'')}</div></div>`; fetchCard(card.name).then(x=>{ if(x?.image_uri){card.image_uri=x.image_uri;d.innerHTML=`<img src="${x.image_uri}" loading="lazy" draggable="false" />`} }) }
    d.addEventListener('click', e=>{ e.stopPropagation(); openCardModal(card,'hand') })
    d.addEventListener('contextmenu', e=>{ e.preventDefault(); showHandCtx(card,e) })
    d.addEventListener('dragstart', e=>{ d.classList.add('dragging'); hideHandPreview(); e.dataTransfer.setData('cid',card.id); e.dataTransfer.setData('from','hand') })
    d.addEventListener('dragend', ()=>d.classList.remove('dragging'))
    // Hover preview rendered at document root — escapes overflow:hidden on
    // every ancestor (hand wrap, bottom strip, center, body, game screen)
    // so the enlarged card is never clipped at the top of the window.
    d.addEventListener('mouseenter', () => showHandPreview(d, card))
    d.addEventListener('mouseleave', hideHandPreview)
    handEl.appendChild(d)
  })
  if (countEl) countEl.textContent = `${me.hand?.length||0} cards`
}

// ── Floating hand-card preview (escapes clipped containers) ──
let _handPreviewEl = null
function showHandPreview(sourceEl, card) {
  hideHandPreview()
  const rect = sourceEl.getBoundingClientRect()
  const preview = div('hcard-float')
  if (card.image_uri) {
    preview.innerHTML = `<img src="${card.image_uri}" draggable="false" />`
  } else {
    preview.innerHTML = `<div class="card-face"><div class="cf-name">${esc(card.name)}</div><div class="cf-type">${esc(card.type_line||'')}</div><div class="cf-cost">${esc(card.mana_cost||'')}</div></div>`
  }
  // Size: bigger than the in-hand card, capped so it always fits on screen
  const w = Math.min(220, Math.max(rect.width * 2.1, 140))
  const h = w * 1.4
  preview.style.width = w + 'px'
  preview.style.height = h + 'px'
  // Anchor horizontally centered on the source card, vertically above it,
  // clamped so it never goes off-screen on any edge.
  let left = rect.left + rect.width / 2 - w / 2
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  let top = rect.top - h - 14
  if (top < 8) top = rect.bottom + 14  // not enough room above — show below instead
  preview.style.left = left + 'px'
  preview.style.top = top + 'px'
  document.body.appendChild(preview)
  _handPreviewEl = preview
}
function hideHandPreview() {
  if (_handPreviewEl) { _handPreviewEl.remove(); _handPreviewEl = null }
}

// ── Opponents column ──
function renderOpponents(el, opponents, gs) {
  const col = el.querySelector('#g-opps'); if (!col) return
  col.innerHTML = ''
  if (!opponents.length) { col.innerHTML='<div style="padding:.5rem;font-size:.72rem;color:var(--text4)">Waiting for opponents…</div>'; return }

  opponents.forEach(op => {
    const lifeC = op.life<=10?'low':op.life<=20?'mid':'ok'
    const panel = div('opp-panel')
    panel.innerHTML = `
      <div class="opp-hdr">
        <div class="opp-dot" style="background:${op.color}"></div>
        <span class="opp-name" style="color:${op.color}">${esc(op.name)}</span>
        <span class="opp-conn ${op.connected?'on':''}">●</span>
      </div>
      <div class="opp-life ${lifeC}">${op.life}${op.left?"<span style=\"font-size:.6rem;color:var(--red2);margin-left:.4rem\">LEFT</span>":""}</div>
      <div class="opp-adj">
        <button data-op="${op.id}" data-d="-1" class="oadj dn">−1</button>
        <button data-op="${op.id}" data-d="1" class="oadj up">+1</button>
      </div>
      <div class="opp-stats">
        ${op.counters?.poison?`<span class="ostat poison">☠${op.counters.poison}</span>`:''}
        ${(op.hand?.length||0)?`<span class="ostat">✋${op.hand?.length}</span>`:''}
      </div>
      <div class="opp-bf" id="opbf-${op.id}"></div>
      <button class="zca-btn viewboard-btn" data-viewboard="${op.id}">🔍 View Board</button>
      <div class="opp-zones">
        <div class="oz-pill" data-pid="${op.id}" data-zone="graveyard"><b>${op.graveyard?.length||0}</b><span>GY</span></div>
        <div class="oz-pill" data-pid="${op.id}" data-zone="exile"><b>${op.exile?.length||0}</b><span>Ex</span></div>
        <div class="oz-pill" data-pid="${op.id}" data-zone="commandZone"><b>${op.commandZone?.length||0}</b><span>Cmd</span></div>
        <div class="oz-pill" data-pid="${op.id}" data-zone="lib"><b>${op.libraryCount||op.library?.length||0}</b><span>Lib</span></div>
      </div>`

    const bfEl = panel.querySelector(`#opbf-${op.id}`)
    op.battlefield?.forEach(c => {
      const d = div('opp-card'+(c.tapped?' tapped':''))
      if (c.image_uri) d.innerHTML=`<img src="${c.image_uri}" loading="lazy" />`
      const ctrs=Object.entries(c.counters||{}).filter(([,v])=>v)
      if(ctrs.length) d.innerHTML+=`<div class="card-badge">${ctrs.map(([k,v])=>counterShort(k,v)).join(' ')}</div>`
      d.title=c.name; d.addEventListener('click',()=>openViewModal(c))
      bfEl.appendChild(d)
    })

    panel.querySelector('[data-viewboard]').addEventListener('click', () => openBoardModal(op))
    panel.querySelectorAll('.oadj').forEach(b=>b.addEventListener('click', e=>{ e.stopPropagation(); adjOppLife(b.dataset.op,+b.dataset.d) }))
    panel.querySelectorAll('.oz-pill').forEach(pill=>pill.addEventListener('click', ()=>{
      const p=gs.players[pill.dataset.pid]; if(!p) return
      const zone=pill.dataset.zone; const cards=zone==='lib'?[]:p[zone]||[]
      openZoneModal(`${p.name}'s ${zone}`, cards, zone, true)
    }))

    col.appendChild(panel)
  })
}

// ── Stats / right panel ──
function renderStats(el, me, opponents) {
  const rp = el.querySelector('#g-stats'); if (!rp) return
  const lifeC = me.life<=10?'low':me.life<=20?'mid':'ok'
  rp.innerHTML = `
    <div class="rps">
      <div class="rp-lbl">Life Total</div>
      <div class="life-big ${lifeC}" id="rp-life">${me.life}</div>
      <div class="life-adjs">
        <button class="ladj dn" data-a="-5">−5</button>
        <button class="ladj dn" data-a="-1">−1</button>
        <button class="ladj up" data-a="1">+1</button>
        <button class="ladj up" data-a="5">+5</button>
      </div>
      <div class="life-input-row">
        <input id="li-val" type="number" placeholder="±" />
        <button id="li-adj">±</button>
        <button id="li-set">Set</button>
      </div>
    </div>

    ${(me.commandZone?.length)?`<div class="rps">
      <div class="rp-lbl">👑 Commander Tax</div>
      ${me.commandZone.map(c=>`
        <div class="cdmg-row">
          <span class="cdmg-name">${esc(c.name)}</span>
          <button class="cadj" data-taxcid="${c.id}" data-d="-2">−</button>
          <span class="cdmg-val tax-val">+${c.commanderTax||0}</span>
          <button class="cadj" data-taxcid="${c.id}" data-d="2">+</button>
        </div>`).join('')}
    </div>`:''}

    ${opponents.length?`<div class="rps">
      <div class="rp-lbl">⚔ CMD Damage</div>
      ${opponents.map(op=>{
        const dmg=me.cmdDmg?.[op.id]||0
        return `<div class="cdmg-row">
          <div class="cdmg-dot" style="background:${op.color}"></div>
          <span class="cdmg-name">${esc(op.name)}</span>
          <button class="cadj" data-cid="${op.id}" data-d="-1">−</button>
          <span class="cdmg-val${dmg>=21?' crit':''}">${dmg}</span>
          <button class="cadj" data-cid="${op.id}" data-d="1">+</button>
        </div>`}).join('')}
    </div>`:''}

    <div class="rps">
      <div class="rp-lbl">Mana Pool <button id="rp-clrmana" class="tiny-btn">clear</button></div>
      <div class="mana-row">
        ${[['W','#f0ece0','#333'],['U','#2266cc','#fff'],['B','#6633aa','#fff'],['R','#cc3333','#fff'],['G','#2a8844','#fff'],['C','#888','#fff']].map(([k,bg,fg])=>
          `<div class="mana-sym" data-mk="${k}" style="background:${bg};color:${fg}">${k}<div class="mc" id="mc-${k}">${me.mana?.[k]||0}</div></div>`).join('')}
      </div>
    </div>

    <div class="rps">
      <div class="rp-lbl">Counters</div>
      ${[['poison','☠ Poison'],['energy','⚡ Energy'],['exp','🎓 Exp'],['rad','☢ Rad']].map(([k,lbl])=>
        `<div class="ctr-row">
          <span class="ctr-lbl">${lbl}</span>
          <button class="cadj" data-ck="${k}" data-d="-1">−</button>
          <span class="ctr-val ctr-${k}">${me.counters?.[k]||0}</span>
          <button class="cadj" data-ck="${k}" data-d="1">+</button>
        </div>`).join('')}
    </div>

    <div class="rps rp-actions">
      <button class="rp-btn primary" id="rp-mulligan">Mulligan</button>
      <button class="rp-btn" id="rp-shuffle">Shuffle</button>
      <button class="rp-btn" id="rp-scry1">Scry 1</button>
      <button class="rp-btn" id="rp-token-search">🔍 Search Tokens…</button>
      <button class="rp-btn" id="rp-token">Custom Token…</button>
      <button class="rp-btn" id="rp-viewtop">View Top Cards…</button>
      <button class="rp-btn" id="rp-conjure">🔮 Conjure Card…</button>
    </div>
  `

  rp.querySelectorAll('[data-a]').forEach(b=>b.addEventListener('click',()=>adjLife(+b.dataset.a)))
  rp.querySelector('#li-adj').addEventListener('click',()=>{ const v=+rp.querySelector('#li-val').value; if(!isNaN(v)&&v){adjLife(v);rp.querySelector('#li-val').value=''} })
  rp.querySelector('#li-set').addEventListener('click',()=>{ const v=+rp.querySelector('#li-val').value; if(!isNaN(v)){setLife(v);rp.querySelector('#li-val').value=''} })

  // Commander tax adjust
  rp.querySelectorAll('[data-taxcid]').forEach(b=>b.addEventListener('click',()=>{
    const me2=S.gs.players[S.playerId]
    const card=me2.commandZone?.find(c=>c.id===+b.dataset.taxcid); if(!card) return
    card.commanderTax=Math.max(0,(card.commanderTax||0)+(+b.dataset.d))
    send({type:'CARD_FIELD',playerId:S.playerId,cardId:card.id,zone:'commandZone',field:'commanderTax',value:card.commanderTax})
  }))

  // CMD dmg
  rp.querySelectorAll('[data-cid]').forEach(b=>b.addEventListener('click',()=>{
    const me2=S.gs.players[S.playerId]; if(!me2.cmdDmg)me2.cmdDmg={}
    me2.cmdDmg[b.dataset.cid]=Math.max(0,(me2.cmdDmg[b.dataset.cid]||0)+(+b.dataset.d))
    if(me2.cmdDmg[b.dataset.cid]>=21) toast('21 CMD damage!','warn')
    send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{cmdDmg:{...me2.cmdDmg}}})
  }))

  rp.querySelectorAll('[data-mk]').forEach(sym=>sym.addEventListener('click',()=>{
    const me2=S.gs.players[S.playerId]; me2.mana[sym.dataset.mk]++
    send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{mana:{...me2.mana}}})
  }))
  rp.querySelector('#rp-clrmana').addEventListener('click',()=>{
    const me2=S.gs.players[S.playerId]; me2.mana={W:0,U:0,B:0,R:0,G:0,C:0}
    send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{mana:{...me2.mana}}})
  })

  rp.querySelectorAll('[data-ck]').forEach(b=>b.addEventListener('click',()=>{
    const me2=S.gs.players[S.playerId]; if(!me2.counters)me2.counters={}
    me2.counters[b.dataset.ck]=Math.max(0,(me2.counters[b.dataset.ck]||0)+(+b.dataset.d))
    if(b.dataset.ck==='poison'&&me2.counters.poison>=10) toast('10 poison counters!','warn')
    send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{counters:{...me2.counters}}})
  }))

  rp.querySelector('#rp-mulligan').addEventListener('click',()=>gMulligan())
  rp.querySelector('#rp-shuffle').addEventListener('click',()=>{ send({type:'SHUFFLE',playerId:S.playerId}); sysMsg(`${S.myName} shuffled`); toast('Shuffled','good') })
  rp.querySelector('#rp-scry1').addEventListener('click',()=>gScry(1))
  rp.querySelector('#rp-token').addEventListener('click',()=>{ const n=prompt('Token name:'); if(n) gCreateToken(n,'Token Creature','',n.match(/\d+\/\d+/)?.[0]||'') })
  rp.querySelector('#rp-token-search').addEventListener('click',()=>openTokenSearch())
  rp.querySelector('#rp-viewtop').addEventListener('click',()=>openLibraryTopModal())
  rp.querySelector('#rp-conjure').addEventListener('click',()=>openConjureModal())
}

// ── Stack bar ──
function renderStack(el, gs) {
  const sb=el.querySelector('#g-stack'); if(!sb) return
  if (!gs.stack?.length) { sb.innerHTML='<span class="stack-lbl">Stack</span><span class="stack-empty">— empty —</span>'; return }
  sb.innerHTML=`<span class="stack-lbl">Stack</span>
    ${gs.stack.map((s,i)=>`
      <div class="si${i===0?' top':''}" data-sid="${s.id}">
        ${i===0?'▶ ':''}<b>${esc(s.name)}</b> <span class="si-who">${esc(gs.players[s.playerId]?.name||'?')}</span>
      </div>${i<gs.stack.length-1?'<span class="sarrow">›</span>':''}
    `).join('')}
    <div class="stack-btns">
      <button class="tb" id="sb-respond">+ Respond</button>
      <button class="tb primary" id="sb-resolve">Resolve Top ›</button>
    </div>`

  sb.querySelectorAll('.si').forEach(item=>item.addEventListener('click',()=>{
    const s=gs.stack.find(x=>x.id===+item.dataset.sid); if(!s) return
    showCtxAt(window.innerWidth/2,50,[
      {head:s.name},
      {label:'Counter this', action:()=>{ send({type:'STACK_COUNTER',stackId:s.id}); sysMsg(`${S.myName} countered ${s.name}`) }},
      {label:'Copy spell',   action:()=>{ send({type:'STACK_PUSH',playerId:S.playerId,name:s.name+' [copy]'}); sysMsg(`${S.myName} copies ${s.name}`) }},
    ])
  }))
  sb.querySelector('#sb-resolve').addEventListener('click',()=>{
    const top=gs.stack[0]; send({type:'STACK_RESOLVE'}); if(top) sysMsg(`${S.myName} resolved ${top.name}`)
  })
  sb.querySelector('#sb-respond').addEventListener('click',()=>{
    const n=prompt('Respond with:'); if(!n) return
    send({type:'STACK_PUSH',playerId:S.playerId,name:n+' [response]'}); sysMsg(`${S.myName} responds: ${n}`)
  })
}

// ═══════════════════════════════════════════════════════════
// GAME ACTIONS
// ═══════════════════════════════════════════════════════════
const me = () => S.gs?.players?.[S.playerId]

function adjLife(d) { const p=me(); if(!p)return; p.life+=d; send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{life:p.life}}); if(p.life<=0)toast(`${S.myName} at 0 life!`,'warn'); sysMsg(`${S.myName}: ${d>0?'+':''}${d} life (now ${p.life})`) }
function setLife(v) { const p=me(); if(!p)return; const old=p.life; p.life=v; send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{life:v}}); sysMsg(`${S.myName}: life set to ${v} (was ${old})`) }
function adjOppLife(oid, d) { const p=S.gs?.players?.[oid]; if(!p)return; p.life+=d; send({type:'PLAYER_UPDATE',playerId:oid,patch:{life:p.life}}) }

function gDraw(n=1) {
  const p=me(); if(!p) return
  if (!p.library?.length) return toast('Library empty!','warn')
  send({type:'DRAW',playerId:S.playerId,count:n})
}

function gNextTurn() {
  const gs=S.gs; if(!gs) return
  const activeId = gs.playerOrder[gs.activePlayerIdx]
  if (activeId !== S.playerId) {
    toast("It's not your turn",'warn')
    return
  }
  const nextIdx=(gs.activePlayerIdx+1)%gs.playerOrder.length
  const nextName=gs.players[gs.playerOrder[nextIdx]]?.name||'?'
  send({type:'NEXT_TURN',playerId:S.playerId})
  sysMsg(`${S.myName} ended their turn. Turn ${gs.turn}: ${nextName}'s turn`)
}

function gUntapAll() {
  const p=me(); if(!p) return
  p.battlefield?.forEach(c=>{c.tapped=false;c.summoningSick=false})
  send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{battlefield:[...p.battlefield]}})
  toast('All permanents untapped','good')
}

function gMulligan() {
  const p=me(); if(!p) return
  const hs=p.hand.length
  p.hand.forEach(c=>{c.tapped=false;p.library.push(c)}); p.hand=[]
  for(let i=p.library.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[p.library[i],p.library[j]]=[p.library[j],p.library[i]]}
  p.libraryCount=p.library.length
  send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{hand:p.hand,library:p.library,libraryCount:p.libraryCount}})
  send({type:'DRAW',playerId:S.playerId,count:7})
  sysMsg(`${S.myName} took a mulligan`); toast(`Mulligan! Drew 7`,'warn')
}

function gScry(n=1) {
  const p=me(); if(!p||!p.library?.length) return
  S.modal = { type:'libtop', count:n, label:`Scry ${n}`, hint:'Reorder, or send cards to the bottom/graveyard/exile. Click Done when finished.' }
  R()
}

function gSurveil(n) {
  const p=me(); if(!p||!p.library?.length) return
  S.modal = { type:'libtop', count:n, label:`Surveil ${n}`, hint:'Look at the top cards — keep on top in any order, or put into the graveyard.' }
  R()
}

function openLibraryTopModal(n=1) {
  const p=me(); if(!p) return
  if (!p.library?.length) return toast('Library empty!','warn')
  S.modal = { type:'libtop', count:Math.min(n,p.library.length), label:'View Top Cards', hint:'Look at, reorder, or move the top cards of your library.' }
  R()
}

function gMoveCard(cardId, fromZone, toZone, tapped=false) {
  // Tokens leaving the battlefield cease to exist (MTG rule 111.7)
  if (fromZone === 'battlefield') {
    const p = S.gs?.players?.[S.playerId]
    const card = p?.battlefield?.find(c => c.id === cardId)
    if (card?.token && toZone !== 'battlefield') {
      // Just remove from battlefield, don't send anywhere
      p.battlefield = p.battlefield.filter(c => c.id !== cardId)
      send({type:'PLAYER_UPDATE', playerId:S.playerId, patch:{ battlefield:[...p.battlefield] }})
      toast(card.name + ' token ceases to exist','good')
      sysMsg(S.myName + ': ' + card.name + ' token ceased to exist')
      return
    }
  }
  send({type:'MOVE_CARD',playerId:S.playerId,cardId,fromZone,toZone,tapped})
}

function gPlayCard(card) {
  const zone = inferZone(card.type_line||'')
  if (zone==='land') {
    gMoveCard(card.id,'hand','battlefield'); sysMsg(`${S.myName} played ${card.name}`); toast(`Played ${card.name}`,'good')
  } else {
    gMoveCard(card.id,'hand','battlefield')
    sysMsg(`${S.myName} cast ${card.name}`); toast(`Cast: ${card.name}`,'gold')
  }
}

function gTapCard(card, zone='battlefield') {
  card.tapped=!card.tapped
  send({type:'TAP_CARD',playerId:S.playerId,cardId:card.id,tapped:card.tapped,zone})
}

function gCreateToken(name, type_line, oracle_text, pt='') {
  const p=me(); if(!p) return
  const t={id:++S.cardIdCounter,name,type_line,oracle_text,mana_cost:'',image_uri:'',pt,tapped:false,summoningSick:false,counters:{},token:true}
  fetchCard(name.replace(/^\d+\/\d+\s*/,'')).then(d=>{if(d?.image_uri){t.image_uri=d.image_uri;R()}})
  if(!p.battlefield)p.battlefield=[]
  p.battlefield.push(t)
  send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{battlefield:[...p.battlefield]}})
  toast(`Token: ${name}`,'good'); sysMsg(`${S.myName} created ${name} token`)
}

function gCastCommander(card) {
  gMoveCard(card.id,'commandZone','battlefield')
  sysMsg(`${S.myName} cast commander ${card.name}`); toast(`Cast commander: ${card.name}`,'gold')
}

function showLibMenu() {
  const p=me(); if(!p) return
  showCtxAt(window.innerWidth-220,180,[
    {head:`Library (${p.libraryCount||p.library?.length||0})`},
    {label:'Draw 1',    action:()=>gDraw(1)},
    {label:'Draw 3',    action:()=>gDraw(3)},
    {label:'Draw 7',    action:()=>gDraw(7)},
    {sep:true},
    {label:'Scry 1',    action:()=>gScry(1)},
    {label:'Scry 2',    action:()=>gScry(2)},
    {label:'Scry 3',    action:()=>gScry(3)},
    {sep:true},
    {label:'Surveil 1', action:()=>gSurveil(1)},
    {label:'Surveil 2', action:()=>gSurveil(2)},
    {label:'Surveil 3', action:()=>gSurveil(3)},
    {sep:true},
    {label:'View Top Cards…', action:()=>openLibraryTopModal(1)},
    {sep:true},
    {label:'View / Search Whole Library', action:()=>openZoneModal('Library', p.library||[], 'library', false, true)},
    {sep:true},
    {label:'Shuffle',   action:()=>{ send({type:'SHUFFLE',playerId:S.playerId}); toast('Shuffled','good') }},
    {label:'Mill 1 → GY', action:()=>{ const c=p.library?.shift(); if(c){p.graveyard.push(c);p.libraryCount=p.library.length;send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{library:p.library,graveyard:p.graveyard,libraryCount:p.libraryCount}});toast(`Milled: ${c.name}`,'warn')} }},
    {label:'Mill 3 → GY', action:()=>{ const cs=p.library?.splice(0,3)||[]; cs.forEach(c=>p.graveyard.push(c)); p.libraryCount=p.library.length; send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{library:p.library,graveyard:p.graveyard,libraryCount:p.libraryCount}}); toast(`Milled ${cs.length}`,'warn') }},
  ])
}

// ═══════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════
function openCardModal(card, zone) { S.modal={type:'card',card,zone}; R() }
function openZoneModal(title, cards, zone, readOnly=false, searchable=false) { S.modal={type:'zone',title,cards,zone,readOnly,searchable,filter:''}; R() }
function openViewModal(card) { S.modal={type:'card',card,zone:'view',readOnly:true}; R() }
function openCountersModal(card, zone) { S.modal={type:'counters',card,zone}; R() }
function openBoardModal(player) { S.viewingPlayer = player.id; R() }
function openTokenSearch() { S.modal={type:'tokensearch',query:'',results:[]}; R() }
function openConjureModal() { S.modal={type:'conjure'}; R() }

function buildModal() {
  const m=S.modal; if(!m) return document.createDocumentFragment()
  const bg = div('modal-bg')
  bg.addEventListener('click', e=>{ if(e.target===bg){ if(S.modal?.onClose){S.modal.onClose()}else{S.modal=null;R()} } })

  if (m.type==='card') {
    const {card,zone,readOnly}=m
    const actions = readOnly ? [] : getCardActions(card,zone)
    bg.innerHTML=`<div class="modal">
      <div class="modal-hdr"><h3>${esc(card.name)}</h3><button class="x-btn" id="mc-close">✕</button></div>
      <div class="modal-body">
        ${card.image_uri?`<img class="modal-img" src="${card.image_uri}" />`:''}
        <div class="modal-type">${esc(card.type_line||'')}</div>
        <div class="modal-oracle">${esc(card.oracle_text||'')}</div>
        ${card.pt?`<div class="modal-pt">${esc(card.pt)}</div>`:''}
        ${card.isCommander?`<div class="modal-pt" style="color:#a070e0">👑 Commander${card.commanderTax?` · Tax +${card.commanderTax}`:''}</div>`:''}
        ${Object.keys(card.counters||{}).length?`<div class="modal-counters">${Object.entries(card.counters).filter(([,v])=>v).map(([k,v])=>`<span class="ctr-chip">${esc(k)}: ${v}</span>`).join('')}</div>`:''}
        <div class="modal-acts" id="modal-acts"></div>
      </div>
    </div>`
    bg.querySelector('#mc-close').addEventListener('click',()=>{ if(m.onClose){m.onClose()}else{S.modal=null;R()} })
    const actsEl=bg.querySelector('#modal-acts')
    actions.forEach(a=>{
      const b=document.createElement('button'); b.className='ma-btn'+(a.red?' red':'')+(a.gold?' gold':'')
      b.textContent=a.label
      b.addEventListener('click',()=>{ if(a.keepOpen){ a.fn(); R() } else { S.modal=null; a.fn(); R() } })
      actsEl.appendChild(b)
    })
    if (!card.image_uri||!card.oracle_text) fetchCard(card.name).then(d=>{ if(d){Object.assign(card,d);if(S.modal?.card?.id===card.id)R()} })
  }

  else if (m.type==='zone') {
    const {title,cards,zone,readOnly,searchable,filter}=m
    const filtered = filter ? cards.filter(c=>c.name.toLowerCase().includes(filter.toLowerCase())) : cards
    bg.innerHTML=`<div class="modal zone-modal">
      <div class="modal-hdr">
        <h3>${esc(title)} (${filtered.length}${filter?` / ${cards.length}`:''})</h3>
        <button class="x-btn" id="mz-close">✕</button>
      </div>
      ${searchable?`<div class="zone-search-row">
        <input id="zone-search" class="db-si" placeholder="Search by name…" value="${esc(filter||'')}" style="width:100%" />
      </div>`:''}
      <div class="zone-grid" id="zone-grid"></div>
    </div>`
    bg.querySelector('#mz-close').addEventListener('click',()=>{S.modal=null;R()})

    if (searchable) {
      const input = bg.querySelector('#zone-search')
      input.addEventListener('input', () => { S.modal.filter = input.value; renderZoneGrid() })
      setTimeout(()=>input.focus(),0)
    }

    const renderZoneGrid = () => {
      const grid=bg.querySelector('#zone-grid')
      grid.innerHTML=''
      const list = S.modal.filter ? cards.filter(c=>c.name.toLowerCase().includes(S.modal.filter.toLowerCase())) : cards
      bg.querySelector('.modal-hdr h3').textContent = `${title} (${list.length}${S.modal.filter?` / ${cards.length}`:''})`
      list.forEach(card=>{
        const wrap=div('zc-wrap')
        const img=div('zc-img')
        if(card.image_uri) img.innerHTML=`<img src="${card.image_uri}" loading="lazy" />`
        else { img.innerHTML=`<div class="zc-name">${esc(card.name)}</div>`; fetchCard(card.name).then(d=>{if(d?.image_uri){card.image_uri=d.image_uri;img.innerHTML=`<img src="${d.image_uri}" loading="lazy" />`}}) }
        wrap.appendChild(img)
        wrap.appendChild(Object.assign(div('zc-label'),{textContent:card.name}))
        if (!readOnly) {
          const btns=div('zc-btns')
          if (zone==='scry') {
            const p=me()
            addZcBtn(btns,'Keep on top',()=>{ toast(`${card.name} kept on top`,'good'); S.modal=null; R() })
            addZcBtn(btns,'→ Bottom',()=>{
              if(p){ const i=p.library.findIndex(c=>c.id===card.id); if(i>=0){p.library.splice(i,1);p.library.push(card);p.libraryCount=p.library.length; send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{library:p.library,libraryCount:p.libraryCount}}) } }
              toast(`${card.name} → bottom`); S.modal=null; R()
            })
          } else if (zone==='library') {
            addZcBtn(btns,'To hand',()=>{ gMoveCard(card.id,'library','hand'); S.modal=null; R() })
            addZcBtn(btns,'To battlefield',()=>{ gMoveCard(card.id,'library','battlefield'); S.modal=null; R() })
            addZcBtn(btns,'To GY',()=>{ gMoveCard(card.id,'library','graveyard'); S.modal=null; R() })
          } else {
            getCardActions(card,zone).slice(0,3).forEach(a=>addZcBtn(btns,a.label.replace(/[▶↺↷☠✦↩↑📚⚡👑]/,'').trim(),()=>{ S.modal=null; a.fn(); R() }))
          }
          wrap.appendChild(btns)
        }
        img.addEventListener('click',()=>openCardModal(card,zone))
        grid.appendChild(wrap)
      })
    }
    renderZoneGrid()
  }

  else if (m.type==='counters') {
    const {card,zone}=m
    const current = card.counters||{}
    bg.innerHTML=`<div class="modal" style="max-width:280px">
      <div class="modal-hdr"><h3>Counters: ${esc(card.name)}</h3><button class="x-btn" id="ctr-close">✕</button></div>
      <div class="modal-body">
        <div class="ctr-current" id="ctr-current"></div>
        <div class="ctr-presets">
          ${COUNTER_PRESETS.map(p=>`<button class="zca-btn ctr-preset" data-k="${esc(p.key)}">${esc(p.label)} +1</button>`).join('')}
        </div>
        <div class="ctr-custom-row">
          <input id="ctr-custom-name" class="db-si" placeholder="Custom counter name…" style="flex:1" />
          <button class="db-sbtn" id="ctr-custom-add">+1</button>
        </div>
      </div>
    </div>`
    bg.querySelector('#ctr-close').addEventListener('click',()=>{S.modal=null;R()})

    const renderCurrent = () => {
      const cur=bg.querySelector('#ctr-current')
      const entries=Object.entries(card.counters||{}).filter(([,v])=>v)
      if(!entries.length){ cur.innerHTML='<div class="empty-hint">No counters yet</div>'; return }
      cur.innerHTML = entries.map(([k,v])=>`
        <div class="ctr-cur-row">
          <span class="ctr-cur-name">${esc(k)}</span>
          <button class="cadj" data-adjk="${esc(k)}" data-d="-1">−</button>
          <span class="ctr-cur-val">${v}</span>
          <button class="cadj" data-adjk="${esc(k)}" data-d="1">+</button>
        </div>`).join('')
      cur.querySelectorAll('[data-adjk]').forEach(b=>b.addEventListener('click',()=>{
        const k=b.dataset.adjk
        const val=Math.max(0,(card.counters[k]||0)+(+b.dataset.d))
        if(val<=0) delete card.counters[k]; else card.counters[k]=val
        send({type:'CARD_COUNTERS',playerId:S.playerId,cardId:card.id,zone,counterKey:k,value:val})
        renderCurrent()
      }))
    }
    renderCurrent()

    bg.querySelectorAll('.ctr-preset').forEach(b=>b.addEventListener('click',()=>{
      const k=b.dataset.k
      if(!card.counters)card.counters={}
      const val=(card.counters[k]||0)+1
      card.counters[k]=val
      send({type:'CARD_COUNTERS',playerId:S.playerId,cardId:card.id,zone,counterKey:k,value:val})
      renderCurrent()
    }))
    bg.querySelector('#ctr-custom-add').addEventListener('click',()=>{
      const name=bg.querySelector('#ctr-custom-name').value.trim(); if(!name) return
      if(!card.counters)card.counters={}
      const val=(card.counters[name]||0)+1
      card.counters[name]=val
      send({type:'CARD_COUNTERS',playerId:S.playerId,cardId:card.id,zone,counterKey:name,value:val})
      bg.querySelector('#ctr-custom-name').value=''
      renderCurrent()
    })
  }

  else if (m.type==='libtop') {
    const p = me()
    const n = m.count
    // workingSet: fixed list of card IDs we're inspecting.
    // Set ONCE when modal opens. Never auto-replaced when cards move out.
    // Increasing count appends more cards from library top.
    if (!m.workingSet) {
      m.workingSet = (p.library||[]).slice(0, n).map(c=>c.id)
    }

    bg.innerHTML=`<div class="modal" style="max-width:560px;width:95vw">
      <div class="modal-hdr"><h3>${esc(m.label)}</h3><button class="x-btn" id="lt-close">✕</button></div>
      <div class="modal-body">
        <div class="libtop-hint">${esc(m.hint||'')}</div>
        <div class="libtop-controls">
          <label class="lt-lbl">Cards to show:</label>
          <button class="zca-btn" id="lt-dec">−</button>
          <input type="number" id="lt-count" value="${n}" min="1" max="${p.library?.length||100}" class="lt-count-in" />
          <button class="zca-btn" id="lt-inc">+</button>
          <span class="lt-of">of ${p.library?.length||0}</span>
          <button class="zca-btn" id="lt-shuffle-rest" style="margin-left:auto">Shuffle library</button>
          <button class="ma-btn gold" id="lt-done">Done</button>
        </div>
        <div class="libtop-grid" id="libtop-grid"></div>
      </div>
    </div>`
    bg.querySelector('#lt-close').addEventListener('click',()=>{S.modal=null;R()})
    bg.querySelector('#lt-done').addEventListener('click',()=>{S.modal=null;R()})
    bg.querySelector('#lt-shuffle-rest').addEventListener('click',()=>{
      send({type:'SHUFFLE',playerId:S.playerId}); toast('Library shuffled','good'); S.modal=null; R()
    })
    const countIn = bg.querySelector('#lt-count')
    const updateCount = () => {
      const newN = Math.max(1, Math.min(p.library?.length||1, parseInt(countIn.value)||1))
      countIn.value = newN
      S.modal.count = newN
      const ws = S.modal.workingSet
      if (ws) {
        // Count how many workingSet cards are still in the library (not moved out)
        const visibleCount = ws.filter(id => p.library?.find(c=>c.id===id)).length
        // If we need more visible cards, append from top of library (never replace moved-out slots)
        if (visibleCount < newN) {
          const need = newN - visibleCount
          let added = 0
          for (const card of (p.library||[])) {
            if (added >= need) break
            if (!ws.includes(card.id)) { ws.push(card.id); added++ }
          }
        }
      }
      renderGrid()
    }
    bg.querySelector('#lt-dec').addEventListener('click',()=>{ countIn.value=Math.max(1,parseInt(countIn.value||1)-1); updateCount() })
    bg.querySelector('#lt-inc').addEventListener('click',()=>{ countIn.value=parseInt(countIn.value||1)+1; updateCount() })
    countIn.addEventListener('change', updateCount)
    countIn.addEventListener('input', updateCount)

    const grid = bg.querySelector('#libtop-grid')
    const renderGrid = () => {
      grid.innerHTML=''
      // Only show cards that are still in working set AND still in library
      const cards = (m.workingSet||[])
        .map(id => p.library?.find(c=>c.id===id))
        .filter(Boolean)
      if (!cards.length) { grid.innerHTML='<div class="empty-hint">All cards moved. Click Done.</div>'; return }
      cards.forEach((card, idx) => {
        const wrap=div('zc-wrap')
        const img=div('zc-img')
        if(card.image_uri) img.innerHTML=`<img src="${card.image_uri}" loading="lazy" />`
        else { img.innerHTML=`<div class="zc-name">${esc(card.name)}</div>`; fetchCard(card.name).then(d=>{if(d?.image_uri){card.image_uri=d.image_uri;img.innerHTML=`<img src="${d.image_uri}" loading="lazy" />`}}) }
        wrap.appendChild(img)
        wrap.appendChild(Object.assign(div('zc-label'),{textContent:`${card.name}`}))
        const btns=div('zc-btns')
        // moveFromLib: remove from library, add to zone, remove from working set, re-render
        const moveFromLib = (destZone) => {
          const i = p.library.findIndex(c=>c.id===card.id); if(i<0) return
          const [moved] = p.library.splice(i,1)
          p.libraryCount = p.library.length
          moved.tapped = false
          if (!p[destZone]) p[destZone]=[]
          p[destZone].push(moved)
          // Remove from working set so it doesn't show again
          if (m.workingSet) m.workingSet = m.workingSet.filter(id=>id!==card.id)
          netSend({ type:'MOVE_CARD', playerId:S.playerId, cardId:card.id,
                    fromZone:'library', toZone:destZone, _from:S.playerId })
          netSend({ type:'PLAYER_UPDATE', playerId:S.playerId,
                    patch:{libraryCount:p.libraryCount}, _from:S.playerId })
          renderGrid()
        }
        addZcBtn(btns,'Hand',()=>moveFromLib('hand'))
        addZcBtn(btns,'Battlefield',()=>moveFromLib('battlefield'))
        addZcBtn(btns,'→ Bottom',()=>{
          const i=p.library.findIndex(c=>c.id===card.id)
          if(i>=0){ const [cc]=p.library.splice(i,1); p.library.push(cc); p.libraryCount=p.library.length
            netSend({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{library:p.library,libraryCount:p.libraryCount},_from:S.playerId}) }
          if (m.workingSet) m.workingSet=m.workingSet.filter(id=>id!==card.id)
          renderGrid()
        })
        addZcBtn(btns,'GY',()=>moveFromLib('graveyard'))
        addZcBtn(btns,'Exile',()=>moveFromLib('exile'))
        if (idx>0) addZcBtn(btns,'↑',()=>{
          // Reorder in working set
          if(m.workingSet){[m.workingSet[idx-1],m.workingSet[idx]]=[m.workingSet[idx],m.workingSet[idx-1]]}
          // Also reorder in actual library
          const li=p.library.findIndex(c=>c.id===card.id)
          const prevCard=cards[idx-1]
          const li2=p.library.findIndex(c=>c.id===prevCard?.id)
          if(li>=0&&li2>=0){[p.library[li2],p.library[li]]=[p.library[li],p.library[li2]]}
          netSend({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{library:p.library},_from:S.playerId})
          renderGrid()
        })
        wrap.appendChild(btns)
        img.addEventListener('click',()=>openCardModal(card,'library'))
        grid.appendChild(wrap)
      })
    }
    renderGrid()
  }

  else if (m.type==='tokensearch') {
    bg.innerHTML=`<div class="modal" style="max-width:560px;width:95vw">
      <div class="modal-hdr"><h3>🎴 Search Tokens</h3><button class="x-btn" id="ts-close">✕</button></div>
      <div class="modal-body" style="gap:.4rem">
        <div style="display:flex;gap:.4rem">
          <input id="ts-q" class="db-si" placeholder="Search token name e.g. Goblin, Soldier, Treasure…" style="flex:1" />
          <button class="db-sbtn" id="ts-go">Search</button>
        </div>
        <div style="font-size:.7rem;color:var(--text3)">Official Scryfall token art. Click any token to create it on your battlefield.</div>
        <div id="ts-results" style="display:flex;flex-wrap:wrap;gap:.5rem;overflow-y:auto;max-height:380px;padding:.2rem 0"></div>
      </div>
    </div>`
    bg.querySelector('#ts-close').addEventListener('click',()=>{S.modal=null;R()})
    bg.addEventListener('click',e=>{if(e.target===bg){S.modal=null;R()}})

    // Restore previous results if returning from card preview
    if (m.cachedResults?.length) {
      setTimeout(() => renderTokenResults(m.cachedResults, bg), 0)
      if (m.lastQuery) bg.querySelector('#ts-q').value = m.lastQuery
    }

    const doSearch = async () => {
      const q = bg.querySelector('#ts-q').value.trim()
      if (!q) return
      m.lastQuery = q
      const res = bg.querySelector('#ts-results')
      res.innerHTML = '<div class="empty-hint">Searching Scryfall tokens…</div>'
      try {
        const cards = await searchTokens(q)
        res.innerHTML = ''
        if (!cards.length) { res.innerHTML='<div class="empty-hint">No tokens found for "'+esc(q)+'".</div>'; return }
        m.cachedResults = cards.slice(0,40)
        renderTokenResults(m.cachedResults, bg)
      } catch(err) {
        console.error('Token search failed:', err)
        const msg = (err?.message || '').includes('NETWORK_ERROR')
          ? 'Network error — check your internet connection.'
          : (err?.message || '').includes('SCRYFALL_429')
            ? 'Scryfall rate limit hit — wait a few seconds and try again.'
            : 'Search failed: ' + (err?.message || 'unknown error')
        res.innerHTML = '<div class="empty-hint">'+esc(msg)+'</div>'
      }
    }

    function renderTokenResults(cards, bgEl) {
      const res2 = bgEl.querySelector('#ts-results'); if(!res2) return
      res2.innerHTML=''
      cards.forEach(card => {
          const imgUri = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || ''
          const smallUri = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || ''
          if (!imgUri) return
          const wrap = div('zc-wrap')
          wrap.style.cssText='cursor:pointer;'
          const img = document.createElement('img')
          img.src = smallUri || imgUri
          img.loading = 'lazy'
          img.style.cssText='width:74px;height:103px;object-fit:cover;border-radius:4px;border:1.5px solid var(--border2);transition:border-color .12s'
          img.addEventListener('mouseenter',()=>img.style.borderColor='var(--gold)')
          img.addEventListener('mouseleave',()=>img.style.borderColor='var(--border2)')
          const lbl = div('zc-label')
          lbl.textContent = card.name
          const pt = (card.power&&card.toughness)?card.power+'/'+card.toughness:''
          wrap.appendChild(img)
          wrap.appendChild(lbl)
          if (pt) wrap.appendChild(Object.assign(div('zc-label'),{textContent:pt,style:'color:var(--gold3)'}))
          const createToken = () => {
            const token = {
              id:++S.cardIdCounter, name:card.name,
              type_line:card.type_line||'Token',
              oracle_text:card.oracle_text||card.card_faces?.[0]?.oracle_text||'',
              mana_cost:'', image_uri:imgUri, pt,
              tapped:false, summoningSick:false, counters:{}, token:true,
            }
            const p2 = S.gs?.players?.[S.playerId]; if(!p2) return
            if (!p2.battlefield) p2.battlefield=[]
            p2.battlefield.push(token)
            send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{battlefield:[...p2.battlefield]}})
            toast('Token created: '+card.name,'good')
            sysMsg(S.myName+' created '+card.name+' token')
            S.modal=null; R()
          }
          // Left-click image = preview card detail; X button returns to token search
          img.addEventListener('click', ()=>{
            const savedModal = { ...S.modal }  // snapshot (includes cachedResults & lastQuery)
            S.modal = { type:'card',
              card:{ id:-1, name:card.name, type_line:card.type_line||'Token',
                oracle_text:card.oracle_text||card.card_faces?.[0]?.oracle_text||'',
                image_uri:imgUri, pt, mana_cost:'', counters:{} },
              zone:'view', readOnly:true,
              onClose: () => { S.modal = savedModal; R() }  // ← back to token search with results
            }
            R()
          })
          const addBtn2 = document.createElement('button')
          addBtn2.className='zca-btn'; addBtn2.textContent='+ Create'
          addBtn2.addEventListener('click', createToken)
          wrap.appendChild(addBtn2)
          res.appendChild(wrap)
        })
    }

    bg.querySelector('#ts-go').addEventListener('click', doSearch)
    bg.querySelector('#ts-q').addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch() })
    // Auto-search common tokens if empty
    setTimeout(()=>{ bg.querySelector('#ts-q').focus() }, 50)
  }

  else if (m.type==='conjure') {
    // Conjure: search Scryfall, add card directly to hand/battlefield.
    // Conjured cards have a special "banish" action that removes them entirely.
    bg.innerHTML=`<div class="modal" style="max-width:520px;width:95vw">
      <div class="modal-hdr">
        <h3>🔮 Conjure Card</h3>
        <button class="x-btn" id="conj-close">✕</button>
      </div>
      <div class="modal-body" style="gap:.4rem">
        <div style="font-size:.72rem;color:var(--text3);line-height:1.5">
          Add any card directly into the game from outside. Conjured cards can be
          <b style="color:var(--purple2)">banished</b> (right-click → Banish) to remove them
          from existence entirely — they won't go to GY, exile, or anywhere.
        </div>
        <div style="display:flex;gap:.4rem">
          <input id="conj-q" class="db-si" placeholder="Search any card name…" style="flex:1" />
          <button class="db-sbtn" id="conj-go">Search</button>
        </div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap" id="conj-dest-row">
          <span style="font-size:.7rem;color:var(--text3);align-self:center">Add to:</span>
          <button class="zca-btn conj-dest on" data-dest="hand">Hand</button>
          <button class="zca-btn conj-dest" data-dest="battlefield">Battlefield</button>
        </div>
        <div id="conj-results" style="display:flex;flex-wrap:wrap;gap:.5rem;overflow-y:auto;max-height:340px;padding:.2rem 0"></div>
      </div>
    </div>`
    let conjDest = 'hand'
    bg.querySelector('#conj-close').addEventListener('click',()=>{S.modal=null;R()})
    bg.addEventListener('click',e=>{if(e.target===bg){S.modal=null;R()}})
    bg.querySelectorAll('.conj-dest').forEach(b=>b.addEventListener('click',()=>{
      bg.querySelectorAll('.conj-dest').forEach(x=>x.classList.remove('on'))
      b.classList.add('on'); conjDest=b.dataset.dest
    }))

    const conjSearch = async () => {
      const q = bg.querySelector('#conj-q').value.trim(); if(!q) return
      const res = bg.querySelector('#conj-results')
      res.innerHTML='<div class="empty-hint">Searching…</div>'
      try {
        const cards = await searchCards(q)
        res.innerHTML=''
        if (!cards.length) { res.innerHTML='<div class="empty-hint">No results for "'+esc(q)+'".</div>'; return }
        cards.slice(0,20).forEach(card => {
          const imgUri = card.image_uri||''
          const smallUri = card.image_small||''
          if (!imgUri) return
          const wrap = div('zc-wrap')
          const img = document.createElement('img')
          img.src = smallUri||imgUri; img.loading='lazy'
          img.style.cssText='width:74px;height:103px;object-fit:cover;border-radius:4px;border:1.5px solid var(--border2);cursor:pointer;transition:border-color .12s'
          img.addEventListener('mouseenter',()=>img.style.borderColor='var(--purple2)')
          img.addEventListener('mouseleave',()=>img.style.borderColor='var(--border2)')
          const lbl = Object.assign(div('zc-label'),{textContent:card.name})
          const addBtn = document.createElement('button')
          addBtn.className='zca-btn'; addBtn.textContent='+ Add'
          addBtn.style.cssText='border-color:var(--purple2);color:var(--purple2)'
          const doAdd = () => {
            const p2 = S.gs?.players?.[S.playerId]; if(!p2) return
            const conjCard = {
              id:++S.cardIdCounter, name:card.name,
              type_line:card.type_line||'', mana_cost:card.mana_cost||'',
              oracle_text:card.oracle_text||card.card_faces?.[0]?.oracle_text||'',
              image_uri:imgUri, pt:(card.power&&card.toughness)?card.power+'/'+card.toughness:'',
              loyalty:card.loyalty||'', tapped:false, summoningSick:false,
              counters:{}, token:false, conjured:true  // mark as conjured for banish action
            }
            if (!p2[conjDest]) p2[conjDest]=[]
            p2[conjDest].push(conjCard)
            send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{[conjDest]:[...p2[conjDest]]}})
            toast(`Conjured: ${card.name} → ${conjDest}`,'gold')
            sysMsg(`${S.myName} conjured ${card.name} into ${conjDest}`)
            S.modal=null; R()
          }
          addBtn.addEventListener('click', doAdd)
          img.addEventListener('click', doAdd)
          wrap.appendChild(img); wrap.appendChild(lbl); wrap.appendChild(addBtn)
          res.appendChild(wrap)
        })
        if (!res.children.length) res.innerHTML='<div class="empty-hint">No results.</div>'
      } catch(err) {
        console.error('Conjure search failed:', err)
        const msg = (err?.message || '').includes('NETWORK_ERROR')
          ? 'Network error — check your internet connection.'
          : (err?.message || '').includes('SCRYFALL_429')
            ? 'Scryfall rate limit hit — wait a few seconds and try again.'
            : 'Search failed: ' + (err?.message || 'unknown error')
        res.innerHTML = '<div class="empty-hint">'+esc(msg)+'</div>'
      }
    }
    bg.querySelector('#conj-go').addEventListener('click', conjSearch)
    bg.querySelector('#conj-q').addEventListener('keydown',e=>e.key==='Enter'&&conjSearch())
    setTimeout(()=>bg.querySelector('#conj-q')?.focus(),50)
  }

  return bg
}

function addZcBtn(parent,label,fn) {
  const b=document.createElement('button'); b.className='zca-btn'; b.textContent=label; b.addEventListener('click',fn); parent.appendChild(b)
}

function getCardActions(card, zone) {
  const acts=[]
  const add=(label,fn,opts={})=>acts.push({label,fn,red:opts.red,gold:opts.gold,keepOpen:opts.keepOpen})
  if (zone==='hand') {
    add('▶ Play / Cast',()=>gPlayCard(card))
    add('↓ Put on battlefield',()=>{ gMoveCard(card.id,'hand','battlefield'); sysMsg(`${S.myName} put ${card.name} on battlefield`) })
    add('☠ Discard',()=>{ gMoveCard(card.id,'hand','graveyard'); sysMsg(`${S.myName} discarded ${card.name}`) },{red:true})
    add('📚 Return to library (top)',()=>gMoveCard(card.id,'hand','library_top'))
    add('📚 Return to library (bottom)',()=>gMoveCard(card.id,'hand','library_bottom'))
  } else if (zone==='battlefield') {
    add(card.tapped?'↺ Untap':'↷ Tap',()=>gTapCard(card,'battlefield'))
    if ((card.type_line||'').toLowerCase().includes('creature')) {
      add('⚔ Declare as attacker',()=>{ gTapCard(card,'battlefield'); sysMsg(`${S.myName} attacks with ${card.name}`) })
    }
    add('🔵 Manage counters…',()=>openCountersModal(card,zone),{gold:true,keepOpen:true})
    if ((card.type_line||'').toLowerCase().includes('planeswalker')) {
      add('+1 Loyalty',()=>{ if(!card.counters)card.counters={}; card.counters.loyalty=(card.counters.loyalty||0)+1; send({type:'CARD_COUNTERS',playerId:S.playerId,cardId:card.id,zone:'battlefield',counterKey:'loyalty',value:card.counters.loyalty}) })
    }
    add('⚡ Activate ability',()=>{ const ab=prompt('Ability:'); if(ab){ sysMsg(`${S.myName} activates ${card.name}: ${ab}`) } })
    add('☠ Destroy → GY',()=>{ gMoveCard(card.id,'battlefield','graveyard'); sysMsg(`${S.myName}: ${card.name} → GY`) })
    add('✦ Exile',()=>{ gMoveCard(card.id,'battlefield','exile'); sysMsg(`${S.myName}: ${card.name} → exile`) },{red:true})
    add('↩ Bounce to hand',()=>{ gMoveCard(card.id,'battlefield','hand'); sysMsg(`${S.myName}: ${card.name} → hand`) })
    add('📚 Return to library',()=>gMoveCard(card.id,'battlefield','library_bottom'))
    if (card.token || card.conjured) {
      add('💨 Banish (remove from existence)',()=>{
        const p = S.gs?.players?.[S.playerId]
        if (!p) return
        // Remove card from wherever it is — no zone, just gone
        ;['battlefield','graveyard','exile','hand','commandZone'].forEach(z=>{
          if (p[z]) p[z] = p[z].filter(c=>c.id!==card.id)
        })
        send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{
          battlefield:[...(p.battlefield||[])],
          graveyard:[...(p.graveyard||[])],
          exile:[...(p.exile||[])],
          hand:[...(p.hand||[])],
        }})
        toast(`${card.name} banished from existence`,'gold')
        sysMsg(`${S.myName} banished ${card.name}`)
      },{red:true})
    }
  } else if (zone==='graveyard') {
    add('↩ Return to hand',()=>{ gMoveCard(card.id,'graveyard','hand'); sysMsg(`${S.myName}: ${card.name} from GY → hand`) })
    add('↑ Return to battlefield',()=>{ gMoveCard(card.id,'graveyard','battlefield'); sysMsg(`${S.myName}: ${card.name} from GY → battlefield`) })
    add('📚 Return to library (top)',()=>gMoveCard(card.id,'graveyard','library_top'))
    add('✦ Exile from GY',()=>gMoveCard(card.id,'graveyard','exile'),{red:true})
  } else if (zone==='exile') {
    add('↩ Return to hand',()=>gMoveCard(card.id,'exile','hand'))
    add('↑ Return to battlefield',()=>gMoveCard(card.id,'exile','battlefield'))
  } else if (zone==='commandZone') {
    add('👑 Cast commander',()=>gCastCommander(card))
    if (card.commanderTax) add(`Tax: +${card.commanderTax} (reset)`,()=>{ card.commanderTax=0; send({type:'CARD_FIELD',playerId:S.playerId,cardId:card.id,zone:'commandZone',field:'commanderTax',value:0}) },{keepOpen:true})
    add('↩ Move to hand',()=>gMoveCard(card.id,'commandZone','hand'))
  } else if (zone==='library') {
    add('To hand',()=>gMoveCard(card.id,'library','hand'))
    add('To battlefield',()=>gMoveCard(card.id,'library','battlefield'))
    add('To graveyard',()=>gMoveCard(card.id,'library','graveyard'))
  }
  return acts
}

function showBfCtx(card,e) {
  showCtxAt(e.clientX,e.clientY,[
    {head: card.name + (card.mana_cost?' · '+card.mana_cost:'')},
    {head: (card.type_line||'') + (card.pt?' · '+card.pt:'') + (card.commanderTax?' · Tax +'+card.commanderTax:'')},
    {sep:true},
    {label:card.tapped?'↺ Untap':'↷ Tap',                action:()=>gTapCard(card,'battlefield')},
    {label:'⚔ Declare as attacker',                       action:()=>{ gTapCard(card,'battlefield'); send({type:'STACK_PUSH',playerId:S.playerId,name:card.name+' attacks',card:null}); sysMsg(S.myName+' attacks with '+card.name) }},
    {label:'🔵 Manage counters…',                          action:()=>openCountersModal(card,'battlefield')},
    {label:'⚡ Activate ability…',                         action:()=>{ const ab=prompt('Ability:'); if(ab){send({type:'STACK_PUSH',playerId:S.playerId,name:card.name+': '+ab,card:null});sysMsg(S.myName+' activates '+card.name+': '+ab)} }},
    {sep:true},
    {label:'☠ Destroy → Graveyard',                      action:()=>{ gMoveCard(card.id,'battlefield','graveyard'); sysMsg(S.myName+': '+card.name+'→GY') }},
    {label:'✦ Exile',                                      action:()=>{ gMoveCard(card.id,'battlefield','exile'); sysMsg(S.myName+': '+card.name+'→exile') }},
    {label:'↩ Bounce to hand',                            action:()=>{ gMoveCard(card.id,'battlefield','hand'); sysMsg(S.myName+': '+card.name+'→hand') }},
    {label:'📚 Return to library (bottom)',               action:()=>gMoveCard(card.id,'battlefield','library_bottom')},
    {label:'👑 Return to command zone',                   action:()=>gMoveCard(card.id,'battlefield','commandZone')},
    {sep:true},
    {label:'🔍 View full card details',                   action:()=>openCardModal(card,'battlefield')},
    ...(card.token||card.conjured ? [{sep:true},{label:'💨 Banish (remove from existence)', action:()=>{
      const p=S.gs?.players?.[S.playerId]; if(!p) return
      ;['battlefield','graveyard','exile','hand','commandZone'].forEach(z=>{ if(p[z]) p[z]=p[z].filter(c=>c.id!==card.id) })
      send({type:'PLAYER_UPDATE',playerId:S.playerId,patch:{battlefield:[...(p.battlefield||[])],graveyard:[...(p.graveyard||[])],exile:[...(p.exile||[])],hand:[...(p.hand||[])]}}); toast(`${card.name} banished`,'gold'); sysMsg(`${S.myName} banished ${card.name}`)
    }, red:true}] : []),
  ])
}
function showHandCtx(card,e) {
  showCtxAt(e.clientX,e.clientY,[
    {head:card.name},
    {label:'▶ Play / Cast',  action:()=>gPlayCard(card)},
    {label:'☠ Discard',      action:()=>{ gMoveCard(card.id,'hand','graveyard'); sysMsg(`${S.myName} discarded ${card.name}`) }},
    {sep:true},
    {label:'🔍 View details', action:()=>openCardModal(card,'hand')},
  ])
}

// ═══════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════
function buildChat() {
  const el = div('chat-panel'+(S.chatOpen?'':' hidden'))
  el.innerHTML=`
    <div class="chat-hdr">
      <h3>💬 Game Log</h3>
      <button class="x-btn" id="chat-close">✕</button>
    </div>
    <div class="chat-log" id="chat-log"></div>
    <div class="chat-in-row">
      <input class="chat-in" id="chat-in" placeholder="Say something…" maxlength="200" />
      <button class="chat-send" id="chat-send">Send</button>
    </div>`
  el.querySelector('#chat-close').addEventListener('click',()=>{S.chatOpen=false;R()})
  const sendFn=()=>{
    const inp=el.querySelector('#chat-in'), txt=inp.value.trim(); if(!txt) return
    inp.value=''; send({type:'CHAT',playerId:S.playerId,playerName:S.myName,text:txt,isSystem:false})
  }
  el.querySelector('#chat-send').addEventListener('click',sendFn)
  el.querySelector('#chat-in').addEventListener('keydown',e=>e.key==='Enter'&&sendFn())
  refreshChatEl(el)
  return el
}

function sysMsg(text) { send({type:'CHAT',playerId:S.playerId,playerName:S.myName,text,isSystem:true}) }

function refreshChatEl(el) {
  const log=el?.querySelector('#chat-log'); if(!log||!S.gs?.chat) return
  log.innerHTML=S.gs.chat.slice(-80).map(e=>{
    const col=S.gs.players?.[e.playerId]?.color||'var(--text3)'
    if(e.isSystem) return `<div class="ce sys">${esc(e.text)}</div>`
    return `<div class="ce"><span class="ce-who" style="color:${col}">${esc(e.playerName)}:</span>${esc(e.text)}</div>`
  }).join('')
  log.scrollTop=log.scrollHeight
}

function refreshChat() { refreshChatEl(document.querySelector('.chat-panel')) }

// ═══════════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════════
function buildCtx() {
  const el=document.createElement('div'); el.id='ctx'
  document.addEventListener('click',()=>el.classList.remove('show'))
  return el
}
function showCtxAt(x,y,items) {
  const m=document.getElementById('ctx'); if(!m) return
  m.innerHTML=''
  items.forEach(it=>{
    if(it.sep){ const s=document.createElement('div');s.className='ctx-sep';m.appendChild(s);return }
    if(it.head){ const h=document.createElement('div');h.className='ctx-head';h.textContent=it.head;m.appendChild(h);return }
    const d=document.createElement('div');d.className='ctx-item'+(it.red?' red':'')+(it.gold?' gold':'')
    d.textContent=it.label
    d.addEventListener('click',e=>{e.stopPropagation();it.action?.();hideCtx()})
    m.appendChild(d)
  })
  m.style.left=Math.min(x,innerWidth-185)+'px'
  m.style.top=Math.min(y,innerHeight-items.length*28-8)+'px'
  m.classList.add('show')
}
function hideCtx() { document.getElementById('ctx')?.classList.remove('show') }

// ═══════════════════════════════════════════════════════════
// TOASTS
// ═══════════════════════════════════════════════════════════
function buildToasts() { const el=document.createElement('div');el.id='toasts';return el }
function toast(msg,type='') {
  const el=document.createElement('div'); el.className='toast'+(type?' '+type:''); el.textContent=msg
  document.getElementById('toasts')?.appendChild(el); setTimeout(()=>el.remove(),3000)
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function div(cls='', html='') { const el=document.createElement('div'); if(cls) el.className=cls; if(html) el.innerHTML=html; return el }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

// Drag-resize helper.
// mode: 'v'     = drag down increases height (handle on bottom edge)
//       'v-inv' = drag up increases height (handle on top edge of bottom strip)
//       'h'     = drag right increases width
//       'h-rev' = drag left increases width (handle on left edge)
function wireResize(handle, mode, onChange, getCurrent, min, max) {
  if (!handle) return
  let startPos=0, startVal=0, dragging=false
  const isV = mode==='v' || mode==='v-inv'
  const onMove = e => {
    if (!dragging) return
    const pos = isV ? e.clientY : e.clientX
    let delta = pos - startPos
    if (mode==='h-rev' || mode==='v-inv') delta = -delta
    let val = startVal + delta
    val = Math.max(min, Math.min(max, val))
    onChange(val)
  }
  const onUp = () => { dragging=false; document.body.style.cursor=''; document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp) }
  handle.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation()
    dragging=true
    startPos = isV ? e.clientY : e.clientX
    startVal = getCurrent()
    document.body.style.cursor = isV ? 'row-resize' : 'col-resize'
    document.addEventListener('mousemove',onMove)
    document.addEventListener('mouseup',onUp)
  })
}

function restoreSize(cssVar, key) {
  const v = localStorage.getItem(key)
  if (v) document.documentElement.style.setProperty(cssVar, `${v}px`)
}
