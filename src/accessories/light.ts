import { HAPStatus, type API, type Characteristic, type Logging, type PlatformAccessory } from 'homebridge';
import { HTWebService, type HTLightStateResponse } from '../webservice.js';

export class HTLightAccessory {
  private log: Logging;
  private displayName: string;
  private onCharacteristic: Characteristic;
  private on = false;

  constructor(accessory: PlatformAccessory, log: Logging, api: API, webservice: HTWebService) {
    this.log = log;
    this.displayName = accessory.displayName;

    const { Service, Characteristic } = api.hap;

    const lightService = accessory.getService(Service.Lightbulb) ??
      accessory.addService(Service.Lightbulb, accessory.displayName);
    this.onCharacteristic = lightService.getCharacteristic(Characteristic.On);

    this.onCharacteristic.onGet(() => {
      this.log.info('Get light on state', this.displayName);
      (async () => {
        try {
          const response = await webservice.getLightState(accessory.context.device.id);
          this.updateValueByResponse(response);
        } catch (e) {
          this.log.error('Failed to get light on state:', e);
        }
      })();
      return this.on;
    }).onSet(async (value) => {
      this.log.info('Set light on state', this.displayName, value);
      try {
        const response = await webservice.putLightPower(accessory.context.device.id, value as boolean);
        this.updateValueByResponse(response);
      } catch (e) {
        this.log.error('Failed to set light on state:', e);
        throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  private updateValueByResponse(response: HTLightStateResponse) {
    this.on = response.data.statusList[0]?.value === 'on';
    this.log.debug('Update light on value', this.displayName, this.on);
    this.onCharacteristic.updateValue(this.on);
  }
}