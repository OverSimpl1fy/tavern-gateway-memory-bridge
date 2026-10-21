import { plotIsLive } from './history-core.js';

const NAMESPACE = 'tavern_gateway_memory_mirror';
const LABELS = { event: '剧情', character_sheet: '人物', location_state: '地点', setting: '设定', history: '历史', conspiracy: '线索' };

// This is a display replica. Luker's character/setting create operations can
// merge existing nodes by primary key, and its event titles are auto-generated.
// Use independent event-view nodes and retain the gateway type/fields in their
// details, then set the display title explicitly. This cannot merge a gateway
// NPC into the user's manually maintained native NPC record.
export async function mirrorGatewayMemory({ context, memory, stillCurrent, nativeSettings }) {
    if (nativeSettings?.enabled || nativeSettings?.autoExtractionEnabled === true) {
        return { state: 'settings-required', message: '请关闭 Luker 记忆的“启用”和“自动抽取”；网关继续负责生成和召回，原生图仅供查看。' };
    }
    const api = context?.getExtensionApi?.('memory-graph');
    if (!api?.openSession || !api.getNodeById || !context?.getChatState || !context?.updateChatState) {
        return { state: 'unsupported', message: '当前 Luker 未提供可持久化记忆接口；网关记忆正常，手机镜像未写入。' };
    }
    const hasNodes = (memory.nodes || []).length > 0;
    if (hasNodes && !await plotIsLive({ parts: [{ sourceAnchors: memory.sourceProof || [] }] }, context.chat)) {
        return { state: 'stale', message: '记忆来源与当前楼层不一致，等待重新对账；未写入旧分支。' };
    }
    const target = context.resolveChatStateTarget?.();
    if (!target) throw new Error('无法绑定当前聊天的原生记忆目录。');
    const loaded = await context.getChatState(NAMESPACE, { target });
    const mapping = loaded?.ok && loaded.state?.nodes ? structuredClone(loaded.state) : { version: 1, nodes: {}, edges: [] };
    if (!hasNodes && Object.keys(mapping.nodes).length === 0) return { state: 'synced', message: '当前暂无有效网关记忆，手机镜像没有旧节点需要清理。' };
    const lastFloor = hasNodes ? (memory.plot?.parts?.at(-1)?.to ?? memory.checkpoint?.floor)
        : context.chat.findLastIndex(row => row?.is_user === false && String(row.mes || '').trim());
    if (!Number.isInteger(lastFloor) || lastFloor < 0 || !stillCurrent()) return { state: 'waiting', message: '等待第一份有效记忆。' };
    const anchorContext = { ...context, chat: context.chat.slice(0, lastFloor + 1) };
    const session = await api.openSession(anchorContext);
    if (!session || !stillCurrent()) return { state: 'waiting', message: '聊天已切换，稍后重新打开时同步。' };
    const eventSchema = session.getSchema()?.types?.find(type => type.type === 'event');
    if (!eventSchema?.tableColumns?.includes('summary')) {
        return { state: 'schema-required', message: '原生记忆 schema 缺少 event.summary，无法建立展示镜像；未覆盖现有 schema。' };
    }
    const owned = new Set(Object.values(mapping.nodes).map(row => row.id));
    const foreign = session.listVisibleCandidates().filter(row => !owned.has(row.id));
    if (foreign.length && hasNodes) return { state: 'conflict', message: '检测到原生图已有其它记忆。已保留这些内容并暂停镜像；网关记忆仍正常，不会覆盖或混合。' };

    const persist = async () => {
        const saved = await context.updateChatState(NAMESPACE, () => structuredClone(mapping), { target });
        if (!saved?.ok) throw new Error('原生记忆映射保存失败。');
    };
    const desired = new Map((memory.nodes || []).map(node => [node.id, node]));
    for (const [sourceId, row] of Object.entries(mapping.nodes)) {
        if (!stillCurrent()) return { state: 'waiting', message: '聊天已变化，镜像同步已暂停。' };
        if (!desired.has(sourceId)) {
            if (await api.getNodeById(anchorContext, row.id)) await session.deleteNode({ id: row.id });
            delete mapping.nodes[sourceId]; await persist();
        }
    }
    for (const node of desired.values()) {
        if (!stillCurrent()) return { state: 'waiting', message: '聊天已变化，镜像同步已暂停。' };
        const title = `${LABELS[node.type] || node.type} · ${node.title}${node.archived ? '（已归档）' : ''}`;
        const summary = JSON.stringify({ 来源: '网关记忆展示镜像', 类型: node.type, 楼层: [node.floorFrom, node.floorTo], 内容: node.fields }, null, 2);
        const fingerprint = JSON.stringify([title, summary]);
        let row = mapping.nodes[node.id];
        if (row && !await api.getNodeById(anchorContext, row.id)) { delete mapping.nodes[node.id]; row = null; }
        if (!row) {
            const created = await session.createNode({ type: 'event', fields: { summary } });
            row = mapping.nodes[node.id] = { id: created.id, fingerprint: null };
            await persist();
        }
        if (row.fingerprint !== fingerprint) {
            const edited = await session.editNode({ id: row.id, title, setFields: { summary } });
            if (!edited.ok) throw new Error('原生记忆节点更新失败。');
            row.fingerprint = fingerprint; await persist();
        }
    }
    const edgeKey = edge => JSON.stringify([edge.from, edge.to, edge.type]);
    const edges = (memory.edges || []).filter(edge => mapping.nodes[edge.from] && mapping.nodes[edge.to]);
    const wanted = new Set(edges.map(edgeKey)), old = new Set((mapping.edges || []).map(edgeKey));
    const ops = [];
    for (const edge of mapping.edges || []) if (!wanted.has(edgeKey(edge)) && mapping.nodes[edge.from] && mapping.nodes[edge.to]) {
        ops.push({ op: 'link_delete', sourceNodeId: mapping.nodes[edge.from].id, targetNodeId: mapping.nodes[edge.to].id, relation: edge.type, direction: 'outgoing' });
    }
    for (const edge of edges) if (!old.has(edgeKey(edge))) {
        ops.push({ op: 'link_upsert', sourceNodeId: mapping.nodes[edge.from].id, links: [{ targetNodeId: mapping.nodes[edge.to].id, relation: edge.type, direction: 'outgoing' }] });
    }
    if (!stillCurrent()) return { state: 'waiting', message: '聊天已变化，稍后继续同步关系边。' };
    if (ops.length) {
        const maxSeq = anchorContext.chat.filter(row => row?.is_user === false && String(row.mes || '').trim()).length;
        const result = await session.applyExtractionBatch({ ops, maxSeq });
        if (result.rejected?.length) throw new Error('原生记忆关系边未全部保存。');
    }
    mapping.edges = structuredClone(edges); await persist();
    return { state: 'synced', message: `已同步到 Luker 记忆：${desired.size} 个节点、${edges.length} 条关系；没有额外调用模型。` };
}
