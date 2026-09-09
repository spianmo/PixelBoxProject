import type { SpeechConfig } from './controller';

/**
 * 示例工程的 Azure Speech 默认配置，仓库中保持密钥为空。
 *
 * 登录后在 PixelBox 语音配置页输入区域和密钥，密钥只保留在本次运行内存。
 * 两项同时有效时会在启动时自动配置，并将密钥编译进 main.js 和设备应用包；
 * 不要将真实密钥写入源码并提交到 Git。
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
