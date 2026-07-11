const util = require("util");
const emitter = require("events").EventEmitter;
const MAGIC = require("./magic");
const Airtouch2API = require("./api");
var Accessory, Service, Characteristic, UUIDGen, FakeGatoHistoryService;
var CustomCharacteristic = {};

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;
    FakeGatoHistoryService = require("fakegato-history")(homebridge);

    // AC Spill Custom Characteristic
    // ES class: Characteristic is a class in modern hap-nodejs and cannot be Function.call'd
    CustomCharacteristic.SpillStatus = class extends Characteristic {
        constructor() {
            super("Spill Active", "154c4ebb-a16f-488b-8968-2e5bbe15809d", {
                format: "bool",
                perms: ["pr", "ev"],
            });
            this.value = this.getDefaultValue();
        }
    };
    CustomCharacteristic.SpillStatus.UUID = "154c4ebb-a16f-488b-8968-2e5bbe15809d";

    // AC Timer Custom Characteristic
    CustomCharacteristic.TimerStatus = class extends Characteristic {
        constructor() {
            super("Timer Set", "2f9bfcd0-00ff-481a-873c-188a2e93d316", {
                format: "bool",
                perms: ["pr", "ev"],
            });
            this.value = this.getDefaultValue();
        }
    };
    CustomCharacteristic.TimerStatus.UUID = "2f9bfcd0-00ff-481a-873c-188a2e93d316";

    // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
    homebridge.registerPlatform("homebridge-Airtouch2plus-platform", "Airtouch2", Airtouch2, true);
};

//
// Airtouch2 platform
// Homebridge platform which creates accessories for AC units and AC zones
// Handles communication with the Airtouch2 Touchpad Controller using the Airtouch2 API
//
function Airtouch2(log, config, api) {
    this.log = log;
    this.config = config;
    this.platform = api;

    // initialize accessory lists
    this.units = {};
    this.zones = {};
    this.thermostats = {};

    // set up callbacks from API
    util.inherits(Airtouch2API, emitter);
    this.api = new Airtouch2API(log);
    this.api.on("ac_status", (ac_status) => {
        this.onACStatusNotification(ac_status);
    });
    this.api.on("groups_status", (group_status) => {
        this.onGroupsStatusNotification(group_status);
    });
    // will try to reconnect on api error - worried this might end up causing a loop..
    this.api.on("attempt_reconnect", () => {
        this.api.connect(config.ip_address);
    });

    // Connect only after homebridge has restored cached accessories -
    // status messages arriving before configureAccessory() runs would
    // re-create (duplicate) accessories that are already in the cache.
    this.platform.on("didFinishLaunching", () => {
        this.api.connect(config.ip_address);
    });
};

// configure cached accessories
Airtouch2.prototype.configureAccessory = function(accessory) {
    this.log("Trying to configure [" + accessory.displayName + "] from cache...");

    if (accessory.displayName in this.units || accessory.displayName in this.zones) {
        this.log("[" + accessory.displayName + "] is already configured");
        return;
    }

    accessory.reacheable = false;
    accessory.log = this.log;
    accessory.api = this.api;

    // Identify cached accessories by their services rather than display-name
    // prefixes: unit_names/zone_names give accessories arbitrary names, and an
    // unclaimed cache entry gets re-registered as a duplicate on every restart.
    if (accessory.getService(Service.Thermostat)) {
        this.setupACAccessory(accessory);
        this.units[accessory.displayName] = accessory;
    } else if (accessory.getService(Service.Switch) || accessory.getService(Service.Fanv2)) {
        // If the cached accessory doesn't match the configured zone_control
        // style, drop it so it gets recreated in the right style.
        let wantFan = this.config.zone_control === "fan";
        let isFan = accessory.getService(Service.Fanv2) !== undefined;
        if (wantFan !== isFan) {
            this.log("[" + accessory.displayName + "] cached with a different zone_control style, recreating...");
            this.platform.unregisterPlatformAccessories("homebridge-airtouch2plus-platform", "Airtouch2", [accessory]);
            return;
        }
        if (isFan)
            this.setupZoneFanAccessory(accessory);
        else
            this.setupZoneAccessory(accessory);
        this.zones[accessory.displayName] = accessory;
    }

    this.log("[" + accessory.displayName + "] was restored from cache and should be reachable");
};

