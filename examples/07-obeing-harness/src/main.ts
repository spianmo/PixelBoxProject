import { CatMotion, clamp } from '../../06-obeing-pixel/src/model';
import { fullscreenAt } from '../../06-obeing-pixel/src/render';
import { layoutPoint } from '../../06-obeing-pixel/src/layout';
import { EnterpriseAuth, validateOrigin } from './auth';
import { MexusConversation } from './conversation';
import { defaultServer, HarnessController, userMessage, type SpeechPort } from './controller';
import { projectSpeechConfig } from './project-config';
import { LocalAuthStore } from './persistence';
import { drawHarness, keyboardKeyAt, type Field, type FormState, type Page } from './render';

const info = px.system.info();
const defaults = defaultServer(info.deviceId);
const bundledSpeech = projectSpeechConfig();
const saved = (key: string, fallback: string) => {
    const value = px.storage.kv.get(key);
    return typeof value === 'string' ? value : fallback;
};
const form: FormState = {
    page: 'login', returnPage: 'login', field: 'tenant', upper: true, symbols: false, busy: false, speechReady: false,
    values: { tenant: saved('h.tenant', ''), account: saved('h.account', ''), password: '',
        region: bundledSpeech?.region ?? saved('h.region', ''), key: bundledSpeech?.key ?? '',
        origin: saved('h.origin', defaults.origin), oem: saved('h.oem', ''), domain: saved('h.domain', ''), question: '' },
};
const speech: SpeechPort = px.speech;
let authStore: LocalAuthStore;
let controller = createController();
let restorePending = Boolean(controller.auth.current());
let running = true;
let fullscreen = false;
const motion = new CatMotion();
let clock = 0;
let lastActivity = px.system.now();
let tiltX = 0;
let tiltY = 0;
let targetX = 0;
let targetY = 0;
let shakeUntil = 0;
let battery = px.system.battery().level;
// TLS 证书校验依赖正确系统时间；NTP 自身已有 15 秒有界超时。
let clockSync: Promise<void> = px.system.ntpSync('pool.ntp.org').catch(() => { /* 登录前检查同步结果 */ });
let loginEpoch = 0;

function createController(): HarnessController {
    let origin = form.values.origin;
    try { origin = validateOrigin(origin); } catch { origin = defaults.origin; form.values.origin = origin; }
    const server = { ...defaults, origin, oem: form.values.oem, domain: form.values.domain };
    authStore = new LocalAuthStore(px.storage.kv, server);
    form.values.password = authStore.password(form.values.tenant, form.values.account);
    const auth = new EnterpriseAuth(server, fetch, () => Date.now(), authStore);
    const cached = auth.current();
    if (cached && (cached.tenantCode !== form.values.tenant.toUpperCase() || cached.userCode !== form.values.account.toUpperCase())) auth.clear();
    const result = new HarnessController(auth, new MexusConversation(auth), speech, () => px.wifi.status().connected);
    result.view.theme = saved('h.theme', 'dark') === 'light' ? 'light' : 'dark';
    // 工程配置优先；只有工程未同时提供 region/key 时，才采用本次运行在 PixelBox 输入的值。
    const speechConfig = bundledSpeech ?? (form.values.region && form.values.key
        ? { region: form.values.region, key: form.values.key } : null);
    if (speechConfig) {
        try { result.configureSpeech(speechConfig); }
        catch (error) { result.view.errorText = userMessage(error, '工程语音配置不可用'); }
    }
    return result;
}

function showPage(page: Page, resumeWake = true): void {
    if (page !== 'assistant') fullscreen = false;
    form.page = page;
    controller.setPaused(page !== 'assistant');
    if (page === 'assistant' && resumeWake) void controller.standby();
}

function edit(field: Field, from: Page): void {
    if (form.busy) return;
    form.field = field;
    form.returnPage = from;
    showPage('editor');
    form.symbols = false;
    form.upper = field === 'tenant' || field === 'account';
}

