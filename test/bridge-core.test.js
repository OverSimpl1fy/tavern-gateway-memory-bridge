import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    buildGatewayMemoryPayload,
    canonicalFloorHashInput,
    decodeGatewayMemoryMarker,
    fnv1a32,
    hashText,
    injectGatewayMemoryMessage,
    isDefaultGatewayEndpoint,
    matchGatewayEndpoint,
    mergeGatewayMemoryIntoCustomIncludeBody,
    resolveGenerationType,
    resolveTargetAnchor,
} from '../bridge-core.js';

test('floor hashes use one dependency-free FNV-1a protocol', async () => {
    assert.equal(fnv1a32('hello'), '4f9f2cab', 'matches the standard ASCII FNV-1a vector');
    assert.equal(fnv1a32('user\u00001\u0000你好'), '5f12cb05', 'hashes Unicode as UTF-8 bytes');
    assert.equal(
        canonicalFloorHashInput('assistant', false, ' \r\nline 1\r\nline 2\r\n '),
        'assistant\u00000\u0000line 1\nline 2',
    );
    assert.equal(
        await hashText(canonicalFloorHashInput('assistant', false, ' \r\nline 1\r\nline 2\r\n ')),
        'b4ed263e',
    );
    assert.match(await hashText('任意内容'), /^[0-9a-f]{8}$/);
});

test('default endpoint policy accepts only loopback gateway ports', () => {
    assert.equal(isDefaultGatewayEndpoint('http://127.0.0.1:3080/gateway'), true);
    assert.equal(isDefaultGatewayEndpoint('https://localhost:3180/v1'), true);
    assert.equal(isDefaultGatewayEndpoint('http://[::1]:3080/v1'), true);
    assert.equal(isDefaultGatewayEndpoint('http://127.0.0.1:3000/v1'), false);
    assert.equal(isDefaultGatewayEndpoint('http://127.0.0.1.evil.example:3080/v1'), false);
    assert.equal(isDefaultGatewayEndpoint('https://example.com:3080/v1'), false);
});

test('custom endpoint regex is explicit and invalid patterns fail closed', () => {
    const data = { reverse_proxy: 'http://192.168.1.20:3080/v1' };
    assert.equal(matchGatewayEndpoint(data, '^https?://192\\.168\\.1\\.20:3080(?:/|$)').matched, true);
    const invalid = matchGatewayEndpoint(data, '[');
    assert.equal(invalid.matched, false);
    assert.match(invalid.error, /无效/);
});

test('target anchors distinguish normal turns, rerolls, and empty in-flight slots', () => {
    const chat = [
        { is_user: true, mes: 'u0' },
        { is_user: false, mes: 'a0', swipe_id: 2 },
        { is_user: true, mes: 'u1' },
    ];
    assert.deepEqual(resolveTargetAnchor(chat, 'normal'), {
        targetFloor: 3,
        targetSwipeId: 0,
        targetAssistantSeq: 2,
    });
    assert.deepEqual(resolveTargetAnchor(chat, 'swipe'), {
        targetFloor: 1,
        targetSwipeId: 2,
        targetAssistantSeq: 1,
    });

    // Generate('regenerate') removes the prior tail reply before the request
    // hook runs. An older assistant may remain, but the replacement belongs at
    // chat.length, not on that historical assistant floor.
    assert.deepEqual(resolveTargetAnchor(chat, 'regenerate'), {
        targetFloor: 3,
        targetSwipeId: 0,
        targetAssistantSeq: 2,
    });

    const inFlight = [...chat, { is_user: false, is_system: false, mes: '', swipe_id: 4 }];
    assert.deepEqual(resolveTargetAnchor(inFlight, 'normal'), {
        targetFloor: 3,
        targetSwipeId: 4,
        targetAssistantSeq: 2,
    });
});

test('takeover requests recover their one-shot generation type', () => {
    assert.equal(resolveGenerationType(undefined, 'Continue'), 'continue');
    assert.equal(resolveGenerationType('SWIPE', 'continue'), 'swipe');
    assert.equal(resolveGenerationType(undefined, undefined), 'normal');
});

