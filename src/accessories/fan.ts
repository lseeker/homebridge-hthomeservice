import { Mutex } from 'async-mutex';
import { Characteristic, type API, type Logging, type PlatformAccessory } from 'homebridge';
import { HTWebService, type HTFanStateResponse } from '../webservice.js';

const mutex = new Mutex();

export class HTFanAccessory {
  private log: Logging;
  private deviceId: string;
  private displayName: string;
  private webservice: HTWebService;
  private Characteristic: typeof Characteristic;

  private activeCharacteristic: Characteristic;
  private currentStateCharacteristic: Characteristic;
  private targetStateCharacteristic: Characteristic;
  private rotationSpeedCharacteristic: Characteristic;

  private active;
  private currentState;
  private targetState;
  private rotationSpeed;

  private loading = false;

  constructor(accessory: PlatformAccessory, log: Logging, api: API, webservice: HTWebService) {
    this.log = log;
    this.deviceId = accessory.context.device.id;
    this.displayName = accessory.displayName;
    this.webservice = webservice;

    const { Service, Characteristic } = api.hap;

    this.Characteristic = Characteristic;
    this.active = Characteristic.Active.INACTIVE;
    this.currentState = Characteristic.CurrentAirPurifierState.INACTIVE;
    this.targetState = Characteristic.TargetAirPurifierState.MANUAL;
    this.rotationSpeed = 0;

    const airPurifierService = accessory.getService(Service.AirPurifier) ??
      accessory.addService(Service.AirPurifier, accessory.displayName);
    this.activeCharacteristic = airPurifierService.getCharacteristic(Characteristic.Active);
    this.currentStateCharacteristic = airPurifierService.getCharacteristic(Characteristic.CurrentAirPurifierState);
    this.targetStateCharacteristic = airPurifierService.getCharacteristic(Characteristic.TargetAirPurifierState);
    this.rotationSpeedCharacteristic = airPurifierService.getCharacteristic(Characteristic.RotationSpeed);

    this.activeCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.active;
    }).onSet(async (value) => {
      this.log.info('Set air purifier active', this.displayName, value);
      this.targetState = Characteristic.TargetAirPurifierState.MANUAL;
      const response = await webservice.putFanPower(this.deviceId, value === Characteristic.Active.ACTIVE);
      this.updateValueByResponse(response);
    });

    this.currentStateCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.currentState;
    });

    this.targetStateCharacteristic.onGet(() => {
      return this.targetState;
    }).onSet(async (value) => {
      this.log.info('Set air purifier target state', this.displayName, value);
      if (value === Characteristic.TargetAirPurifierState.AUTO) {
        // const response = await webservice.putFanWind(this.deviceId, 'auto');
        // this.updateValueByResponse(response);
      } else {
        this.targetState = value as number;
        await this.setRotationSpeed(this.rotationSpeed);
      }
    });

    this.rotationSpeedCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.rotationSpeed;
    }).onSet(async (value) => {
      this.log.info('Set air purifier rotation speed', this.displayName, value);
      await this.setRotationSpeed(value as number);
    });
  }

  private async loadValues() {
    if (this.loading) {
      return;
    }
    try {
      await mutex.acquire();
      if (this.loading) {
        return;
      }
      this.loading = true;
    } finally {
      mutex.release();
    }

    try {
      this.log.info('Get air purifier state', this.displayName);
      const response = await this.webservice.getFanState(this.deviceId);
      this.updateValueByResponse(response);
    } catch (e) {
      this.log.error('Failed to get air purifier state:', e);
    } finally {
      this.loading = false;
    }
  }

  private async setRotationSpeed(value: number) {
    let wind: 'light' | 'mid' | 'pow' = 'pow';
    if (value <= 40) {
      wind = 'light';
    } else if (value <= 80) {
      wind = 'mid';
    }
    const response = await this.webservice.putFanWind(this.deviceId, wind);
    this.updateValueByResponse(response);
  }

  private updateValueByResponse(response: HTFanStateResponse) {
    const power = response.data.statusList.find((status) => status.command === 'power')?.value ?? 'off';
    const wind = response.data.statusList.find((status) => status.command === 'wind')?.value ?? 'stop';

    if (power === 'on') {
      this.active = this.Characteristic.Active.ACTIVE;
      if (wind === 'stop') {
        this.currentState = this.Characteristic.CurrentAirPurifierState.IDLE;
      } else {
        this.currentState = this.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
      }
    } else {
      this.active = this.Characteristic.Active.INACTIVE;
      this.currentState = this.Characteristic.CurrentAirPurifierState.INACTIVE;
    }

    switch (wind) {
    case 'stop':
      this.rotationSpeed = 0;
      this.targetState = this.Characteristic.TargetAirPurifierState.AUTO;
      break;
    case 'light':
      this.rotationSpeed = 30;
      break;
    case 'mid':
      this.rotationSpeed = 60;
      break;
    case 'pow':
      this.rotationSpeed = 100;
      break;
    }

    this.log.debug('Update air purifier values', this.displayName, this.active, this.currentState, this.targetState, this.rotationSpeed);

    this.activeCharacteristic.updateValue(this.active);
    this.currentStateCharacteristic.updateValue(this.currentState);
    this.targetStateCharacteristic.updateValue(this.targetState);
    this.rotationSpeedCharacteristic.updateValue(this.rotationSpeed);
  }
}