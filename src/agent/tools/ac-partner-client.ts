/**
 * 小米空调伴侣 (cuco.acpartner.cp6) miio + MIOT 客户端
 *
 * 基于 home.miot-spec.com/spec/cuco.acpartner.cp6：
 *   - air-conditioner 服务：siid=3, piid=1 (bool) 控制空调红外开关
 *   - air-condition-outlet 服务：siid=2, piid=1 (bool) 控制插座本身（一般保持开）
 *
 * 复用 gosund-plug-client 中实现的 MiioSession（同样的 miio 二进制协议）。
 */

import { MiioSession } from './gosund-plug-client';

const TOKEN_RE = /^[0-9a-fA-F]{32}$/;

/**
 * MIOT 属性定义（cuco.acpartner.cp6）
 * 参考：https://home.miot-spec.com/spec/cuco.acpartner.cp6
 */
/** 空调红外开关 */
export const AC_POWER_SIID = 3;
export const AC_POWER_PIID = 1;
/** 空调模式：0=制冷, 1=制热, 2=自动, 3=送风, 4=除湿 */
export const AC_MODE_SIID = 3;
export const AC_MODE_PIID = 2;
/** 设定温度（uint16, 16~30, 步长 1） */
export const AC_TARGET_TEMP_SIID = 3;
export const AC_TARGET_TEMP_PIID = 4;
/** 风机档位：0=Auto, 1=低, 2=中, 3=高 */
export const AC_FAN_LEVEL_SIID = 4;
export const AC_FAN_LEVEL_PIID = 2;

/** 设备插座开关（保留备用） */
export const OUTLET_POWER_SIID = 2;
export const OUTLET_POWER_PIID = 1;

export type AcMode = 'cool' | 'heat' | 'auto' | 'fan' | 'dehumidify';
export type AcFanLevel = 'auto' | 'low' | 'medium' | 'high';

export const AC_MODE_VALUE: Record<AcMode, number> = {
  cool: 0,
  heat: 1,
  auto: 2,
  fan: 3,
  dehumidify: 4,
};
export const AC_MODE_FROM_VALUE: Record<number, AcMode> = {
  0: 'cool',
  1: 'heat',
  2: 'auto',
  3: 'fan',
  4: 'dehumidify',
};

export const AC_FAN_LEVEL_VALUE: Record<AcFanLevel, number> = {
  auto: 0,
  low: 1,
  medium: 2,
  high: 3,
};
export const AC_FAN_LEVEL_FROM_VALUE: Record<number, AcFanLevel> = {
  0: 'auto',
  1: 'low',
  2: 'medium',
  3: 'high',
};

export const AC_TEMP_MIN = 16;
export const AC_TEMP_MAX = 30;

export interface AcPartnerOptions {
  timeoutMs?: number;
}

export interface AcState {
  on: boolean;
  mode: AcMode;
  targetTemperature: number;
  fanLevel: AcFanLevel;
}

export class AcPartner {
  readonly ip: string;
  private readonly session: MiioSession;

  constructor(ip: string, tokenHex: string, options: AcPartnerOptions = {}) {
    if (!TOKEN_RE.test(tokenHex)) {
      throw new Error('token must be a 32-char hex string');
    }
    this.ip = ip;
    this.session = new MiioSession(ip, Buffer.from(tokenHex, 'hex'), options);
  }