// callback for AC messages received from Airtouch2 Touchpad Controller
Airtouch2.prototype.onACStatusNotification = function(ac_status) {
    ac_status.forEach(unit_status => {
        unit_name = (this.config.unit_names || {})[unit_status.ac_unit_number] || ("AC " + unit_status.ac_unit_number);
        this.log("Received status update for [" + unit_name + "]: " + JSON.stringify(unit_status));
        // check if accessory exists
        if (!(unit_name in this.units)) {
            this.log("[" + unit_name + "] was not found, creating as new AC accessory...");
            let uuid = UUIDGen.generate(unit_name);
            let unit = new Accessory(unit_name, uuid);
            unit.log = this.log;
            unit.api = this.api;
            unit.context.manufacturer = this.config.units[unit_status.ac_unit_number].manufacturer || "N/A";
            unit.context.model = this.config.units[unit_status.ac_unit_number].model || "N/A";
            unit.context.serial = unit_status.ac_unit_number;
            this.setupACAccessory(unit);
            this.units[unit_name] = unit;
            this.platform.registerPlatformAccessories("homebridge-airtouch2plus-platform", "Airtouch2", [unit]);
        }
        // update accessory
        this.updateACAccessory(this.units[unit_name], unit_status);
    });
};

// callback for Group messages received from Airtouch2 Touchpad Controller
Airtouch2.prototype.onGroupsStatusNotification = function(groups_status) {
    groups_status.forEach(zone_status => {
        zone_name = (this.config.zone_names || {})[zone_status.group_number] || ("Zone " + zone_status.group_number);
        this.log("Received status update for [" + zone_name + "]: " + JSON.stringify(zone_status));
        // check if accessory exists
        if (!(zone_name in this.zones)) {
            this.log("[" + zone_name + "] was not found, creating as new Zone accessory...");
            let uuid = UUIDGen.generate(zone_name);
            let zone = new Accessory(zone_name, uuid);
            zone.log = this.log;
            zone.api = this.api;
            zone.context.manufacturer = "Polyaire";
            zone.context.model = "Quick Fix Damper";
            zone.context.serial = zone_status.group_number;
            if (this.config.zone_control === "fan")
                this.setupZoneFanAccessory(zone);
            else
                this.setupZoneAccessory(zone);
            this.zones[zone_name] = zone;
            this.platform.registerPlatformAccessories("homebridge-airtouch2plus-platform", "Airtouch2", [zone]);
        }
        // update accessory
        this.updateZoneAccessory(this.zones[zone_name], zone_status);
    });
};

