import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayMemoryPayload } from '../bridge-core.js';
import { attachPage, cleanHistoryText, historyPage, mapCoreFloors, plotIsLive } from '../history-core.js';
import { createMemoryFeatures } from '../memory-features.js';
import { mirrorGatewayMemory } from '../native-mirror.js';

const chat = () => [
    { is_user: false, mes: '商行开门。', name: '旁白', send_date: 'a' },
    { is_user: true, mes: '检查货物。', name: '主角', send_date: 'b' },
    { is_user: false, mes: '<plan>还没有发生。</plan><content>三箱货物待验。</content><book_info>旧账</book_info>', name: '旁白', send_date: 'c' },
    { is_user: true, mes: '交付清单。', name: '主角', send_date: 'd' },
];
async function payload(rows) { return buildGatewayMemoryPayload({ chat: rows, identity: { chatId: 'chat', character: { id: 1 } } }); }
async function memory(rows) {
    const data = await payload(rows);
    const proof = data.ledger.filter(row => row.floor <= 2).map(({ floor, swipeId, hash }) => ({ floor, swipeId, hash }));
    return { capabilities: { plotSynopsis: true }, bridge: { clientChatId: 'chat', characterId: '1' }, stats: { nodes: 2 },
        plot: { coveredThrough: 2, parts: [{ from: 0, to: 2, summary: '清点货物。', sourceAnchors: proof }] },
        checkpoint: { floor: 2 }, sourceProof: proof,
        nodes: [{ id: 'g1', type: 'event', title: '清点', fields: { summary: '三箱待验' } }, { id: 'g2', type: 'character_sheet', title: '管事', fields: { title: '管事' } }],
        edges: [{ from: 'g1', to: 'g2', type: 'involves' }], job: null };
}

test('historical blocks are removed with regex without touching source chat or raw hashes', async () => {
    const rows = chat(), before = await payload(rows);
    assert.equal(cleanHistoryText(rows[2].mes), '<content>三箱货物待验。</content>');
    assert.match(rows[2].mes, /<plan>/);
    assert.deepEqual((await payload(rows)).ledger, before.ledger);
});

test('long old chats page from the beginning instead of silently keeping only the recent upload window', async () => {
    const rows = Array.from({ length: 251 }, (_, i) => ({ is_user: i % 2 === 1, mes: '安全合成文本' + i }));
    const page = historyPage(rows, 0), data = await payload(rows);
    assert.equal(page[0].floor, 0); assert.equal(page.at(-1).floor % 2, 0);
    await attachPage(data, page);
    assert.equal(data.messages[0].floor, 0);
    assert.equal(data.coverage.messageEndFloor, page.at(-1).floor);
    assert.equal(await plotIsLive({ parts: [{ sourceAnchors: data.messages }] }, rows), true);
    rows[1].mes = '改写过的源楼层';
    assert.equal(await plotIsLive({ parts: [{ sourceAnchors: data.messages }] }, rows), false);
    assert.throws(() => historyPage([{ is_user: false, mes: 'a'.repeat(100001) }], 0), /上限/);
});

test('kernel history mapping preserves real floors across hidden system messages and fails closed for unknown transforms', () => {
    const rows = chat(); rows.splice(1, 0, { is_system: true, is_user: false, mes: '系统标记' });
    const core = rows.filter(row => !row.is_system).map((row, index) => ({ ...row, index }));
    assert.deepEqual(mapCoreFloors(core, rows), [0, 2, 3, 4]);
    delete core[1].index;
    assert.equal(mapCoreFloors(core, rows), null);
});

