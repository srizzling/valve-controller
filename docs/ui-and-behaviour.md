# The UI and how a run behaves

## The UI

An animated cartoon garden follows the controller, not the buttons you press:

- **Idle**: a sunflower swaying under the real sky (sun, moon and stars, clouds, bee), and the next watering time.
- **Watering**: a little robot gardener rolls in with a hose and sprays the sunflower, but only once the
  controller has confirmed the valve open. Clicking "Water now" changes nothing on screen until the run state comes back.
- **Soaking**: the robot leaves, the view eases in towards the soil, and droplets seep towards the roots while the moisture
  spreads in step with the soak countdown.
- **Rain**: rain falls only when it is raining now (from the current conditions), with puddles and a darker sky. A rain
  *forecast* on a sunny day only shows the "Rain delay active" notice and why.

The weather card shows:

- current conditions, taken as the consensus of seven weather models (ECMWF, GFS, ICON, GEM, UK Met Office, ARPEGE and
  JMA) rather than Open-Meteo's default blend, so one model drizzling on a sunny day is outvoted. It counts as raining only
  when most models say so. If fewer than three models answer, the default blend is used. Hover the label to see the vote.
- rain now / last 24 h / next 24 h, chance of rain, humidity, wind, water use today and soil moisture
- a 7-day outlook with a badge per day: waters (with the planned cycles), skips for rain or weather, or no run. Tap a day for the times and reasons.
- whether the next scheduled run will go ahead, and with how many cycles

Future days use today's forecast and the same rules the controller applies when a run starts, so they can change as
the forecast does. Animations respect `prefers-reduced-motion`.

To preview every scene without a backend, serve `worker/public` and open `/?demo=idle`, `watering`, `soaking`,
`rain`, `delay` (sunny with a rain delay), `cloudy` or `night`.

## How a run behaves

- Settings (water minutes, soak minutes, number of cycles, start times, rain and weather thresholds) live in the UI. A run
  snapshots them at start, so editing mid-run changes nothing until the next run.
- A run is `cycles` watering periods with a soak between each. It ends after the last watering period (no trailing soak).
- Rain check applies to **scheduled** runs only: skip if any hour in the lookahead window is at or above the
  probability threshold, or the forecast total reaches the mm threshold. If the forecast can't be fetched it waters
  anyway and says so in the notification. Starting from the UI or by voice always runs.
- **Catch-up**: when a run is skipped for rain, the controller checks again one hour after the look-ahead ends. If less rain
  fell than your mm limit (or 1 mm when that is 0), the forecast no longer says rain is coming, and it is daylight, it waters
  with a `catch-up` run, scaled by the weather like any other. If the rain came, it does nothing. It gives up 30 minutes
  before your next start time, or after a day if there is none, so with two start times a day the next one is often the
  make-up. Extra runs and weather skips (frost, wind, wet soil) never get one. Starting a run by hand cancels a pending
  catch-up. Switch it off with "Make up a rain skip if the rain does not come" in the rain settings.
- **Forced run**: if the last run in the history was skipped for rain and less rain than your mm limit has fallen since, the
  next scheduled run ignores the rain forecast and goes ahead, so a forecast that keeps promising rain cannot starve the
  garden day after day. Wet soil, wind and frost can still skip it. It uses the same setting as the catch-up.
- Weather smarts change the number of cycles for scheduled runs (see below).
- A start time can be a clock time, "N minutes before sunrise", "N minutes before sunset" or "N minutes after sunset".
  Sunrise and sunset are worked out from your latitude and longitude, so they follow the seasons. You can have as many
  start times as you like, for example one before sunrise and one before sunset. Each run is scaled by the weather on
  its own, so two runs on a hot day both get the extra cycles.
- A start time can be an **extra run**. It is on top of your normal starts, which still run every day. Set "only if ET ≥ X mm" and
  it only happens on days the forecast ET reaches X, for example sunrise and sunset every day plus a mid-afternoon run on hot days.
  On a milder day it does nothing, leaves no history entry and sends no alert, and the 7-day outlook leaves it out. If
  there is no ET forecast for the day, it does not run. Leave the field empty for a run that happens every day.
- Every change of the valve is confirmed by reading its state back. If Tuya can't be reached when a phase changes, it
  retries twice (30s apart), then aborts the run, tries to close the valve and sends a high-priority ntfy.
- Using the Smart Life app while a run is going is safe for the valve (its own countdown still applies), but the
  controller will not notice. The next phase change reads the real state and reports a mismatch.

### Weather smarts

On by default, for scheduled runs only. Your minutes per cycle and soak stay fixed. The number of cycles changes with
the weather.

Open-Meteo supplies the day's evapotranspiration (ET, the water lost to heat, sun, wind and dry air) and the modelled
soil moisture. Dryness is 1 for dry soil, 0 for wet soil, and in between as it dries out.

```
percent = 100 × (ET × plant factor / normal ET) × dryness      (capped at your maximum)
cycles  = round(your cycles × percent / 100)                    (at least 1)
```

These gates skip a run. The frost and wind gates apply whatever the scaling says.

| Gate | Skips when |
| --- | --- |
| Soil | the soil is wet |
| Low demand | percent is below your minimum |
| Wind | it is windier than your limit at the start |
| Frost | it is colder than your limit at the start |

Every decision and its reason goes in the ntfy message, the history and the UI. All thresholds are in the UI, and the
defaults suit pots and beds (normal ET 4.5 mm, plant factor 1). The soil model is on a roughly 10 km grid, so treat it as
a guide. If the forecast is unavailable, your normal cycles run.
