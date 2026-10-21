import { buildGatewayMemoryPayload, getActiveMessageText } from './bridge-core.js';
import { attachPage, cleanHistoryText, historyPage, mapCoreFloors, plotIsLive } from './history-core.js';
import { mirrorGatewayMemory } from './native-mirror.js';

const CONFIG = 'tavernGatewayMemoryBridge';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createMemoryFeatures({ getSettings, getContext, currentIdentity, readToken, now, allowedEndpoint, nativeSettings }) {
    const cache = new Map(), pollTimers = new Map(), mirrorTasks = new Map();
    let importRun = null, epoch = 0;
    const chatId = context => String(context?.chatId ?? context?.getCurrentChatId?.() ?? '');
    const config = context => context?.chatMetadata?.[CONFIG] || {};
    const keyOf = context => JSON.stringify([getSettings().gatewayBaseUrl, currentIdentity(context, chatId(context)), config(context).world || '']);
    const current = key => key === keyOf(getContext());
    const status = message => { const element = document.querySelector('#tgm-memory-status'); if (element) element.textContent = message; };

    function connection() {
        const settings = getSettings();
        if (!settings.enabled || !allowedEndpoint()) throw new Error('当前模型连接未指向获授权的网关。');
        const base = new URL(settings.gatewayBaseUrl);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('网关地址无效。');
        const token = readToken();
        if (!token) throw new Error('请先保存 Dashboard 令牌；补建、进度查询和手机镜像需要访问受保护的记忆接口。');
        return { base, token };
    }

    async function fetchJson(path, init = {}) {
        const { base, token } = connection();
        const response = await fetch(new URL(path, base), {
            ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
            cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(20000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`);
        return body;
    }

    async function payload(context) {
        return buildGatewayMemoryPayload({ chat: context.chat, generationType: 'reconcile', requestNonce: crypto.randomUUID?.() || String(Date.now()),
            identity: currentIdentity(context, chatId(context)), endpoint: getSettings().gatewayBaseUrl, settings: getSettings(), now });
    }

    async function mirror(body, context, key) {
        if (!getSettings().nativeMirror) return true;
        if (mirrorTasks.has(key)) return false;
        const mirrorStatus = message => { const element = document.querySelector('#tgm-memory-mirror-status'); if (element) element.textContent = message; };
        const version = epoch;
        const task = mirrorGatewayMemory({ context, memory: body.memory, nativeSettings: nativeSettings(), stillCurrent: () => current(key) && epoch === version });
        mirrorTasks.set(key, task);
        try {
            const result = await task;
            if (current(key)) mirrorStatus(result.message);
            return result.state === 'synced';
        } catch (error) {
            if (current(key)) mirrorStatus(`手机镜像未完成：${error.message}；网关中的记忆仍保留。`);
            return false;
        } finally { if (mirrorTasks.get(key) === task) mirrorTasks.delete(key); }
    }

    function schedulePoll(key, gatewayChat) {
        if (pollTimers.has(key)) return;
        const timer = setTimeout(async () => {
            pollTimers.delete(key);
            if (!current(key) || !getSettings().enabled) return;
            try {
                const body = await fetchJson(`/gateway/memory?chat=${encodeURIComponent(gatewayChat)}`);
                await accept(body, getContext());
            } catch (error) { if (current(key)) status(`记忆进度查询失败：${error.message}；下次对账会恢复。`); }
        }, 4000);
        pollTimers.set(key, timer);
    }

    async function accept(body, context) {
        if (!body?.memory || body.memory.bridge?.clientChatId !== chatId(context)) return;
        if (String(body.memory.bridge?.characterId || '') !== String(currentIdentity(context, chatId(context)).character?.id ?? '')) return;
        if (!body.memory.capabilities?.plotSynopsis) { status('基础楼层桥接正常；历史补建和手机镜像需要网关6.14.0或更新版本。'); return; }
        const key = keyOf(context);
        if (!current(key)) return;
        const previous = cache.get(key);
        cache.set(key, body);
        const job = body.job || body.memory.job;
        const busy = ['queued', 'running'].includes(job?.status) || job?.hasQueued;
        const through = body.memory.plot?.coveredThrough ?? -1;
        status(busy ? `记忆正在后台建立；已完整覆盖到第 ${through} 楼，可继续对话。`
            : job?.status === 'failed' ? `记忆提取失败：${job.error || '请重新补建'}；未丢弃正文。`
            : `网关记忆：${body.memory.stats?.nodes || 0} 个节点；剧情梗概完整覆盖至第 ${through} 楼。`);
        if (busy) schedulePoll(key, body.chatKey);
        const signature = JSON.stringify([body.memory.nodes, body.memory.edges]);
        body._signature = signature;
        body._mirrored = signature === previous?._signature && previous?._mirrored === true;
        if ((!busy || !body.memory.nodes?.length) && !body._mirrored) body._mirrored = await mirror(body, context, key);
    }

    async function refresh() {
        const context = getContext(), data = await payload(context);
        const body = await fetchJson('/gateway/memory/reconcile', { method: 'POST', body: JSON.stringify({ ...data, action: 'status', world: config(context).world || '' }) });
        await accept(body, context);
        return body;
    }

    async function interceptor(core, _contextSize, _abort, type) {
        if (!getSettings().enabled || !allowedEndpoint() || ['quiet', 'impersonate'].includes(type)) return;
        const context = getContext(), key = keyOf(context), chat = context.chat || [];
        if (cache.has(key)) cache.get(key)._cut = null;
        const floors = mapCoreFloors(core, chat);
        if (!floors) { status('其它扩展改变了楼层映射，本次保留完整历史，未猜测删楼。'); return; }
        const latestUser = chat.findLastIndex(row => row?.is_user === true);
        if (getSettings().cleanHistory) for (let i = 0; i < core.length; i++) {
            if (floors[i] < latestUser || core[i].is_user !== true) core[i].mes = cleanHistoryText(core[i].mes);
        }
        const cut = config(context).omitThrough;
        if (!Number.isInteger(cut) || cut < 0) return;
        let body = cache.get(key);
        if (!body) { try { body = await refresh(); } catch (error) { status(`本次保留旧楼层：${error.message}`); return; } }
        if (cut >= (latestUser < 0 ? chat.length - 1 : latestUser) || (body.memory.plot?.coveredThrough ?? -1) < cut
            || !await plotIsLive(body.memory.plot, chat)) {
            status('所选旧楼层尚无完整有效的梗概，或来源已修改；本次继续发送原文。请先补建或重新对账。');
            return;
        }
        for (let i = core.length - 1; i >= 0; i--) if (floors[i] <= cut) core.splice(i, 1);
        // The final hook adds this selection to the raw floor manifest. The
        // gateway independently verifies coverage before making a model call.
        body._cut = { toFloor: cut, epoch, targetChat: key };
        status(`本次用已确认剧情梗概替换第0–${cut}楼；原聊天和变量完整保留。`);
    }

    function attachCut(data, context) {
        const key = keyOf(context), cut = cache.get(key)?._cut;
        if (cut && cut.epoch === epoch && cut.targetChat === key) data.contextCut = { toFloor: cut.toFloor };
    }

    async function backfill() {
        if (importRun) { importRun.cancelled = true; status('已暂停后续批次；当前已提交的后台批次会完成。'); return; }
        const context = getContext(), key = keyOf(context);
        const goal = context.chat.findLastIndex(row => row?.is_user !== true && getActiveMessageText(row).trim());
        if (goal < 0) throw new Error('当前聊天没有已保存的AI回复。');
        connection();
        if (!config(context).world) throw new Error('请先选择这段旧聊天所属的世界；新会话绑定不能猜测。');
        const run = importRun = { key, cancelled: false };
        try {
            let body;
            try { body = await refresh(); } catch (error) { if (!/唯一会话|先在对应聊天/.test(error.message)) throw error; }
            while (!run.cancelled && current(key)) {
                const live = getContext();
                const from = Math.max(0, (body?.memory.plot?.coveredThrough ?? -1) + 1);
                if (from > goal) { status(`历史补建完成，剧情梗概完整覆盖第0–${goal}楼。`); break; }
                const page = historyPage(live.chat, from, goal);
                const data = await attachPage(await payload(live), page);
                body = await fetchJson('/gateway/memory/reconcile', { method: 'POST', body: JSON.stringify({ ...data, action: 'backfill', world: config(live).world, toFloor: page.at(-1).floor }) });
                await accept(body, live);
                const start = Date.now();
                while (!run.cancelled && current(key) && (body.memory.plot?.coveredThrough ?? -1) < page.at(-1).floor) {
                    if (Date.now() - start > 15 * 60 * 1000) throw new Error('这一批后台任务较久，已暂停后续批次；稍后点刷新查看实际进度。');
                    await delay(3500);
                    body = await fetchJson(`/gateway/memory?chat=${encodeURIComponent(body.chatKey)}`);
                    await accept(body, getContext());
                    if (['failed', 'deferred'].includes(body.memory.job?.status) && !body.memory.job?.hasQueued) throw new Error(body.memory.job.error || body.memory.job.reason || '本批未完成，请重新补建。');
                }
                if (!current(key)) break;
                if (!await plotIsLive(body.memory.plot, getContext().chat)) throw new Error('补建来源已编辑或重Roll，已停止后续批次；先重新对账再补建。');
            }
        } finally { importRun = null; }
    }

    function changed() {
        epoch++;
        if (importRun && !current(importRun.key)) importRun.cancelled = true;
        render();
    }

    function render() {
        const context = getContext(), saved = config(context);
        const cut = document.querySelector('#tgm-memory-omit-through'), world = document.querySelector('#tgm-memory-world');
        if (cut) { cut.value = Number.isInteger(saved.omitThrough) ? String(saved.omitThrough) : ''; cut.max = String(Math.max(0, (context.chat?.length || 1) - 2)); }
        if (world) world.value = saved.world || '';
    }

    function bindUi() {
        render();
        for (const [id, setting] of [['#tgm-memory-clean-history', 'cleanHistory'], ['#tgm-memory-native-mirror', 'nativeMirror']]) {
            const element = document.querySelector(id);
            if (element) {
                element.checked = getSettings()[setting];
                element.addEventListener('change', () => { getSettings()[setting] = element.checked; getContext().saveSettingsDebounced?.(); changed(); });
            }
        }
        const saveConfig = patch => {
            const context = getContext();
            if (!chatId(context) || !context.chatMetadata) return;
            context.chatMetadata[CONFIG] = { ...config(context), ...patch };
            context.saveMetadata?.(); changed();
        };
        document.querySelector('#tgm-memory-omit-through')?.addEventListener('change', event => {
            const value = event.target.value.trim();
            saveConfig({ omitThrough: value === '' ? null : Math.max(0, Math.floor(Number(value))) });
        });
        document.querySelector('#tgm-memory-world')?.addEventListener('change', event => saveConfig({ world: event.target.value }));
        document.querySelector('#tgm-memory-backfill')?.addEventListener('click', () => void backfill().catch(error => status(error.message)));
        document.querySelector('#tgm-memory-refresh')?.addEventListener('click', () => void refresh().catch(error => status(error.message)));
    }

    const hasAppliedCut = context => {
        const cut = cache.get(keyOf(context))?._cut;
        return cut && cut.epoch === epoch && cut.targetChat === keyOf(context);
    };
    return { accept, interceptor, attachCut, hasAppliedCut, changed, bindUi, refresh };
}
