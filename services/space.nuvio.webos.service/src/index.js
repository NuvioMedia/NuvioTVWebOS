var path = require("path");

var serverHost = require("./serverHost");
var SERVICE_ID = serverHost.SERVICE_ID;
var HEALTH_REQUEST_TIMEOUT_MS = serverHost.HEALTH_REQUEST_TIMEOUT_MS;
var TRACK_REQUEST_TIMEOUT_MS = serverHost.TRACK_REQUEST_TIMEOUT_MS;
var READY_WAIT_TIMEOUT_MS = serverHost.READY_WAIT_TIMEOUT_MS;
var READY_POLL_INTERVAL_MS = serverHost.READY_POLL_INTERVAL_MS;
var bootLocalRuntime = serverHost.bootLocalRuntime;
var waitForLocalServer = serverHost.waitForLocalServer;
var requestActiveServerPath = serverHost.requestActiveServerPath;

var RUNTIME_PATH = path.resolve(__dirname, "..", "runtime", "media-http.cjs");

function createService() {
  try {
    var Service = require("webos-service");
    return new Service(SERVICE_ID);
  } catch (error) {
    console.warn("[" + SERVICE_ID + "] webos-service unavailable, using local mock:", error.message);
    return {
      register: function() {}
    };
  }
}

var service = createService();

var runtimeState = {
  booted: false,
  bootTimestamp: null,
  error: null,
  ready: false,
  readyTimestamp: null,
  readyPort: null
};

function ensureRuntimeStarted() {
  if (runtimeState.booted || runtimeState.error) {
    return;
  }

  runtimeState.bootTimestamp = new Date().toISOString();

  try {
    bootLocalRuntime(RUNTIME_PATH);
    runtimeState.booted = true;
    console.log("[" + SERVICE_ID + "] local media runtime booted from", RUNTIME_PATH);
  } catch (error) {
    runtimeState.error = {
      message: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : "")
    };
    console.error("[" + SERVICE_ID + "] failed to boot local media runtime:", error);
  }
}

function respond(message, payload) {
  if (message && typeof message.respond === "function") {
    message.respond(payload);
    return;
  }

  console.log("[" + SERVICE_ID + "] response:", JSON.stringify(payload));
}

function markRuntimeReady(status) {
  if (!status || !status.port) {
    return;
  }

  runtimeState.ready = true;
  runtimeState.readyPort = status.port;

  if (!runtimeState.readyTimestamp) {
    runtimeState.readyTimestamp = new Date().toISOString();
  }
}

function buildBasePayload() {
  return {
    returnValue: !runtimeState.error,
    serviceId: SERVICE_ID,
    booted: runtimeState.booted,
    bootTimestamp: runtimeState.bootTimestamp,
    ready: runtimeState.ready,
    readyTimestamp: runtimeState.readyTimestamp,
    readyPort: runtimeState.readyPort,
    runtimePath: RUNTIME_PATH,
    error: runtimeState.error
  };
}

function buildErrorPayload(error, extras) {
  return Object.assign(buildBasePayload(), {
    returnValue: false,
    errorCode: -1,
    errorText: String(error && error.message ? error.message : error || "Unknown service error")
  }, extras || {});
}

function getMessagePayload(message) {
  if (message && message.payload && typeof message.payload === "object") {
    return message.payload;
  }
  return {};
}

function buildServerStatusPayload(status, includeBody, warning) {
  if (status) {
    markRuntimeReady(status);
  }

  return Object.assign(buildBasePayload(), {
    url: status ? "http://127.0.0.1:" + status.port : null,
    settingsReachable: Boolean(status),
    settingsStatusCode: status ? status.statusCode : null,
    heartbeatStatusCode: status ? status.heartbeatStatusCode || null : null,
    settingsBody: includeBody && status ? status.body : null,
    warning: warning || null
  });
}

function buildTracksFallbackPayload(error, tracksPath, status, extras) {
  var message = String(error && error.message ? error.message : error || "Track probe unavailable");

  if (status) {
    markRuntimeReady(status);
  }

  return Object.assign(buildBasePayload(), {
    returnValue: true,
    error: null,
    degraded: true,
    warning: message,
    url: status && status.port ? "http://127.0.0.1:" + status.port : null,
    proxiedPath: tracksPath,
    statusCode: status && status.statusCode ? status.statusCode : null,
    tracks: [],
    runtimeError: runtimeState.error
  }, extras || {});
}

function registerCommand(commandName, includeBody) {
  service.register(commandName, function(message) {
    ensureRuntimeStarted();

    waitForLocalServer(
      {
        timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
        readyTimeoutMs: READY_WAIT_TIMEOUT_MS,
        pollIntervalMs: READY_POLL_INTERVAL_MS
      },
      function(error, status) {
        respond(
          message,
          buildServerStatusPayload(status, includeBody, error ? String(error && error.message ? error.message : error) : null)
        );
      }
    );
  });
}

function parseTracksResponse(text) {
  try {
    var parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return null;
  }
}

function respondWithTracks(message, tracksPath, trackStatus, readyStatus) {
  var status = trackStatus || readyStatus;
  var tracks = parseTracksResponse(trackStatus && trackStatus.body);

  if (!trackStatus || trackStatus.statusCode < 200 || trackStatus.statusCode >= 300) {
    var statusCode = trackStatus ? trackStatus.statusCode || 0 : 0;
    respond(message, buildTracksFallbackPayload("Track request failed with HTTP " + statusCode, tracksPath, status, {
      rawBody: trackStatus ? trackStatus.body || "" : ""
    }));
    return;
  }

  if (tracks === null) {
    respond(message, buildTracksFallbackPayload("Track response was not valid JSON", tracksPath, status, {
      rawBody: trackStatus.body || ""
    }));
    return;
  }

  if (status) {
    markRuntimeReady(status);
  }

  respond(message, Object.assign(buildBasePayload(), {
    url: status && status.port ? "http://127.0.0.1:" + status.port : null,
    proxiedPath: tracksPath,
    statusCode: trackStatus.statusCode,
    tracks: tracks
  }));
}

function registerTracksCommand() {
  service.register("tracks", function(message) {
    ensureRuntimeStarted();

    var mediaUrl = String(getMessagePayload(message).url || "").trim();
    if (!mediaUrl) {
      respond(message, buildErrorPayload("Missing required parameter: url"));
      return;
    }

    var tracksPath = "/tracks/" + encodeURIComponent(mediaUrl);

    if (runtimeState.error) {
      respond(message, buildTracksFallbackPayload(runtimeState.error, tracksPath, null));
      return;
    }

    requestActiveServerPath(
      tracksPath,
      {
        probeTimeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
        requestTimeoutMs: TRACK_REQUEST_TIMEOUT_MS,
        readyTimeoutMs: READY_WAIT_TIMEOUT_MS,
        pollIntervalMs: READY_POLL_INTERVAL_MS
      },
      function(error, trackStatus, readyStatus) {
        if (error) {
          respond(message, buildTracksFallbackPayload(error, tracksPath, readyStatus || trackStatus));
          return;
        }

        respondWithTracks(message, tracksPath, trackStatus, readyStatus);
      }
    );
  });
}

ensureRuntimeStarted();
registerCommand("ping", false);
registerCommand("status", true);
registerTracksCommand();
