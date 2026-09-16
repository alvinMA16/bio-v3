import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
@Injectable()
export class SmsService {
  constructor(private readonly config: ConfigService) {}
  private setting(key: string, fallback = ''): string {
    return this.config.get<string>(key) || (key === 'ALIYUN_SMS_ACCESS_KEY_ID'
      ? this.config.get('ALIYUN_ACCESS_KEY_ID', '') : key === 'ALIYUN_SMS_ACCESS_KEY_SECRET'
      ? this.config.get('ALIYUN_ACCESS_KEY_SECRET', '') : fallback);
  }
  validate(): void {
    if (this.config.get('SMS_PROVIDER') === 'test' && this.config.get('NODE_ENV') === 'production') throw new Error('Test SMS is forbidden in production');
    if (this.config.get('SMS_PROVIDER') === 'test' && this.config.get('NODE_ENV') !== 'production') {
      if (!/^\d{6}$/.test(this.config.get('SMS_TEST_CODE', ''))) throw new Error('SMS_TEST_CODE must have six digits');
      return;
    }
    for (const key of ['ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_CODE']) {
      if (!this.setting(key)) throw new Error(`Missing ${key}`);
    }
  }
  async send(phone: string, code: string): Promise<void> {
    if (this.config.get('SMS_PROVIDER') === 'test' && this.config.get('NODE_ENV') !== 'production') return;
    // Ported from biography-v2/internal/provider/sms/aliyun/aliyun.go (ACS3).
    const template: Record<string, string> = { code, minute: '5', minutes: '5', time: '5', ttl: '5', ttl_minutes: '5' };
    template[this.setting('ALIYUN_SMS_TEMPLATE_PARAM_KEY', 'code')] = code;
    const params: Record<string, string> = { PhoneNumbers: phone, SignName: this.setting('ALIYUN_SMS_SIGN_NAME'),
      TemplateCode: this.setting('ALIYUN_SMS_TEMPLATE_CODE'), TemplateParam: JSON.stringify(template) };
    const canonical = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key]!)}`).join('&');
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const headers: Record<string, string> = { host: 'dysmsapi.aliyuncs.com', 'x-acs-action': 'SendSms',
      'x-acs-content-sha256': sha(''), 'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'x-acs-signature-nonce': randomUUID(), 'x-acs-version': '2017-05-25' };
    const keys = Object.keys(headers).sort(), signed = keys.join(';');
    const request = ['POST', '/', canonical, keys.map(key => `${key}:${headers[key]}\n`).join(''), signed, sha('')].join('\n');
    const signature = createHmac('sha256', this.setting('ALIYUN_SMS_ACCESS_KEY_SECRET')).update(`ACS3-HMAC-SHA256\n${sha(request)}`).digest('hex');
    headers.Authorization = `ACS3-HMAC-SHA256 Credential=${this.setting('ALIYUN_SMS_ACCESS_KEY_ID')},SignedHeaders=${signed},Signature=${signature}`;
    headers.Accept = 'application/json';
    try {
      const response = await fetch(`https://dysmsapi.aliyuncs.com/?${canonical}`, { method: 'POST', signal: AbortSignal.timeout(10000), headers });
      const result = await response.json() as { Code?: string };
      if (!response.ok || result.Code !== 'OK') throw new Error('SMS rejected');
    } catch { throw new ServiceUnavailableException('短信暂时无法发送，请稍后重试'); }
  }
}
