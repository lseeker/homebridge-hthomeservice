import { Mutex } from 'async-mutex';
import { Characteristic, HAPStatus, type API, type Logging, type PlatformAccessory } from 'homebridge';
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
      try {
        const response = await webservice.putFanPower(this.deviceId, value === Characteristic.Active.ACTIVE);
        this.updateValueByResponse(response);
      } catch (e) {
        this.log.error('Failed to set air purifier active', e);
        throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
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
        try {
          this.targetStateCharacteristic.updateValue(value);
          await this.setRotationSpeed(this.rotationSpeedCharacteristic.value as number);
        } catch (e) {
          this.log.error('Failed to set air purifier target state', e);
          throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      }
    });

    this.rotationSpeedCharacteristic.onGet(() => {
      (async () => this.loadValues())();
      return this.rotationSpeedCharacteristic.value;
    }).onSet(async (value) => {
      try {
        this.log.info('Set air purifier rotation speed', this.displayName, value);
        await this.setRotationSpeed(value as number);
      } catch (e) {
        this.log.error('Failed to set air purifier rotation speed', e);
        throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  private async loadValues() {
    if (this.loading) {
      return;
    }
    const release = await mutex.acquire();
    try {
      if (this.loading) {
        return;
      }
      this.loading = true;
    } finally {
      release();
    }

    try {
      this.log.debug('Get air purifier state', this.displayName);
      const response = await this.webservice.getFanState(this.deviceId);
      this.updateValueByResponse(response);
    } catch (e) {
      this.log.error('Failed to get air purifier state', e);
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

    let newActiveValue = this.Characteristic.Active.INACTIVE;
    let newCurrentValue = this.Characteristic.CurrentAirPurifierState.INACTIVE;
    let newTargetValue = this.Characteristic.TargetAirPurifierState.MANUAL;
    let newRotationSpeedValue = 0;

    if (power === 'on') {
      newActiveValue = this.Characteristic.Active.ACTIVE;
      if (wind === 'stop') {
        newCurrentValue = this.Characteristic.CurrentAirPurifierState.IDLE;
      } else {
        newCurrentValue = this.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
      }
    } else {
      newActiveValue = this.Characteristic.Active.ACTIVE;
      newCurrentValue = this.Characteristic.CurrentAirPurifierState.INACTIVE;
    }

    switch (wind) {
    case 'stop':
      newRotationSpeedValue = 0;
      if (newActiveValue === this.Characteristic.Active.ACTIVE) {
        newTargetValue = this.Characteristic.TargetAirPurifierState.AUTO;
      }
      break;
    case 'light':
      newRotationSpeedValue = 30;
      break;
    case 'mid':
      newRotationSpeedValue = 60;
      break;
    case 'pow':
      newRotationSpeedValue = 100;
      break;
    }

    let didUpdate = false;

    if (this.activeCharacteristic.value !== newActiveValue) {
      this.activeCharacteristic.updateValue(newActiveValue);
      didUpdate = true;
    }

    if (this.targetStateCharacteristic.value !== newTargetValue) {
      this.targetStateCharacteristic.updateValue(newTargetValue);
      didUpdate = true;
    }

    if (this.currentStateCharacteristic.value !== newCurrentValue) {
      this.currentStateCharacteristic.updateValue(newCurrentValue);
      didUpdate = true;
    }
    
    if (this.rotationSpeedCharacteristic.value !== newRotationSpeedValue) {
      this.rotationSpeedCharacteristic.updateValue(newRotationSpeedValue);
      didUpdate = true;
    }

    if (didUpdate) {
      this.log.info('Updated air purifier values',
        this.displayName,
        this.activeCharacteristic.value,
        this.currentStateCharacteristic.value,
        this.targetStateCharacteristic.value,
        this.rotationSpeedCharacteristic.value);
    }
  }
}
