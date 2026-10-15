import {
    DEFAULT_SETTINGS,
    buildGatewayMemoryPayload,
    injectGatewayMemoryMessage,
    matchGatewayEndpoint,
    mergeGatewayMemoryIntoCustomIncludeBody,
    normalizeSettings,
    inferGatewayConfiguration,
    activeEndpointSettings,
    collectEndpointCandidates,
    resolveGenerationType,
    shouldSkipGenerationType,
} from './bridge-core.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { getCurrentUserHandle } from '../../../user.js';
import { createTokenStore } from './token-store.js';

const MODULE_NAME = 'tavern-gateway-memory-bridge';
const VERSION = '1.2.0';
const tokenStore = createTokenStore({ persistent: () => localStorage, session: () => sessionStorage });
const MUTATION_STORAGE_KEY = `${MODULE_NAME}:mutations-v1`;
const MAX_MUTATIONS_PER_CHAT = 50;
const MAX_MUTATION_CHATS = 20;
const SIDEBAND_DEBOUNCE_MS = 350;
// Event-boundary settlement can include two bounded extraction attempts.  It
// runs after delivery and never blocks generation, so allow the sideband enough
// time to receive the definitive commit result before falling back to the next
// full request manifest.
const SIDEBAND_TIMEOUT_MS = 90000;

const pendingSidebandTimers = new Map();
const openRequests = new Map();
let lastCaptureAtMs = 0;
let pendingGeneration = null;

function newRequestNonce() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch { /* fall through */ }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function openRequestKey(chatId, targetFloor) {
    return `${String(chatId)}\u0000${Number(targetFloor)}`;
}

function rememberOpenRequest(payload) {
    const key = openRequestKey(payload.clientChatId, payload.targetFloor);
    openRequests.set(key, {
        requestNonce: payload.requestNonce,
        chatId: payload.clientChatId,
        targetFloor: payload.targetFloor,
        generationType: String(payload.generationType || 'normal').toLowerCase(),
        at: Date.now(),
    });
    for (const [candidateKey, candidate] of openRequests) {
        if (Date.now() - Number(candidate?.at || 0) > 5 * 60 * 1000) openRequests.delete(candidateKey);
    }
}

function takeOpenRequest(chatId, targetFloor, generationType) {
    const key = openRequestKey(chatId, targetFloor);
    const candidate = openRequests.get(key) || null;
    if (!candidate) return null;
    const observed = String(generationType || '').trim().toLowerCase();
    const expected = String(candidate.generationType || '').trim().toLowerCase();
    const continuationTypes = new Set(['continue', 'append', 'appendfinal']);
    if (observed && observed !== expected && !(continuationTypes.has(observed) && continuationTypes.has(expected))) return null;
    return candidate;
}

function monotonicCaptureTime() {
    const next = Math.max(Date.now(), lastCaptureAtMs + 1);
    lastCaptureAtMs = next;
    return new Date(next);
}

let lastStatus = {
    state: 'idle',
    message: '等待下一次主对话生成。',
    updatedAt: null,
    endpoint: '',
    chatId: '',
    targetFloor: null,
    targetSwipeId: null,
    sidebandState: 'off',
    sidebandMessage: '实时对账未启用；下一次生成会携带完整楼层账本。',
};

function getSettings() {
    const existing = extension_settings[MODULE_NAME];
    const normalized = normalizeSettings(existing);
    extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS, ...normalized };
    return extension_settings[MODULE_NAME];
}

function readGatewayToken() {
    const settings = getSettings();
    return tokenStore.read(getCurrentUserHandle(), settings.gatewayBaseUrl, settings.rememberToken);
}

function syncConnectionUi() {
    const settings = getSettings();
    const fields = {
        '#tgm-bridge-endpoint-pattern': settings.endpointPattern,
        '#tgm-bridge-gateway-base-url': settings.gatewayBaseUrl,
        '#tgm-bridge-gateway-token': readGatewayToken(),
    };
    for (const [selector, value] of Object.entries(fields)) {
        const element = document.querySelector(selector);
        if (element) element.value = value;
    }
    const auto = document.querySelector('#tgm-bridge-auto-configure');
    if (auto) auto.checked = settings.autoConfigure;
}

