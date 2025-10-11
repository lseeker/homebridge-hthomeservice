import { Mutex } from 'async-mutex';
import got, { type Got, type Options } from 'got';
import { type Logging } from 'homebridge';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';

const HTSECRET = 'hTsEcret';
const HTURL = 'https://www2.hthomeservice.com';

const mutex = new Mutex();

function encryptAES(text: string, secret: string) {
  const salt = randomBytes(8);
  const passinput = Buffer.concat([Buffer.from(secret, 'binary'), salt]);
  const hashes = [];
  let digest = passinput;
  for (let i = 0; i < 3; i++) {
    hashes[i] = createHash('md5').update(digest).digest();
    digest = Buffer.concat([hashes[i], passinput]);
  }
  const keyDerivation = Buffer.concat(hashes);
  const key = keyDerivation.subarray(0, 32);
  const iv = keyDerivation.subarray(32);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    Buffer.from('Salted__', 'utf8'),
    salt,
    cipher.update(text),
    cipher.final(),
  ]).toString('base64');
}

export interface HTDevice {
  id: string
  deviceType: 'heating' | 'light' | 'gas' | 'aircon' | 'wallsocket' | 'multi_switch' | 'fan' | 'elevator' | 'eventsender'
  deviceName: string
  deviceLocation: string
  state: 'NORMAL' | 'INIT'
  deviceDetailName: string
  statusList: []
}

export interface HTHouseholdResponse {
  resultCode: '100',
  resultMessage: string
  resultData: {
    danjiList: {
      siteId: string
      siteName: string
      dong: string
      ho: string
      isApproved: boolean
      homepageDomain: string
      siteAddress: string
    }[]
  }
}

export interface HTDevicesResponse {
  resultStatus: 'success'
  transactionId: string
  data: {
    deviceList: HTDevice[],
    totalCount: number
  }
}

export interface HTStateResponse {
  resultStatus: 'success'
  transactionId: string
}

export interface HTLightStateResponse extends HTStateResponse {
  data: {
    deviceType: 'light'
    statusList: [
      {
        command: 'power',
        value: 'on' | 'off'
      }
    ],
    deviceDetailName: string
    id: string
    state: 'NORMAL'
  }
}

export interface HTFanStateResponse extends HTStateResponse {
  data: {
    deviceType: 'fan'
    statusList: [
      {
        command: 'power',
        value: 'on' | 'off'
      },
      {
        command: 'wind',
        value: 'stop' | 'light' | 'mid' | 'pow'
      }
    ],
    deviceDetailName: string,
    id: string,
    state: 'NORMAL'
  }
}

export class HTWebService {
  private username: string;
  private password: string;
  private cookieJar = new CookieJar();
  private client: Got;
  private log: Logging;
  private expire: Date | null = null;

  constructor(username: string, password: string, log: Logging) {
    this.username = encryptAES(username, HTSECRET);
    this.password = encryptAES(password, HTSECRET);
    this.log = log;

    this.client = got.extend({
      prefixUrl: HTURL,
      cookieJar: this.cookieJar,
      hooks: {
        beforeRequest: [
          async (options) => {
            if (!options.context?.onAuthenticate) {
              // on current request, cookie not set by cookieJar. so set by ensure authenticate.
              await this.ensureAuthenticated(options);
            }
          },
        ],
        beforeError: [
          (error) => {
            if (error.response?.statusCode === 401) {
              this.log.warn('HTWS: Unauthorized after request, need to re-authenticate', error);
              this.expire = null;
            }
            return error;
          },
        ],
      },
    });
  }

  private async postLogin() {
    this.log.debug('HTWS: post login');
    return await this.client.post('login', {
      json: {
        id: this.username,
        password: this.password,
        rememberMe: false,
      },
      context: {
        onAuthenticate: true,
      },
    });
  }

  private async postCtocToken() {
    this.log.debug('HTWS: get household');
    const household = await this.client.get('proxy/bearer/api/v1/user/danji/household', {
      context: {
        onAuthenticate: true,
      },
    }).json<HTHouseholdResponse>();
    const [danji] = household.resultData.danjiList;
    if (!danji) {
      throw new Error('No household found for the user');
    }
    this.log.debug('HTWS: household result: ', JSON.stringify(household.resultData.danjiList));
    const response = await this.client.post('getctoctoken', {
      json: {
        siteId: danji.siteId,
        dong: danji.dong,
        ho: danji.ho,
        clientId: 'HT-WEB',
        uuid: '',
      },
      context: {
        onAuthenticate: true,
      },
    });
    this.updateExpireFromCookie();
    return response;
  }

  private updateExpireFromCookie() {
    const cookies = this.cookieJar.getCookiesSync(HTURL);
    const expire = cookies.filter((cookie) => cookie.key === 'connect.sid').map((cookie) => cookie.expires).at(0);
    this.log.info('HTWS: Session expire at', expire);
    if (expire === null || expire === undefined) {
      this.expire = null;
      return;
    }
    if (expire === 'Infinity') {
      this.expire = new Date('9999-12-31T23:59:59Z');
      return;
    }
    this.expire = expire;
  }

  private isExpired() {
    if (this.expire === null) {
      return true;
    }
    if (this.expire < new Date()) {
      return true;
    }
    return false;
  }

  private async ensureAuthenticated(options?: Options) {
    if (!this.isExpired()) {
      return;
    }

    await mutex.runExclusive(async () => {
      if (!this.isExpired()) {
        return true;
      }

      this.log.info('HTWS: Re-authenticating: expired at', this.expire);
      await this.postLogin();
      await this.postCtocToken();
    });
    await this.ensureAuthenticated();
    if (options) {
      options.headers.cookie = this.cookieJar.getCookieStringSync(HTURL);
    }
  }

  public getDevices() {
    this.log.debug('HTWS: get devices');
    return this.client.get('proxy/ctoc/devices').json<HTDevicesResponse>();
  }

  public getLightState(deviceId: string) {
    this.log.debug('HTWS: get light state', deviceId);
    return this.client.get(`proxy/ctoc/lights/${deviceId}`).json<HTLightStateResponse>();
  }

  public putLightPower(deviceId: string, power: boolean) {
    this.log.debug('HTWS: put light power', deviceId, power);
    return this.client.put(`proxy/ctoc/lights/${deviceId}`, {
      json: {
        commandList: [{
          command: 'power',
          value: power ? 'on' : 'off',
        }],
      },
    }).json<HTLightStateResponse>();
  }

  public getFanState(deviceId: string) {
    this.log.debug('HTWS: get fan state', deviceId);
    return this.client.get(`proxy/ctoc/fans/${deviceId}`).json<HTFanStateResponse>();
  }

  public putFanPower(deviceId: string, power: boolean) {
    this.log.debug('HTWS: put fan power', deviceId, power);
    return this.client.put(`proxy/ctoc/fans/${deviceId}`, {
      json: {
        commandList: [{
          command: 'power',
          value: power ? 'on' : 'off',
        }],
      },
    }).json<HTFanStateResponse>();
  }

  public putFanWind(deviceId: string, wind: 'light' | 'mid' | 'pow') {
    this.log.debug('HTWS: put fan wind', deviceId, wind);
    return this.client.put(`proxy/ctoc/fans/${deviceId}`, {
      json: {
        commandList: [{
          command: 'wind',
          value: wind,
        }],
      },
    }).json<HTFanStateResponse>();
  }
}
