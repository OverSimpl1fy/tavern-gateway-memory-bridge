import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../bridge-core.js';
import { createTokenStore, tokenStorageKey } from '../token-store.js';

const storage = () => {
    const data = new Map();
    return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data };
};

test('active private gateway is filled with an exact origin rule; cloud and invalid hosts never auto-authorize', () => {
    for (const url of ['http://192.168.1.20:3180/v1', 'http://10.0.1.2:3080/v1', 'http://172.19.1.3:3180/v1', 'http://localhost:3180/v1', 'http://[::1]:3080/v1']) {
        const inferred = core.inferGatewayConfiguration({ custom_url: url });
        assert.equal(inferred.gatewayBaseUrl, new URL(url).origin);
        assert.equal(core.matchGatewayEndpoint({ custom_url: url }, inferred.endpointPattern).matched, true);
        assert.equal(core.matchGatewayEndpoint({ custom_url: new URL(url).origin + '.evil.example/v1' }, inferred.endpointPattern).matched, false);
    }
    for (const url of ['https://api.example.com:3180/v1', 'http://192.168.1.999:3180/v1', 'http://172.32.0.1:3180/v1', 'http://192.168.1.20:3000/v1', 'http://secret@192.168.1.20:3180/v1']) {
        assert.equal(core.inferGatewayConfiguration({ custom_url: url }), null, url);
    }
});

test('manual choices and disabled auto configuration survive; automatically saved origins can follow a changed LAN address', () => {
    const active = { custom_url: 'http://192.168.1.20:3180/v1' };
    assert.equal(core.inferGatewayConfiguration(active, { autoConfigure: false }), null);
    assert.equal(core.inferGatewayConfiguration(active, { endpointPattern: '^https://my.example' }), null);
    assert.equal(core.inferGatewayConfiguration(active, { gatewayBaseUrl: 'https://my.example' }), null);
    assert.equal(core.inferGatewayConfiguration(active, { autoConfiguredOrigin: 'http://10.0.0.1:3180', gatewayBaseUrl: 'http://10.0.0.1:3180' }).gatewayBaseUrl, 'http://192.168.1.20:3180');
});

test('inactive custom URL is never used while the selected provider is a cloud connection', () => {
    assert.equal(core.activeEndpointSettings({ chat_completion_source: 'openai', custom_url: 'http://192.168.1.20:3180/v1', reverse_proxy: '' }).custom_url, undefined);
    assert.deepEqual(core.activeEndpointSettings({ chat_completion_source: 'custom', custom_url: 'http://192.168.1.20:3180/v1', reverse_proxy: 'https://cloud.example' }), { custom_url: 'http://192.168.1.20:3180/v1' });
});

test('remembered tokens survive a new tab and isolate account and gateway; clearing and remember-off remove persistence', () => {
    const local = storage(), session = storage();
    const store = createTokenStore({ persistent: () => local, session: () => session });
    const base = 'http://192.168.1.20:3180';
    assert.equal(store.write('alice', base, 'Bearer fixture-secret'), true);
    const fresh = createTokenStore({ persistent: () => local, session: storage });
    assert.equal(fresh.read('alice', base), 'fixture-secret');
    assert.equal(fresh.read('bob', base), '');
    assert.equal(fresh.read('alice', 'http://192.168.1.21:3180'), '');
    assert.equal(fresh.read('alice', 'http://192.168.1.20:3080'), '');
    store.write('alice', base, 'fixture-secret', false);
    assert.equal(local.data.size, 0);
    assert.equal(store.read('alice', base, false), 'fixture-secret');
    store.clear('alice', base);
    assert.equal(store.read('alice', base), '');
    assert.equal(session.data.size, 0);
    assert.equal(tokenStorageKey('alice', 'https://secret@host'), '');
});

test('denied browser storage leaves token usable in memory and reports persistence failure', () => {
    const denied = () => { throw new Error('blocked'); };
    const store = createTokenStore({ persistent: denied, session: denied });
    assert.equal(store.write('alice', 'http://localhost:3180', 'fixture'), false);
    assert.equal(store.read('alice', 'http://localhost:3180'), 'fixture');
    store.clear('alice', 'http://localhost:3180');
    assert.equal(store.read('alice', 'http://localhost:3180'), '');
});

