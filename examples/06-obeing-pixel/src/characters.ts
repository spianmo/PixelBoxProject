export const CHARACTERS = ['cat', 'kitty-classic', 'kitty-witch', 'kitty-fish', 'kitty-scarf'] as const;
export type Character = typeof CHARACTERS[number];
export type KittyCharacter = Exclude<Character, 'cat'>;

export function readCharacter(value: unknown): Character {
    return CHARACTERS.includes(value as Character) ? value as Character : 'cat';
}

export function nextCharacter(character: Character): Character {
    return CHARACTERS[(CHARACTERS.indexOf(character) + 1) % CHARACTERS.length];
}

export const CHARACTER_HOLD_MS = 700;

// 触摸没有原生 longPress：按下时暂存短按，满 700ms 换装，松开才执行短按。
// 定时器独立于绘制，音频背压跳帧时仍能识别；移动超过 12 个布局像素取消本次手势。
export class CharacterTouch {
    private press?: { x: number; y: number; at: number; cancelled: boolean; held: boolean };
    private timer?: ReturnType<typeof setTimeout>;

    constructor(private readonly now: () => number, private readonly active: () => boolean,
        private readonly tap: () => void, private readonly hold: () => void) {}

    handle(event: PxTouchEvent, hit: boolean): boolean {
        if (event.type === 'down') {
            this.cancel();
            if (!hit || !this.active()) return false;
            this.press = { x: event.x, y: event.y, at: this.now(), cancelled: false, held: false };
            this.timer = setTimeout(() => { this.timer = undefined; this.fire(); }, CHARACTER_HOLD_MS);
            return true;
        }
        const press = this.press;
        if (!press) return false;
        if (!this.active() || Math.hypot(event.x - press.x, event.y - press.y) > 12) {
            press.cancelled = true;
            this.clearTimer();
        }
        if (event.type === 'up') {
            // JS 繁忙导致定时器未及时执行时，使用真实经过时间补判，不能误变成语音短按。
            if (this.now() - press.at >= CHARACTER_HOLD_MS) this.fire();
            const tapped = !press.cancelled && !press.held;
            this.cancel();
            if (tapped) this.tap();
        }
        return true;
    }

    private fire(): void {
        const press = this.press;
        if (!press || press.cancelled || press.held || !this.active()) return;
        press.held = true;
        this.hold();
    }

    private clearTimer(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }

    cancel(): void { this.clearTimer(); this.press = undefined; }
}
