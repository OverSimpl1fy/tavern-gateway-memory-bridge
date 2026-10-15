// Never serialize credentials into extension settings, payloads, or chat.
export function tokenStorageKey(account, gateway) {
    try {
        const url = new URL(gateway);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        return `tavern-gateway-memory-bridge:token-v2:${encodeURIComponent(account || 'default-user')}:${encodeURIComponent(url.origin)}`;
    } catch { return ''; }
}

export function createTokenStore({ persistent, session }) {
    const volatile = new Map();
    const read = (storage, key) => { try { return storage()?.getItem(key) || ''; } catch { return ''; } };
    const remove = (storage, key) => { try { storage()?.removeItem(key); } catch { /* denied storage */ } };
    return {
        read(account, gateway, remember = true) {
            const key = tokenStorageKey(account, gateway);
            if (!key) return '';
            return volatile.get(key) || read(session, key) || (remember ? read(persistent, key) : '');
        },
        write(account, gateway, value, remember = true) {
            const key = tokenStorageKey(account, gateway);
            if (!key) return false;
            const token = String(value || '').replace(/^Bearer\s+/i, '').trim();
            if (token) volatile.set(key, token); else volatile.delete(key);
            let saved = true;
            for (const [storage, retain] of [[session, true], [persistent, remember]]) {
                try {
                    if (token && retain) storage()?.setItem(key, token);
                    else storage()?.removeItem(key);
                } catch { saved = false; }
            }
            return saved;
        },
        clear(account, gateway) {
            const key = tokenStorageKey(account, gateway);
            if (!key) return;
            volatile.delete(key);
            remove(session, key); remove(persistent, key);
        },
    };
}