// setup AC accessory callbacks
Airtouch2.prototype.setupACAccessory = function(accessory) {
    accessory.on('identify', (paired, cb) => {
        this.log(accessory.displayName, " identified");
        cb();
    });

    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, accessory.context.manufacturer)
        .setCharacteristic(Characteristic.Model, accessory.context.model)
        .setCharacteristic(Characteristic.SerialNumber, "AT2-" + accessory.context.serial);

    let thermostat = accessory.getService(Service.Thermostat);
    if (thermostat === undefined)
        thermostat = accessory.addService(Service.Thermostat, accessory.displayName);

    thermostat
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .on("get", function(cb){ return cb(null, this.context.currentHeatingCoolingState); }.bind(accessory));

    thermostat
        .getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on("get", function(cb){ return cb(null, this.context.targetHeatingCoolingState); }.bind(accessory))
        .on("set", this.acSetTargetHeatingCoolingState.bind(accessory));

    thermostat
        .getCharacteristic(Characteristic.CurrentTemperature)
        .on("get", function(cb){ return cb(null, this.context.currentTemperature); }.bind(accessory));

    thermostat
        .getCharacteristic(Characteristic.TargetTemperature)
        .setProps({
            minStep: 1.0,
            minValue: 14.0,
            maxValue: 29.0})
        .on("get", function(cb){ return cb(null, this.context.targetTemperature); }.bind(accessory))
        .on("set", this.acSetTargetTemperature.bind(accessory));

    accessory.context.temperatureDisplayUnits = 0; // defaults to Celsius
    thermostat
        .getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .on("get", function(cb){ return cb(null, this.context.temperatureDisplayUnits); }.bind(accessory))
        .on("set", function(val, cb){ this.context.temperatureDisplayUnits = val; cb(); }.bind(accessory));

    thermostat
        .getCharacteristic(Characteristic.Name)
        .on("get", function(cb){ return cb(null, this.displayName); }.bind(accessory));

    accessory.context.fan_speeds = this.config.units[accessory.context.serial].fan;
    accessory.context.rotation_step = Math.floor(100/(Object.keys(accessory.context.fan_speeds).length-1));
    let fan = thermostat.getCharacteristic(Characteristic.RotationSpeed);
    if (fan === undefined)
        fan = thermostat.addCharacteristic(Characteristic.RotationSpeed);
    fan.setProps({
            minStep: accessory.context.rotation_step,
            minValue: 0,
            maxValue: accessory.context.rotation_step*(Object.keys(accessory.context.fan_speeds).length-1)})
        .on("get", function(cb){ return cb(null, this.context.rotationSpeed); }.bind(accessory))
        .on("set", this.acSetRotationSpeed.bind(accessory));

    let statusFault = thermostat.getCharacteristic(Characteristic.StatusFault);
    if (statusFault === undefined)
        statusFault = thermostat.addCharacteristic(Characteristic.StatusFault);
    statusFault
        .on("get", function(cb){ return cb(null, this.context.statusFault); }.bind(accessory));

    let spillStatus = thermostat.getCharacteristic(CustomCharacteristic.SpillStatus);
    if (spillStatus === undefined)
        spillStatus = thermostat.addCharacteristic(CustomCharacteristic.SpillStatus);
    spillStatus
        .on("get", function(cb){ return cb(null, this.context.spillStatus); }.bind(accessory));

    let timerStatus = thermostat.getCharacteristic(CustomCharacteristic.TimerStatus);
    if (timerStatus === undefined)
        timerStatus = thermostat.addCharacteristic(CustomCharacteristic.TimerStatus);
    timerStatus
        .on("get", function(cb){ return cb(null, this.context.timerStatus); }.bind(accessory));

    thermostat.isPrimaryService = true;

    // Global fan speed as its own fan service: the RotationSpeed characteristic
    // on the thermostat is nonstandard and the Home app never displays it.
    // Speed is exposed as N notches (1..fan_speeds.length), not a raw percent.
    let acfan = accessory.getService(Service.Fanv2);
    if (acfan === undefined)
        acfan = accessory.addService(Service.Fanv2, accessory.displayName + " Fan");

    acfan
        .getCharacteristic(Characteristic.Active)
        .on("get", function(cb){ return cb(null, this.context.currentHeatingCoolingState != 0 ? 1 : 0); }.bind(accessory))
        .on("set", this.acFanSetActive.bind(accessory));

    acfan
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
            minStep: 1,
            minValue: 0,
            maxValue: accessory.context.fan_speeds.length})
        .on("get", function(cb){ return cb(null, (this.context.rotationSpeed / this.context.rotation_step) + 1); }.bind(accessory))
        .on("set", this.acFanSetSpeedLevel.bind(accessory));

    thermostat.addLinkedService(acfan);

    accessory.historyService = new FakeGatoHistoryService("thermo", accessory, { storage: "fs" });
    accessory.historyUpdate = 0;

    this.log("Finished creating accessory [" + accessory.displayName + "]");
};

