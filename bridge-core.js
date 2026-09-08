export const PROTOCOL_NAME = 'tavern-gateway-memory-bridge';
export const PROTOCOL_VERSION = 1;
export const MARKER_PREFIX = '<!-- tavern_gateway_memory_bridge_v1:';
export const MARKER_SUFFIX = ' -->';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    endpointPattern: '',
    maxLedgerEntries: 5000,
    maxTextMessages: 240,
    maxCharsPerMessage: 16000,
    maxTotalTextChars: 240000,
    sidebandEnabled: false,
    gatewayBaseUrl: '',
    debug: false,
});

const SKIPPED_GENERATION_TYPES = new Set(['quiet', 'impersonate']);
const EXISTING_ASSISTANT_TARGET_TYPES = new Set([
    'swipe',
    'continue',
    'append',
    'appendfinal',
]);
const ENDPOINT_FIELDS = Object.freeze([
    'reverse_proxy',
    'base_url',
    'custom_url',
    'endpoint',
    'api_url',
]);

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function safeString(value, maxLength = 1000) {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, maxLength);
}

export function normalizeSettings(raw = {}) {
    const settings = raw && typeof raw === 'object' ? raw : {};
    const maxLedgerEntries = clampInteger(settings.maxLedgerEntries, DEFAULT_SETTINGS.maxLedgerEntries, 100, 10000);
    return {
        enabled: settings.enabled !== false,
        endpointPattern: safeString(settings.endpointPattern, 512).trim(),
        maxLedgerEntries,
        maxTextMessages: Math.min(
            maxLedgerEntries,
            clampInteger(settings.maxTextMessages, DEFAULT_SETTINGS.maxTextMessages, 20, 2000),
        ),
        maxCharsPerMessage: clampInteger(settings.maxCharsPerMessage, DEFAULT_SETTINGS.maxCharsPerMessage, 1024, 100000),
        maxTotalTextChars: clampInteger(settings.maxTotalTextChars, DEFAULT_SETTINGS.maxTotalTextChars, 20000, 2000000),
        sidebandEnabled: settings.sidebandEnabled === true,
        gatewayBaseUrl: safeString(settings.gatewayBaseUrl, 2048).trim(),
        debug: settings.debug === true,
    };
}

export function shouldSkipGenerationType(type) {
    return SKIPPED_GENERATION_TYPES.has(safeString(type, 80).trim().toLowerCase());
}

export function resolveGenerationType(explicitType, pendingType = '') {
    return safeString(explicitType, 80).trim().toLowerCase()
        || safeString(pendingType, 80).trim().toLowerCase()
        || 'normal';
}

export function collectEndpointCandidates(generateData = {}) {
    if (!generateData || typeof generateData !== 'object') return [];
    const seen = new Set();
    const candidates = [];
    for (const field of ENDPOINT_FIELDS) {
        const value = safeString(generateData[field], 2048).trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        candidates.push({ field, value });
    }
    return candidates;
}

function parseEndpoint(value) {
    const raw = safeString(value, 2048).trim();
    if (!raw) return null;
    try {
        return new URL(raw);
    } catch {
        try {
            return new URL(`http://${raw}`);
        } catch {
            return null;
        }
    }
}

export function isDefaultGatewayEndpoint(value) {
    const url = parseEndpoint(value);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === '127.0.0.1'
        || hostname === 'localhost'
        || hostname === '::1'
        || hostname === '[::1]';
    return isLoopback && (url.port === '3080' || url.port === '3180');
}

export function matchGatewayEndpoint(generateData, endpointPattern = '') {
    const candidates = collectEndpointCandidates(generateData);
    const defaultMatch = candidates.find(candidate => isDefaultGatewayEndpoint(candidate.value));
    if (defaultMatch) {
        return { matched: true, method: 'default-loopback', ...defaultMatch, error: '' };
    }

    const pattern = safeString(endpointPattern, 512).trim();
    if (!pattern) {
        return { matched: false, method: 'none', field: '', value: '', error: '' };
    }

    let matcher;
    try {
        matcher = new RegExp(pattern, 'i');
    } catch (error) {
        return {
            matched: false,
            method: 'custom-regex',
            field: '',
            value: '',
            error: `自定义端点正则无效：${safeString(error?.message || error, 300)}`,
        };
    }

    const customMatch = candidates.find(candidate => {
        matcher.lastIndex = 0;
        return matcher.test(candidate.value);
    });
    return customMatch
        ? { matched: true, method: 'custom-regex', ...customMatch, error: '' }
        : { matched: false, method: 'custom-regex', field: '', value: '', error: '' };
}

export function normalizeSwipeId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function getActiveMessageText(message) {
    if (!message || typeof message !== 'object') return '';
    if (typeof message.mes === 'string') return message.mes;
    const swipeId = normalizeSwipeId(message.swipe_id);
    const swipeText = Array.isArray(message.swipes) ? message.swipes[swipeId] : '';
    return typeof swipeText === 'string' ? swipeText : '';
}

