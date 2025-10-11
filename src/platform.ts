import {
  Categories,
  type API, type Characteristic, type DynamicPlatformPlugin,
  type Logging, type PlatformAccessory, type PlatformConfig, type Service,
} from 'homebridge';
import { HTDevice, HTWebService } from './webservice.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

// This is only required when using Custom Services and Characteristics not support by HomeKit
import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';

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
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // This is only required when using Custom Services and Characteristics not support by HomeKit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

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

    // This is only required when using Custom Services and Characteristics not support by HomeKit
    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

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
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    this.log.debug('Registering devices...');

    const removedAccessories = new Map(this.accessories);

    try {
      const devices = await this.webservice?.getDevices();
      this.log.debug('Devices: ', JSON.stringify(devices));

      devices?.data.deviceList.forEach((device) => {
        const uuid = this.api.hap.uuid.generate(`${device.deviceType}-${device.id}`);
        const exists = this.accessories.get(uuid);
        if (exists) {
          this.log.info('Found cached accessory:', exists.displayName, uuid, exists.category);
          exists.context.device = device;
          this.api.updatePlatformAccessories([exists]);
          removedAccessories.delete(uuid);
        } else {
          const displayName = `${device.deviceLocation} ${device.deviceName}`;
          this.log.info('Adding new accessory:', displayName, uuid, device.deviceType);
          const accessory = new this.api.platformAccessory<HTDeviceContext>(displayName, uuid, HTDeviceTypeToCateogory[device.deviceType]);
          accessory.context.device = device;
          this.accessories.set(uuid, accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      });

      if (removedAccessories.size === 0) {
        for (const uuid of removedAccessories.keys()) {
          this.accessories.delete(uuid);
        };
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [...removedAccessories.values()]);
      }

      this.log.debug('Registered accessories:', this.accessories);

      this.accessories.forEach((accessory) => {
        switch (accessory.category) {
        case Categories.LIGHTBULB: {
          const lightService = accessory.getService(this.Service.Lightbulb) ??
            accessory.addService(this.Service.Lightbulb, accessory.displayName);
          const onChar = lightService.getCharacteristic(this.Characteristic.On);
          onChar.onGet(async () => {
            this.log.debug('Get Light On State ', accessory.displayName);
            try {
              const state = await this.webservice?.getLightOnState(accessory.context.device.id);
              return state?.data.statusList[0]?.value === 'on';
            } catch (e) {
              this.log.error('Failed to get light state: ', e);
              return false;
            }
          });
          onChar.onSet(async (value) => {
            this.log.debug('Set Light On State', accessory.displayName, value);
            try {
              await this.webservice?.putLightOnState(accessory.context.device.id, value as boolean);
            } catch (e) {
              this.log.error('Failed to set light state: ', e);
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
      this.log.error('Failed to discover devices: ', e);
    }
  }
}