// update AC accessory data
Airtouch2.prototype.updateACAccessory = function(accessory, status) {
    let thermostat = accessory.getService(Service.Thermostat);

    // CurrentHeatingCoolingState only allows OFF(0)/HEAT(1)/COOL(2) - AUTO(3) is
    // valid only for the target state, and an out-of-range value makes iOS show
    // the accessory as unresponsive.
    if (status.ac_power_state == 0) // OFF
        accessory.context.currentHeatingCoolingState = 0;
    else if (status.ac_mode == 1 || status.ac_mode == 8) // HEAT, AUTO-HEAT
        accessory.context.currentHeatingCoolingState = 1;
    else if (status.ac_mode == 4 || status.ac_mode == 9 || status.ac_mode == 2) // COOL, AUTO-COOL, DRY
        accessory.context.currentHeatingCoolingState = 2;
    else if (status.ac_mode == 3) // FAN shows as idle
        accessory.context.currentHeatingCoolingState = 0;
    else // AUTO before the unit picks a direction
        accessory.context.currentHeatingCoolingState = 1;
    thermostat.setCharacteristic(Characteristic.CurrentHeatingCoolingState, accessory.context.currentHeatingCoolingState);

    if (status.ac_power_state == 0) // OFF
        accessory.context.targetHeatingCoolingState = 0;
    else if (status.ac_mode == 1) // HEAT
        accessory.context.targetHeatingCoolingState = 1;
    else if (status.ac_mode == 4) // COOL
        accessory.context.targetHeatingCoolingState = 2;
    else // AUTO/DRY/FAN/AUTO-HEAT/AUTO-COOL
        accessory.context.targetHeatingCoolingState = 3;
    thermostat.setCharacteristic(Characteristic.TargetHeatingCoolingState, accessory.context.targetHeatingCoolingState);

    accessory.context.currentTemperature = status.ac_temp;
    thermostat.setCharacteristic(Characteristic.CurrentTemperature, accessory.context.currentTemperature);

    accessory.context.targetTemperature = status.ac_target;
    thermostat.setCharacteristic(Characteristic.TargetTemperature, accessory.context.targetTemperature);

    // convert AC fan speed number in AC fan speed string (e.g. 4 => High)
    let fan_speed = Object.keys(MAGIC.AT2_AC_FAN_SPEEDS).find(key => MAGIC.AT2_AC_FAN_SPEEDS[key] === status.ac_fan_speed);
    // convert AC fan speed string into homebridge fan rotation % (e.g. High => 99%) using the config array
    accessory.context.rotationSpeed = accessory.context.fan_speeds.indexOf(fan_speed) * accessory.context.rotation_step;
    thermostat.setCharacteristic(Characteristic.RotationSpeed, accessory.context.rotationSpeed);

    let acfan = accessory.getService(Service.Fanv2);
    if (acfan !== undefined) {
        acfan.setCharacteristic(Characteristic.Active, accessory.context.currentHeatingCoolingState != 0 ? 1 : 0);
        acfan.setCharacteristic(Characteristic.RotationSpeed, (accessory.context.rotationSpeed / accessory.context.rotation_step) + 1);
    }

    // save history as Eve Thermo
    let now = new Date().getTime() / 1000;
    if (now - accessory.historyUpdate > 285) { // 285s = 4.75 min update intervals
        accessory.historyService.addEntry({
            time: now,
            currentTemp: accessory.context.currentTemperature,
            setTemp: accessory.context.targetTemperature,
            valvePosition: accessory.context.rotationSpeed
        });
        accessory.historyUpdate = now;
    }

    accessory.context.statusFault = status.ac_error_code;
    thermostat.setCharacteristic(Characteristic.StatusFault, accessory.context.statusFault);

    accessory.context.spillStatus = !!status.ac_spill;
    thermostat.setCharacteristic(CustomCharacteristic.SpillStatus, accessory.context.spillStatus);

    accessory.context.timerStatus = !!status.ac_timer_set;
    thermostat.setCharacteristic(CustomCharacteristic.TimerStatus, accessory.context.timerStatus);

    accessory.updateReachability(true);
    this.log("Finished updating accessory [" + accessory.displayName + "]");
};

