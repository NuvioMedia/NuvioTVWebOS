var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");
var Module = require("module");

var SERVICE_ID = "space.nuvio.webos.service";
var PORT_CANDIDATES = require("./constants").PORT_CANDIDATES;
var HEALTH_REQUEST_TIMEOUT_MS = 3000;
var TRACK_REQUEST_TIMEOUT_MS = 20000;
var READY_WAIT_TIMEOUT_MS = 15000;
var READY_POLL_INTERVAL_MS = 250;
var RUNTIME_SETTINGS_FILE = "server-settings.json";
var RUNTIME_PACKAGE_NAME = "nuvio-media-server";

function once(callback) {
  var called = false;

  return function() {
    if (called) {
      return;
    }

    called = true;
    callback.apply(null, arguments);
  };
}

function resolveRuntimeAppPath() {
  if (process.env.APP_PATH) {
    return process.env.APP_PATH;
  }

  if (process.platform === "linux") {
    return path.join(process.env.HOME || os.homedir(), "." + RUNTIME_PACKAGE_NAME);
  }

  if (process.platform === "darwin") {
    return path.join(process.env.HOME || os.homedir(), "Library", "Application Support", RUNTIME_PACKAGE_NAME);
  }

  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(process.env.HOME || os.homedir(), "AppData", "Roaming"),
      "nuvio",
      RUNTIME_PACKAGE_NAME
    );
  }

  return path.join(os.tmpdir(), RUNTIME_PACKAGE_NAME);
}

function resolveRuntimeSettingsPath() {
  return path.join(resolveRuntimeAppPath(), RUNTIME_SETTINGS_FILE);
}

function ensureRuntimeSettings() {
  var settingsPath = resolveRuntimeSettingsPath();
  var settingsDir = path.dirname(settingsPath);
  var settings = {};
  var hasChanges = false;

  fs.mkdirSync(settingsDir, { recursive: true });

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (error) {
      console.warn("[" + SERVICE_ID + "] failed to parse runtime settings, rebuilding safe defaults:", error.message);
      settings = {};
      hasChanges = true;
    }
  } else {
    hasChanges = true;
  }

  if (!Array.isArray(settings.allTranscodeProfiles)) {
    settings.allTranscodeProfiles = [];
    hasChanges = true;
  }

  // Disable auto-detection when there is no cached profile so first playback
  // is not blocked by the runtime's startup transcoder probes.
  if (
    !Object.prototype.hasOwnProperty.call(settings, "transcodeHardwareAccel") ||
    (settings.transcodeHardwareAccel && settings.allTranscodeProfiles.length === 0)
  ) {
    settings.transcodeHardwareAccel = false;
    hasChanges = true;
  }

  if (hasChanges) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
  }

  return settingsPath;
}

function loadCommonJsScript(filename) {
  var code = fs.readFileSync(filename, "utf8");
  var mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(code, filename);
  return mod.exports;
}

function bootLocalRuntime(runtimePath) {
  ensureRuntimeSettings();
  loadCommonJsScript(runtimePath);
}

function normalizeRequestOptions(options) {
  return Object.assign(
    {
      timeoutMs: HEALTH_REQUEST_TIMEOUT_MS
    },
    options || {}
  );
}

function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function isValidHeartbeatPayload(payload) {
  return Boolean(payload && typeof payload === "object" && payload.success === true);
}

function isValidSettingsPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    payload.values &&
    typeof payload.values === "object" &&
    typeof payload.baseUrl === "string" &&
    payload.baseUrl.length > 0
  );
}

function requestLocalPath(port, pathname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = null;
  }

  var requestOptions = normalizeRequestOptions(options);
  var done = once(callback);
  var req = http.get(
    {
      host: "127.0.0.1",
      port: port,
      path: pathname
    },
    function(res) {
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function(chunk) {
        body += chunk;
      });
      res.on("end", function() {
        done(null, {
          port: port,
          pathname: pathname,
          statusCode: res.statusCode || 0,
          body: body
        });
      });
    }
  );

  req.setTimeout(requestOptions.timeoutMs, function() {
    req.destroy(new Error("Local media request timed out after " + requestOptions.timeoutMs + "ms"));
  });

  req.on("error", function(error) {
    done(error);
  });
}

