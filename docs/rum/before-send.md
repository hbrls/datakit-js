# beforeSend (Data Interception and Data Modification)

The RUM SDK executes the `beforeSend` method before sending each piece of data. By customizing the implementation of this method, you can achieve the following operations:

- Modify certain data;
- Intercept data transmission.

`beforeSend` provides two parameters:

```js
function beforeSend(event, context)
```

`event` is an object generated by the SDK to collect various metrics data. `context` contains specific related information as follows:

| EVENT TYPE       | CONTEXT                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View             | [Location](https://developer.mozilla.org/en-US/docs/Web/API/Location)                                                                                                                                                                               |
| Action           | [Event](https://developer.mozilla.org/en-US/docs/Web/API/Event)                                                                                                                                                                                     |
| Resource (XHR)   | [XMLHttpRequest](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest), [PerformanceResourceTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming)                                                          |
| Resource (Fetch) | [Request](https://developer.mozilla.org/en-US/docs/Web/API/Request), [Response](https://developer.mozilla.org/en-US/docs/Web/API/Response), [PerformanceResourceTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming) |
| Resource (Other) | [PerformanceResourceTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming)                                                                                                                                             |
| Error            | [Error](https://developer.mozilla.org/en-US/docs/Web//Reference/Global_Objects/Error)                                                                                                                                                               |
| Long Task        | [PerformanceLongTaskTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)                                                                                                                                             |

## Modify Certain Data

```js
window.DATAFLUX_RUM &&
    window.DATAFLUX_RUM.init({
        ...,
        beforeSend: (event, context) => {
            if (event.type === 'resource' && event.resource.type === 'fetch') {
                // Add response headers information to the original data
                event.context = {...event.context, responseHeaders: context.response.headers}
            }
        },
        ...
    });
```

**Note**: `beforeSend` can only modify data fields that the SDK allows. Modifications outside these fields will be ignored.

The fields that the SDK allows modification are listed in the table below:

| Property             | Type   | Description                                                                    |
| -------------------- | ------ | ------------------------------------------------------------------------------ |
| `view.url`           | string | Page URL                                                                       |
| `view.referrer`      | string | Referrer URL                                                                   |
| `resource.url`       | string | Resource URL                                                                   |
| `error.message`      | string | Error message                                                                  |
| `error.resource.url` | string | Error resource URL                                                             |
| `context`            | string | Global custom content, for example: content added via `addAction`, `addError`. |

## Intercept Data Transmission

You can intercept unnecessary data by returning `true` or `false` from the `beforeSend` method.

- `true` means this data should be reported;
- `false` means this data should be ignored.

```js
window.DATAFLUX_RUM &&
    window.DATAFLUX_RUM.init({
        ...,
        beforeSend: (event) => {
            if (shouldDiscard(event)) {
                return false
            } else {
                return true
            }
            ...
        },
        ...
    });
```