// setup Zone accessory as a fan (zone on/off = fan active, damper % = rotation speed)
Airtouch2.prototype.setupZoneFanAccessory = function(accessory) {
    accessory.on('identify', (paired, cb) => {
        this.log(accessory.displayName, " identified");
        cb();
    });

    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, accessory.context.manufacturer)
        .setCharacteristic(Characteristic.Model, accessory.context.model)
        .setCharacteristic(Characteristic.SerialNumber, "AT2-" + accessory.context.serial);

    let fan = accessory.getService(Service.Fanv2);
    if (fan === undefined)
        fan = accessory.addService(Service.Fanv2, accessory.displayName);

    fan
        .getCharacteristic(Characteristic.Active)
        .on("get", function(cb){ return cb(null, this.context.active ? 1 : 0); }.bind(accessory))
        .on("set", this.zoneSetActive.bind(accessory));

    fan
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
            minStep: 5,
            minValue: 0,
            maxValue: 100})
        .on("get", function(cb){ return cb(null, this.context.damperPosition || 0); }.bind(accessory))
        .on("set", this.zoneSetRotationSpeed.bind(accessory));

    fan
        .getCharacteristic(Characteristic.Name)
        .on("get", function(cb){ return cb(null, this.displayName); }.bind(accessory));

    fan.isPrimaryService = true;

    this.log("Finished creating accessory [" + accessory.displayName + "]");
};

// setup Zone accessory callbacks
Airtouch2.prototype.setupZoneAccessory = function(accessory) {
    accessory.on('identify', (paired, cb) => {
        this.log(accessory.displayName, " identified");
        cb();
    });

    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, accessory.context.manufacturer)
        .setCharacteristic(Characteristic.Model, accessory.context.model)
        .setCharacteristic(Characteristic.SerialNumber, "AT2-" + accessory.context.serial);

    let zone = accessory.getService(Service.Switch);
    if (zone === undefined)
        zone = accessory.addService(Service.Switch, accessory.displayName);

    zone
        .getCharacteristic(Characteristic.On)
        .on("get", function(cb){ return cb(null, this.context.active); }.bind(accessory))
        .on("set", this.zoneSetActive.bind(accessory));

    zone
        .getCharacteristic(Characteristic.Name)
        .on("get", function(cb){ return cb(null, this.displayName); }.bind(accessory));

    zone.isPrimaryService = true;

    let damper = accessory.getService(Service.Window);
    if (damper === undefined)
        damper = accessory.addService(Service.Window, accessory.displayName + " Damper");

    damper
        .getCharacteristic(Characteristic.CurrentPosition)
        .on("get", function(cb){ return cb(null, this.context.damperPosition); }.bind(accessory));

    damper
        .getCharacteristic(Characteristic.TargetPosition)
        .setProps({
            minStep: 5,
            minValue: 0,
            maxValue: 100})
        .on("get", function(cb){ return cb(null, this.context.targetPosition); }.bind(accessory))
        .on("set", this.zoneSetDamperPosition.bind(accessory));

    damper
        .getCharacteristic(Characteristic.PositionState)
        .on("get", function(cb){ return cb(null, 2); }.bind(accessory)); // show status as STOPPED, don't track intermediary movements

    damper
        .getCharacteristic(Characteristic.Name)
        .on("get", function(cb){ return cb(null, this.displayName + " Damper"); }.bind(accessory));

    zone.addLinkedService(damper);

    //let sensor = accessory.getService(Service.TemperatureSensor);
    //if (sensor === undefined)
    //  sensor = accessory.addService(Service.TemperatureSensor, accessory.displayName + " Sensor");

    //sensor
    //  .getCharacteristic(Characteristic.CurrentTemperature)
    //  .on("get", function(cb){ return cb(null, this.context.currentTemperature); }.bind(accessory));

    //sensor
    //  .getCharacteristic(Characteristic.StatusLowBattery)
    //  .on("get", function(cb){ return cb(null, this.context.sensorLowBattery); }.bind(accessory));

    //sensor.setHiddenService(true);
    //zone.addLinkedService(sensor);

    //accessory.historyService = new FakeGatoHistoryService("room", accessory, { storage: "fs" });

    this.log("Finished creating accessory [" + accessory.displayName + "]");
};