export function getMessageRole(message) {
    return message?.is_user === true ? 'user' : 'assistant';
}

export function isExtractableAssistant(message) {
    return Boolean(message && message.is_user !== true && getActiveMessageText(message).trim());
}

function lastFloorMatching(chat, predicate) {
    for (let floor = chat.length - 1; floor >= 0; floor--) {
        if (predicate(chat[floor])) return floor;
    }
    return -1;
}

export function resolveTargetAnchor(chatInput, generationType = 'normal') {
    const chat = Array.isArray(chatInput) ? chatInput : [];
    const type = safeString(generationType, 80).trim().toLowerCase() || 'normal';
    const tailFloor = chat.length - 1;
    const tail = tailFloor >= 0 ? chat[tailFloor] : null;
    const lastAssistantFloor = lastFloorMatching(chat, message => message && message.is_user !== true);

    let targetFloor = chat.length;
    if (EXISTING_ASSISTANT_TARGET_TYPES.has(type) && lastAssistantFloor >= 0) {
        targetFloor = lastAssistantFloor;
    } else if (tail && tail.is_user !== true && !getActiveMessageText(tail).trim()) {
        // Luker may create an empty in-flight assistant slot before dispatch.
        targetFloor = tailFloor;
    }

    const targetMessage = targetFloor < chat.length ? chat[targetFloor] : null;
    const targetSwipeId = targetMessage ? normalizeSwipeId(targetMessage.swipe_id) : 0;
    let completedAssistantCount = 0;
    for (let floor = 0; floor < chat.length; floor++) {
        if (isExtractableAssistant(chat[floor])) completedAssistantCount++;
        if (floor === targetFloor && isExtractableAssistant(chat[floor])) {
            return {
                targetFloor,
                targetSwipeId,
                targetAssistantSeq: completedAssistantCount,
            };
        }
    }

    return {
        targetFloor,
        targetSwipeId,
        targetAssistantSeq: completedAssistantCount + 1,
    };
}

export function normalizeFloorHashText(text) {
    return safeString(text, Number.MAX_SAFE_INTEGER).replace(/\r\n/g, '\n').trim();
}

export function canonicalFloorHashInput(role, isSystem, text) {
    const normalizedRole = role === 'user' ? 'user' : 'assistant';
    return `${normalizedRole}\u0000${isSystem === true ? '1' : '0'}\u0000${normalizeFloorHashText(text)}`;
}

function updateFnv1aByte(hash, byte) {
    return Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;
}

/**
 * Dependency-free FNV-1a 32-bit over the UTF-8 bytes of a JavaScript string.
 * Lone UTF-16 surrogates follow TextEncoder semantics and become U+FFFD.
 */
export function fnv1a32(text) {
    const input = safeString(text, Number.MAX_SAFE_INTEGER);
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        const first = input.charCodeAt(index);
        let codePoint;
        if (first >= 0xd800 && first <= 0xdbff) {
            const second = input.charCodeAt(index + 1);
            if (second >= 0xdc00 && second <= 0xdfff) {
                codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
                index++;
            } else {
                codePoint = 0xfffd;
            }
        } else if (first >= 0xdc00 && first <= 0xdfff) {
            codePoint = 0xfffd;
        } else {
            codePoint = first;
        }

        if (codePoint <= 0x7f) {
            hash = updateFnv1aByte(hash, codePoint);
        } else if (codePoint <= 0x7ff) {
            hash = updateFnv1aByte(hash, 0xc0 | (codePoint >>> 6));
            hash = updateFnv1aByte(hash, 0x80 | (codePoint & 0x3f));
        } else if (codePoint <= 0xffff) {
            hash = updateFnv1aByte(hash, 0xe0 | (codePoint >>> 12));
            hash = updateFnv1aByte(hash, 0x80 | ((codePoint >>> 6) & 0x3f));
            hash = updateFnv1aByte(hash, 0x80 | (codePoint & 0x3f));
        } else {
            hash = updateFnv1aByte(hash, 0xf0 | (codePoint >>> 18));
            hash = updateFnv1aByte(hash, 0x80 | ((codePoint >>> 12) & 0x3f));
            hash = updateFnv1aByte(hash, 0x80 | ((codePoint >>> 6) & 0x3f));
            hash = updateFnv1aByte(hash, 0x80 | (codePoint & 0x3f));
        }
    }
    return hash.toString(16).padStart(8, '0');
}

export async function hashText(text) {
    return fnv1a32(text);
}

