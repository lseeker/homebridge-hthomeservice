import { HAPStatus, type API, type Characteristic, type Logging, type PlatformAccessory } from 'homebridge';
import { HTLightOnResponse, HTWebService } from '../webservice.js';

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
      this.log.info('Get Light On State', this.displayName);
      (async () => {
        try {
          const response = await webservice.getLightOnState(accessory.context.device.id);
          this.updateValueByResponse(response);
        } catch (e) {
          this.log.error('Failed to get light on state:', e);
        }
      })();
      return this.on;
    });
    this.onCharacteristic.onSet(async (value) => {
      this.log.info('Set Light On State', this.displayName, value);
      try {
        const response = await webservice.putLightOnState(accessory.context.device.id, value as boolean);
        this.updateValueByResponse(response);
      } catch (e) {
        this.log.error('Failed to set light on state:', e);
        throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  private updateValueByResponse(response: HTLightOnResponse) {
    this.on = response.data.statusList[0]?.value === 'on';
    this.log.debug('Update Light On value', this.displayName, this.on);
    this.onCharacteristic.updateValue(this.on);
  }
}