function editKey(key: string): void {
    if (key === 'shift') { form.upper = !form.upper; return; }
    if (key === 'symbols') { form.symbols = !form.symbols; return; }
    if (key === 'delete') { form.values[form.field] = form.values[form.field].slice(0, -1); return; }
    if (key === 'done') {
        showPage(form.returnPage, form.field !== 'question');
        if (form.field === 'question') {
            const value = form.values.question;
            form.values.question = '';
            showPage('assistant', false);
            void controller.sendText(value);
        }
        return;
    }
    const char = key === 'space' ? ' ' : key;
    const limit = form.field === 'tenant' || form.field === 'account' ? 6 : form.field === 'question' ? 2000 : form.field === 'key' ? 256 : 128;
    if (form.values[form.field].length < limit) form.values[form.field] += char;
}

async function submitLogin(): Promise<void> {
    if (form.busy) return;
    restorePending = false;
    const epoch = ++loginEpoch;
    form.busy = true;
    const active = controller;
    const password = form.values.password;
    try { authStore.remember(form.values.tenant, form.values.account, password); }
    catch { form.busy = false; active.view.errorText = '密码保存失败，请重试'; return; }
    await clockSync;
    if (!running || controller !== active || epoch !== loginEpoch) return;
    if (Date.now() < 1704067200000) {
        form.busy = false;
        active.view.errorText = '设备时间未同步，请检查 Wi-Fi 后重试';
        clockSync = px.system.ntpSync('pool.ntp.org').catch(() => {});
        return;
    }
    await active.login(form.values.tenant, form.values.account, password);
    if (!running || controller !== active || epoch !== loginEpoch) return;
    form.busy = false;
    if (active.view.authenticated) {
        px.storage.kv.set('h.tenant', form.values.tenant.toUpperCase());
        px.storage.kv.set('h.account', form.values.account.toUpperCase());
        showPage(active.hasSpeech() ? 'assistant' : 'speech');
    }
}

async function restoreLogin(): Promise<void> {
    if (!running || !restorePending || form.busy || !px.wifi.status().connected) return;
    const epoch = ++loginEpoch;
    const active = controller;
    form.busy = true;
    await clockSync;
    if (!running || controller !== active || epoch !== loginEpoch) return;
    if (Date.now() < 1704067200000) {
        form.busy = false;
        active.view.errorText = '设备时间未同步，正在重试';
        clockSync = px.system.ntpSync('pool.ntp.org').catch(() => {});
        return;
    }
    await active.restore();
    if (!running || controller !== active || epoch !== loginEpoch) return;
    // Expired/revoked sessions can reauthenticate with the remembered password.
    // Explicit logout clears the saved session, so it never enters this path.
    if (!active.view.authenticated && !active.auth.current() && form.values.password && px.wifi.status().connected) {
        await active.login(form.values.tenant, form.values.account, form.values.password);
    }
    if (!running || controller !== active || epoch !== loginEpoch) return;
    form.busy = false;
    if (active.view.authenticated) {
        restorePending = false;
        showPage(active.hasSpeech() ? 'assistant' : 'speech');
    } else restorePending = Boolean(active.auth.current());
}

function saveForm(): void {
    try {
        if (form.page === 'speech') {
            controller.configureSpeech({ region: form.values.region, key: form.values.key });
            px.storage.kv.set('h.region', form.values.region);
            form.speechReady = true;
            showPage(controller.view.authenticated ? 'assistant' : 'login');
        } else if (form.page === 'server') {
            form.values.origin = validateOrigin(form.values.origin);
            controller.dispose();
            for (const field of ['origin', 'oem', 'domain'] as Field[]) px.storage.kv.set('h.' + field, form.values[field]);
            controller = createController();
            restorePending = false;
            showPage('login');
        }
    } catch (error) { controller.view.errorText = userMessage(error, '设置未保存'); }
}

function theme(): void {
    controller.view.theme = controller.view.theme === 'dark' ? 'light' : 'dark';
    px.storage.kv.set('h.theme', controller.view.theme);
}