test('payload preserves real floors and hashes full active text before truncation', async () => {
    const chat = [
        { is_user: true, mes: 'user', swipe_id: 0, name: 'U' },
        { is_user: false, is_system: true, mes: 'hidden answer', swipe_id: 1, name: 'A' },
        { is_user: true, mes: 'x'.repeat(2000), swipe_id: 0, name: 'U' },
    ];
    const payload = await buildGatewayMemoryPayload({
        chat,
        generationType: 'normal',
        identity: {
            chatId: 'real-chat-id',
            stateTarget: { chatId: 'real-chat-id', characterId: 7 },
            character: { id: 7, name: 'Hero', avatar: 'hero.png' },
        },
        lastInContextMessageId: 2,
        endpoint: 'http://127.0.0.1:3080/v1',
        settings: {
            maxLedgerEntries: 100,
            maxTextMessages: 20,
            maxCharsPerMessage: 1024,
            maxTotalTextChars: 20000,
        },
        now: () => new Date('2026-09-08T00:00:00.000Z'),
        hashTextFn: async text => `hash:${text.length}`,
    });

    assert.equal(payload.chatId, 'real-chat-id');
    assert.equal(payload.targetFloor, 3);
    assert.equal(payload.targetAssistantSeq, 2);
    assert.equal(payload.ledger[1].floor, 1);
    assert.equal(payload.ledger[1].assistantSeq, 1, 'hidden assistants keep assistant coordinates');
    assert.equal(payload.ledger[2].hash, 'hash:2007');
    assert.equal(payload.messages[2].text.length, 1024);
    assert.equal(payload.messages[2].truncated, true);
    assert.equal(payload.coverage.ledgerComplete, true);
    assert.equal(payload.lastInContextMessageId, 2);
    assert.equal(payload.rawVisibleFromFloor, 2);
});

test('settled sideband payload targets MESSAGE_RECEIVED floor, not the next future floor', async () => {
    const chat = [
        { is_user: true, mes: '行动', swipe_id: 0 },
        { is_user: false, mes: '最终正文', swipe_id: 3 },
        { is_user: true, mes: '下一轮', swipe_id: 0 },
    ];
    const payload = await buildGatewayMemoryPayload({
        chat,
        generationType: 'reconcile',
        requestNonce: 'capture-sideband',
        finalizedTargetFloor: 1,
        identity: { chatId: 'sideband-chat' },
    });
    assert.equal(payload.requestNonce, 'capture-sideband');
    assert.equal(payload.targetFloor, 1);
    assert.equal(payload.targetSwipeId, 3);
    assert.equal(payload.targetAssistantSeq, 1);
    assert.equal(payload.ledger[1].hash, payload.messages[1].hash);
});

test('payload hashes the normalized complete active body, never its truncated copy', async () => {
    const body = `  第一行\r\n${'x'.repeat(2000)}  `;
    const payload = await buildGatewayMemoryPayload({
        chat: [{ is_user: true, mes: body, swipe_id: 2 }],
        identity: { chatId: 'hash-normalization' },
        settings: {
            maxLedgerEntries: 100,
            maxTextMessages: 20,
            maxCharsPerMessage: 1024,
            maxTotalTextChars: 20000,
        },
    });

    const expected = await hashText(canonicalFloorHashInput('user', false, body));
    assert.equal(payload.ledger[0].hash, expected);
    assert.equal(payload.messages[0].hash, expected);
    assert.equal(payload.messages[0].text.length, 1024);
    assert.equal(payload.messages[0].truncated, true);
});

test('system marker round-trips Unicode payload and replaces prior bridge message', () => {
    const payload = { chatId: '新世界', targetFloor: 9, messages: [{ text: '你好' }] };
    const first = injectGatewayMemoryMessage([{ role: 'user', content: 'hello' }], payload);
    assert.equal(first.length, 2);
    assert.deepEqual(decodeGatewayMemoryMarker(first[1].content), payload);

    const second = injectGatewayMemoryMessage(first, { ...payload, targetFloor: 10 });
    assert.equal(second.length, 2);
    assert.equal(decodeGatewayMemoryMarker(second[1].content).targetFloor, 10);
});

test('CUSTOM include body keeps effective user keys and reserves gateway_memory', () => {
    const yamlApi = {
        parse: JSON.parse,
        stringify: JSON.stringify,
    };
    const result = mergeGatewayMemoryIntoCustomIncludeBody(
        '{"reasoning":{"effort":"high"},"gateway_memory":{"old":true}}',
        { version: 1, chatId: 'chat' },
        yamlApi,
    );
    assert.equal(result.error, '');
    assert.deepEqual(JSON.parse(result.value), {
        reasoning: { effort: 'high' },
        gateway_memory: { version: 1, chatId: 'chat' },
    });
});

test('manifest and protocol schema are valid JSON', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const schema = JSON.parse(await readFile(new URL('../protocol.schema.json', import.meta.url), 'utf8'));
    assert.equal(manifest.js, 'index.js');
    assert.equal(schema.properties.protocol.const, 'tavern-gateway-memory-bridge');
    assert.equal(schema.properties.version.const, 1);
    assert.equal(schema.$defs.ledgerEntry.properties.hash.pattern, '^[0-9a-f]{8}$');
    assert.equal(schema.$defs.message.properties.hash.pattern, '^[0-9a-f]{8}$');
});