function normalizeStateTarget(target) {
    if (!target || typeof target !== 'object') return null;
    const normalized = {};
    for (const key of ['chatId', 'characterId', 'id', 'avatar_url', 'file_name', 'is_group']) {
        const value = target[key];
        if (typeof value === 'boolean') normalized[key] = value;
        else if (typeof value === 'string' || typeof value === 'number') normalized[key] = value;
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeIdentity(identity = {}) {
    const character = identity.character && typeof identity.character === 'object'
        ? {
            id: identity.character.id ?? null,
            name: safeString(identity.character.name, 300),
            avatar: safeString(identity.character.avatar, 1000),
        }
        : null;
    return {
        chatId: safeString(identity.chatId, 2000),
        stateTarget: normalizeStateTarget(identity.stateTarget),
        character,
        groupId: identity.groupId === null || identity.groupId === undefined
            ? null
            : safeString(identity.groupId, 1000),
    };
}

function truncateText(text, maximum) {
    if (text.length <= maximum) return { text, truncated: false };
    return { text: text.slice(0, maximum), truncated: true };
}

function normalizeMessageId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= -1 ? parsed : null;
}

export async function buildGatewayMemoryPayload({
    chat: chatInput,
    generationType = 'normal',
    requestNonce = '',
    finalizedTargetFloor = null,
    identity = {},
    lastInContextMessageId = null,
    endpoint = '',
    settings: rawSettings = {},
    now = () => new Date(),
    hashTextFn = hashText,
} = {}) {
    const chat = Array.isArray(chatInput) ? chatInput : [];
    const settings = normalizeSettings(rawSettings);
    const normalizedIdentity = normalizeIdentity(identity);
    const generation = safeString(generationType, 80).trim() || 'normal';
    let anchor = resolveTargetAnchor(chat, generation);
    const ledgerStartFloor = Math.max(0, chat.length - settings.maxLedgerEntries);
    const ledgerSource = chat.slice(ledgerStartFloor);

    let assistantSeq = 0;
    for (let floor = 0; floor < ledgerStartFloor; floor++) {
        if (isExtractableAssistant(chat[floor])) assistantSeq++;
    }

    const ledger = await Promise.all(ledgerSource.map(async (message, offset) => {
        const floor = ledgerStartFloor + offset;
        const text = getActiveMessageText(message);
        const role = getMessageRole(message);
        const isSystem = message?.is_system === true;
        const extractableAssistant = isExtractableAssistant(message);
        if (extractableAssistant) assistantSeq++;
        const messageAssistantSeq = extractableAssistant ? assistantSeq : null;
        const hash = await hashTextFn(canonicalFloorHashInput(role, isSystem, text));
        return {
            floor,
            role,
            isSystem,
            swipeId: normalizeSwipeId(message?.swipe_id),
            // Role flags are included so changing a floor from user/assistant or
            // hiding/unhiding it invalidates the same floor-state commit too.
            hash,
            textLength: text.length,
            assistantSeq: messageAssistantSeq,
        };
    }));

    const ledgerByFloor = new Map(ledger.map(entry => [entry.floor, entry]));
    const finalizedFloor = normalizeMessageId(finalizedTargetFloor);
    if (finalizedFloor !== null && finalizedFloor >= 0 && finalizedFloor < chat.length) {
        const finalizedMessage = chat[finalizedFloor];
        const finalizedLedger = ledgerByFloor.get(finalizedFloor);
        if (finalizedMessage?.is_user !== true && finalizedLedger) {
            anchor = {
                targetFloor: finalizedFloor,
                targetSwipeId: normalizeSwipeId(finalizedMessage?.swipe_id),
                targetAssistantSeq: Number.isInteger(finalizedLedger.assistantSeq)
                    ? finalizedLedger.assistantSeq
                    : resolveTargetAnchor(chat.slice(0, finalizedFloor + 1), 'continue').targetAssistantSeq,
            };
        }
    }
    const newestCandidateFloor = chat.length - 1;
    const earliestMessageFloor = Math.max(ledgerStartFloor, chat.length - settings.maxTextMessages);
    const newestFirst = [];
    let totalTextChars = 0;

    for (let floor = newestCandidateFloor; floor >= earliestMessageFloor; floor--) {
        const message = chat[floor];
        const rawText = getActiveMessageText(message);
        const perMessage = truncateText(rawText, settings.maxCharsPerMessage);
        const remaining = settings.maxTotalTextChars - totalTextChars;
        if (remaining <= 0 && newestFirst.length > 0) break;
        const bounded = truncateText(perMessage.text, Math.max(0, remaining));
        if (!bounded.text && rawText && newestFirst.length > 0) break;
        totalTextChars += bounded.text.length;
        const ledgerEntry = ledgerByFloor.get(floor);
        newestFirst.push({
            floor,
            role: getMessageRole(message),
            isSystem: message?.is_system === true,
            swipeId: normalizeSwipeId(message?.swipe_id),
            hash: ledgerEntry?.hash || await hashTextFn(
                canonicalFloorHashInput(getMessageRole(message), message?.is_system === true, rawText),
            ),
            name: safeString(message?.name, 300),
            text: bounded.text,
            originalLength: rawText.length,
            truncated: perMessage.truncated || bounded.truncated,
        });
    }
    const messages = newestFirst.reverse();

    const lastCompletedAssistantFloor = lastFloorMatching(chat, isExtractableAssistant);
    const latestUserFloor = lastFloorMatching(chat, message => message?.is_user === true);
    const generatedAtValue = typeof now === 'function' ? now() : now;
    const generatedAt = generatedAtValue instanceof Date
        ? generatedAtValue.toISOString()
        : new Date(generatedAtValue).toISOString();

    const visibleFromFloor = normalizeMessageId(lastInContextMessageId);
    return {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        generatedAt,
        requestNonce: safeString(requestNonce, 160).trim(),
        generationType: generation,
        endpoint: safeString(endpoint, 2048),
        chatId: normalizedIdentity.chatId,
        clientChatId: normalizedIdentity.chatId,
        stateTarget: normalizedIdentity.stateTarget,
        character: normalizedIdentity.character,
        groupId: normalizedIdentity.groupId,
        floorCount: chat.length,
        lastFloor: chat.length - 1,
        lastCompletedAssistantFloor,
        latestUserFloor,
        // Luker's historical field name is misleading: it stores the first raw
        // chat[] floor included in the current prompt, not the last floor.
        lastInContextMessageId: visibleFromFloor,
        rawVisibleFromFloor: visibleFromFloor,
        targetFloor: anchor.targetFloor,
        targetSwipeId: anchor.targetSwipeId,
        targetAssistantSeq: anchor.targetAssistantSeq,
        ledger,
        messages,
        coverage: {
            ledgerStartFloor,
            ledgerEndFloor: chat.length - 1,
            ledgerComplete: ledgerStartFloor === 0,
            messageStartFloor: messages[0]?.floor ?? null,
            messageEndFloor: messages.at(-1)?.floor ?? null,
            totalTextChars,
        },
    };
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
    }
    if (typeof btoa === 'function') return btoa(binary);
    throw new Error('当前浏览器不支持 btoa，无法编码记忆桥接消息。');
}