function autoConfigureGateway(force = false) {
    const settings = getSettings();
    const inferred = inferGatewayConfiguration(activeEndpointSettings(oai_settings), force ? { ...settings, autoConfigure: true, endpointPattern: '', gatewayBaseUrl: '' } : settings);
    if (!inferred) return false;
    const changed = Object.entries(inferred).some(([key, value]) => settings[key] !== value);
    if (changed || force) {
        Object.assign(settings, inferred, { autoConfigure: true });
        saveSettingsDebounced();
        syncConnectionUi();
        updateStatus({ state: settings.enabled ? 'idle' : 'disabled', endpoint: inferred.gatewayBaseUrl, message: settings.enabled ? `v${VERSION} 已自动保存网关 ${inferred.gatewayBaseUrl}，基础桥接无需令牌；等待下一次生成确认楼层注入。` : '地址已保存，但桥接开关仍关闭。' });
    }
    return true;
}

async function checkConnection() {
    autoConfigureGateway();
    const settings = getSettings();
    if (!settings.enabled) { updateStatus({ state: 'disabled', message: '桥接开关已关闭，请先启用。' }); return; }
    if (!event_types.CHAT_COMPLETION_SETTINGS_READY) { updateStatus({ state: 'error', message: '酒馆缺少生成前事件，请先更新 Luker。' }); return; }
    const match = matchGatewayEndpoint(activeEndpointSettings(oai_settings), settings.endpointPattern);
    if (!match.matched) { updateStatus({ state: 'warning', message: match.error || '尚未匹配网关：在模型连接里选择本地网关，或手动填写额外允许的地址。' }); return; }
    const token = readGatewayToken();
    if (!token) { updateStatus({ state: 'idle', endpoint: match.value, message: `v${VERSION} 桥接配置就绪；下一次生成会显示“已注入”。基础桥接无需令牌；即时对账如需启用，首次填写 Dashboard 令牌即可保存。` }); return; }
    const url = normalizedGatewayBaseUrl(settings.gatewayBaseUrl);
    if (!url || url.username || url.password) { updateStatus({ state: 'warning', message: '实时对账地址无效。' }); return; }
    try {
        const response = await fetch(new URL('/gateway/health', url), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = await response.json();
        updateStatus({ state: 'idle', message: `v${VERSION} 网关可达${health.version ? `（${health.version}）` : ''}；地址及令牌已保存，等待下一次生成确认注入。` });
    } catch (error) {
        updateStatus({ state: 'warning', message: `连接检查失败：${String(error?.message || error)}。请确认地址、令牌及手机到电脑的连接；基础桥接仍会随生成请求发送。` });
    }
}

function legacyMemoryGraphIsEnabled() {
    return extension_settings?.memory_graph?.enabled === true;
}

function updateStatus(patch) {
    lastStatus = {
        ...lastStatus,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    const statusElement = document.querySelector('#tgm-bridge-status');
    if (!statusElement) return;
    statusElement.dataset.state = lastStatus.state;
    statusElement.textContent = lastStatus.message;
    statusElement.title = lastStatus.updatedAt || '';
    const sidebandElement = document.querySelector('#tgm-bridge-sideband-status');
    if (sidebandElement) {
        sidebandElement.dataset.state = lastStatus.sidebandState;
        sidebandElement.textContent = lastStatus.sidebandMessage;
        sidebandElement.title = lastStatus.updatedAt || '';
    }
}

function readSessionValue(key) {
    try {
        return sessionStorage.getItem(key) || '';
    } catch {
        return '';
    }
}

function writeSessionValue(key, value) {
    try {
        if (value) sessionStorage.setItem(key, value);
        else sessionStorage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

function readMutationStore() {
    try {
        const parsed = JSON.parse(readSessionValue(MUTATION_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function mutationBucketKey(chatId) {
    return `chat:${String(chatId).slice(0, 2000)}`;
}

function writeMutationStore(store) {
    const entries = Object.entries(store)
        .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
        .slice(0, MAX_MUTATION_CHATS);
    writeSessionValue(MUTATION_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function mutationDetails(kind, args) {
    const [first, second] = args;
    const details = {};
    if (typeof first === 'string' || typeof first === 'number') {
        if (kind === 'message-deleted') details.chatLength = first;
        else if (kind === 'chat-changed') details.chatId = first;
        else details.messageId = first;
    }
    if (kind === 'message-received' && typeof second === 'string') details.generationType = second;
    const meta = second && typeof second === 'object' && !Array.isArray(second) ? second : null;
    if (meta) {
        for (const key of [
            'messageId',
            'playableSeq',
            'assistantSeq',
            'isUser',
            'isAssistant',
            'isSystem',
            'kind',
            'pendingGeneration',
            'previousSwipeId',
            'nextSwipeId',
            'swipeId',
            'newSwipeId',
            'deletedPlayableSeqFrom',
            'deletedPlayableSeqTo',
            'deletedAssistantSeqFrom',
            'deletedAssistantSeqTo',
        ]) {
            const value = meta[key];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
                details[key] = value;
            }
        }
    }
    if (kind === 'message-swipe-deleted' && first && typeof first === 'object') {
        for (const key of ['messageId', 'swipeId', 'newSwipeId']) {
            const value = first[key];
            if (typeof value === 'string' || typeof value === 'number' || value === null) details[key] = value;
        }
    }
    if (kind === 'chat-branch-created' && first && typeof first === 'object') {
        for (const key of ['mesId', 'branchName', 'assistantMessageCount']) {
            const value = first[key];
            if (typeof value === 'string' || typeof value === 'number' || value === null) details[key] = value;
        }
    }
    return details;
}

function mutationChatId(context, kind, args) {
    if (kind === 'chat-changed' && (typeof args[0] === 'string' || typeof args[0] === 'number')) {
        return String(args[0]);
    }
    const value = context?.chatId ?? context?.getCurrentChatId?.();
    return value === null || value === undefined ? '' : String(value);
}

function rememberMutation(chatId, kind, details = {}) {
    if (!chatId) return [];
    const store = readMutationStore();
    const bucket = mutationBucketKey(chatId);
    const previous = Array.isArray(store[bucket]?.items) ? store[bucket].items : [];
    const mutation = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        kind,
        at: new Date().toISOString(),
        details,
    };
    const items = [...previous, mutation].slice(-MAX_MUTATIONS_PER_CHAT);
    store[bucket] = { updatedAt: Date.now(), items };
    writeMutationStore(store);
    return items;
}

function rememberedMutations(chatId) {
    if (!chatId) return [];
    const items = readMutationStore()[mutationBucketKey(chatId)]?.items;
    return Array.isArray(items) ? items.slice(-MAX_MUTATIONS_PER_CHAT) : [];
}

function clearRememberedMutations(chatId, postedIds) {
    if (!chatId || !Array.isArray(postedIds) || postedIds.length === 0) return;
    const store = readMutationStore();
    const bucket = mutationBucketKey(chatId);
    const existing = Array.isArray(store[bucket]?.items) ? store[bucket].items : [];
    const completed = new Set(postedIds);
    const remaining = existing.filter(item => !completed.has(item?.id));
    if (remaining.length > 0) store[bucket] = { updatedAt: Date.now(), items: remaining };
    else delete store[bucket];
    writeMutationStore(store);
}

function currentCharacter(context) {
    const characterId = context?.characterId;
    const source = characterId === null || characterId === undefined
        ? null
        : context?.characters?.[characterId];
    if (!source) return null;
    return {
        id: characterId,
        name: source.name || context?.name2 || '',
        avatar: source.avatar || '',
    };
}

function currentStateTarget(context) {
    try {
        return typeof context?.resolveChatStateTarget === 'function'
            ? context.resolveChatStateTarget()
            : null;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] resolveChatStateTarget failed`, error);
        return null;
    }
}

function currentIdentity(context, chatId) {
    return {
        chatId,
        stateTarget: currentStateTarget(context),
        character: currentCharacter(context),
        groupId: context?.groupId ?? null,
    };
}

function normalizedGatewayBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function postSidebandReconcile(chatId, mutationKind, finalize = null) {
    autoConfigureGateway();
    const settings = getSettings();
    if (!settings.sidebandEnabled) return;
    const gatewayBase = normalizedGatewayBaseUrl(settings.gatewayBaseUrl);
    const token = readGatewayToken();
    if (!gatewayBase || !token) {
        updateStatus({
            sidebandState: 'degraded',
            sidebandMessage: !gatewayBase
                ? '最终一致性降级：请填写有效的 http(s) 网关地址；下一次生成仍会完整对账。'
                : '尚未保存此网关的 Dashboard 令牌；基础桥接无需令牌，下一次生成仍会完整对账。',
        });
        return;
    }

    const context = getContext();
    const liveChatId = context?.chatId ?? context?.getCurrentChatId?.();
    if (String(liveChatId ?? '') !== String(chatId)) {
        updateStatus({
            sidebandState: 'degraded',
            sidebandMessage: `最终一致性降级：聊天 ${chatId} 已不在前台；再次打开或生成时会完整对账。`,
        });
        return;
    }

    const mutations = rememberedMutations(chatId);
    const payload = await buildGatewayMemoryPayload({
        chat: Array.isArray(context?.chat) ? context.chat : [],
        generationType: 'reconcile',
        requestNonce: finalize?.requestNonce || newRequestNonce(),
        finalizedTargetFloor: finalize?.targetFloor ?? null,
        identity: currentIdentity(context, chatId),
        lastInContextMessageId: context?.chatMetadata?.lastInContextMessageId,
        endpoint: gatewayBase.toString(),
        settings,
        now: monotonicCaptureTime,
    });
    payload.reconcileMode = 'full-manifest';
    payload.mutationKind = mutationKind;
    payload.mutations = mutations;
    if (finalize?.requestNonce) payload.finalizeRequestNonce = finalize.requestNonce;
    if (Number.isInteger(finalize?.targetFloor)) payload.finalizedTargetFloor = finalize.targetFloor;

    const endpoint = new URL('/gateway/memory/reconcile', gatewayBase).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDEBAND_TIMEOUT_MS);
    updateStatus({
        sidebandState: 'sending',
        sidebandMessage: `正在实时对账 ${chatId}（${mutationKind}）…`,
    });
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
        });
        const responseBody = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const finalizeStatus = String(responseBody?.finalizeStatus || 'no-pending');
        if (!['finalized', 'superseded', 'no-pending', 'deferred'].includes(finalizeStatus)) {
            throw new Error(`unexpected finalize status: ${finalizeStatus}`);
        }
        if (finalizeStatus !== 'deferred') {
            clearRememberedMutations(chatId, mutations.map(item => item?.id).filter(Boolean));
            if (finalize?.requestNonce) openRequests.delete(openRequestKey(chatId, finalize.targetFloor));
        }
        updateStatus({
            sidebandState: 'active',
            sidebandMessage: `实时对账成功：${mutationKind}，${payload.ledger.length} 个楼层；记忆边界 ${finalizeStatus}。`,
        });
    } catch (error) {
        const reason = error?.name === 'AbortError' ? '请求超时' : String(error?.message || error);
        updateStatus({
            sidebandState: 'degraded',
            sidebandMessage: `最终一致性降级：实时对账失败（${reason}）；不影响生成，下次生成会完整对账。`,
        });
        if (settings.debug) console.warn(`[${MODULE_NAME}] sideband reconcile failed`, error);
    } finally {
        clearTimeout(timer);
    }
}

function scheduleSidebandReconcile(chatId, mutationKind, immediate = false, finalize = null) {
    if (!getSettings().sidebandEnabled || !chatId) return;
    const existing = pendingSidebandTimers.get(chatId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        pendingSidebandTimers.delete(chatId);
        void postSidebandReconcile(chatId, mutationKind, finalize).catch(error => {
            updateStatus({
                sidebandState: 'degraded',
                sidebandMessage: `最终一致性降级：对账准备失败（${String(error?.message || error)}）；不影响生成，下次生成会完整对账。`,
            });
            if (getSettings().debug) console.warn(`[${MODULE_NAME}] sideband preparation failed`, error);
        });
    }, immediate ? 0 : SIDEBAND_DEBOUNCE_MS);
    pendingSidebandTimers.set(chatId, timer);
}

function onChatMutation(kind, ...args) {
    try {
        if (!getSettings().enabled) return;
        const context = getContext();
        const chatId = mutationChatId(context, kind, args);
        if (!chatId) return;
        const details = mutationDetails(kind, args);
        rememberMutation(chatId, kind, details);
        // MESSAGE_UPDATED is emitted for streaming/takeover partial text. It is
        // diagnostic only: publishing it as a newer manifest used to race the
        // final response and make a correct bridge look stale.
        if (kind === 'message-updated') return;
        let finalize = null;
        if (kind === 'message-received' && Number.isInteger(Number(details.messageId))) {
            const targetFloor = Number(details.messageId);
            const open = takeOpenRequest(chatId, targetFloor, details.generationType);
            if (open) finalize = { requestNonce: open.requestNonce, targetFloor };
        }
        scheduleSidebandReconcile(chatId, kind, kind === 'chat-changed' || kind === 'message-received', finalize);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] failed to record ${kind}`, error);
    }
}

async function onChatCompletionSettingsReady(generateData) {
    // The Luker takeover path emits this event with `{ messages }` only.  The
    // authoritative type was emitted earlier by GENERATION_STARTED, so consume
    // that one-shot value here instead of silently treating swipe/continue as
    // a brand-new normal floor.
    const startedGeneration = pendingGeneration && Date.now() - Number(pendingGeneration.at || 0) <= 2 * 60 * 1000
        ? pendingGeneration
        : null;
    pendingGeneration = null;
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        autoConfigureGateway();
        Object.assign(settings, getSettings());
        if (startedGeneration?.dryRun === true) return;

        const generationType = resolveGenerationType(generateData?.type, startedGeneration?.type);
        if (shouldSkipGenerationType(generationType)) {
            if (settings.debug) console.debug(`[${MODULE_NAME}] skipped generation type`, generationType);
            return;
        }

        const requestEndpoints = activeEndpointSettings(generateData);
        let endpointMatch = matchGatewayEndpoint(requestEndpoints, settings.endpointPattern);
        const endpointWasDeclared = Object.keys(requestEndpoints).some(key => Object.hasOwn(generateData, key));
        if (!endpointMatch.matched && !endpointMatch.error && !endpointWasDeclared && collectEndpointCandidates(requestEndpoints).length === 0) {
            // Luker's takeover compatibility event intentionally contains only
            // `{ messages }`. Consult the active OpenAI settings so endpoint
            // authorization remains strict without requiring the hook to leak
            // unrelated request options.
            endpointMatch = matchGatewayEndpoint(activeEndpointSettings(oai_settings), settings.endpointPattern);
        }
        if (!endpointMatch.matched) {
            if (endpointMatch.error) {
                updateStatus({ state: 'warning', message: endpointMatch.error, endpoint: '' });
            } else {
                updateStatus({
                    state: 'idle',
                    message: '本次请求未匹配获授权的网关地址，未注入任何聊天数据。',
                    endpoint: '',
                });
                if (settings.debug) console.debug(`[${MODULE_NAME}] request is not routed to an allowed gateway endpoint`);
            }
            return;
        }

        const context = getContext();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const chatId = context?.chatId ?? context?.getCurrentChatId?.();
        if (chatId === null || chatId === undefined || String(chatId).trim() === '') {
            updateStatus({
                state: 'warning',
                message: '已匹配网关，但当前没有可用的真实 chatId；本次未注入。',
                endpoint: endpointMatch.value,
            });
            return;
        }

        const payload = await buildGatewayMemoryPayload({
            chat,
            generationType,
            requestNonce: newRequestNonce(),
            identity: currentIdentity(context, chatId),
            lastInContextMessageId: context?.chatMetadata?.lastInContextMessageId,
            endpoint: endpointMatch.value,
            settings,
            now: monotonicCaptureTime,
        });
        payload.reconcileMode = 'full-manifest-before-recall';
        payload.mutationKind = 'generation-request';
        payload.mutations = rememberedMutations(payload.chatId);
        rememberOpenRequest(payload);

        // Channel 1: preserved in the browser -> Luker request. A patched or
        // compatible dispatcher may forward this field directly.
        generateData.gateway_memory = payload;

        // Channel 2: all current OpenAI-compatible dispatchers forward messages.
        // The gateway must parse and remove this reserved marker before routing,
        // so neither the marker nor its decoded chat transcript reaches a model.
        generateData.messages = injectGatewayMemoryMessage(generateData.messages, payload);

        // CUSTOM source reconstructs the upstream body but explicitly merges
        // custom_include_body. Mirror the same object there without mutating the
        // user's persisted setting. The system marker remains the universal path.
        if (String(generateData.chat_completion_source || '').toLowerCase() === 'custom') {
            const merged = mergeGatewayMemoryIntoCustomIncludeBody(
                generateData.custom_include_body,
                payload,
                context?.lib?.yaml,
            );
            generateData.custom_include_body = merged.value;
            if (merged.error && settings.debug) console.warn(`[${MODULE_NAME}] ${merged.error}`);
        }

        const legacyMemoryEnabled = legacyMemoryGraphIsEnabled();
        updateStatus({
            state: legacyMemoryEnabled ? 'warning' : 'active',
            message: `已注入：楼层 ${payload.targetFloor} / swipe ${payload.targetSwipeId}，账本 ${payload.ledger.length} 层，正文 ${payload.messages.length} 条，待对账变更 ${payload.mutations.length} 项。${legacyMemoryEnabled ? ' 检测到旧 Memory Graph 仍启用，请关闭它以免双重召回。' : ''}`,
            endpoint: endpointMatch.value,
            chatId: payload.chatId,
            targetFloor: payload.targetFloor,
            targetSwipeId: payload.targetSwipeId,
        });
        if (settings.debug) {
            console.debug(`[${MODULE_NAME}] injected`, {
                endpoint: endpointMatch.value,
                endpointField: endpointMatch.field,
                endpointMatch: endpointMatch.method,
                chatId: payload.chatId,
                targetFloor: payload.targetFloor,
                targetSwipeId: payload.targetSwipeId,
                ledgerEntries: payload.ledger.length,
                transcriptMessages: payload.messages.length,
            });
        }
    } catch (error) {
        // A diagnostics bridge must never make the user's generation fail.
        console.error(`[${MODULE_NAME}] bridge injection failed`, error);
        updateStatus({
            state: 'error',
            message: `注入失败，已放行原请求：${String(error?.message || error)}`,
        });
    }
}

function onGenerationStarted(type, _params, dryRun) {
    pendingGeneration = {
        type: resolveGenerationType(type),
        dryRun: dryRun === true,
        at: Date.now(),
    };
}

function updateNumberSetting(id, key) {
    const element = document.querySelector(id);
    if (!element) return;
    element.addEventListener('change', () => {
        const current = getSettings();
        current[key] = Number(element.value);
        Object.assign(current, normalizeSettings(current));
        element.value = String(current[key]);
        saveSettingsDebounced();
    });
}

function bindSettingsUi() {
    autoConfigureGateway();
    const settings = getSettings();
    const enabled = document.querySelector('#tgm-bridge-enabled');
    const endpointPattern = document.querySelector('#tgm-bridge-endpoint-pattern');
    const sidebandEnabled = document.querySelector('#tgm-bridge-sideband-enabled');
    const gatewayBaseUrl = document.querySelector('#tgm-bridge-gateway-base-url');
    const gatewayToken = document.querySelector('#tgm-bridge-gateway-token');
    const debug = document.querySelector('#tgm-bridge-debug');

    if (enabled) {
        enabled.checked = settings.enabled;
        enabled.addEventListener('change', () => {
            getSettings().enabled = enabled.checked;
            saveSettingsDebounced();
            updateStatus({
                state: enabled.checked ? 'idle' : 'disabled',
                message: enabled.checked ? '等待下一次主对话生成。' : '桥接已停用。',
            });
        });
    }
    if (endpointPattern) {
        endpointPattern.value = settings.endpointPattern;
        endpointPattern.addEventListener('change', () => {
            getSettings().endpointPattern = endpointPattern.value.trim();
            getSettings().autoConfigure = false;
            Object.assign(getSettings(), normalizeSettings(getSettings()));
            endpointPattern.value = getSettings().endpointPattern;
            saveSettingsDebounced();
            updateStatus({ state: 'idle', message: '端点规则已保存，等待下一次主对话生成。' });
        });
    }
    if (debug) {
        debug.checked = settings.debug;
        debug.addEventListener('change', () => {
            getSettings().debug = debug.checked;
            saveSettingsDebounced();
        });
    }
    if (sidebandEnabled) {
        sidebandEnabled.checked = settings.sidebandEnabled;
        sidebandEnabled.addEventListener('change', () => {
            getSettings().sidebandEnabled = sidebandEnabled.checked;
            saveSettingsDebounced();
            updateStatus({
                sidebandState: sidebandEnabled.checked ? 'idle' : 'off',
                sidebandMessage: sidebandEnabled.checked
                    ? '实时对账已启用，等待聊天变更。'
                    : '实时对账未启用；下一次生成会携带完整楼层账本。',
            });
        });
    }
    if (gatewayBaseUrl) {
        gatewayBaseUrl.value = settings.gatewayBaseUrl;
        gatewayBaseUrl.addEventListener('change', () => {
            getSettings().gatewayBaseUrl = gatewayBaseUrl.value.trim();
            getSettings().autoConfigure = false;
            Object.assign(getSettings(), normalizeSettings(getSettings()));
            gatewayBaseUrl.value = getSettings().gatewayBaseUrl;
            saveSettingsDebounced();
            syncConnectionUi();
            const valid = normalizedGatewayBaseUrl(getSettings().gatewayBaseUrl);
            updateStatus({
                sidebandState: valid ? 'idle' : 'degraded',
                sidebandMessage: valid
                    ? '实时对账地址已保存，等待聊天变更。'
                    : '最终一致性降级：地址必须是完整的 http(s) URL。',
            });
        });
    }
    if (gatewayToken) {
        gatewayToken.value = readGatewayToken();
        gatewayToken.addEventListener('input', () => {
            const current = getSettings();
            const saved = tokenStore.write(getCurrentUserHandle(), current.gatewayBaseUrl, gatewayToken.value, current.rememberToken);
            if (gatewayToken.value.trim() && !current.sidebandEnabled) {
                current.sidebandEnabled = true;
                if (sidebandEnabled) sidebandEnabled.checked = true;
                saveSettingsDebounced();
            }
            updateStatus({
                sidebandState: saved ? 'idle' : 'degraded',
                sidebandMessage: saved
                    ? (gatewayToken.value.trim() ? (current.rememberToken ? '令牌已按账号与网关保存在当前浏览器，刷新自动填回。' : '令牌仅在当前标签页保留。') : '已清除保存的令牌。')
                    : '令牌未能持久保存，本次仍可使用；请检查浏览器存储权限与网关地址。',
            });
        });
    }

    const values = {
        '#tgm-bridge-max-ledger': settings.maxLedgerEntries,
        '#tgm-bridge-max-messages': settings.maxTextMessages,
        '#tgm-bridge-max-message-chars': settings.maxCharsPerMessage,
        '#tgm-bridge-max-total-chars': settings.maxTotalTextChars,
    };
    for (const [selector, value] of Object.entries(values)) {
        const element = document.querySelector(selector);
        if (element) element.value = String(value);
    }
    updateNumberSetting('#tgm-bridge-max-ledger', 'maxLedgerEntries');
    updateNumberSetting('#tgm-bridge-max-messages', 'maxTextMessages');
    updateNumberSetting('#tgm-bridge-max-message-chars', 'maxCharsPerMessage');
    updateNumberSetting('#tgm-bridge-max-total-chars', 'maxTotalTextChars');

    const resetPattern = document.querySelector('#tgm-bridge-reset-pattern');
    resetPattern?.addEventListener('click', () => {
        getSettings().endpointPattern = '';
        getSettings().autoConfigure = false;
        getSettings().gatewayBaseUrl = '';
        getSettings().autoConfiguredOrigin = '';
        if (endpointPattern) endpointPattern.value = '';
        saveSettingsDebounced();
        syncConnectionUi();
        updateStatus({ state: 'idle', message: '已恢复仅允许本机 3080/3180。' });
    });

    const clearToken = document.querySelector('#tgm-bridge-clear-token');
    clearToken?.addEventListener('click', () => {
        tokenStore.clear(getCurrentUserHandle(), getSettings().gatewayBaseUrl);
        if (gatewayToken) gatewayToken.value = '';
        updateStatus({
            sidebandState: settings.sidebandEnabled ? 'degraded' : 'off',
            sidebandMessage: settings.sidebandEnabled
                ? '令牌已从本浏览器与标签页清除；下一次生成仍会完整对账。'
                : '令牌已从本浏览器与标签页清除。',
        });
    });

    const rememberToken = document.querySelector('#tgm-bridge-remember-token');
    if (rememberToken) {
        rememberToken.checked = settings.rememberToken;
        rememberToken.addEventListener('change', () => {
            const current = getSettings();
            const token = readGatewayToken();
            current.rememberToken = rememberToken.checked;
            tokenStore.write(getCurrentUserHandle(), current.gatewayBaseUrl, token, current.rememberToken);
            saveSettingsDebounced();
            updateStatus({ sidebandMessage: current.rememberToken ? '令牌将按账号与网关保存在此浏览器。' : '已删除持久令牌，仅本标签页保留。' });
        });
    }
    const autoConfigure = document.querySelector('#tgm-bridge-auto-configure');
    if (autoConfigure) {
        autoConfigure.checked = settings.autoConfigure;
        autoConfigure.addEventListener('change', () => {
            getSettings().autoConfigure = autoConfigure.checked;
            saveSettingsDebounced();
            if (autoConfigure.checked) autoConfigureGateway(true);
        });
    }
    document.querySelector('#tgm-bridge-auto-fill')?.addEventListener('click', () => {
        if (!autoConfigureGateway(true)) updateStatus({ state: 'warning', message: '未从模型连接中找到本机或内网 3080/3180 网关；请先配置连接，或手动填写地址。' });
        syncConnectionUi();
    });
    document.querySelector('#tgm-bridge-check-connection')?.addEventListener('click', checkConnection);

    const reconcileNow = document.querySelector('#tgm-bridge-reconcile-now');
    reconcileNow?.addEventListener('click', () => {
        if (!getSettings().sidebandEnabled) {
            updateStatus({
                sidebandState: 'off',
                sidebandMessage: '请先启用“聊天变更后立即向 Dashboard 对账”。',
            });
            return;
        }
        const context = getContext();
        const chatId = context?.chatId ?? context?.getCurrentChatId?.();
        if (chatId === null || chatId === undefined || String(chatId).trim() === '') {
            updateStatus({ sidebandState: 'degraded', sidebandMessage: '最终一致性降级：当前没有可对账的聊天。' });
            return;
        }
        rememberMutation(String(chatId), 'manual', {});
        scheduleSidebandReconcile(String(chatId), 'manual', true);
    });

    updateStatus(lastStatus);
}

async function loadSettingsUi() {
    try {
        const settingsUrl = new URL('./settings.html', import.meta.url);
        const response = await fetch(settingsUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        document.querySelector('#extensions_settings')?.insertAdjacentHTML('beforeend', html);
        bindSettingsUi();
    } catch (error) {
        console.error(`[${MODULE_NAME}] failed to load settings UI`, error);
    }
}

autoConfigureGateway();
if (event_types.GENERATION_STARTED) {
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
}
if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
} else {
    updateStatus({
        state: 'error',
        message: '当前酒馆版本不提供 CHAT_COMPLETION_SETTINGS_READY，桥接无法工作。',
    });
}

const mutationEvents = [
    ['MESSAGE_RECEIVED', 'message-received'],
    ['MESSAGE_UPDATED', 'message-updated'],
    ['MESSAGE_EDITED', 'message-edited'],
    ['MESSAGE_DELETED', 'message-deleted'],
    ['MESSAGE_SWIPED', 'message-swiped'],
    ['MESSAGE_SWIPE_DELETED', 'message-swipe-deleted'],
    ['CHAT_CHANGED', 'chat-changed'],
    ['CHAT_BRANCH_CREATED', 'chat-branch-created'],
];
for (const [eventKey, mutationKind] of mutationEvents) {
    const eventName = event_types[eventKey];
    if (!eventName) continue;
    eventSource.on(eventName, (...args) => onChatMutation(mutationKind, ...args));
}

globalThis.TavernGatewayMemoryBridge = Object.freeze({
    version: VERSION,
    getStatus: () => structuredClone(lastStatus),
    getSettings: () => structuredClone(getSettings()),
});

jQuery(loadSettingsUi);
