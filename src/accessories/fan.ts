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

  private loading = false;

  constructor(accessory: PlatformAccessory, log: Logging, api: API, webservice: HTWebService) {
    this.log = log;
    this.deviceId = accessory.context.device.id;
    this.displayName = accessory.displayName;
    this.webservice = webservice;

    const { Service, Characteristic } = api.hap;

    this.Characteristic = Characteristic;

    const airPurifierService = accessory.getService(Service.AirPurifier) ??
      accessory.addService(Service.AirPurifier, accessory.displayName);
    this.activeCharacteristic = airPurifierService.getCharacteristic(Characteristic.Active)
      .updateValue(Characteristic.Active.INACTIVE);
    this.currentStateCharacteristic = airPurifierService.getCharacteristic(Characteristic.CurrentAirPurifierState)
      .updateValue(Characteristic.CurrentAirPurifierState.INACTIVE);
    this.targetStateCharacteristic = airPurifierService.getCharacteristic(Characteristic.TargetAirPurifierState)
      .updateValue(Characteristic.TargetAirPurifierState.MANUAL);
    this.rotationSpeedCharacteristic = airPurifierService.getCharacteristic(Characteristic.RotationSpeed)
      .updateValue(0).setProps({
        validValues: [0, 30, 60, 100],
      });

    this.activeCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.activeCharacteristic.value;
    }).onSet(async (value) => {
      this.log.info('Set air purifier active', this.displayName, value);
      this.targetStateCharacteristic.updateValue(Characteristic.TargetAirPurifierState.MANUAL);
      const response = await webservice.putFanPower(this.deviceId, value === Characteristic.Active.ACTIVE);
      this.updateValueByResponse(response);
    });

    this.currentStateCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.currentStateCharacteristic.value;
    });

    this.targetStateCharacteristic.onGet(() => {
      return this.targetStateCharacteristic.value;
    }).onSet(async (value) => {
      this.log.info('Set air purifier target state', this.displayName, value);
      if (value === Characteristic.TargetAirPurifierState.AUTO) {
        // const response = await webservice.putFanWind(this.deviceId, 'auto');
        // this.updateValueByResponse(response);
      } else {
        this.targetStateCharacteristic.updateValue(value);
        await this.setRotationSpeed(this.rotationSpeedCharacteristic.value as number);
      }
    });

    this.rotationSpeedCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.rotationSpeedCharacteristic.value;
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
      this.activeCharacteristic.updateValue(this.Characteristic.Active.ACTIVE);
      if (wind === 'stop') {
        this.currentStateCharacteristic.updateValue(this.Characteristic.CurrentAirPurifierState.IDLE);
      } else {
        this.currentStateCharacteristic.updateValue(this.Characteristic.CurrentAirPurifierState.PURIFYING_AIR);
      }
    } else {
      this.activeCharacteristic.updateValue(this.Characteristic.Active.INACTIVE);
      this.currentStateCharacteristic.updateValue(this.Characteristic.CurrentAirPurifierState.INACTIVE);
    }

    switch (wind) {
    case 'stop':
      this.rotationSpeedCharacteristic.updateValue(0);
      if (this.activeCharacteristic.value === this.Characteristic.Active.ACTIVE) {
        this.targetStateCharacteristic.updateValue(this.Characteristic.TargetAirPurifierState.AUTO);
      }
      break;
    case 'light':
      this.rotationSpeedCharacteristic.updateValue(30);
      break;
    case 'mid':
      this.rotationSpeedCharacteristic.updateValue(60);
      break;
    case 'pow':
      this.rotationSpeedCharacteristic.updateValue(100);
      break;
    }

    this.log.debug('Updated air purifier values',
      this.displayName,
      this.activeCharacteristic.value,
      this.currentStateCharacteristic.value,
      this.targetStateCharacteristic.value,
      this.rotationSpeedCharacteristic.value);
  }
}