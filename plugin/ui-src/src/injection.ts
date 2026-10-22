import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { HostBridge } from './host/bridge'
import type { ConnectionsStore } from './connections/hostConnections'
import type { createCatalogCache } from './run/catalog'
import type { EngineClient } from './run/engineClient'
import type { PluginSettings } from './state/pluginSettings'
import type { ExportSettings } from './export/exportSettings'
import type { ExportClient } from './export/exportClient'
import type { AiSettings } from './ai/aiSettings'
import type { AiClient } from './ai/aiClient'
import type { ChatStore } from './ai/chatStore'
import type { DrawerManager } from './ai/drawerState'
import type { useNotebookStore } from './state/notebookStore'

export const StoreKey: InjectionKey<ReturnType<typeof useNotebookStore>> = Symbol('sqlnb.store')
export const ConnectionsKey: InjectionKey<ConnectionsStore> = Symbol('sqlnb.connections')
export const BridgeKey: InjectionKey<HostBridge> = Symbol('sqlnb.bridge')
export const CanRunKey: InjectionKey<ComputedRef<boolean>> = Symbol('sqlnb.canRun')
export const SelectedKey: InjectionKey<Ref<string | null>> = Symbol('sqlnb.selected')
export const RunningAllKey: InjectionKey<Ref<boolean>> = Symbol('sqlnb.runningAll')
export const CatalogKey: InjectionKey<ReturnType<typeof createCatalogCache>> = Symbol('sqlnb.catalog')
export const EngineKey: InjectionKey<EngineClient> = Symbol('sqlnb.engine')
export const PluginSettingsKey: InjectionKey<PluginSettings> = Symbol('sqlnb.pluginSettings')
export const ExportSettingsKey: InjectionKey<ExportSettings> = Symbol('sqlnb.exportSettings')
export const ExportClientKey: InjectionKey<ExportClient> = Symbol('sqlnb.exportClient')
export const AiSettingsKey: InjectionKey<AiSettings> = Symbol('sqlnb.aiSettings')
export const AiClientKey: InjectionKey<AiClient> = Symbol('sqlnb.aiClient')
export const DrawerKey: InjectionKey<DrawerManager> = Symbol('sqlnb.drawer')
export const HistoryActionsKey: InjectionKey<import('./shell/historyActions').HistoryActions> = Symbol('sqlnb.historyActions')
export const ChatStoreKey: InjectionKey<ChatStore> = Symbol('sqlnb.chatStore')
export const FileTransferKey: InjectionKey<import('./files/fileTransferClient').FileTransferClient> = Symbol('sqlnb.fileTransfer')
export const DropGateKey: InjectionKey<import('./blocks/dropGate').DropGate> = Symbol('sqlnb.dropGate')
export const DropTargetsKey: InjectionKey<ReturnType<typeof import('./blocks/mdDropTargets').createDropTargets>> = Symbol('sqlnb.dropTargets')
export const DropCandidateKey: InjectionKey<Ref<string | null>> = Symbol('sqlnb.dropCandidate')