// update Zone accessory data
Airtouch2.prototype.updateZoneAccessory = function(accessory, status) {
    accessory.context.active = status.group_power_state % 2;
    accessory.context.damperPosition = status.group_damper_position;

    let fan = accessory.getService(Service.Fanv2);
    if (fan !== undefined) {
        fan.setCharacteristic(Characteristic.Active, accessory.context.active);
        fan.setCharacteristic(Characteristic.RotationSpeed, accessory.context.damperPosition);
        accessory.updateReachability(true);
        this.log("Finished updating accessory [" + accessory.displayName + "]");
        return;
    }

    let zone = accessory.getService(Service.Switch);
    let damper = accessory.getService(Service.Window);
//  let sensor = accessory.getService(Service.TemperatureSensor);

    zone.setCharacteristic(Characteristic.On, !!accessory.context.active);

    //accessory.context.controlType = status.group_control_type;
    // when using temperature control, set the damper as obstructed
    //damper.setCharacteristic(Characteristic.ObstructionDetected, accessory.context.controlType);

    damper.setCharacteristic(Characteristic.CurrentPosition, accessory.context.damperPosition);
    damper.setCharacteristic(Characteristic.TargetPosition, accessory.context.damperPosition);

    //if (status.group_has_sensor) {
    //  if (sensor.isHiddenService)
    //      sensor.setHiddenService(false);

    //  accessory.context.currentTemperature = status.group_temp;
    //  sensor.setCharacteristic(Characteristic.CurrentTemperature, accessory.context.currentTemperature);

    //  accessory.context.sensorLowBattery = status.group_battery_low;
    //  sensor.setCharacteristic(Characteristic.StatusLowBattery, accessory.context.sensorLowBattery);

        // save history as Eve Light Switch
    //  accessory.historyService.addEntry({
    //      time: new Date().getTime() / 1000,
    //      temp: accessory.context.currentTemperature,
    //      status: accessory.context.active
    //  });

    //  // update thermostat accessory
    //  thermo_name = accessory.displayName + " Thermostat";
    //  this.log("Updating [" + thermo_name + "]");
    //  // check if accessory exists
    //  if (!(thermo_name in this.thermostats)) {
    //      this.log("[" + thermo_name + "] was not found, creating as new Thermostat accessory...");
    //      let uuid = UUIDGen.generate(thermo_name);
    //      let thermo = new Accessory(thermo_name, uuid);
    //      thermo.log = this.log;
    //      thermo.api = this.api;
    //      thermo.context.manufacturer = "Polyaire";
    //      thermo.context.model = "Temperature Control Thermostat";
    //      thermo.context.serial = status.group_number;
    //      this.setupThermoAccessory(thermo);
    //      this.thermostats[thermo_name] = thermo;
    //      this.platform.registerPlatformAccessories("homebridge-Airtouch2plus-platform", "Airtouch2", [thermo]);
    //  }
    //  // update accessory
    //  this.updateThermoAccessory(this.thermostats[thermo_name], status);

    //  // show temperature in the AC accessory
    //  let ac = Object.entries(this.units)[0][1]; // get "AC 0"
    //  let ac_sensor = ac.getService(accessory.displayName); // get sensor "Zone <N>" from ac
    //  if (this.config["ac_include_temps"] == true) {
    //      if (ac_sensor === undefined)
    //          ac.addService(Service.TemperatureSensor, accessory.displayName, accessory.displayName);
    //      ac_sensor.setCharacteristic(Characteristic.CurrentTemperature, accessory.context.currentTemperature);
    //  } else {
    //      ac.removeService(ac_sensor);
    //  }
    // }

    accessory.updateReachability(true);
    this.log("Finished updating accessory [" + accessory.displayName + "]");
};

