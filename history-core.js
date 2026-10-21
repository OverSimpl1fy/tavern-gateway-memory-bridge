import { getActiveMessageText, getMessageRole, hashText, canonicalFloorHashInput, normalizeSwipeId } from './bridge-core.js';

export function cleanHistoryText(value) {
    return String(value ?? '').replace(/<(plan|book_info|corruption_info|UpdateVariable|fox_selc|think_fox)\b[^>]*>[\s\S]*?<\/\1>/giu, '');
}

export function historyPage(chat, from, through = chat.length - 1) {
    const messages = []; let bytes = 0; let lastAssistant = -1;
    for (let floor = from; floor <= Math.min(through, chat.length - 1); floor++) {
        const row = chat[floor], text = getActiveMessageText(row);
        const cost = JSON.stringify({ floor, role: getMessageRole(row), text: cleanHistoryText(text) }).length + 1;
        if (text.length > 100000) throw new Error(`第 ${floor} 楼超过单条补建上限（10万字符），未截断或丢弃它。`);
        if ((bytes + cost > 80000 || messages.reduce((n, r) => n + r.text.length, 0) + text.length > 500000 || messages.length >= 100) && messages.length) break;
        if (cost > 110000) throw new Error(`第 ${floor} 楼超过单批提取预算，未截断或丢弃它。`);
        bytes += cost;
        messages.push({ floor, role: getMessageRole(row), isSystem: row?.is_system === true, swipeId: normalizeSwipeId(row?.swipe_id), text, originalLength: text.length, truncated: false });
        if (row?.is_user !== true && text.trim()) lastAssistant = messages.length - 1;
    }
    if (lastAssistant < 0) throw new Error('本批没有完整的AI回复作为补建终点，请缩小单楼长度或保留下一条AI回复。');
    return messages.slice(0, lastAssistant + 1);
}

export async function attachPage(payload, page) {
    const byFloor = new Map(payload.ledger.map(row => [row.floor, row]));
    payload.messages = await Promise.all(page.map(async row => {
        const ledger = byFloor.get(row.floor);
        if (!ledger) throw new Error(`账本不包含第 ${row.floor} 楼；请提高账本上限。`);
        const hash = await hashText(canonicalFloorHashInput(row.role, row.isSystem, row.text));
        if (hash !== ledger.hash || ledger.swipeId !== row.swipeId) throw new Error('补建期间聊天已变化，请重试。');
        return { ...row, hash };
    }));
    payload.coverage = { ...payload.coverage, messageStartFloor: page[0].floor, messageEndFloor: page.at(-1).floor, totalTextChars: page.reduce((sum, row) => sum + row.text.length, 0) };
    payload.textTruncated = false;
    return payload;
}

export async function plotIsLive(plot, chat) {
    if (!plot || !Array.isArray(plot.parts)) return false;
    for (const part of plot.parts) {
        if (!part.sourceAnchors?.length) return false;
        for (const anchor of part.sourceAnchors) {
            const row = chat[anchor.floor];
            if (!row || normalizeSwipeId(row.swipe_id) !== anchor.swipeId) return false;
            const actual = await hashText(canonicalFloorHashInput(getMessageRole(row), row.is_system === true, getActiveMessageText(row)));
            if (actual !== anchor.hash) return false;
        }
    }
    return true;
}

// Luker 2.7.0 assigns `index` before filtering or merging prompt history.
// Match the verified kernel projection, including optional system tool rows.
// If another extension changes that contract, retain history instead of guessing.
export function mapCoreFloors(core, chat) {
    const candidates = [
        chat.map((row, floor) => ({ row, floor })).filter(x => !x.row?.is_system),
        chat.map((row, floor) => ({ row, floor })).filter(x => !x.row?.is_system || Array.isArray(x.row?.extra?.tool_invocations)),
    ];
    const valid = [];
    for (const source of candidates) {
        const mapped = core.map(row => {
            if (!Number.isInteger(row.index) || row.index < 0) return null;
            const item = source[row.index];
            if (!item || item.row?.is_user !== row.is_user || item.row?.name !== row.name || item.row?.send_date !== row.send_date) return null;
            return item.floor;
        });
        if (mapped.every(floor => floor !== null)) valid.push(mapped);
    }
    return valid.length && valid.every(row => JSON.stringify(row) === JSON.stringify(valid[0])) ? valid[0] : null;
}