const unsubTouch = px.input.onTouch((touch) => {
    if (touch.type !== 'down') return;
    const event = layoutPoint(px.screen, touch.x, touch.y);
    lastActivity = px.system.now();
    if (form.page === 'assistant') {
        if (fullscreenAt(event.x, event.y, event.width)) { fullscreen = !fullscreen; return; }
        if (fullscreen) { if (event.y >= 42) void controller.listen(); return; }
        if (event.y >= 35 && event.y < 74) {
            if (event.x >= event.width - 52) { showPage('settings'); return; }
            if (event.x >= event.width - 90) { theme(); return; }
            if (event.x >= event.width - 132) { controller.toggleMute(); return; }
        }
        void controller.listen();
        return;
    }
    if (event.y >= 36 && event.y < 79) {
        if (event.x > event.width - 67) { theme(); return; }
        if (event.x < 62) {
            if (form.page === 'editor') { showPage(form.returnPage); return; }
            if (form.busy) { loginEpoch++; restorePending = false; controller.logout(); form.busy = false; }
            showPage(controller.view.authenticated ? 'assistant' : 'login');
            return;
        }
    }
    if (form.page === 'editor') { const key = keyboardKeyAt(form, event.x, event.y, event.width); if (key) editKey(key); return; }
    if (form.page === 'settings') {
        if (event.y >= 159 && event.y < 216) showPage('speech');
        else if (event.y < 273 && event.y >= 216) showPage('server');
        else if (event.y < 330 && event.y >= 273) {
            if (controller.view.authenticated) edit('question', 'assistant'); else showPage('login');
        }
        else if (event.y >= 330 && event.y < 395 && controller.view.authenticated) {
            controller.logout();
            restorePending = false;
            form.values.question = '';
            showPage('login');
        }
        return;
    }
    const fields: Field[] = form.page === 'login' ? ['tenant', 'account', 'password']
        : form.page === 'speech' ? ['region', 'key'] : ['origin', 'oem', 'domain'];
    for (let i = 0; i < fields.length; i++) if (event.y >= 94 + i * 65 && event.y < 153 + i * 65) { edit(fields[i], form.page); return; }
    const actionY = form.page === 'speech' ? 252 : 314;
    if (event.y >= actionY && event.y < actionY + 44) {
        if (form.page === 'login') void submitLogin(); else saveForm();
    } else if (form.page === 'login' && event.y >= 405) showPage('server');
});

const unsubButton = px.input.onButton((event) => {
    if (event.id !== 'boot') return;
    lastActivity = px.system.now();
    if (event.type === 'click' && controller.view.authenticated) { showPage('assistant', false); void controller.listen(); }
    else if (event.type === 'doubleClick') controller.toggleMute();
    else if (event.type === 'longPress') {
        if (form.busy) { loginEpoch++; restorePending = false; form.busy = false; controller.logout(); } else controller.cancel();
        showPage('settings');
    }
});
const unsubOffline = px.wifi.on('disconnected', () => controller.networkChanged(false));
const unsubOnline = px.wifi.on('gotIp', () => {
    if (Date.now() < 1704067200000) clockSync = px.system.ntpSync('pool.ntp.org').catch(() => {});
    controller.networkChanged(true);
    void restoreLogin();
});
void restoreLogin();

if (px.sensors.imu.available()) px.sensors.imu.start({ rateHz: 50, onData(data) {
    if (Math.abs(data.ax + targetX) + Math.abs(data.ay - targetY) > 0.35) shakeUntil = px.system.now() + 180;
    targetX = clamp(-data.ax, -1, 1); targetY = clamp(data.ay, -1, 1);
} });
px.screen.setFps(24);
px.screen.onFrame((dt) => {
    if (!running) return;
    const step = Math.max(0, dt);
    clock += step;
    tiltX = targetX; tiltY = targetY;
    if (controller.view.state === 'idle' && px.system.now() - lastActivity > 45000) controller.view.state = 'sleep';
    if (!controller.view.authenticated && form.page === 'assistant') showPage('login');
    form.speechReady = controller.hasSpeech();
    drawHarness(px.screen, controller.view, { clock, tiltX, tiltY, battery, settings: false, fullscreen, shake: px.system.now() < shakeUntil ? 1 : 0,
        pose: motion.sample(controller.view.state, clock, tiltX, tiltY, controller.view.level) }, form);
});
const batteryTimer = setInterval(() => { battery = px.system.battery().level; void restoreLogin(); }, 10000);
px.app.onExit(() => {
    running = false;
    loginEpoch++;
    controller.dispose();
    form.values.password = ''; form.values.key = ''; form.values.question = '';
    clearInterval(batteryTimer);
    unsubTouch(); unsubButton(); unsubOffline(); unsubOnline();
    if (px.sensors.imu.available()) px.sensors.imu.stop();
});