// Execute the shipped index with minimal host bindings. It exercises real UI
// listeners and the real generation hook, without launching a second Tavern.
async function host(initial = {}, persistent = storage()) {
    let source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    source = source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../index.js', import.meta.url).href));
    const controls = new Map();
    const document = { querySelector(selector) {
        if (!controls.has(selector)) controls.set(selector, { value: '', checked: false, dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
        return controls.get(selector);
    } };
    const settings = { 'tavern-gateway-memory-bridge': initial };
    const active = { chat_completion_source: 'custom', custom_url: 'http://192.168.1.20:3180/v1' };
    const events = new Map();
    let saves = 0;
    const bindings = { ...core, createTokenStore, document, extension_settings: settings, oai_settings: active, saveSettingsDebounced: () => saves++, getCurrentUserHandle: () => 'alice', localStorage: persistent, sessionStorage: storage(), getContext: () => ({ chatId: 'chat-fixture', chat: [{ is_user: true, mes: '用户' }] }), event_types: { CHAT_COMPLETION_SETTINGS_READY: 'ready' }, eventSource: { on: (name, fn) => events.set(name, fn) }, jQuery: () => {}, globalThis: { crypto: globalThis.crypto }, console };
    const api = new Function(...Object.keys(bindings), source + '\nreturn { bindSettingsUi, onChatCompletionSettingsReady, readGatewayToken, autoConfigureGateway, getSettings };')(...Object.values(bindings));
    api.bindSettingsUi();
    return { api, controls, settings, active, events, persistent, saves: () => saves };
}

test('actual UI auto-fills LAN settings, saves pasted token and restores it after reload without serializing it', async () => {
    const a = await host();
    assert.equal(a.controls.get('#tgm-bridge-gateway-base-url').value, 'http://192.168.1.20:3180');
    const input = a.controls.get('#tgm-bridge-gateway-token');
    input.value = 'fixture-secret';
    input.listeners.input();
    assert.equal(a.api.readGatewayToken(), 'fixture-secret');
    assert.equal(a.api.getSettings().sidebandEnabled, true);
    assert.equal(JSON.stringify(a.settings).includes('fixture-secret'), false);
    const b = await host(a.api.getSettings(), a.persistent);
    assert.equal(b.controls.get('#tgm-bridge-gateway-token').value, 'fixture-secret');
    b.controls.get('#tgm-bridge-clear-token').listeners.click();
    assert.equal(b.api.readGatewayToken(), '');
});

test('actual hook injects LAN gateway and takeover requests, but never sends credentials or injects an unrelated endpoint', async () => {
    const h = await host();
    const token = h.controls.get('#tgm-bridge-gateway-token');
    token.value = 'fixture-secret';
    token.listeners.input();
    const normal = { chat_completion_source: 'custom', custom_url: h.active.custom_url, messages: [{ role: 'user', content: '生成' }] };
    await h.api.onChatCompletionSettingsReady(normal);
    assert.equal(normal.gateway_memory.chatId, 'chat-fixture');
    assert.equal(normal.gateway_memory.targetFloor, 1);
    const takeover = { messages: [{ role: 'user', content: '继续' }] };
    await h.api.onChatCompletionSettingsReady(takeover);
    assert.ok(takeover.gateway_memory);
    const cloud = { chat_completion_source: 'custom', custom_url: 'https://cloud.example/v1', messages: [] };
    await h.api.onChatCompletionSettingsReady(cloud);
    assert.equal(cloud.gateway_memory, undefined);
    const explicitWithoutSource = { custom_url: 'https://cloud.example/v1', messages: [] };
    await h.api.onChatCompletionSettingsReady(explicitWithoutSource);
    assert.equal(explicitWithoutSource.gateway_memory, undefined);
    assert.equal(JSON.stringify(normal).includes('fixture-secret'), false);
    h.active.chat_completion_source = 'openai';
    h.active.reverse_proxy = '';
    const switched = { chat_completion_source: 'openai', reverse_proxy: '', messages: [] };
    await h.api.onChatCompletionSettingsReady(switched);
    assert.equal(switched.gateway_memory, undefined);
});
