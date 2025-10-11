import got, { type Got } from 'got';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { Mutex } from 'async-mutex';
import { type Logging } from 'homebridge';

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
  deviceType: 'heating'|'light'|'gas'|'aircon'|'wallsocket'|'multi_switch'|'fan'|'elevator'|'eventsender'
  deviceName: string
  deviceLocation: string
  state: 'NORMAL'|'INIT'
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

export interface HTLightOnResponse {
  resultStatus: 'success'
  transactionId: string
  data: {
    deviceType: 'light'
    statusList: [
      {
        command: 'power',
        value: 'on'|'off'
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
    this.username = encryptAES( username, HTSECRET);
    this.password = encryptAES(password, HTSECRET);
    this.log = log;

    this.client = got.extend({
      prefixUrl: HTURL,
      cookieJar: this.cookieJar,
      hooks: {
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
    this.log.info('HTWS: post login');
    return await this.client.post('login', { 
      json: {
        id: this.username,
        password: this.password,
        rememberMe: false,
      },
    });
  }

  private async postCtocToken() {
    this.log.info('HTWS: get household');
    const household = await this.client.get('proxy/bearer/api/v1/user/danji/household').json<HTHouseholdResponse>();
    const [danji] = household.resultData.danjiList;
    if (!danji) {
      throw new Error('No household found for the user');
    }
    this.log.debug('household result: ', JSON.stringify(household.resultData.danjiList));
    const response = await this.client.post('getctoctoken', { json:
       {
         siteId: danji.siteId,
         dong: danji.dong,
         ho: danji.ho,
         clientId: 'HT-WEB',
         uuid: '',
       },
    });
    this.updateExpireFromCookie();
    return response;
  }

  private updateExpireFromCookie() {
    const cookies = this.cookieJar.getCookiesSync(HTURL);
    const expire = cookies.filter((cookie) => cookie.key === 'connect.sid').map((cookie) => cookie.expires).at(0);
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

  private async ensureAuthenticated() {
    if (!this.isExpired()) {
      return;
    }

    await mutex.runExclusive(async () => {
      if (!this.isExpired()) {
        return true;
      }

      this.log.info('HTWS: Re-authenticating: expired at ', this.expire);
      await this.postLogin();
      await this.postCtocToken();
    });
    await this.ensureAuthenticated();
  }

  public async getDevices() {
    this.log.info('HTWS: get devices');
    await this.ensureAuthenticated();
    return await this.client.get('proxy/ctoc/devices').json<HTDevicesResponse>();
  }

  public async getLightOnState(deviceId: string) {
    this.log.info('HTWS: get light state', deviceId);
    await this.ensureAuthenticated();
    const response = await this.client.get(`proxy/ctoc/lights/${deviceId}`).json<HTLightOnResponse>();
    return response;
  }

  public async putLightOnState(deviceId: string, on: boolean) {
    this.log.info('HTWS: put light state', deviceId, on);
    await this.ensureAuthenticated();
    const response = await this.client.put(`proxy/ctoc/lights/${deviceId}`, { json: {
      commandList: [ {
        command: 'power',
        value: on ? 'on' : 'off',
      } ],
    },
    }).json<HTLightOnResponse>();
    return response.data.statusList[0].value === 'on';
  }
}
