<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, watch } from 'vue'
import { BridgeKey, CatalogKey, ConnectionsKey, StoreKey } from '../injection'
import type { HostConnection } from '../host/bridge'
import CatalogPicker from '../blocks/CatalogPicker.vue'
import { useCatalogOptions } from '../blocks/useCatalogOptions'
import { createCatalogCache, dialectHasSchemas } from '../run/catalog'
import { t } from '../i18n'
import { groupConnections } from '../connections/groups'

const MISSING = '__missing__'
const CURRENT = '__current__'
const store = inject(StoreKey)!
const connections = inject(ConnectionsKey)!
const catalog = inject(CatalogKey, null) ?? createCatalogCache(inject(BridgeKey)!)
const conns = computed(() => connections.list())
const defName = computed(() => store.nb.value.settings.defaultConnection ?? '')
const resolved = computed(() => (defName.value ? connections.resolve(defName.value) : null))
const ready = computed(() => connections.state.value === 'ready' || (connections.state.value === 'loading' && connections.loaded.value))
const grouped = ready
const missing = computed(() => ready.value && !!defName.value && resolved.value?.status === 'unmatched')
const plainCurrent = computed(() => !ready.value && !!defName.value && resolved.value?.status !== 'ok')
const selected = computed(() => (missing.value ? MISSING : plainCurrent.value ? CURRENT : current.value))
const current = computed(() => (resolved.value?.status === 'ok' ? resolved.value.conn.id : ''))
const grp = computed(() => groupConnections(conns.value))
const noneConnected = computed(() => ready.value && conns.value.length > 0 && !grp.value.connected.length)
const ambiguous = computed(() => resolved.value?.status === 'ambiguous')

const okConn = computed(() => (resolved.value?.status === 'ok' ? resolved.value.conn : undefined))
const defDb = computed(() => store.nb.value.settings.defaultDatabase)
const defSc = computed(() => store.nb.value.settings.defaultSchema)
const hasSchemas = computed(() => (okConn.value ? dialectHasSchemas(okConn.value.dialect) !== false : true))
const opts = useCatalogOptions(catalog, () => okConn.value, () => defDb.value ?? okConn.value?.database)
const loaded = { db: false, sc: false }
watch(() => okConn.value?.id, (_id, old) => { if (old !== undefined) catalog.clear(old); opts.reset(); loaded.db = loaded.sc = false })
watch(defDb, () => { opts.sc.options = []; if (loaded.sc) void opts.loadSchemas() })
function openDb() { loaded.db = true; void opts.loadDatabases() }
function openSc() { loaded.sc = true; void opts.loadSchemas() }
function setDb(v: string | undefined) { store.setDefaultCatalog(v, defSc.value) }
function setSc(v: string | undefined) { store.setDefaultCatalog(defDb.value, v) }

const refresh = () => { void connections.refreshIfStale() }
let lastForce = 0
let forcing = false
const forceRefresh = () => {
  const n = Date.now()
  if (forcing || n - lastForce < 50) return
  lastForce = n
  forcing = true
  void connections.refresh({ force: true }).finally(() => { forcing = false })
}
const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
onMounted(() => {
  refresh()
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', onVisible)
})

const label = (c: HostConnection) => {
  const d = c.dialect ? ` (${c.dialect})` : ''
  return `${c.name}${d} · ${c.connected ? t('conn.connected') : t('conn.notConnected')}${c.readOnly ? ` · ${t('conn.readOnly')}` : ''}`
}

async function onPick(e: Event) {
  const id = (e.target as HTMLSelectElement).value
  const c = conns.value.find((x) => x.id === id)
  if (!c || (grouped.value && !c.connected)) return
  store.setDefaultConnection(c.name, c.dialect || undefined)
  if (conns.value.filter((x) => x.name === c.name).length > 1) await connections.setMapping(c.name, c.id)
}
async function onMap(e: Event) {
  const el = e.target as HTMLSelectElement
  const c = conns.value.find((x) => x.id === el.value)
  if (c && !c.connected && grouped.value) return
  if (el.value && defName.value) await connections.setMapping(defName.value, el.value)
}
</script>

