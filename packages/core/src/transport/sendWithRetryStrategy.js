import { clocksNow, ONE_SECOND } from '../helper/tools'
import { ONE_MEBI_BYTE, ONE_KIBI_BYTE } from '../helper/byteUtils'
import { ErrorSource } from '../helper/errorTools'
import { setTimeout } from '../helper/timer'
export var MAX_ONGOING_BYTES_COUNT = 80 * ONE_KIBI_BYTE
export var MAX_ONGOING_REQUESTS = 32
export var MAX_QUEUE_BYTES_COUNT = 3 * ONE_MEBI_BYTE
export var MAX_BACKOFF_TIME = 256 * ONE_SECOND
export var INITIAL_BACKOFF_TIME = ONE_SECOND

var TransportStatus = {
  UP: 0,
  FAILURE_DETECTED: 1,
  DOWN: 2
}

var RetryReason = {
  AFTER_SUCCESS: 0,
  AFTER_RESUME: 1
}

export function sendWithRetryStrategy(
  payload,
  state,
  sendStrategy,
  endpointUrl,
  reportError
) {
  if (
    state.transportStatus === TransportStatus.UP &&
    state.queuedPayloads.size() === 0 &&
    state.bandwidthMonitor.canHandle(payload)
  ) {
    send(payload, state, sendStrategy, {
      onSuccess: function () {
        return retryQueuedPayloads(
          RetryReason.AFTER_SUCCESS,
          state,
          sendStrategy,
          endpointUrl,
          reportError
        )
      },
      onFailure: function () {
        state.queuedPayloads.enqueue(payload)
        scheduleRetry(state, sendStrategy, endpointUrl, reportError)
      }
    })
  } else {
    state.queuedPayloads.enqueue(payload)
  }
}

function scheduleRetry(state, sendStrategy, endpointUrl, reportError) {
  if (state.transportStatus !== TransportStatus.DOWN) {
    return
  }
  setTimeout(function () {
    var payload = state.queuedPayloads.first()
    send(payload, state, sendStrategy, {
      onSuccess: function () {
        state.queuedPayloads.dequeue()

        state.currentBackoffTime = INITIAL_BACKOFF_TIME
        retryQueuedPayloads(
          RetryReason.AFTER_RESUME,
          state,
          sendStrategy,
          endpointUrl,
          reportError
        )
      },
      onFailure: function () {
        state.currentBackoffTime = Math.min(
          MAX_BACKOFF_TIME,
          state.currentBackoffTime * 2
        )
        scheduleRetry(state, sendStrategy, endpointUrl, reportError)
      }
    })
  }, state.currentBackoffTime)
}

function send(payload, state, sendStrategy, responseData) {
  var onSuccess = responseData.onSuccess
  var onFailure = responseData.onFailure
  state.bandwidthMonitor.add(payload)
  sendStrategy(payload, function (response) {
    state.bandwidthMonitor.remove(payload)
    if (!shouldRetryRequest(response, state, payload)) {
      state.transportStatus = TransportStatus.UP
      onSuccess()
    } else {
      // do not consider transport down if another ongoing request could succeed
      state.transportStatus =
        state.bandwidthMonitor.ongoingRequestCount > 0
          ? TransportStatus.FAILURE_DETECTED
          : TransportStatus.DOWN
      payload.retry = {
        count: payload.retry ? payload.retry.count + 1 : 1,
        lastFailureStatus: response.status
      }
      onFailure()
    }
  })
}

function retryQueuedPayloads(
  reason,
  state,
  sendStrategy,
  endpointUrl,
  reportError
) {
  if (
    reason === RetryReason.AFTER_SUCCESS &&
    state.queuedPayloads.isFull() &&
    !state.queueFullReported
  ) {
    reportError({
      message:
        'Reached max ' +
        endpointUrl +
        ' events size queued for upload: ' +
        MAX_QUEUE_BYTES_COUNT / ONE_MEBI_BYTE +
        'MiB',
      source: ErrorSource.AGENT,
      startClocks: clocksNow()
    })
    state.queueFullReported = true
  }
  var previousQueue = state.queuedPayloads
  state.queuedPayloads = newPayloadQueue()
  while (previousQueue.size() > 0) {
    sendWithRetryStrategy(
      previousQueue.dequeue(),
      state,
      sendStrategy,
      endpointUrl,
      reportError
    )
  }
}

function shouldRetryRequest(response, state, payload) {
  if (
    state.retryMaxSize > -1 &&
    payload.retry &&
    payload.retry.count > state.retryMaxSize
  )
    return false
  return (
    response.type !== 'opaque' &&
    ((response.status === 0 && !navigator.onLine) ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500)
  )
}
export function newRetryState(retryMaxSize) {
  return {
    transportStatus: TransportStatus.UP,
    currentBackoffTime: INITIAL_BACKOFF_TIME,
    bandwidthMonitor: newBandwidthMonitor(),
    queuedPayloads: newPayloadQueue(),
    queueFullReported: false,
    retryMaxSize: retryMaxSize
  }
}

function newPayloadQueue() {
  var queue = []
  return {
    bytesCount: 0,
    enqueue: function (payload) {
      if (this.isFull()) {
        return
      }
      queue.push(payload)
      this.bytesCount += payload.bytesCount
    },
    first: function () {
      return queue[0]
    },
    dequeue: function () {
      var payload = queue.shift()
      if (payload) {
        this.bytesCount -= payload.bytesCount
      }
      return payload
    },
    size: function () {
      return queue.length
    },
    isFull: function () {
      return this.bytesCount >= MAX_QUEUE_BYTES_COUNT
    }
  }
}

function newBandwidthMonitor() {
  return {
    ongoingRequestCount: 0,
    ongoingByteCount: 0,
    canHandle: function (payload) {
      return (
        this.ongoingRequestCount === 0 ||
        (this.ongoingByteCount + payload.bytesCount <=
          MAX_ONGOING_BYTES_COUNT &&
          this.ongoingRequestCount < MAX_ONGOING_REQUESTS)
      )
    },
    add: function (payload) {
      this.ongoingRequestCount += 1
      this.ongoingByteCount += payload.bytesCount
    },
    remove: function (payload) {
      this.ongoingRequestCount -= 1
      this.ongoingByteCount -= payload.bytesCount
    }
  }
}