function requestLocalJson(port, pathname, options, callback) {
  requestLocalPath(port, pathname, options, function(error, result) {
    if (error) {
      callback(error);
      return;
    }

    callback(null, Object.assign({}, result, {
      json: parseJson(result.body)
    }));
  });
}

function probeLocalServer(options, callback, index) {
  if (typeof options === "function") {
    index = callback;
    callback = options;
    options = null;
  }

  var requestOptions = normalizeRequestOptions(options);
  var candidateIndex = typeof index === "number" ? index : 0;
  if (candidateIndex >= PORT_CANDIDATES.length) {
    callback(null, null);
    return;
  }

  var port = PORT_CANDIDATES[candidateIndex];
  requestLocalJson(port, "/heartbeat", requestOptions, function(heartbeatError, heartbeatStatus) {
    if (
      heartbeatError ||
      !heartbeatStatus ||
      heartbeatStatus.statusCode !== 200 ||
      !isValidHeartbeatPayload(heartbeatStatus.json)
    ) {
      probeLocalServer(requestOptions, callback, candidateIndex + 1);
      return;
    }

    requestLocalJson(port, "/settings", requestOptions, function(settingsError, settingsStatus) {
      if (
        !settingsError &&
        settingsStatus &&
        settingsStatus.statusCode === 200 &&
        isValidSettingsPayload(settingsStatus.json)
      ) {
        callback(null, Object.assign({}, settingsStatus, {
          heartbeatStatusCode: heartbeatStatus.statusCode,
          heartbeatBody: heartbeatStatus.body
        }));
        return;
      }

      if (settingsError) {
        probeLocalServer(requestOptions, callback, candidateIndex + 1);
        return;
      }

      probeLocalServer(requestOptions, callback, candidateIndex + 1);
    });
  });
}

function waitForLocalServer(options, callback) {
  var requestOptions = normalizeRequestOptions(options);
  var deadline = Date.now() + (requestOptions.readyTimeoutMs || READY_WAIT_TIMEOUT_MS);

  function tryProbe() {
    probeLocalServer({ timeoutMs: requestOptions.timeoutMs }, function(error, status) {
      if (!error && status && status.port) {
        callback(null, status);
        return;
      }

      if (Date.now() >= deadline) {
        callback(error || new Error("Local media server unavailable"));
        return;
      }

      setTimeout(tryProbe, requestOptions.pollIntervalMs || READY_POLL_INTERVAL_MS);
    });
  }

  tryProbe();
}

function requestActiveServerPath(pathname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = null;
  }

  var requestOptions = Object.assign(
    {
      probeTimeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
      requestTimeoutMs: TRACK_REQUEST_TIMEOUT_MS,
      readyTimeoutMs: READY_WAIT_TIMEOUT_MS,
      pollIntervalMs: READY_POLL_INTERVAL_MS
    },
    options || {}
  );

  waitForLocalServer(
    {
      timeoutMs: requestOptions.probeTimeoutMs,
      readyTimeoutMs: requestOptions.readyTimeoutMs,
      pollIntervalMs: requestOptions.pollIntervalMs
    },
    function(error, status) {
      if (error) {
        callback(error);
        return;
      }

      if (!status || !status.port) {
        callback(new Error("Local media server unavailable"));
        return;
      }

      requestLocalPath(status.port, pathname, { timeoutMs: requestOptions.requestTimeoutMs }, function(requestError, result) {
        if (requestError) {
          callback(requestError, null, status);
          return;
        }

        callback(null, result, status);
      });
    }
  );
}

module.exports = {
  SERVICE_ID: SERVICE_ID,
  PORT_CANDIDATES: PORT_CANDIDATES,
  HEALTH_REQUEST_TIMEOUT_MS: HEALTH_REQUEST_TIMEOUT_MS,
  TRACK_REQUEST_TIMEOUT_MS: TRACK_REQUEST_TIMEOUT_MS,
  READY_WAIT_TIMEOUT_MS: READY_WAIT_TIMEOUT_MS,
  READY_POLL_INTERVAL_MS: READY_POLL_INTERVAL_MS,
  resolveRuntimeAppPath: resolveRuntimeAppPath,
  resolveRuntimeSettingsPath: resolveRuntimeSettingsPath,
  ensureRuntimeSettings: ensureRuntimeSettings,
  bootLocalRuntime: bootLocalRuntime,
  probeLocalServer: probeLocalServer,
  waitForLocalServer: waitForLocalServer,
  requestActiveServerPath: requestActiveServerPath
};