function base64ToBytes(base64) {
    if (typeof atob !== 'function') throw new Error('当前环境不支持 atob。');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

export function encodeGatewayMemoryMarker(payload) {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    const base64Url = bytesToBase64(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `${MARKER_PREFIX}${base64Url}${MARKER_SUFFIX}`;
}

export function decodeGatewayMemoryMarker(marker) {
    const text = safeString(marker, Number.MAX_SAFE_INTEGER).trim();
    if (!text.startsWith(MARKER_PREFIX) || !text.endsWith(MARKER_SUFFIX)) return null;
    const base64Url = text.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/') + padding;
    const json = new TextDecoder().decode(base64ToBytes(base64));
    return JSON.parse(json);
}

export function isGatewayMemoryBridgeMessage(message) {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    return content.startsWith(MARKER_PREFIX) && content.endsWith(MARKER_SUFFIX);
}

export function injectGatewayMemoryMessage(messagesInput, payload) {
    const messages = Array.isArray(messagesInput)
        ? messagesInput.filter(message => !isGatewayMemoryBridgeMessage(message))
        : [];
    return [
        ...messages,
        {
            role: 'system',
            content: encodeGatewayMemoryMarker(payload),
        },
    ];
}

function parseYamlValue(source, yamlApi) {
    if (!source.trim()) return {};
    if (yamlApi && typeof yamlApi.parse === 'function') return yamlApi.parse(source);
    if (yamlApi && typeof yamlApi.load === 'function') return yamlApi.load(source);
    return JSON.parse(source);
}

function stringifyYamlValue(value, yamlApi) {
    if (yamlApi && typeof yamlApi.stringify === 'function') return yamlApi.stringify(value);
    if (yamlApi && typeof yamlApi.dump === 'function') return yamlApi.dump(value);
    return JSON.stringify(value);
}

export function mergeGatewayMemoryIntoCustomIncludeBody(existingValue, payload, yamlApi = null) {
    const source = safeString(existingValue, Number.MAX_SAFE_INTEGER);
    try {
        const parsed = parseYamlValue(source, yamlApi);
        let merged = {};
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(merged, item);
            }
        } else if (parsed && typeof parsed === 'object') {
            merged = { ...parsed };
        }
        merged.gateway_memory = payload;
        return { value: stringifyYamlValue(merged, yamlApi), error: '' };
    } catch (error) {
        return {
            value: source,
            error: `custom_include_body 无法解析，已保留原值并改用 system 桥接消息：${safeString(error?.message || error, 300)}`,
        };
    }
}