  private async miot(
    method: 'get_properties' | 'set_properties',
    params: unknown,
  ): Promise<any> {
    const payload = JSON.stringify({ id: 1, method, params });
    const replyBuf = await this.session.send(payload);
    const text = replyBuf.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from device: ${text}`);
    }
  }

  /** 读空调开关状态（true=开机）。 */
  async status(): Promise<boolean> {
    const resp = await this.miot('get_properties', [
      { siid: AC_POWER_SIID, piid: AC_POWER_PIID },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to read ac power: ${JSON.stringify(resp)}`);
    }
    return Boolean(result.value);
  }

  async setPower(value: boolean): Promise<void> {
    const resp = await this.miot('set_properties', [
      { siid: AC_POWER_SIID, piid: AC_POWER_PIID, value: Boolean(value) },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to set ac power: ${JSON.stringify(resp)}`);
    }
  }

  on(): Promise<void> {
    return this.setPower(true);
  }

  off(): Promise<void> {
    return this.setPower(false);
  }

  async toggle(): Promise<boolean> {
    const cur = await this.status();
    await this.setPower(!cur);
    return !cur;
  }

  // ---------------- 模式 / 温度 / 风速 ----------------

  async getMode(): Promise<AcMode> {
    const resp = await this.miot('get_properties', [
      { siid: AC_MODE_SIID, piid: AC_MODE_PIID },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to read ac mode: ${JSON.stringify(resp)}`);
    }
    const mode = AC_MODE_FROM_VALUE[Number(result.value)];
    if (!mode) throw new Error(`Unknown ac mode value: ${result.value}`);
    return mode;
  }

  async setMode(mode: AcMode): Promise<void> {
    const value = AC_MODE_VALUE[mode];
    if (value === undefined) throw new Error(`Unknown ac mode: ${mode}`);
    const resp = await this.miot('set_properties', [
      { siid: AC_MODE_SIID, piid: AC_MODE_PIID, value },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to set ac mode: ${JSON.stringify(resp)}`);
    }
  }

  async getTargetTemperature(): Promise<number> {
    const resp = await this.miot('get_properties', [
      { siid: AC_TARGET_TEMP_SIID, piid: AC_TARGET_TEMP_PIID },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to read ac temperature: ${JSON.stringify(resp)}`);
    }
    return Number(result.value);
  }

  async setTargetTemperature(value: number): Promise<number> {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid temperature: ${value}`);
    }
    const target = Math.round(value);
    if (target < AC_TEMP_MIN || target > AC_TEMP_MAX) {
      throw new Error(
        `Temperature out of range [${AC_TEMP_MIN}, ${AC_TEMP_MAX}]: ${target}`,
      );
    }
    const resp = await this.miot('set_properties', [
      { siid: AC_TARGET_TEMP_SIID, piid: AC_TARGET_TEMP_PIID, value: target },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to set ac temperature: ${JSON.stringify(resp)}`);
    }
    return target;
  }

  async adjustTargetTemperature(delta: number): Promise<number> {
    const cur = await this.getTargetTemperature();
    const next = Math.min(AC_TEMP_MAX, Math.max(AC_TEMP_MIN, cur + Math.round(delta)));
    if (next === cur) return cur;
    return this.setTargetTemperature(next);
  }

  async getFanLevel(): Promise<AcFanLevel> {
    const resp = await this.miot('get_properties', [
      { siid: AC_FAN_LEVEL_SIID, piid: AC_FAN_LEVEL_PIID },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to read fan level: ${JSON.stringify(resp)}`);
    }
    const level = AC_FAN_LEVEL_FROM_VALUE[Number(result.value)];
    if (!level) throw new Error(`Unknown fan-level value: ${result.value}`);
    return level;
  }

  async setFanLevel(level: AcFanLevel): Promise<void> {
    const value = AC_FAN_LEVEL_VALUE[level];
    if (value === undefined) throw new Error(`Unknown fan level: ${level}`);
    const resp = await this.miot('set_properties', [
      { siid: AC_FAN_LEVEL_SIID, piid: AC_FAN_LEVEL_PIID, value },
    ]);
    const result = resp?.result?.[0];
    if (!result || result.code !== 0) {
      throw new Error(`Failed to set fan level: ${JSON.stringify(resp)}`);
    }
  }

  /** 一次性读取所有空调状态（开关 / 模式 / 温度 / 风速）。 */
  async getState(): Promise<AcState> {
    const resp = await this.miot('get_properties', [
      { siid: AC_POWER_SIID, piid: AC_POWER_PIID },
      { siid: AC_MODE_SIID, piid: AC_MODE_PIID },
      { siid: AC_TARGET_TEMP_SIID, piid: AC_TARGET_TEMP_PIID },
      { siid: AC_FAN_LEVEL_SIID, piid: AC_FAN_LEVEL_PIID },
    ]);
    const results = resp?.result;
    if (!Array.isArray(results) || results.length < 4) {
      throw new Error(`Failed to read ac state: ${JSON.stringify(resp)}`);
    }
    const [powerR, modeR, tempR, fanR] = results;
    return {
      on: Boolean(powerR?.value),
      mode: AC_MODE_FROM_VALUE[Number(modeR?.value)] ?? 'auto',
      targetTemperature: Number(tempR?.value) || AC_TEMP_MIN,
      fanLevel: AC_FAN_LEVEL_FROM_VALUE[Number(fanR?.value)] ?? 'auto',
    };
  }

  close(): void {
    this.session.close();
  }
}
