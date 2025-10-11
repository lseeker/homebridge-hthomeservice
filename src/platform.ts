import {
  Categories, HAPStatus,
  type API, type Characteristic, type DynamicPlatformPlugin,
  type Logging, type PlatformAccessory, type PlatformConfig, type Service,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { HTWebService, type HTDevice } from './webservice.js';

const HTDeviceTypeToCateogory = {
  'heating': Categories.AIR_HEATER,
  'light': Categories.LIGHTBULB,
  'gas': Categories.SWITCH,
  'aircon': Categories.AIR_CONDITIONER,
  'wallsocket': Categories.OUTLET,
  'multi_switch': Categories.SWITCH,
  'fan': Categories.FAN,
  'elevator': Categories.SWITCH,
  'eventsender': Categories.SECURITY_SYSTEM,
};

interface HTDeviceContext {
  device: HTDevice
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class HTHomeServicePlugin implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly cachedAccessories = new Map<string, PlatformAccessory>();

  private webservice: HTWebService | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const { username, password } = config;
    if (!username || !password) {
      this.log.warn('Cannot start plugin, username and password are required in configuration');
      return;
    }

    this.log.debug('Create HT Web Service');
    this.webservice = new HTWebService(username, password, log);

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Execute didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    this.log.debug('Discover devices...');

    try {
      const response = await this.webservice?.getDevices();
      this.log.debug('Devices response: ', JSON.stringify(response));

      const newAccessories: PlatformAccessory<HTDeviceContext>[] = [];
      const updatedAccessories: PlatformAccessory<HTDeviceContext>[] = [];

      response?.data.deviceList.forEach((device) => {
        const uuid = this.api.hap.uuid.generate(`${device.deviceType}-${device.id}`);
        const exists = this.cachedAccessories.get(uuid) as PlatformAccessory<HTDeviceContext>;
        if (exists) {
          this.log.info('Found cached accessory:', exists.displayName, uuid, exists.category);
          exists.context.device = device;
          updatedAccessories.push(exists);
          this.cachedAccessories.delete(uuid);
        } else {
          const displayName = `${device.deviceLocation} ${device.deviceName}`;
          this.log.info('Adding new accessory:', displayName, uuid, device.deviceType);
          const accessory = new this.api.platformAccessory<HTDeviceContext>(displayName, uuid, HTDeviceTypeToCateogory[device.deviceType]);
          accessory.context.device = device;
          newAccessories.push(accessory);
        }
      });

      if (newAccessories.length > 0) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
      }
      if (updatedAccessories.length > 0) {
        this.api.updatePlatformAccessories(updatedAccessories);
      }
      if (this.cachedAccessories.size > 0) {
        const removedAccessories = [...this.cachedAccessories.values()];
        this.log.debug('Remove cached accessories:', removedAccessories);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removedAccessories);
        this.cachedAccessories.clear();
      }

      const discoveredAccessories = newAccessories.concat(updatedAccessories);
      this.log.info('Discovered accessories:', discoveredAccessories);

      discoveredAccessories.forEach((accessory) => {
        switch (accessory.category) {
        case Categories.LIGHTBULB: {
          const lightService = accessory.getService(this.Service.Lightbulb) ??
              accessory.addService(this.Service.Lightbulb, accessory.displayName);
          const onChar = lightService.getCharacteristic(this.Characteristic.On);
          onChar.onGet(async () => {
            this.log.debug('Get Light On State ', accessory.displayName);
            try {
              const response = await this.webservice!.getLightOnState(accessory.context.device.id);
              return response.data.statusList[0]?.value === 'on';
            } catch (e) {
              this.log.error('Failed to get light state: ', e);
              throw new this.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
          });
          onChar.onSet(async (value) => {
            this.log.debug('Set Light On State', accessory.displayName, value);
            try {
              await this.webservice!.putLightOnState(accessory.context.device.id, value as boolean);
            } catch (e) {
              this.log.error('Failed to set light state: ', e);
              throw new this.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
          });
          break;
        }
        case Categories.AIR_CONDITIONER:
        case Categories.AIR_HEATER:
        case Categories.FAN:
        case Categories.OUTLET:
        case Categories.SECURITY_SYSTEM:
        case Categories.SWITCH:
          break;
        }
      });

    } catch (e) {
      this.log.error('Failed to discover devices:' , e);
      throw new this.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
