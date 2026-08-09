// Shared data layer for Owen's Spending Tracker.
// Everything lives in the browser's localStorage - no server or database required.
(function (global) {
    const STORAGE_KEY = 'owens_tracker_data';
    const SCHEMA_VERSION = 2;
    const TYPES = ['income', 'spend', 'grocery'];
    const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP'];

    const DEFAULT_SETTINGS = {
        spending_percentage: 35,
        weekly_grocery_limit: 75,
        currency: 'USD'
    };

    const emptyData = () => ({
        schema_version: SCHEMA_VERSION,
        last_updated: null,
        settings: Object.assign({}, DEFAULT_SETTINGS),
        income_entries: [],
        spend_entries: [],
        grocery_entries: []
    });

    function newId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        return 'e-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    }

    // 'YYYY-MM-DD' parsed as a LOCAL date. new Date('2026-08-03') parses as UTC,
    // which lands on the previous day west of Greenwich and shifts week grouping.
    function parseDate(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
            return null; // rejects things like 2026-02-31
        }
        return d;
    }

    function isValidDate(value) {
        return parseDate(value) !== null;
    }

    // Monday-start week. Returns the week's start date at local midnight.
    function weekStart(date) {
        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const offset = (d.getDay() + 6) % 7; // Sunday(0) -> 6, Monday(1) -> 0
        d.setDate(d.getDate() - offset);
        return d;
    }

    function weekKey(value) {
        const d = typeof value === 'string' ? parseDate(value) : value;
        if (!d) return null;
        const s = weekStart(d);
        return s.getFullYear() + '-' +
            String(s.getMonth() + 1).padStart(2, '0') + '-' +
            String(s.getDate()).padStart(2, '0');
    }

    function clampNumber(value, fallback, min, max) {
        const n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.min(Math.max(n, min), max);
    }

    function normalizeSettings(raw) {
        const s = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
        return {
            spending_percentage: clampNumber(s.spending_percentage, DEFAULT_SETTINGS.spending_percentage, 1, 100),
            weekly_grocery_limit: clampNumber(s.weekly_grocery_limit, DEFAULT_SETTINGS.weekly_grocery_limit, 0.01, 1e9),
            // An unrecognised currency would make Intl.NumberFormat throw and blank every page.
            currency: SUPPORTED_CURRENCIES.indexOf(s.currency) > -1 ? s.currency : DEFAULT_SETTINGS.currency
        };
    }

    // Returns {entries, skipped}. Anything without a real date or a finite
    // positive amount is dropped rather than silently stored as $0.00.
    function normalizeEntries(rawList) {
        const entries = [];
        let skipped = 0;

        (Array.isArray(rawList) ? rawList : []).forEach(e => {
            if (!e || typeof e !== 'object') { skipped++; return; }
            const amount = parseFloat(e.amount);
            if (!isValidDate(e.date) || !isFinite(amount) || amount <= 0) { skipped++; return; }
            entries.push({
                id: typeof e.id === 'string' && e.id ? e.id : newId(),
                date: String(e.date),
                amount: Math.round(amount * 100) / 100,
                notes: e.notes === undefined || e.notes === null ? '' : String(e.notes)
            });
        });

        return { entries: entries, skipped: skipped };
    }

    // Accepts anything and returns a valid db, reporting what it had to drop.
    function normalize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { db: emptyData(), skipped: 0, addedIds: false };
        }

        const db = emptyData();
        db.settings = normalizeSettings(raw.settings);
        db.last_updated = typeof raw.last_updated === 'string' ? raw.last_updated : null;

        let skipped = 0;
        let addedIds = false;

        TYPES.forEach(type => {
            const key = type + '_entries';
            const rawList = Array.isArray(raw[key]) ? raw[key] : [];
            const result = normalizeEntries(rawList);
            // Entries saved before ids existed need one assigned and written back.
            if (rawList.some(e => e && typeof e === 'object' && !e.id)) addedIds = true;
            db[key] = result.entries;
            skipped += result.skipped;
        });

        return { db: db, skipped: skipped, addedIds: addedIds };
    }

    function load() {
        let raw;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch (err) {
            console.error('localStorage is unavailable:', err);
            return emptyData();
        }
        if (!raw) return emptyData();

        let result;
        try {
            result = normalize(JSON.parse(raw));
        } catch (err) {
            console.error('Saved data is corrupt and was ignored:', err);
            return emptyData();
        }

        // Migrate older records (no ids / older schema) once, in place.
        if (result.addedIds || result.db.schema_version !== SCHEMA_VERSION || result.skipped > 0) {
            try { persist(result.db); } catch (err) { /* read-only mode is still usable */ }
        }
        return result.db;
    }

    function persist(db) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        return db;
    }

    function save(db) {
        db.schema_version = SCHEMA_VERSION;
        db.last_updated = new Date().toISOString();
        try {
            persist(db);
        } catch (err) {
            console.error('Could not save data:', err);
            const quota = err && (err.name === 'QuotaExceededError' || err.code === 22);
            throw new Error(quota
                ? 'Storage is full. Export a backup and clear some entries.'
                : 'Could not save your data. Check that browser storage is enabled.');
        }
        return db;
    }

    function assertType(type) {
        if (TYPES.indexOf(type) === -1) throw new Error('Unknown entry type: ' + type);
    }

    // Writes always re-read storage first. A page holding a stale copy in memory
    // (e.g. it was open while another tab cleared or imported) would otherwise
    // write its old entries back and resurrect deleted data.
    function addEntry(type, entry) {
        assertType(type);
        const amount = parseFloat(entry.amount);
        if (!isValidDate(entry.date)) throw new Error('Please enter a valid date.');
        if (!isFinite(amount) || amount <= 0) throw new Error('Please enter an amount greater than zero.');

        const db = load();
        db[type + '_entries'].push({
            id: newId(),
            date: String(entry.date),
            amount: Math.round(amount * 100) / 100,
            notes: entry.notes ? String(entry.notes) : ''
        });
        return save(db);
    }

    // Delete by id so duplicate date/amount/notes rows stay distinguishable.
    function deleteEntry(type, id) {
        assertType(type);
        const db = load();
        const list = db[type + '_entries'];
        const i = list.findIndex(e => e.id === id);
        if (i > -1) {
            list.splice(i, 1);
            return save(db);
        }
        return db;
    }

    function updateSetting(key, value) {
        const db = load();
        const next = Object.assign({}, db.settings);
        next[key] = value;
        db.settings = normalizeSettings(next);
        return save(db);
    }

    // Notify open pages when another tab clears, imports, or edits data.
    function subscribe(callback) {
        global.addEventListener('storage', function (e) {
            // e.key is null when the whole store is wiped via localStorage.clear()
            if (e.key === STORAGE_KEY || e.key === null) callback(load());
        });
    }

    function clear() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) {
            console.error('Could not clear data:', err);
            throw new Error('Could not clear your data. Check that browser storage is enabled.');
        }
        return emptyData();
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    function exportToFile() {
        const db = load();
        const now = new Date();
        const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
        const payload = Object.assign({}, db, { exported_at: now.toISOString() });

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'owens-tracker-backup-' + stamp + '.json';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoking immediately can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        return counts(db);
    }

    // Returns {db, imported, skipped}. Throws if the file isn't a usable backup.
    function importFromJSON(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            throw new Error('That file is not valid JSON.');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('That backup is not in the expected format.');
        }
        const hasAnyList = TYPES.some(t => Array.isArray(parsed[t + '_entries']));
        if (!hasAnyList) throw new Error('That file contains no paycheck, spend or grocery entries.');

        const result = normalize(parsed);
        const total = TYPES.reduce((sum, t) => sum + result.db[t + '_entries'].length, 0);
        if (total === 0 && result.skipped > 0) {
            throw new Error('Every entry in that file was invalid, so nothing was imported.');
        }

        save(result.db);
        return { db: result.db, imported: total, skipped: result.skipped };
    }

    function counts(db) {
        return {
            income: db.income_entries.length,
            spend: db.spend_entries.length,
            grocery: db.grocery_entries.length,
            total: db.income_entries.length + db.spend_entries.length + db.grocery_entries.length
        };
    }

    function sum(list) {
        return list.reduce((total, e) => total + e.amount, 0);
    }

    // Every page derives its numbers from here so they cannot disagree.
    function summary(db) {
        const earned = sum(db.income_entries);
        const spent = sum(db.spend_entries);
        const grocery = sum(db.grocery_entries);
        const totalSpent = spent + grocery;
        const allowance = earned * (db.settings.spending_percentage / 100);
        const thisWeek = weekKey(new Date());

        return {
            earned: earned,
            spent: spent,
            grocery: grocery,
            totalSpent: totalSpent,
            allowance: allowance,
            remaining: allowance - totalSpent,
            saved: earned - allowance,
            groceryThisWeek: groceryThisWeek(db),
            groceryLeft: db.settings.weekly_grocery_limit - groceryThisWeek(db),
            thisWeekKey: thisWeek
        };
    }

    // The current calendar week's grocery total - not "whichever entry is last
    // in the list", which made a back-dated bill count as this week's.
    function groceryThisWeek(db) {
        const current = weekKey(new Date());
        return sum(db.grocery_entries.filter(e => weekKey(e.date) === current));
    }

    // Groups grocery entries into the last `count` calendar weeks, oldest first,
    // including weeks with no spending so the chart keeps a real time axis.
    function groceryByWeek(db, count) {
        const totals = {};
        db.grocery_entries.forEach(e => {
            const key = weekKey(e.date);
            if (key) totals[key] = (totals[key] || 0) + e.amount;
        });

        const weeks = [];
        const cursor = weekStart(new Date());
        for (let i = 0; i < count; i++) {
            const key = weekKey(cursor);
            weeks.unshift({
                key: key,
                label: i === 0 ? 'This Week' : (cursor.getMonth() + 1) + '/' + cursor.getDate(),
                total: totals[key] || 0
            });
            cursor.setDate(cursor.getDate() - 7);
        }
        return weeks;
    }

    function formatter(db) {
        const currency = (db.settings && db.settings.currency) || 'USD';
        try {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency });
        } catch (err) {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
        }
    }

    // Marks the sidebar link for the page you are on.
    function markActiveNav() {
        const here = location.pathname.split('/').pop() || 'dashboard.html';
        document.querySelectorAll('.sidebar-menu-item').forEach(link => {
            const target = link.getAttribute('href');
            link.classList.toggle('active', target === here);
        });
    }

    global.TrackerStore = {
        STORAGE_KEY: STORAGE_KEY,
        SCHEMA_VERSION: SCHEMA_VERSION,
        SUPPORTED_CURRENCIES: SUPPORTED_CURRENCIES,
        emptyData: emptyData,
        load: load,
        save: save,
        addEntry: addEntry,
        deleteEntry: deleteEntry,
        updateSetting: updateSetting,
        subscribe: subscribe,
        clear: clear,
        exportToFile: exportToFile,
        importFromJSON: importFromJSON,
        counts: counts,
        summary: summary,
        groceryByWeek: groceryByWeek,
        weekKey: weekKey,
        parseDate: parseDate,
        formatter: formatter,
        markActiveNav: markActiveNav
    };
})(window);