// // setup Thermo accessory callbacks
// Airtouch2.prototype.setupThermoAccessory = function(accessory) {
//  accessory.on('identify', (paired, cb) => {
//      this.log(accessory.displayName, " identified");
//      cb();
//  });

//  accessory.getService(Service.AccessoryInformation)
//      .setCharacteristic(Characteristic.Manufacturer, accessory.context.manufacturer)
//      .setCharacteristic(Characteristic.Model, accessory.context.model)
//      .setCharacteristic(Characteristic.SerialNumber, "AT2-" + accessory.context.serial);

//  let thermo = accessory.getService(Service.Thermostat);
//  if (thermo === undefined)
//      thermo = accessory.addService(Service.Thermostat, accessory.displayName);

//  thermo
//      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
//      .on("get", function(cb){ return cb(null, this.context.currentHeatingCoolingState); }.bind(accessory));

//  thermo
//      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
//      .setProps({
//          minStep: 3,
//          minValue: 0,
//          maxValue: 3,
//          validValues: [0, 3]})
//      .on("get", function(cb){ return cb(null, this.context.active ? 3 : 0); }.bind(accessory))
//      .on("set", this.thermoSetActive.bind(accessory));

//  thermo
//      .getCharacteristic(Characteristic.CurrentTemperature)
//      .on("get", function(cb){ return cb(null, this.context.currentTemperature); }.bind(accessory));

//  thermo
//      .getCharacteristic(Characteristic.TargetTemperature)
//      .setProps({
//          minStep: 1.0,
//          minValue: 14.0,
//          maxValue: 29.0})
//      .on("get", function(cb){ return cb(null, this.context.targetTemperature); }.bind(accessory))
//      .on("set", this.thermoSetTargetTemperature.bind(accessory));

//  accessory.context.temperatureDisplayUnits = 0; // defaults to Celsius
//  thermo
//      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
//      .on("get", function(cb){ return cb(null, this.context.temperatureDisplayUnits); }.bind(accessory))
//      .on("set", function(val, cb){ this.context.temperatureDisplayUnits = val; cb(); }.bind(accessory));

//  thermo
//      .getCharacteristic(Characteristic.Name)
//      .on("get", function(cb){ return cb(null, this.displayName); }.bind(accessory));

//  thermo.isPrimaryService = true;

//  //accessory.historyService = new FakeGatoHistoryService("room", accessory, { storage: "fs" });

//  this.log("Finished creating accessory [" + accessory.displayName + "]");
// };

// // update Thermo accessory data
// Airtouch2.prototype.updateThermoAccessory = function(accessory, status) {
//  let thermo = accessory.getService(Service.Thermostat);

//  accessory.context.active = status.group_has_sensor && status.group_control_type;
//  thermo.setCharacteristic(Characteristic.TargetHeatingCoolingState, accessory.context.active * 3);

//  let ac = Object.entries(this.units)[0][1];
//  accessory.context.currentHeatingCoolingState = accessory.context.active * ac.getService(Service.Thermostat).getCharacteristic(Characteristic.CurrentHeatingCoolingState).value;
//  thermo.setCharacteristic(Characteristic.CurrentHeatingCoolingState, accessory.context.currentHeatingCoolingState);

//  accessory.context.currentTemperature = status.group_temp;
//  thermo.setCharacteristic(Characteristic.CurrentTemperature, accessory.context.currentTemperature);

//  accessory.context.targetTemperature = status.group_target;
//  thermo.setCharacteristic(Characteristic.TargetTemperature, accessory.context.targetTemperature);

//  // save history as Eve Room
//  //accessory.historyService.addEntry({
//  //  time: new Date().getTime() / 1000,
//  //  temp: accessory.context.currentTemperature
//  //});

//  accessory.updateReachability(true);
//  this.log("Finished updating accessory [" + accessory.displayName + "]");
// };


/* ----------------------------------------------------------------------------------------------------- */

/* AC accessory function */