<template>
  <div class="cp">
    <select data-test="picker" :value="selected" :title="t('conn.default')" :aria-label="t('conn.default')" @change="onPick">
      <option value="" disabled>{{ t('conn.none') }}</option>
      <template v-if="grouped">
        <optgroup v-if="grp.connected.length" :label="t('conn.groupConnected')">
          <option v-for="c in grp.connected" :key="c.id" :value="c.id" :title="label(c)" :aria-label="label(c)">{{ label(c) }}</option>
        </optgroup>
        <optgroup v-if="grp.disconnected.length" :label="t('conn.groupDisconnected')">
          <option v-for="c in grp.disconnected" :key="c.id" :value="c.id" disabled class="cp-grey" :title="label(c)" :aria-label="label(c)">{{ label(c) }}</option>
        </optgroup>
      </template>
      <template v-else>
        <option v-for="c in conns" :key="c.id" :value="c.id" :title="label(c)" :aria-label="label(c)">{{ label(c) }}</option>
      </template>
      <optgroup v-if="missing" :label="t('conn.groupMissing')">
        <option :value="MISSING" disabled class="cp-grey" data-test="picker-missing-option" :title="t('conn.missing', { name: defName })">{{ t('conn.warnOption', { name: defName }) }}</option>
      </optgroup>
      <option v-else-if="plainCurrent" :value="CURRENT" data-test="picker-current-option">{{ defName }}</option>
    </select>
    <button type="button" class="cp-refresh" data-test="picker-refresh" :aria-label="t('conn.refresh')" :title="t('conn.refresh')" @click="forceRefresh">↻</button>
    <span v-if="connections.state.value === 'unavailable'" class="cp-empty" data-test="picker-unavailable" role="status">{{ t('conn.unavailable') }}</span>
    <span v-else-if="ready && !conns.length" class="cp-empty" data-test="picker-empty" role="status">{{ t('conn.emptyHost') }}</span>
    <span v-if="noneConnected" class="cp-empty" data-test="picker-none-connected" role="status">{{ t('conn.noneConnected') }}</span>
    <CatalogPicker
      kind="database" :model-value="defDb" :options="opts.db.options" :loading="opts.db.loading" :error="opts.db.error"
      :placeholder="t('cat.defDatabase')" @update:model-value="setDb" @open="openDb"
    />
    <CatalogPicker
      v-if="hasSchemas"
      kind="schema" :model-value="defSc" :options="opts.sc.options" :loading="opts.sc.loading" :error="opts.sc.error"
      :placeholder="t('cat.defSchema')" @update:model-value="setSc" @open="openSc"
    />
    <span v-if="ambiguous" class="cp-warn" data-test="picker-warn">
      ⚠ {{ t('conn.unresolved', { name: defName }) }}
      <select v-if="conns.length" data-test="picker-map" value="" @change="onMap">
        <option value="" disabled>{{ t('conn.mapTo') }}</option>
        <template v-if="grouped">
          <optgroup v-if="grp.connected.length" :label="t('conn.groupConnected')">
            <option v-for="c in grp.connected" :key="c.id" :value="c.id">{{ label(c) }}</option>
          </optgroup>
          <optgroup v-if="grp.disconnected.length" :label="t('conn.groupDisconnected')">
            <option v-for="c in grp.disconnected" :key="c.id" :value="c.id" disabled class="cp-grey">{{ label(c) }}</option>
          </optgroup>
        </template>
        <template v-else>
          <option v-for="c in conns" :key="c.id" :value="c.id">{{ label(c) }}</option>
        </template>
      </select>
    </span>
  </div>
</template>

<style scoped>
.cp { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; }
.cp-empty { color: var(--color-muted-foreground, #777); max-width: 320px; }
.cp-grey { color: var(--color-muted-foreground, #888); }
.cp option:disabled { color: var(--color-muted-foreground, #777); }
.cp-warn { color: var(--color-warning, #b80); }
</style>
