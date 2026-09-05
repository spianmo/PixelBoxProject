import type { SpeechConfig } from './controller';

/**
 * 示例工程随包下发的 Azure Speech 配置。
 *
 * 两项同时有效时，应用启动即使用本配置，不要求用户在 PixelBox 上输入；任一项为空时，
 * 视为本地开发构建，登录后回退到设备语音配置页。密钥会被编译进 main.js 和设备固件包，
 * 只能放置允许随示例分发的 Azure 资源密钥。
 */
export const PROJECT_SPEECH_CONFIG: Readonly<SpeechConfig> = {
    region: 'eastasia',
    key: '',
};

/** 只接受完整的工程配置，禁止拿半份配置绕过 PixelBox 的本地输入回退。 */
export function projectSpeechConfig(config: Readonly<SpeechConfig> = PROJECT_SPEECH_CONFIG): SpeechConfig | null {
    const region = config.region.trim();
    const key = config.key.trim();
    if (!region || !key) return null;
    return { region, key, language: config.language, voice: config.voice };
}
