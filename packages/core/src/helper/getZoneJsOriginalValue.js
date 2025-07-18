import { getGlobalObject } from '../init'
/**
 * Gets the original value for a DOM API that was potentially patched by Zone.js.
 *
 * Zone.js[1] is a library that patches a bunch of JS and DOM APIs. It usually stores the original
 * value of the patched functions/constructors/methods in a hidden property prefixed by
 * __zone_symbol__.
 *
 * In multiple occasions, we observed that Zone.js is the culprit of important issues leading to
 * browser resource exhaustion (memory leak, high CPU usage). This method is used as a workaround to
 * use the original DOM API instead of the one patched by Zone.js.
 *
 * [1]: https://github.com/angular/angular/tree/main/packages/zone.js
 */
export function getZoneJsOriginalValue(target, name) {
  var browserWindow = getGlobalObject()
  var original
  if (
    browserWindow.Zone &&
    typeof browserWindow.Zone.__symbol__ === 'function'
  ) {
    original = target[browserWindow.Zone.__symbol__(name)]
  }
  if (!original) {
    original = target[name]
  }
  return original
}