Airtouch2.prototype.acSetTargetHeatingCoolingState = function(val, cb) {
    if (this.context.targetHeatingCoolingState != val) {
        this.context.targetHeatingCoolingState = val;
        if (this.context.currentHeatingCoolingState != val)
            this.api.acSetCurrentHeatingCoolingState(this.context.serial, val);
    }
    cb();
};

Airtouch2.prototype.acSetTargetTemperature = function(val, cb) {
    if (this.context.targetTemperature != val) {
        this.context.targetTemperature = val;
        this.api.acSetTargetTemperature(this.context.serial, val);
    }
    cb();
};

// fan service: active follows/toggles AC power
Airtouch2.prototype.acFanSetActive = function(val, cb) {
    let isOn = this.context.currentHeatingCoolingState != 0;
    if (val == 0 && isOn) {
        this.context.targetHeatingCoolingState = 0;
        this.api.acSetCurrentHeatingCoolingState(this.context.serial, 0);
    } else if (val != 0 && !isOn) {
        let mode = this.context.targetHeatingCoolingState || 3;
        if (mode == 0) mode = 3;
        this.api.acSetCurrentHeatingCoolingState(this.context.serial, mode);
    }
    cb();
};

// fan service: speed notch 1..N maps to the configured fan speed list;
// 0 accompanies Active=0 and is handled there, not as a damper/speed change
Airtouch2.prototype.acFanSetSpeedLevel = function(val, cb) {
    if (val > 0) {
        let pct = (val - 1) * this.context.rotation_step;
        if (this.context.rotationSpeed != pct) {
            this.context.rotationSpeed = pct;
            let fan_speed = this.context.fan_speeds[val - 1];
            this.api.acSetFanSpeed(this.context.serial, MAGIC.AT2_AC_FAN_SPEEDS[fan_speed]);
        }
    }
    cb();
};

Airtouch2.prototype.acSetRotationSpeed = function(val, cb) {
    if (this.context.rotationSpeed != val) {
        this.context.rotationSpeed = val;
        // convert homebridge fan rotation % into AC fan speed string (e.g. 99% => High) using the config array
        let fan_speed = this.context.fan_speeds[val / this.context.rotation_step];
        // convert AC fan speed string in AC fan speed number (e.g. High => 4) and update AC
        this.api.acSetFanSpeed(this.context.serial, MAGIC.AT2_AC_FAN_SPEEDS[fan_speed]);
    }
    cb();
};

/* /AC accessory functions */

/* Zone accessory functions */

Airtouch2.prototype.zoneSetActive = function(val, cb) {
    if (this.context.active != val) {
        this.context.active = val;
        this.api.zoneSetActive(this.context.serial, val);
    }
    cb();
};

Airtouch2.prototype.zoneSetDamperPosition = function(val, cb) {
    // set damper position
    if (this.context.damperPosition != val) {
        this.context.damperPosition = val;
        this.api.zoneSetDamperPosition(this.context.serial, val);
    }
    cb();
};

Airtouch2.prototype.zoneSetRotationSpeed = function(val, cb) {
    // fan speed % maps to damper position; 0% is handled by Active, not the damper
    if (val > 0 && this.context.damperPosition != val) {
        this.context.damperPosition = val;
        this.api.zoneSetDamperPosition(this.context.serial, val);
    }
    cb();
};

/* /Zone accessory functions */

/* Thermo accessory functions */

// Airtouch2.prototype.thermoSetActive = function(val, cb) { // 0 = OFF, 3 = AUTO (ON)
//  // sets control type
//  if (this.context.active != (val % 2)) {
//      this.context.active = (val % 2);
//      this.api.zoneSetControlType(this.context.serial, (val % 2)); // 0 = DAMPER (OFF), 1 = TEMPERATURE (ON)
//  }
//  cb();
// };

// Airtouch2.prototype.thermoSetTargetTemperature = function(val, cb) {
//  // sets zone target temperature
//  if (this.context.active && this.context.targetTemperature != val) {
//      this.context.targetTemperature = val;
//      this.api.zoneSetTargetTemperature(this.context.serial, val);
//  }
//  cb();
// };

/* /Thermo accessory functions */



