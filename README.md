# homebridge-airtouch2plus-platform

based off the homebridge-airtouch4-platform plugin by mihailescu2m

#### Homebridge plugin for the Airtouch2+ AC Controller

## Installation

1. Install [homebridge](https://github.com/nfarina/homebridge#installation-details)
2. Install this plugin: `npm install -g homebridge-airtouch2plus-platform`
3. Update your `config.json` file (See below).

## Configuration example

```json
"platforms": [
	{
		"platform": "Airtouch2",
		"name": "Airtouch2",
		"ip_address": "192.168.0.10",
		"ac_include_temps": false,
		"units": [
			{
				"manufacturer": "LG",
				"model": "B36AWY-7G6",
				"fan": ["AUTO", "QUIET", "LOW", "MEDIUM"]
			}
		]
	}
]
```

## Structure

| Key | Description |
| --- | --- |
| `platform` | Must be `Airtouch2` |
| `name` | Name for the platform |
| `ip_address` | Airtouch4 console IP address, can be found under "System Settings" -> "WiFi Settings", click the three-dots icon in the upper right corner, select "Advanced" in the popup menu |
| `ac_include_temps` | Add zone temperature information in the AC accessory page |
| `units` | Array with information about your AC units, containing: |
| `manufacturer` _(optional)_ | Appears under "Manufacturer" for your AC accessory in the Home app |
| `model` _(optional)_ | Appears under "Model" for your AC accessory in the Home app |
| `fan` _(required)_ | List with fan speeds that can be set for your AC |

## Accessories

#### `AC` - created for each AC unit (e.g. `AC 0`, `AC 1`, ...)

It uses the Homekit `Thermostat` service, and can set AC OFF/HEAT/COOL/AUTO and fan speed. DRY/FAN modes appear as AUTO.

There are custom fields such as "Spill Active" and "Timer Set" received from the Airtouch2+ console that are also available only on 3rd party apps.

Thermostat uses FakeGato service for temperature history, available only in the Eve app.

#### `Zone` - created for each Airtouch group (e.g. `Zone 0`, `Zone 1`, ...)

It uses 2 Homekit services:

* `Switch` - to turn the zone ON/OFF.
* `Window` - for damper control. Window in Homekit represents a motorized control that can open/close a window and can be set open to a specific position (in %). This control is the most compatible to the damper percentage control. From the Apple home interface you can set it in 5% increments, the Eve app has options only to "Open" (100%) and "Close" (0%). Damper is being set to the desired value only if zone is set to percentage control type, when using temperature control the Damper shows up as "Obstructed" and cannot be set.
---

## Fork notes (bradystroud)

This fork makes the plugin work on current Homebridge 1.x / hap-nodejs and adds friendly accessory names:

- **Fixed crash on startup** (`Class constructor Characteristic cannot be invoked without 'new'`): the Spill/Timer custom characteristics are now ES classes; `Characteristic` has been a class in hap-nodejs for years and can't be `Function.call`'d.
- **Fixed** two copy-paste bugs where `addCharacteristic` was passed `Characteristic.SpillStatus` / `Characteristic.TimerStatus` instead of the `CustomCharacteristic` equivalents.
- **Added `unit_names` / `zone_names` config options** so accessories get real names (and therefore natural Siri commands) instead of "AC 0" / "Zone 3":

```json
{
  "platform": "Airtouch2",
  "name": "Airtouch2",
  "ip_address": "192.168.0.95",
  "unit_names": { "0": "Aircon" },
  "zone_names": { "0": "Living", "1": "Main Bed", "2": "Bed 2", "3": "Bed 3", "4": "Bed 4" },
  "units": [{ "manufacturer": "Daikin", "model": "Ducted", "fan": ["LOW", "MEDIUM", "HIGH"] }]
}
```

### `zone_control: "fan"`

By default zones are a Switch + Window pair (the Window models the damper, which gives HomeKit's inverted blind-style slider). Set `"zone_control": "fan"` on the platform to expose each zone as a single fan accessory instead: fan on/off = zone on/off, fan speed % = damper opening. One tile per zone, a bottom-up slider, and natural Siri phrases like "set Bed 3 to 60%". Cached accessories migrate automatically on restart.

**Requires Homebridge 1.x** — Homebridge 2.x removed `updateReachability` and other APIs this plugin still uses.

Install:

```
npm install -g github:bradystroud/homebridge-airtouch2plus-platform
```

Verified against a real AirTouch 2+ console (Daikin ducted, 5 zones).