test('the real interceptor only omits proven floors, keeps the latest player request and passes the cut in metadata', async () => {
    const rows = chat(), controls = new Map();
    globalThis.document = { querySelector: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); } };
    const context = { chatId: 'chat', chat: rows, chatMetadata: { tavernGatewayMemoryBridge: { omitThrough: 2 } } };
    const settings = { enabled: true, gatewayBaseUrl: 'http://localhost:3180', cleanHistory: true, nativeMirror: false };
    const features = createMemoryFeatures({ getSettings: () => settings, getContext: () => context,
        currentIdentity: () => ({ character: { id: 1 } }), readToken: () => '', now: () => new Date(), allowedEndpoint: () => true, nativeSettings: () => ({}) });
    await features.accept({ chatKey: 'gateway-chat', memory: await memory(rows) }, context);
    const core = rows.map((row, index) => ({ ...row, index }));
    await features.interceptor(core, 1000000, () => {}, 'normal');
    assert.equal(core.length, 1); assert.equal(core[0].mes, '交付清单。');
    const outgoing = {}; features.attachCut(outgoing, context);
    assert.deepEqual(outgoing.contextCut, { toFloor: 2 });
    context.chatMetadata.tavernGatewayMemoryBridge.omitThrough = 0; features.changed();
    const zero = rows.map((row, index) => ({ ...row, index }));
    await features.interceptor(zero, 1000000, () => {}, 'normal');
    assert.equal(zero.length, 3, 'explicit zero omits floor zero');
    const zeroPayload = {}; features.attachCut(zeroPayload, context); assert.equal(zeroPayload.contextCut.toFloor, 0);
    context.chatMetadata.tavernGatewayMemoryBridge.omitThrough = null; features.changed();
    const disabled = rows.map((row, index) => ({ ...row, index }));
    await features.interceptor(disabled, 1000000, () => {}, 'normal'); assert.equal(disabled.length, 4, 'null does not become zero');
    context.chatMetadata.tavernGatewayMemoryBridge.omitThrough = 2;
    rows[1].mes = '改成新请求'; features.changed();
    const retry = rows.map((row, index) => ({ ...row, index }));
    await features.interceptor(retry, 1000000, () => {}, 'normal');
    assert.equal(retry.length, 4, 'invalid memory must retain the original floor history');
    const fresh = {}; features.attachCut(fresh, context); assert.equal(fresh.contextCut, undefined);
    assert.match(rows[2].mes, /<plan>/, 'saved chat was not mutated');
    delete globalThis.document;
});

function nativeFixture(rows, foreign = false) {
    let mapping = null, creates = 0, edits = 0;
    const graph = new Map(foreign ? [['foreign', { id: 'foreign' }]] : []);
    const session = { getSchema: () => ({ types: [{ type: 'event', tableColumns: ['summary'] }] }),
        listVisibleCandidates: () => [...graph.values()],
        createNode: async value => { const id = 'n' + (++creates); graph.set(id, { id, ...value }); return { id }; },
        editNode: async value => { edits++; Object.assign(graph.get(value.id), value); return { ok: true }; },
        deleteNode: async ({ id }) => { graph.delete(id); return { ok: true }; },
        applyExtractionBatch: async ({ ops }) => ({ applied: ops, rejected: [] }) };
    const api = { openSession: async () => session, getNodeById: async (_context, id) => graph.get(id) || null };
    const context = { chat: rows, getExtensionApi: () => api, resolveChatStateTarget: () => ({ avatar_url: 'test.png', file_name: 'chat' }),
        getChatState: async () => ({ ok: true, state: mapping }), updateChatState: async (_ns, updater) => { mapping = updater(); return { ok: true }; } };
    return { context, graph, counts: () => ({ creates, edits }) };
}

test('native display mirror persists nodes and links without model calls or duplicate creates on repeat sync', async () => {
    const rows = chat(), fixture = nativeFixture(rows), data = await memory(rows);
    const options = { context: fixture.context, memory: data, stillCurrent: () => true, nativeSettings: { enabled: false, autoExtractionEnabled: false } };
    assert.equal((await mirrorGatewayMemory(options)).state, 'synced');
    assert.equal(fixture.counts().creates, 2);
    assert.match([...fixture.graph.values()][1].setFields.summary, /character_sheet/);
    assert.equal((await mirrorGatewayMemory(options)).state, 'synced');
    assert.equal(fixture.counts().creates, 2);
    assert.equal(fixture.counts().edits, 2);
});

test('native manual memories, stale swipes and unsafe native settings are preserved without writes', async () => {
    const rows = chat(), fixture = nativeFixture(rows, true), data = await memory(rows);
    const options = { context: fixture.context, memory: data, stillCurrent: () => true, nativeSettings: { enabled: false, autoExtractionEnabled: false } };
    assert.equal((await mirrorGatewayMemory(options)).state, 'conflict');
    assert.equal(fixture.counts().creates, 0);
    rows[2].swipe_id = 1;
    assert.equal((await mirrorGatewayMemory(options)).state, 'stale');
    assert.equal((await mirrorGatewayMemory({ ...options, nativeSettings: { enabled: true } })).state, 'settings-required');
    assert.ok(fixture.graph.has('foreign'));
});
