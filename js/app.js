(function () {
  const Data = window.LabData;
  const Phys = window.LabPhysics;
  const fmt = Phys.format;
  const DELAY_MS = 0.05;
  const KEY = "granular-lab-v1";

  const PACK = [];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 16; c++) {
      PACK.push({ x: 26 + c * 22 + (r % 2 ? 11 : 0), y: 20 + r * 20 });
    }
  }
  const LINKS = [];
  for (let i = 0; i < PACK.length; i++) {
    for (let j = i + 1; j < PACK.length; j++) {
      const dx = PACK[j].x - PACK[i].x;
      const dy = PACK[j].y - PACK[i].y;
      const dist = Math.hypot(dx, dy);
      if (dist < 30) LINKS.push({ i, j, align: Math.abs(dx) / dist });
    }
  }

  const state = {
    view: "guide",
    sampleId: "air",
    custom: { d: 2, E: 65, nu: 0.22, rho: 2230 },
    T: 31.4,
    mass: 0,
    g: 9.8,
    tubeMm: 80,
    L: 50,
    Z: 5.2,
    phi: 0.61,
    eta: 1,
    freqKHz: 36,
    vpp: 20,
    pulses: 6,
    periodMs: 60,
    coupling: true,
    backlash: false,
    backlashActive: false,
    noise: 1,
    usPerDiv: 50,
    timebaseManual: false,
    showRef: true,
    cursor1: 7,
    cursor2: 200,
    drag: null,
    plot: null,
    points: [],
    drafts: {},
    draftKey: "air@0.00@",
    runs: [],
    book: [],
    dataTab: "book",
    bookSample: "g1",
    mineSample: "all",
    selectedId: null,
    noisy: null,
    model: null
  };

  function sampleById(id) {
    return Data.SAMPLES.find((s) => s.id === id) || Data.SAMPLES[0];
  }

  function clamp(n, a, b) {
    if (!isFinite(n)) return a;
    return Math.min(b, Math.max(a, n));
  }

  function bindNumber(id, key, min, max, integer) {
    const el = $(id);
    el.addEventListener("input", () => {
      const raw = el.value.trim();
      if (raw === "" || raw === "-" || raw === "." || raw === "-.") return;
      const n = Number(raw);
      if (!isFinite(n) || n < min || n > max) return;
      state[key] = integer ? Math.round(n) : n;
      drawBench();
      persist();
    });
    el.addEventListener("change", () => {
      const n = clamp(Number(el.value), min, max);
      state[key] = integer ? Math.round(n) : n;
      el.value = integer ? String(state[key]) : String(state[key]);
      drawBench();
      persist();
    });
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function cloneBook() {
    return Data.REFERENCE.map((r, i) => ({
      id: "ref-" + r.sampleId + "-" + r.massKg + "-" + i,
      source: "book",
      sampleId: r.sampleId,
      name: sampleById(r.sampleId).name,
      material: r.material,
      diameterMm: r.diameterMm,
      massKg: r.massKg,
      points: r.points.map((p) => [p[0], p[1]])
    }));
  }

  function nominalPressure() {
    return Phys.pressurePa(state.mass, state.g, state.tubeMm);
  }

  function beadDiameter() {
    const s = sampleById(state.sampleId);
    return s.id === "custom" ? state.custom.d : s.diameterMm || 2;
  }

  function trueVelocity() {
    if (state.sampleId === "air") return Phys.airSpeed(state.T);
    const sample = sampleById(state.sampleId);
    const Peff = Math.max(0, nominalPressure() * state.eta);
    let material = sample.material;
    let d = sample.diameterMm;
    let scale = Phys.packingFactor(state.Z, state.phi);
    if (sample.id === "custom") {
      material = "glass";
      d = state.custom.d;
      scale *= Phys.materialSoftRatio(state.custom.E * 1e9, state.custom.nu, state.custom.rho);
    }
    return Math.max(20, state.model.speedAt(material, d, Peff) * scale);
  }

  function acousticLength(Lmm) {
    const gap = state.backlash && state.backlashActive ? 0.4 : 0;
    return Math.max(8, Lmm - gap);
  }

  function flightMsAt(Lmm) {
    return (acousticLength(Lmm) / 1000 / trueVelocity()) * 1000 + DELAY_MS;
  }

  function freqHz() {
    return state.freqKHz * 1000;
  }

  function signalQuality(Lmm) {
    const resonance = Math.exp(-Math.pow((freqHz() - 36000) / 14000, 2));
    const amp = Math.max(0.08, state.vpp / 20);
    const pulseF = Math.min(1.15, Math.max(0.35, state.pulses / 6));
    const coup = state.coupling ? 1 : 0.3;
    const P = Math.max(0, nominalPressure() * state.eta);
    let attenLen = 520;
    if (state.sampleId !== "air") attenLen = 58 * (0.35 + 0.65 * Math.min(P / 15000, 1.3));
    const atten = Math.exp(-Lmm / attenLen);
    let snr = resonance * amp * pulseF * coup * atten;
    if (state.periodMs < 8) snr *= 0.55;
    return { resonance, atten, snr: Math.max(0.04, snr) };
  }

  function jitterMs(Lmm) {
    const q = signalQuality(Lmm);
    return Math.min(0.02, (0.0018 / Math.max(q.snr, 0.1)) * state.noise);
  }

  function gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function hash01(i) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function persist() {
    clearTimeout(persist._t);
    persist._t = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify({
          runs: state.runs,
          book: state.book,
          points: state.points,
          drafts: state.drafts,
          draftKey: state.draftKey,
          sampleId: state.sampleId,
          custom: state.custom,
          T: state.T,
          mass: state.mass,
          g: state.g,
          tubeMm: state.tubeMm,
          L: state.L,
          Z: state.Z,
          phi: state.phi,
          eta: state.eta,
          freqKHz: state.freqKHz,
          vpp: state.vpp,
          pulses: state.pulses,
          periodMs: state.periodMs,
          coupling: state.coupling,
          backlash: state.backlash,
          noise: state.noise,
          dataTab: state.dataTab,
          bookSample: state.bookSample,
          mineSample: state.mineSample,
          selectedId: state.selectedId
        }));
      } catch (err) { /* 存储满了也不影响本次实验 */ }
    }, 180);
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.book) && data.book.length >= 40 && data.book[0].points) state.book = data.book;
      if (Array.isArray(data.runs)) state.runs = data.runs;
      ["sampleId", "T", "mass", "g", "tubeMm", "L", "Z", "phi", "eta", "freqKHz", "vpp", "pulses", "periodMs", "noise", "dataTab", "bookSample", "mineSample", "selectedId", "draftKey"].forEach((k) => {
        if (data[k] !== undefined && data[k] !== null) state[k] = data[k];
      });
      if (typeof data.coupling === "boolean") state.coupling = data.coupling;
      if (typeof data.backlash === "boolean") state.backlash = data.backlash;
      if (data.custom) state.custom = Object.assign(state.custom, data.custom);
      if (Array.isArray(data.points)) state.points = data.points;
      if (data.drafts && typeof data.drafts === "object") state.drafts = data.drafts;
    } catch (err) { /* 忽略损坏的本地记录 */ }
  }

  function keyNow() {
    const d = state.sampleId === "custom" ? state.custom.d.toFixed(2) : "";
    return state.sampleId + "@" + Number(state.mass).toFixed(2) + "@" + d;
  }

  function stashDraft() {
    state.drafts[state.draftKey] = state.points.map((p) => ({ Lmm: p.Lmm, tMs: p.tMs }));
  }

  function swapDraft() {
    const next = keyNow();
    if (next === state.draftKey) return;
    stashDraft();
    const saved = state.drafts[next];
    state.points = saved ? saved.map((p) => ({ Lmm: p.Lmm, tMs: p.tMs })) : [];
    state.draftKey = next;
  }

  function $(id) { return document.getElementById(id); }

  function show(view) {
    if (!document.getElementById("view-" + view)) view = "guide";
    state.view = view;
    document.querySelectorAll(".view").forEach((el) => { el.hidden = el.id !== "view-" + view; });
    document.querySelectorAll("nav [data-view]").forEach((btn) => {
      if (btn.dataset.view === view) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    requestAnimationFrame(redraw);
  }

  function redraw() {
    if (state.view === "bench") drawBench();
    if (state.view === "data") renderData();
    if (state.view === "hertz") updateHertz();
    if (state.view === "discuss") updateDiscussion();
    const probe = state.view === "hertz" ? $("chart-hertz") : state.view === "data" ? $("chart-lt") : null;
    if (probe && probe.clientWidth < 8 && !redraw.pending) {
      redraw.pending = true;
      requestAnimationFrame(() => { redraw.pending = false; redraw(); });
    }
  }

  function syncNumbers() {
    $("temp").value = state.T;
    $("mass").value = state.mass;
    $("mass-num").value = Number(state.mass).toFixed(2);
    $("bench-g").value = state.g;
    $("data-g").value = state.g;
    $("bench-tube").value = state.tubeMm;
    $("data-tube").value = state.tubeMm;
    $("length").value = state.L;
    $("length-num").value = Number(state.L).toFixed(2);
    $("Z").value = state.Z;
    $("phi").value = state.phi;
    $("eta").value = state.eta;
    $("freq").value = state.freqKHz;
    $("vpp").value = state.vpp;
    $("pulses").value = state.pulses;
    $("period").value = state.periodMs;
    $("noise").value = state.noise;
    $("coupling").checked = state.coupling;
    $("backlash").checked = state.backlash;
    $("sample").value = state.sampleId;
    $("custom-d").value = state.custom.d;
    $("custom-E").value = state.custom.E;
    $("custom-nu").value = state.custom.nu;
    $("custom-rho").value = state.custom.rho;
    $("custom-box").hidden = state.sampleId !== "custom";
    $("usdiv").value = String(state.usPerDiv);
    $("show-ref").checked = state.showRef;
  }

  function drawBench() {
    $("temp-val").textContent = Number(state.T).toFixed(1) + " °C";
    $("mass-val").textContent = Number(state.mass).toFixed(2) + " kg";
    $("length-val").textContent = Number(state.L).toFixed(2) + " mm";
    $("z-val").textContent = Number(state.Z).toFixed(2);
    $("phi-val").textContent = Number(state.phi).toFixed(3);
    $("eta-val").textContent = Number(state.eta).toFixed(2);
    $("noise-val").textContent = Number(state.noise).toFixed(1);
    $("temp-note").textContent = state.sampleId === "air"
      ? "空气声速用 v = 331.3 + 0.606 θ。31.4 °C 时约为 350.3 m/s，与空管拟合一致。"
      : "颗粒声速由接触刚度决定，这个模型不随室温改变。温度只影响空气对照。";
    const P = nominalPressure();
    $("sensor-readout").textContent = Number(state.mass).toFixed(2) + " kg";
    $("pressure-readout").textContent = "名义压强 " + P.toFixed(1) + " Pa（" + (P / 1000).toFixed(3) + " kPa）";
    const dt = (state.cursor2 - state.cursor1) / 1000;
    $("dt-readout").textContent = isFinite(dt) ? dt.toFixed(4) : "—";
    $("single-v").textContent = dt > 0 ? fmt(state.L / dt, 1) : "—";
    fitTimebase();
    $("scope-meta").textContent = state.usPerDiv + " μs/div";
    $("warn-backlash").hidden = !(state.backlash && state.backlashActive);
    const q = signalQuality(state.L);
    const warn = $("warn-snr");
    if (q.snr < 0.22) {
      warn.hidden = false;
      warn.textContent = "接收信号偏弱，寻峰会有更大的时间抖动。可以把频率调回 36 kHz、加大幅度、涂耦合剂，或缩短间距、提高载荷。";
    } else warn.hidden = true;
    const n = particleEstimate();
    $("particle-count").textContent = state.sampleId === "air"
      ? "空管 · 空气"
      : "约 " + n.toLocaleString("zh-CN") + " 颗";
    const v = trueVelocity();
    $("truth-box").innerHTML = "仿真真值 v = <b>" + fmt(v, 2) + "</b> m/s。<br>刻度间距 " + fmt(state.L, 2) + " mm，声波实际经过 " + fmt(acousticLength(state.L), 2) + " mm。<br>对应波峰的时间差应为 " + fmt(flightMsAt(state.L), 4) + " ms（含 " + DELAY_MS.toFixed(2) + " ms 固定延迟）。<br>内部压力按 ηP = " + fmt(P * state.eta, 1) + " Pa 计算。";
    renderLiveFit();
    renderPoints();
    renderChecklist();
    drawApparatus();
    drawScope();
    drawChains();
  }

  function fitTimebase() {
    const needUs = flightMsAt(state.L) * 1000 + state.pulses * 1e6 / freqHz() + 80;
    const choices = [20, 50, 100, 200];
    const fit = choices.find((c) => c * 10 >= needUs) || 200;
    const tooSmall = state.usPerDiv * 10 < needUs;
    if (!tooSmall && state.timebaseManual) return;
    if (fit === state.usPerDiv) return;
    state.usPerDiv = fit;
    $("usdiv").value = String(fit);
  }

  function particleEstimate() {
    if (state.sampleId === "air") return 0;
    const d = beadDiameter() / 1000;
    const R = d / 2;
    const L = acousticLength(state.L) / 1000;
    const Rt = state.tubeMm / 2000;
    const vol = Math.PI * Rt * Rt * L;
    const vs = (4 / 3) * Math.PI * R * R * R;
    return Math.max(0, Math.round(state.phi * vol / vs));
  }

  function renderLiveFit() {
    const el = $("live-fit");
    const fit = Phys.fitTimeDistance(state.points.map((p) => [p.tMs, p.Lmm]));
    if (!state.points.length) {
      el.innerHTML = "<p class='small muted'>还没有数据。移动光标后点“记入当前点”，或使用辅助采集。</p>";
      return;
    }
    if (!fit.ok) {
      el.innerHTML = "<p class='small'>" + fit.message + "</p>";
      return;
    }
    const klass = Math.abs(fit.r) >= 0.999 ? "fit-good" : Math.abs(fit.r) >= 0.99 ? "fit-mid" : "fit-bad";
    el.innerHTML = "<p>n = " + fit.n + "<br>斜率声速 <b class='" + klass + "'>" + fmt(fit.slope, 2) + " m/s</b><br>r = " + fmt(fit.r, 9) + "<br>s<sub>m</sub> = " + (fit.sm === null ? "至少 3 点" : fmt(fit.sm, 2) + " m/s") + "<br>截距 b = " + fmt(fit.intercept, 2) + " mm<br>等效延迟 t<sub>0</sub> = " + fmt(fit.t0, 4) + " ms</p>";
  }

  function renderPoints(force) {
    const body = $("point-body");
    if (!force && document.activeElement && document.activeElement.tagName === "INPUT" && body.contains(document.activeElement)) return;
    body.innerHTML = state.points.map((p, i) =>
      "<tr data-i='" + i + "'><td>" + (i + 1) + "</td><td><input class='num t' type='number' step='0.0001' value='" + Number(p.tMs).toFixed(4) + "'></td><td><input class='num L' type='number' step='0.001' value='" + Number(p.Lmm).toFixed(3) + "'></td><td><button type='button' class='del' data-del='" + i + "' aria-label='删除第 " + (i + 1) + " 行'>×</button></td></tr>"
    ).join("");
  }

  function renderChecklist() {
    const runs = state.runs.map(annotate).filter((r) => r.fit.ok);
    const air = runs.some((r) => r.sampleId === "air" && r.fit.n >= 4);
    const zero = runs.some((r) => r.sampleId !== "air" && r.massKg === 0 && r.fit.n >= 4);
    const counts = {};
    runs.forEach((r) => {
      if (r.sampleId !== "air" && r.massKg > 0) counts[r.sampleId] = (counts[r.sampleId] || 0) + 1;
    });
    const enough = Object.keys(counts).some((k) => counts[k] >= 3);
    const items = [[air, "空气声速已记入，且不少于 4 个间距"], [zero, "至少一种颗粒的零载荷已记入"], [enough, "同一样品有不少于 3 个正载荷，可估幂指数"]];
    $("checklist").innerHTML = "<h4>进度</h4>" + items.map(([ok, text]) => "<div class='small'>" + (ok ? "● " : "○ ") + text + "</div>").join("");
  }

  function annotate(run) {
    const fit = Phys.fitTimeDistance(run.points);
    const P = Phys.pressurePa(run.massKg, state.g, state.tubeMm);
    return Object.assign({}, run, { fit, P });
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 8 || h < 8) return null;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function drawApparatus() {
    const view = setupCanvas($("apparatus"));
    if (!view) return;
    const { ctx, w, h } = view;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#24303c";
    roundRect(ctx, 12, h - 34, w - 24, 16, 5);
    ctx.fill();
    ctx.fillStyle = "#31414f";
    ctx.fillRect(36, h - 78, 14, 48);
    ctx.fillRect(w - 168, h - 78, 14, 48);

    const tubeL = 70;
    const tubeR = w - 156;
    const tubeY = 62;
    const tubeH = 92;
    ctx.fillStyle = "rgba(150, 214, 232, 0.12)";
    ctx.strokeStyle = "rgba(198, 236, 248, 0.75)";
    ctx.lineWidth = 2;
    roundRect(ctx, tubeL, tubeY, tubeR - tubeL, tubeH, 20);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.moveTo(tubeL + 24, tubeY + 12);
    ctx.lineTo(tubeR - 24, tubeY + 12);
    ctx.stroke();

    const x1 = tubeL + 34;
    const travel = Math.max(40, tubeR - tubeL - 78);
    const x2 = x1 + 28 + ((state.L - 30) / 90) * travel;
    const sample = sampleById(state.sampleId);
    if (sample.material !== "air") {
      ctx.save();
      roundRect(ctx, tubeL + 2, tubeY + 2, tubeR - tubeL - 4, tubeH - 4, 18);
      ctx.clip();
      const visual = 6 + beadDiameter() * 3.3;
      const cy = tubeY + tubeH / 2;
      for (let row = -1; row <= 1; row++) {
        let x = x1 + visual;
        let col = 0;
        while (x < x2 - visual * 0.4) {
          const y = cy + row * visual * 0.92;
          drawBead(ctx, x, y, visual / 2, sample.bead, sample.color);
          x += visual * 0.96;
          col += 1;
        }
      }
      ctx.restore();
    } else {
      ctx.strokeStyle = "rgba(213,221,230,0.35)";
      ctx.beginPath();
      for (let x = x1 + 10; x < x2; x += 6) {
        const y = tubeY + tubeH / 2 + Math.sin((x - x1) / 14) * 10;
        if (x === x1 + 10) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    drawProbe(ctx, x1, tubeY, tubeH, "S1");
    drawProbe(ctx, x2, tubeY, tubeH, "S2");

    ctx.strokeStyle = "#c8b48a";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x2 + 16, tubeY + tubeH / 2);
    ctx.lineTo(w - 46, tubeY + tubeH / 2);
    ctx.stroke();
    ctx.fillStyle = "#e4b15a";
    ctx.beginPath();
    ctx.arc(w - 36, tubeY + tubeH / 2, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1b1408";
    ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.fillText("螺杆", w - 48, tubeY + tubeH / 2 - 22);

    const portX = (x1 + x2) / 2;
    ctx.fillStyle = "#121a22";
    ctx.strokeStyle = "rgba(198,236,248,0.45)";
    ctx.lineWidth = 1;
    ctx.fillRect(portX - 14, tubeY - 14, 28, 16);
    ctx.strokeRect(portX - 14, tubeY - 14, 28, 16);
    ctx.fillStyle = "#9eb0c2";
    ctx.fillText("填料口", portX - 18, tubeY - 18);

    ctx.fillStyle = "#07140e";
    roundRect(ctx, w - 132, 16, 112, 46, 6);
    ctx.fill();
    ctx.fillStyle = "#8dffb0";
    ctx.font = "11px Consolas, monospace";
    ctx.fillText("GML670", w - 122, 30);
    ctx.font = "18px Consolas, monospace";
    ctx.fillText(Number(state.mass).toFixed(2) + " kg", w - 122, 52);
  }

  function drawBead(ctx, x, y, r, fill, stroke) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.45, fill);
    g.addColorStop(1, stroke);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawProbe(ctx, x, tubeY, tubeH, label) {
    ctx.fillStyle = "#8d97a3";
    ctx.fillRect(x - 8, tubeY + 16, 16, tubeH - 32);
    ctx.fillStyle = "#d9dee6";
    ctx.fillRect(x - 12, tubeY + tubeH / 2 - 10, 8, 20);
    ctx.fillStyle = "#e7eef5";
    ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.fillText(label, x - 8, tubeY + tubeH + 16);
  }

  function ch1(tUs) {
    const period = 1e6 / freqHz();
    const dur = state.pulses * period;
    if (tUs < 0 || tUs >= dur) return 0;
    return (tUs % period) / period < 0.5 ? state.vpp / 2 : -state.vpp / 2;
  }

  function ch2(tUs) {
    const tof = flightMsAt(state.L) * 1000;
    const x = tUs - tof;
    if (x < 0) return 0;
    const period = 1e6 / freqHz();
    const q = signalQuality(state.L);
    const env = Math.exp(-x / (period * 7)) * (1 - Math.exp(-x / (period * 0.75)));
    const late = x > period * 9 ? 0.4 * Math.exp(-(x - period * 9) / (period * 5)) : 0;
    const amp = (state.vpp / 2) * q.atten * (state.coupling ? 1 : 0.32) * q.resonance;
    const wave = env * Math.sin((2 * Math.PI * x) / period) + late * Math.sin((2 * Math.PI * (x - period * 9)) / period);
    const n = (hash01(Math.floor(tUs / 2)) - 0.5) * (0.22 / Math.max(q.snr, 0.15));
    return amp * (wave + n);
  }

  function drawScope() {
    const canvas = $("scope");
    const view = setupCanvas(canvas);
    if (!view) return;
    const { ctx, w, h } = view;
    ctx.fillStyle = "#07140f";
    ctx.fillRect(0, 0, w, h);
    const left = 46;
    const top = 16;
    const plotW = w - left - 12;
    const plotH = h - top - 22;
    const windowUs = state.usPerDiv * 10;
    state.plot = { left, top, width: plotW, height: plotH, windowUs };
    ctx.strokeStyle = "rgba(141,255,176,0.16)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = left + (plotW * i) / 10;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const y = top + (plotH * i) / 8;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
    }
    const y1 = top + plotH * 0.28;
    const y2 = top + plotH * 0.72;
    const vPerDiv = 5;
    const yOf = (center, volts) => center - (volts / vPerDiv) * (plotH / 8);
    strokeWave(ctx, left, plotW, windowUs, y1, yOf, ch1, "#ffe08a");
    strokeWave(ctx, left, plotW, windowUs, y2, yOf, ch2, "#8dffb0");
    cursorLine(ctx, left, plotW, top, plotH, windowUs, state.cursor1, "#ffb4a8", "C1", 12);
    cursorLine(ctx, left, plotW, top, plotH, windowUs, state.cursor2, "#9fd7ff", "C2", 12);
    if (state.showRef) {
      const ref = (1e6 / freqHz()) * 0.25 + flightMsAt(state.L) * 1000;
      cursorLine(ctx, left, plotW, top, plotH, windowUs, ref, "rgba(255,255,255,0.7)", "参考", 46);
    }
    ctx.fillStyle = "#ffe08a";
    ctx.font = "12px Consolas, monospace";
    ctx.fillText("CH1", 8, y1);
    ctx.fillStyle = "#8dffb0";
    ctx.fillText("CH2", 8, y2);
  }

  function strokeWave(ctx, left, plotW, windowUs, center, yOf, fn, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    for (let x = 0; x <= plotW; x += 1) {
      const t = (x / plotW) * windowUs;
      const y = yOf(center, fn(t));
      if (x === 0) ctx.moveTo(left + x, y);
      else ctx.lineTo(left + x, y);
    }
    ctx.stroke();
  }

  function cursorLine(ctx, left, plotW, top, plotH, windowUs, tUs, color, label, labelY) {
    const x = left + (tUs / windowUs) * plotW;
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = "11px Consolas, monospace";
    const tw = ctx.measureText(label).width;
    let lx = x + 4;
    if (lx + tw > left + plotW - 2) lx = x - tw - 4;
    ctx.fillText(label, lx, top + (labelY || 12));
  }

  function drawChains() {
    const view = setupCanvas($("chains"));
    if (!view) return;
    const { ctx, w, h } = view;
    ctx.clearRect(0, 0, w, h);
    const P = Math.max(0, nominalPressure() * state.eta);
    const level = Math.max(0, Math.min(1.5, P / 16000));
    const sx = w / 390;
    const sy = h / 160;
    ctx.lineCap = "round";
    LINKS.forEach((link) => {
      const strength = (0.18 + link.align) * (0.28 + level);
      if (strength < 0.34) return;
      const a = PACK[link.i];
      const b = PACK[link.j];
      ctx.strokeStyle = "rgba(228, 177, 90," + Math.min(0.9, strength).toFixed(3) + ")";
      ctx.lineWidth = 1 + strength * 2.4;
      ctx.beginPath();
      ctx.moveTo(a.x * sx, a.y * sy);
      ctx.lineTo(b.x * sx, b.y * sy);
      ctx.stroke();
    });
    PACK.forEach((p) => {
      ctx.fillStyle = state.sampleId === "air" ? "#d5dde6" : sampleById(state.sampleId).bead || "#ccc";
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 4.2 * Math.min(sx, sy), 0, Math.PI * 2);
      ctx.fill();
    });
    let stage = "零载荷或极低压：只有少数近乎水平的接触在传力，声波路径稀疏。";
    if (P >= 12000) stage = "载荷继续增加后，更多接触连成网。声速仍会上升，但增幅往往变缓。相对 0.4 MPa，这里依然是弱压强。";
    else if (P >= 3000) stage = "压力升高：力链分叉、变粗，平行通道变多，声速通常上升得更明显。";
    $("chain-caption").textContent = stage + " 当前内部压力约 " + fmt(P, 0) + " Pa。";
  }

  function alignCursors() {
    const period = 1e6 / freqHz();
    state.cursor1 = period * 0.25;
    state.cursor2 = state.cursor1 + flightMsAt(state.L) * 1000;
  }

  function recordPoint() {
    const dt = (state.cursor2 - state.cursor1) / 1000;
    if (!(dt > 0)) {
      toast("时间差要大于 0。请把 C2 放到 C1 右侧。");
      return;
    }
    if (state.points.some((p) => Math.abs(p.Lmm - state.L) < 0.2)) toast("这个间距附近已经有一组数据。");
    state.points.push({ Lmm: Number(state.L), tMs: dt });
    renderPoints();
    renderLiveFit();
    persist();
  }

  function autoCollect() {
    const prev = state.backlashActive;
    state.backlashActive = false;
    const Ls = [40, 52, 64, 76, 88, 102];
    state.points = Ls.map((L) => ({ Lmm: L, tMs: flightMsAt(L) + gauss() * jitterMs(L) }));
    state.backlashActive = prev;
    state.L = Ls[Ls.length - 1];
    $("length").value = state.L;
    $("length-num").value = state.L.toFixed(2);
    const period = 1e6 / freqHz();
    const last = state.points[state.points.length - 1];
    state.cursor1 = period * 0.25;
    state.cursor2 = state.cursor1 + last.tMs * 1000;
    state.draftKey = keyNow();
    toast("已生成 6 个间距。噪声来自当前信噪比，改表中的数字会改变拟合。");
    drawBench();
    persist();
  }

  function saveRun() {
    const fit = Phys.fitTimeDistance(state.points.map((p) => [p.tMs, p.Lmm]));
    if (!fit.ok || state.points.length < 3) {
      toast("至少记入 3 个间距后再保存这个载荷。");
      return;
    }
    const sample = sampleById(state.sampleId);
    const run = {
      id: uid(),
      source: "mine",
      sampleId: state.sampleId,
      name: sample.id === "custom" ? "自定义 " + Number(state.custom.d).toFixed(1) + " mm" : sample.name,
      material: sample.material === "custom" ? "custom" : sample.material,
      diameterMm: sample.id === "custom" ? Number(state.custom.d) : sample.diameterMm,
      massKg: Number(state.mass),
      points: state.points.map((p) => [p.tMs, p.Lmm])
    };
    state.runs = state.runs.filter((r) => {
      if (r.sampleId !== run.sampleId) return true;
      if (Math.abs(r.massKg - run.massKg) > 0.051) return true;
      if (run.sampleId === "custom" && Math.abs(r.diameterMm - run.diameterMm) > 0.051) return true;
      return false;
    });
    state.runs.push(run);
    state.points = [];
    state.drafts[state.draftKey] = [];
    state.drafts[keyNow()] = [];
    toast(fit.n < 6 ? "已记入 " + fit.n + " 点。原实验每个载荷使用 6 个间距。" : "这个载荷已记入结果。可以改变质量后再测。");
    drawBench();
    persist();
  }

  function dataset() {
    return state.dataTab === "book" ? state.book : state.runs;
  }

  function visibleRuns() {
    const all = dataset();
    if (state.dataTab === "book") return all.filter((r) => r.sampleId === state.bookSample);
    if (state.mineSample === "all") return all;
    return all.filter((r) => r.sampleId === state.mineSample);
  }

  function ensureSelection() {
    const runs = visibleRuns();
    if (!runs.some((r) => r.id === state.selectedId)) state.selectedId = runs.length ? runs[0].id : null;
  }

  function findSelected() {
    return dataset().find((r) => r.id === state.selectedId) || null;
  }

  function renderData() {
    ensureSelection();
    renderPills();
    renderSummary();
    renderEditor();
    drawDataCharts();
    renderCompare();
    $("tab-mine").classList.toggle("active", state.dataTab === "mine");
    $("tab-book").classList.toggle("active", state.dataTab === "book");
  }

  function renderPills() {
    const host = $("sample-pills");
    let items = [];
    if (state.dataTab === "book") items = Data.SAMPLES.filter((s) => s.id !== "custom");
    else {
      items = [{ id: "all", name: "全部" }].concat(Data.SAMPLES.filter((s) => state.runs.some((r) => r.sampleId === s.id)));
    }
    const current = state.dataTab === "book" ? state.bookSample : state.mineSample;
    host.innerHTML = items.map((s) => "<button type='button' data-sample='" + s.id + "'" + (s.id === current ? " class='active'" : "") + ">" + s.name + "</button>").join("");
  }

  function renderSummary() {
    const runs = visibleRuns().map(annotate);
    const showName = state.dataTab === "mine" && state.mineSample === "all";
    $("summary-body").innerHTML = runs.length ? runs.map((r) => {
      const label = r.sampleId === "air" ? (showName ? r.name : "空气对照") : (showName ? r.name + " · " : "") + Number(r.massKg).toFixed(2) + " kg";
      const klass = r.id === state.selectedId ? "selected clickable" : "clickable";
      return "<tr class='" + klass + "' data-id='" + r.id + "'><td>" + label + "</td><td>" + (r.sampleId === "air" ? "—" : fmt(r.P, 1)) + "</td><td>" + (r.fit.ok ? fmt(r.fit.slope, 2) : "—") + "</td><td>" + (r.fit.ok ? fmt(r.fit.r, 6) : "—") + "</td><td>" + (r.fit.ok && r.fit.sm !== null ? fmt(r.fit.sm, 2) : "—") + "</td><td>" + r.points.length + "</td></tr>";
    }).join("") : "<tr><td colspan='6'>还没有数据。虚拟实验台记入载荷后会出现在这里。</td></tr>";
    const selected = findSelected();
    const box = $("exponent-box");
    if (!selected || selected.sampleId === "air") {
      box.innerHTML = "<p class='small muted'>空气是对照，不对它做压强幂指数。当前分析使用 g = " + state.g + " m/s²，管内径 " + state.tubeMm + " mm。</p>";
      return;
    }
    const group = dataset().filter((r) => r.sampleId === selected.sampleId && (selected.sampleId !== "custom" || Math.abs(r.diameterMm - selected.diameterMm) < 0.051)).map(annotate).filter((r) => r.massKg > 0 && r.fit.ok && r.fit.slope > 0);
    if (group.length < 2) {
      box.innerHTML = "<p class='small muted'>这个样品至少还需要 2 个正载荷，才能拟合 ln v 对 ln P 的斜率。</p>";
      return;
    }
    const fl = Phys.fitLogVelocity(group.map((r) => ({ P: r.P, v: r.fit.slope })));
    box.innerHTML = "<p><b>" + selected.name + "</b> 的幂指数 k = " + fmt(fl.slope, 5) + "，R² = " + fmt(fl.r2, 5) + "。<br>与 1/6（" + fmt(1 / 6, 4) + "）相差 " + fmt(fl.slope - 1 / 6, 4) + "，与 1/4（0.2500）相差 " + fmt(fl.slope - 0.25, 4) + "。<br><span class='small muted'>压强按 g = " + state.g + "、D = " + state.tubeMm + " mm 计算。改这两个数会改变 k，不会改变各载荷的声速。</span></p>";
  }

  function renderEditor(force) {
    const run = findSelected();
    const body = $("editor-body");
    $("editor-title").textContent = run ? run.name + " · " + (run.sampleId === "air" ? "空气" : Number(run.massKg).toFixed(2) + " kg") : "数据点";
    if (!run) {
      body.innerHTML = "";
      return;
    }
    if (!force && document.activeElement && document.activeElement.tagName === "INPUT" && body.contains(document.activeElement)) return;
    body.innerHTML = run.points.map((p, i) =>
      "<tr data-i='" + i + "'><td><input class='num t' type='number' step='0.0001' value='" + Number(p[0]).toFixed(4) + "'></td><td><input class='num L' type='number' step='0.001' value='" + Number(p[1]).toFixed(3) + "'></td><td><button type='button' class='del' data-del='" + i + "' aria-label='删除第 " + (i + 1) + " 行'>×</button></td></tr>"
    ).join("");
  }

  function renderCompare() {
    const runs = dataset().map(annotate);
    const ids = [];
    runs.forEach((r) => { if (r.sampleId !== "air" && !ids.includes(r.sampleId + ":" + r.diameterMm)) ids.push(r.sampleId + ":" + r.diameterMm); });
    const rows = ids.map((key) => {
      const [id, d] = key.split(":");
      const group = runs.filter((r) => r.sampleId === id && String(r.diameterMm) === d && r.massKg > 0 && r.fit.ok && r.fit.slope > 0);
      if (group.length < 2) return null;
      const fl = Phys.fitLogVelocity(group.map((r) => ({ P: r.P, v: r.fit.slope })));
      if (!fl.ok) return null;
      return "<tr><td>" + group[0].name + "</td><td>" + fmt(fl.slope, 5) + "</td><td>" + fmt(fl.r2, 4) + "</td><td>" + fmt(fl.slope - 1 / 6, 4) + "</td></tr>";
    }).filter(Boolean);
    $("compare-box").innerHTML = rows.length
      ? "<table><thead><tr><th>样品</th><th>幂指数 k</th><th>R²</th><th>k − 1/6</th></tr></thead><tbody>" + rows.join("") + "</tbody></table>"
      : "<p class='small muted'>正载荷不足时，这里不会给出幂指数。</p>";
  }

  function drawDataCharts() {
    const selected = findSelected() ? annotate(findSelected()) : null;
    const lt = [];
    if (selected && selected.fit.ok) {
      const ts = selected.points.map((p) => p[0]);
      const t0 = Math.min.apply(null, ts);
      const t1 = Math.max.apply(null, ts);
      lt.push({ name: "拟合直线", color: "#e4b15a", width: 2, points: [[t0, selected.fit.slope * t0 + selected.fit.intercept], [t1, selected.fit.slope * t1 + selected.fit.intercept]] });
      lt.push({ name: "测量点", color: "#8dffb0", width: 0, marker: true, points: selected.points.map((p) => [p[0], p[1]]) });
    }
    drawChart($("chart-lt"), { xLabel: "t / ms", yLabel: "L / mm", series: lt });

    const sampleRuns = selected ? dataset().filter((r) => r.sampleId === selected.sampleId && (selected.sampleId !== "custom" || Math.abs(r.diameterMm - selected.diameterMm) < 0.051)).map(annotate).filter((r) => r.fit.ok).sort((a, b) => a.P - b.P) : [];
    const vp = [{ name: selected ? selected.name : "", color: selected ? (sampleById(selected.sampleId).color) : "#fff", marker: true, width: 2, points: sampleRuns.map((r) => [r.P / 1000, r.fit.slope]) }];
    const air = dataset().map(annotate).find((r) => r.sampleId === "air" && r.fit.ok);
    if (air && sampleRuns.length && selected.sampleId !== "air") {
      const maxP = Math.max.apply(null, sampleRuns.map((r) => r.P / 1000).concat([1]));
      vp.push({ name: "空气", color: "#d5dde6", dash: [5, 4], width: 1.5, points: [[0, air.fit.slope], [maxP, air.fit.slope]] });
    }
    drawChart($("chart-vp"), { xLabel: "P / kPa", yLabel: "v / (m/s)", series: selected && selected.sampleId === "air" ? [{ name: "空气", color: "#d5dde6", marker: true, points: [[0, selected.fit.ok ? selected.fit.slope : 0]] }] : vp });

    const logPts = sampleRuns.filter((r) => r.P > 0 && r.fit.slope > 0).map((r) => [Math.log(r.P), Math.log(r.fit.slope)]);
    const logSeries = [{ name: "ln v", color: "#86e7ff", marker: true, width: 0, points: logPts }];
    if (logPts.length >= 2) {
      const fl = Phys.linearRegression(logPts);
      if (fl.ok) {
        const xs = logPts.map((p) => p[0]);
        const a = Math.min.apply(null, xs);
        const b = Math.max.apply(null, xs);
        logSeries.push({ name: "拟合 k=" + fmt(fl.slope, 4), color: "#e4b15a", width: 2, points: [[a, fl.slope * a + fl.intercept], [b, fl.slope * b + fl.intercept]] });
      }
    }
    drawChart($("chart-log"), { xLabel: "ln(P/Pa)", yLabel: "ln(v)", series: logSeries });

    const allSeries = [];
    const grouped = {};
    dataset().forEach((r) => {
      const key = r.sampleId + ":" + r.diameterMm;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(r);
    });
    Object.keys(grouped).forEach((key) => {
      if (key.indexOf("air") === 0) return;
      const rows = grouped[key].map(annotate).filter((r) => r.fit.ok).sort((a, b) => a.P - b.P);
      if (!rows.length) return;
      allSeries.push({
        name: rows[0].name,
        color: sampleById(rows[0].sampleId).color,
        width: 1.6,
        marker: true,
        points: rows.map((r) => [r.P / 1000, r.fit.slope])
      });
    });
    drawChart($("chart-all"), { xLabel: "全部样品  P / kPa", yLabel: "v / (m/s)", series: allSeries });
  }

  function niceStep(span) {
    if (!(span > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(span)));
    const n = span / p;
    const f = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return f * p;
  }

  function legendLines(ctx, series, maxW) {
    ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";
    const items = (series || []).filter((s) => s.name);
    const lines = [];
    let line = [];
    let used = 0;
    items.forEach((s) => {
      const w = 22 + ctx.measureText(s.name).width + 12;
      if (line.length && used + w > maxW) {
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push({ s, w });
      used += w;
    });
    if (line.length) lines.push(line);
    return lines;
  }

  function drawChart(canvas, spec) {
    const view = setupCanvas(canvas);
    if (!view) return;
    const { ctx, w, h } = view;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#101820";
    ctx.fillRect(0, 0, w, h);
    const lines = legendLines(ctx, spec.series, w - 28);
    const pad = { l: 68, r: 14, t: 10 + lines.length * 18, b: 36 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const pts = [];
    (spec.series || []).forEach((s) => (s.points || []).forEach((p) => { if (isFinite(p[0]) && isFinite(p[1])) pts.push(p); }));
    if (!pts.length) {
      ctx.fillStyle = "#95a6b8";
      ctx.font = "13px Segoe UI, Microsoft YaHei, sans-serif";
      ctx.fillText("暂无数据", 24, 36);
      return;
    }
    let xMin = spec.xMin !== undefined ? spec.xMin : Math.min.apply(null, pts.map((p) => p[0]));
    let xMax = spec.xMax !== undefined ? spec.xMax : Math.max.apply(null, pts.map((p) => p[0]));
    let yMin = spec.yMin !== undefined ? spec.yMin : Math.min.apply(null, pts.map((p) => p[1]));
    let yMax = spec.yMax !== undefined ? spec.yMax : Math.max.apply(null, pts.map((p) => p[1]));
    if (xMax === xMin) { xMin -= 1; xMax += 1; }
    if (yMax === yMin) { yMin -= 1; yMax += 1; }
    if (spec.xMin === undefined) { const d = (xMax - xMin) * 0.08; xMin -= d; xMax += d; }
    if (spec.yMin === undefined) { const d = (yMax - yMin) * 0.12; yMin -= d; yMax += d; }
    if (spec.logX) { xMin = Math.max(xMin, 1e-9); xMax = Math.max(xMax, xMin * 1.01); }
    const xOf = (x) => {
      if (spec.logX) return pad.l + (Math.log(x) - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin)) * pw;
      return pad.l + (x - xMin) / (xMax - xMin) * pw;
    };
    const yOf = (y) => pad.t + (yMax - y) / (yMax - yMin) * ph;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.strokeRect(pad.l, pad.t, pw, ph);
    ctx.font = "11px Consolas, monospace";
    const xTicks = spec.logX ? logTicks(xMin, xMax) : linearTicks(xMin, xMax);
    let lastLabelRight = -999;
    xTicks.forEach((tv) => {
      const x = xOf(tv);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      const label = tickText(tv);
      const tw = ctx.measureText(label).width;
      const lx = Math.max(2, Math.min(w - tw - 2, x - tw / 2));
      if (lx < lastLabelRight + 6) return;
      ctx.fillStyle = "#95a6b8";
      ctx.fillText(label, lx, h - 18);
      lastLabelRight = lx + tw;
    });
    linearTicks(yMin, yMax).forEach((tv) => {
      const y = yOf(tv);
      if (y < pad.t - 2 || y > pad.t + ph + 2) return;
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      const label = tickText(tv);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "#95a6b8";
      ctx.fillText(label, pad.l - tw - 6, y + 3);
    });
    if (spec.yLabel) {
      ctx.save();
      ctx.translate(13, pad.t + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#c9d6e2";
      ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(spec.yLabel, 0, 0);
      ctx.restore();
    }
    ctx.fillStyle = "#c9d6e2";
    ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(spec.xLabel || "", pad.l, h - 4);
    lines.forEach((line, li) => {
      let x = pad.l;
      const y = 12 + li * 18;
      line.forEach((item) => {
        ctx.strokeStyle = item.s.color;
        ctx.fillStyle = item.s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(item.s.dash || []);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 14, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (item.s.marker) {
          ctx.beginPath();
          ctx.arc(x + 7, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#c9d6e2";
        ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(item.s.name, x + 18, y + 4);
        x += item.w;
      });
    });
    (spec.vLines || []).forEach((line) => {
      const x = xOf(line.x);
      ctx.strokeStyle = line.color || "rgba(255,144,124,0.8)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      ctx.setLineDash([]);
      if (line.label) {
        ctx.fillStyle = line.color || "#ff907c";
        ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
        ctx.fillText(line.label, Math.min(x + 4, pad.l + pw - 56), pad.t + ph - 6);
      }
    });
    (spec.series || []).forEach((s) => {
      const points = (s.points || []).filter((p) => isFinite(p[0]) && isFinite(p[1]) && (!spec.logX || p[0] > 0));
      if (!points.length) return;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width || 1.5;
      ctx.setLineDash(s.dash || []);
      if ((s.width || 0) > 0 && points.length >= 2) {
        ctx.beginPath();
        points.forEach((p, i) => {
          const x = xOf(p[0]);
          const y = yOf(p[1]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (s.marker) {
        points.forEach((p) => {
          ctx.beginPath();
          ctx.arc(xOf(p[0]), yOf(p[1]), 3.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    });
  }

  function linearTicks(min, max) {
    const step = niceStep((max - min) / 4);
    const out = [];
    let v = Math.ceil(min / step) * step;
    for (let n = 0; n < 8 && v <= max + step * 0.01; n += 1, v += step) out.push(v);
    return out;
  }

  function logTicks(min, max) {
    const out = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
      const v = Math.pow(10, e);
      if (v >= min * 0.99 && v <= max * 1.01) out.push(v);
    }
    return out;
  }

  function tickText(v) {
    const a = Math.abs(v);
    if (a !== 0 && (a >= 10000 || a < 0.01)) return v.toExponential(0);
    if (a >= 100) return String(Math.round(v));
    if (a >= 10) return v.toFixed(1);
    return String(Math.round(v * 100) / 100);
  }

  function hertzParams() {
    return {
      R: clamp(Number($("h-R").value), 0.05, 5) / 1000,
      Z: clamp(Number($("h-Z").value), 3, 14),
      phi: clamp(Number($("h-phi").value), 0.3, 0.9),
      E: clamp(Number($("h-E").value), 1, 500) * 1e9,
      nu: clamp(Number($("h-nu").value), 0, 0.49),
      rho: clamp(Number($("h-rho").value), 100, 25000)
    };
  }

  function hertzP() {
    return clamp(Number($("h-Pnum").value), 0.01, 10) * 1e6;
  }

  function updateHertz() {
    const P = hertzP();
    $("h-pval").textContent = (P / 1e6).toFixed(3) + " MPa";
    const params = hertzParams();
    const now = Phys.hertz(Object.assign({ P }, params));
    const refP = 0.4e6;
    const ref = Phys.hertz(Object.assign({ P: refP }, params));
    const warn = $("h-warning");
    if (P <= refP) {
      warn.hidden = false;
      warn.textContent = "当前压强不高于 0.4 MPa。真实颗粒在这个区间通常低于理想赫兹曲线，幂指数也常常偏离 1/6，有的实验更接近 1/4。本项目实测都在 20 kPa 以下。";
    } else warn.hidden = true;
    if (!now.ok || !ref.ok) {
      $("h-steps").textContent = now.message || ref.message;
      return;
    }
    const scaled = ref.v * Math.pow(P / refP, 1 / 6);
    $("h-steps").innerHTML = [
      "E* = " + fmt(now.EStar / 1e9, 2) + " GPa",
      "ρeff = " + fmt(now.rhoEff, 1) + " kg/m³",
      "F = " + now.F.toExponential(3) + " N",
      "δ = " + fmt(now.delta * 1e6, 3) + " μm",
      "kn = " + now.kn.toExponential(3) + " N/m",
      "Eeff = " + fmt(now.Eeff / 1e6, 2) + " MPa",
      "v = " + fmt(now.v, 2) + " m/s",
      "以 0.4 MPa 为基准的 1/6 标度给出 " + fmt(scaled, 2) + " m/s",
      "两者相对差 " + fmt((now.v - scaled) / scaled * 100, 4) + " %"
    ].join("<br>");
    const other = Phys.hertz(Object.assign({}, params, { P, R: params.R === 0.00036 ? 0.001 : 0.00036 }));
    $("h-radius-note").textContent = other.ok && Math.abs(other.v - now.v) / now.v < 1e-6
      ? "半径改变时声速保持不变：接触刚度里的 R 和升尺度里的 R 正好相消。低压实验看到的粒径差异，要在虚拟实验台的经验模型里看。"
      : "";
    const PsFit = Phys.logSpaced(1e5, 1e6, 80);
    const clean = PsFit.map((Pi) => ({ P: Pi, v: Phys.hertz(Object.assign({ P: Pi }, params)).v }));
    const fl = Phys.fitLogVelocity(clean);
    let kText = "在 100 kPa–1 MPa 上，无噪声斜率 k = " + fmt(fl.slope, 7) + "，理论值 1/6 = " + fmt(1 / 6, 7) + "。";
    if (state.noisy && state.noisy.length) {
      const nf = Phys.fitLogVelocity(state.noisy);
      if (nf.ok) kText += " 加入 ±5% 噪声后，k = " + fmt(nf.slope, 4) + "，R² = " + fmt(nf.r2, 4) + "。";
    }
    $("h-k").innerHTML = "<p>" + kText + "</p>";

    const Ps = Phys.logSpaced(2e3, 1e7, 160);
    const theory = Ps.map((Pi) => [Pi / 1000, Phys.hertz(Object.assign({ P: Pi }, params)).v]);
    const series = [{ name: "赫兹理论", color: "#79e2ff", width: 2, points: theory }];
    const mode = $("h-overlay").value;
    const buckets = {};
    state.book.map(annotate).filter((r) => r.fit.ok && r.P > 0 && r.sampleId !== "air").forEach((r) => {
      const keep = mode === "all" || (mode === "glass" && r.material === "glass") || (mode === "steel" && r.material === "steel");
      if (!keep) return;
      if (!buckets[r.sampleId]) buckets[r.sampleId] = { name: r.name, color: sampleById(r.sampleId).color, points: [] };
      buckets[r.sampleId].points.push([r.P / 1000, r.fit.slope]);
    });
    Object.keys(buckets).forEach((key) => {
      buckets[key].points.sort((a, b) => a[0] - b[0]);
      series.push({ name: buckets[key].name, color: buckets[key].color, marker: true, width: 1.5, points: buckets[key].points });
    });
    if (mode === "mine") {
      const mineBuckets = {};
      state.runs.map(annotate).filter((r) => r.fit.ok && r.P > 0).forEach((r) => {
        const key = r.sampleId + ":" + r.diameterMm;
        if (!mineBuckets[key]) mineBuckets[key] = { name: r.name, color: sampleById(r.sampleId).color || "#8dffb0", points: [] };
        mineBuckets[key].points.push([r.P / 1000, r.fit.slope]);
      });
      Object.keys(mineBuckets).forEach((key) => {
        mineBuckets[key].points.sort((a, b) => a[0] - b[0]);
        series.push({ name: mineBuckets[key].name, color: mineBuckets[key].color, marker: true, width: 1.5, points: mineBuckets[key].points });
      });
    }
    series.push({ name: "当前", color: "#ff907c", marker: true, width: 0, points: [[P / 1000, now.v]] });
    drawChart($("chart-hertz"), {
      xLabel: "P / kPa",
      yLabel: "v / (m/s)",
      logX: true,
      xMin: 2,
      xMax: 10000,
      yMin: 0,
      series,
      vLines: [{ x: 400, color: "rgba(255,144,124,0.9)", label: "0.4 MPa" }]
    });

    const logSeries = [{
      name: "理论",
      color: "#79e2ff",
      width: 2,
      points: clean.map((p) => [Math.log(p.P), Math.log(p.v)])
    }];
    if (state.noisy) {
      logSeries.push({ name: "带噪声", color: "#e4b15a", marker: true, width: 0, points: state.noisy.filter((p) => p.v > 0).map((p) => [Math.log(p.P), Math.log(p.v)]) });
      const nf = Phys.fitLogVelocity(state.noisy);
      if (nf.ok) {
        const a = Math.log(1e5);
        const b = Math.log(1e6);
        logSeries.push({ name: "噪声拟合", color: "#ff907c", dash: [5, 4], width: 2, points: [[a, nf.slope * a + nf.intercept], [b, nf.slope * b + nf.intercept]] });
      }
    }
    drawChart($("chart-hertz-log"), { xLabel: "ln(P/Pa)", yLabel: "ln(v)", series: logSeries });
  }

  function updateDiscussion() {
    $("my-conclusion").innerHTML = describeSet(state.runs, "你在虚拟实验台记入的结果") + describeSet(state.book, "原始数据表按当前 g 和管内径重算");
  }

  function describeSet(runs, title) {
    const ann = runs.map(annotate).filter((r) => r.fit && r.fit.ok && r.fit.slope > 0);
    if (!ann.length) return "<p class='muted'>" + title + "：还没有有效拟合。</p>";
    const bits = ["<p><b>" + title + "</b>。名义压强使用 g = " + state.g + " m/s²，D = " + state.tubeMm + " mm。</p><p>"];
    const air = ann.find((r) => r.sampleId === "air");
    if (air) bits.push("空气声速 " + fmt(air.fit.slope, 1) + " m/s，r = " + fmt(air.fit.r, 6) + "，s<sub>m</sub> = " + fmt(air.fit.sm, 2) + " m/s。");
    const zeros = ann.filter((r) => r.sampleId !== "air" && r.massKg === 0);
    if (zeros.length) {
      bits.push("零载荷：" + zeros.map((r) => r.name + " " + fmt(r.fit.slope, 1) + " m/s").join("，") + "。");
      if (air) {
        const faster = zeros.filter((r) => r.fit.slope >= air.fit.slope - 0.05);
        bits.push(faster.length ? faster.map((r) => r.name).join("、") + " 不低于空气。" : "这些零载荷声速都低于空气。");
      }
    }
    ["glass", "steel"].forEach((mat) => {
      const zs = zeros.filter((r) => r.material === mat).sort((a, b) => a.diameterMm - b.diameterMm);
      if (zs.length < 2) return;
      const rising = zs.every((r, i) => i === 0 || r.fit.slope + 0.4 >= zs[i - 1].fit.slope);
      bits.push((mat === "glass" ? "玻璃珠" : "钢珠") + "随粒径：" + zs.map((r) => r.diameterMm + " mm 为 " + fmt(r.fit.slope, 1)).join("，") + (rising ? "，粒径较大时声速更高。" : "，粒径和声速并不严格同向。"));
    });
    const seen = {};
    ann.forEach((r) => {
      if (r.sampleId === "air" || !(r.massKg > 0)) return;
      const key = r.sampleId + ":" + r.diameterMm;
      if (!seen[key]) seen[key] = [];
      seen[key].push(r);
    });
    const exps = [];
    Object.keys(seen).forEach((key) => {
      const group = seen[key];
      if (group.length < 2) return;
      const fl = Phys.fitLogVelocity(group.map((r) => ({ P: r.P, v: r.fit.slope })));
      if (fl.ok) exps.push(group[0].name + " 的 k = " + fmt(fl.slope, 4) + "（R² = " + fmt(fl.r2, 3) + "）");
    });
    if (exps.length) bits.push(exps.join("；") + "。这些指数若明显分散，就不能归纳成同一个 1/6 或 1/4。");
    bits.push("</p>");
    return bits.join("");
  }

  function setMass(v) {
    stashDraft();
    state.mass = clamp(Number(v), 0, 12);
    $("mass").value = state.mass;
    $("mass-num").value = state.mass.toFixed(2);
    swapDraft();
    drawBench();
    persist();
  }

  function setL(v) {
    const next = clamp(Number(v), 30, 120);
    if (state.backlash && next < state.L - 0.05) state.backlashActive = true;
    if (state.backlashActive && next > state.L + 0.35) state.backlashActive = false;
    state.L = next;
    $("length").value = state.L;
    $("length-num").value = Number(state.L).toFixed(2);
    drawBench();
    persist();
  }

  function setG(v) {
    state.g = clamp(Number(v), 1, 20);
    $("bench-g").value = state.g;
    $("data-g").value = state.g;
    redraw();
    persist();
  }

  function setTube(v) {
    state.tubeMm = clamp(Number(v), 20, 200);
    $("bench-tube").value = state.tubeMm;
    $("data-tube").value = state.tubeMm;
    redraw();
    persist();
  }

  function bind() {
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => show(btn.dataset.view));
    });
    $("sample").addEventListener("change", () => {
      stashDraft();
      state.sampleId = $("sample").value;
      $("custom-box").hidden = state.sampleId !== "custom";
      swapDraft();
      drawBench();
      persist();
    });
    ["custom-d", "custom-E", "custom-nu", "custom-rho"].forEach((id) => {
      $(id).addEventListener("input", () => {
        if (id === "custom-d") stashDraft();
        state.custom.d = clamp(Number($("custom-d").value), 1, 3);
        state.custom.E = clamp(Number($("custom-E").value), 1, 400);
        state.custom.nu = clamp(Number($("custom-nu").value), 0, 0.45);
        state.custom.rho = clamp(Number($("custom-rho").value), 200, 20000);
        if (id === "custom-d") swapDraft();
        drawBench();
        persist();
      });
    });
    $("temp").addEventListener("input", () => { state.T = clamp(Number($("temp").value), 0, 45); drawBench(); persist(); });
    $("mass").addEventListener("input", () => setMass($("mass").value));
    $("mass-num").addEventListener("change", () => setMass($("mass-num").value));
    $("bench-g").addEventListener("change", () => setG($("bench-g").value));
    $("data-g").addEventListener("change", () => setG($("data-g").value));
    $("bench-tube").addEventListener("change", () => setTube($("bench-tube").value));
    $("data-tube").addEventListener("change", () => setTube($("data-tube").value));
    $("length").addEventListener("input", () => setL($("length").value));
    $("length-num").addEventListener("change", () => setL($("length-num").value));
    $("Z").addEventListener("input", () => { state.Z = clamp(Number($("Z").value), 4, 8); drawBench(); persist(); });
    $("phi").addEventListener("input", () => { state.phi = clamp(Number($("phi").value), 0.45, 0.74); drawBench(); persist(); });
    $("eta").addEventListener("input", () => { state.eta = clamp(Number($("eta").value), 0.5, 1); drawBench(); persist(); });
    bindNumber("freq", "freqKHz", 20, 60, false);
    bindNumber("vpp", "vpp", 1, 20, false);
    bindNumber("pulses", "pulses", 1, 12, true);
    bindNumber("period", "periodMs", 1, 200, false);
    $("noise").addEventListener("input", () => { state.noise = clamp(Number($("noise").value), 0, 3); drawBench(); persist(); });
    $("coupling").addEventListener("change", () => { state.coupling = $("coupling").checked; drawBench(); persist(); });
    $("backlash").addEventListener("change", () => {
      state.backlash = $("backlash").checked;
      if (!state.backlash) state.backlashActive = false;
      drawBench();
      persist();
    });
    $("usdiv").addEventListener("change", () => {
      state.timebaseManual = true;
      state.usPerDiv = Number($("usdiv").value);
      drawScope();
      $("scope-meta").textContent = state.usPerDiv + " μs/div";
    });
    $("show-ref").addEventListener("change", () => { state.showRef = $("show-ref").checked; drawScope(); });
    $("btn-peak").addEventListener("click", () => {
      const period = 1e6 / freqHz();
      state.cursor1 = period * 0.25;
      state.cursor2 = state.cursor1 + flightMsAt(state.L) * 1000 + gauss() * jitterMs(state.L) * 1000;
      drawBench();
    });
    $("btn-record").addEventListener("click", recordPoint);
    $("btn-auto").addEventListener("click", autoCollect);
    $("btn-clear").addEventListener("click", () => { state.points = []; drawBench(); persist(); });
    $("btn-save").addEventListener("click", saveRun);
    $("point-body").addEventListener("input", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const i = Number(tr.dataset.i);
      const t = Number(tr.querySelector(".t").value);
      const L = Number(tr.querySelector(".L").value);
      if (isFinite(t) && isFinite(L)) state.points[i] = { tMs: t, Lmm: L };
      renderLiveFit();
      persist();
    });
    $("point-body").addEventListener("focusout", () => {
      setTimeout(() => {
        if (!$("point-body").contains(document.activeElement)) renderPoints(true);
      }, 0);
    });
    $("point-body").addEventListener("click", (e) => {
      if (e.target.dataset.del === undefined) return;
      state.points.splice(Number(e.target.dataset.del), 1);
      renderPoints(true);
      renderLiveFit();
      persist();
    });
    const scope = $("scope");
    scope.addEventListener("pointerdown", (e) => {
      if (!state.plot) return;
      const rect = scope.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const x1 = state.plot.left + (state.cursor1 / state.plot.windowUs) * state.plot.width;
      const x2 = state.plot.left + (state.cursor2 / state.plot.windowUs) * state.plot.width;
      state.drag = Math.abs(x - x1) <= Math.abs(x - x2) ? "c1" : "c2";
      scope.setPointerCapture(e.pointerId);
      moveCursor(e);
    });
    scope.addEventListener("pointermove", (e) => { if (state.drag) moveCursor(e); });
    scope.addEventListener("pointerup", () => { state.drag = null; });
    function moveCursor(e) {
      const rect = scope.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let t = ((x - state.plot.left) / state.plot.width) * state.plot.windowUs;
      t = clamp(t, 0, state.plot.windowUs);
      if (state.drag === "c1") state.cursor1 = t;
      else state.cursor2 = t;
      drawScope();
      const dt = (state.cursor2 - state.cursor1) / 1000;
      $("dt-readout").textContent = dt.toFixed(4);
      $("single-v").textContent = dt > 0 ? fmt(state.L / dt, 1) : "—";
    }

    $("tab-mine").addEventListener("click", () => { state.dataTab = "mine"; state.selectedId = null; renderData(); persist(); });
    $("tab-book").addEventListener("click", () => { state.dataTab = "book"; state.selectedId = null; renderData(); persist(); });
    $("sample-pills").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sample]");
      if (!btn) return;
      if (state.dataTab === "book") state.bookSample = btn.dataset.sample;
      else state.mineSample = btn.dataset.sample;
      state.selectedId = null;
      renderData();
      persist();
    });
    $("summary-body").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      state.selectedId = tr.dataset.id;
      renderSummary();
      renderEditor();
      drawDataCharts();
      persist();
    });
    $("editor-body").addEventListener("input", (e) => {
      const run = findSelected();
      const tr = e.target.closest("tr");
      if (!run || !tr) return;
      const i = Number(tr.dataset.i);
      const t = Number(tr.querySelector(".t").value);
      const L = Number(tr.querySelector(".L").value);
      if (isFinite(t) && isFinite(L)) run.points[i] = [t, L];
      renderSummary();
      renderCompare();
      drawDataCharts();
      if (state.view === "discuss") updateDiscussion();
      persist();
    });
    $("editor-body").addEventListener("focusout", () => {
      setTimeout(() => {
        if (!$("editor-body").contains(document.activeElement)) renderEditor(true);
      }, 0);
    });
    $("editor-body").addEventListener("click", (e) => {
      if (e.target.dataset.del === undefined) return;
      const run = findSelected();
      if (!run) return;
      if (run.points.length <= 2) { toast("至少保留 2 个点才能拟合直线。"); return; }
      run.points.splice(Number(e.target.dataset.del), 1);
      renderEditor(true);
      renderSummary();
      renderCompare();
      drawDataCharts();
      persist();
    });
    $("btn-add-point").addEventListener("click", () => {
      const run = findSelected();
      if (!run) return;
      const last = run.points[run.points.length - 1] || [0.2, 40];
      run.points.push([Number(last[0]) + 0.02, Number(last[1]) + 5]);
      renderEditor();
      renderSummary();
      drawDataCharts();
      persist();
    });
    $("btn-reset-book").addEventListener("click", () => {
      state.book = cloneBook();
      state.selectedId = null;
      renderData();
      persist();
      toast("原始数据已恢复。");
    });
    $("btn-clear-mine").addEventListener("click", () => {
      state.runs = [];
      state.selectedId = null;
      renderData();
      persist();
    });
    $("btn-export").addEventListener("click", exportCsv);
    $("theory-ratio").addEventListener("input", () => {
      const x = Number($("theory-ratio").value);
      $("theory-scale").textContent = Math.pow(x, 1 / 6).toFixed(3);
      $("theory-mult").textContent = x.toFixed(2);
    });

    ["h-Pnum", "h-R", "h-Z", "h-phi", "h-E", "h-nu", "h-rho"].forEach((id) => {
      $(id).addEventListener("input", () => {
        state.noisy = null;
        if (id === "h-Pnum") $("h-P").value = Math.log10(clamp(Number($("h-Pnum").value), 0.01, 10)).toFixed(4);
        updateHertz();
      });
    });
    $("h-P").addEventListener("input", () => {
      state.noisy = null;
      const p = Math.pow(10, Number($("h-P").value));
      $("h-Pnum").value = p.toFixed(3);
      updateHertz();
    });
    $("h-overlay").addEventListener("change", updateHertz);
    $("btn-glass").addEventListener("click", () => {
      state.noisy = null;
      $("h-R").value = 0.36; $("h-Z").value = 5.2; $("h-phi").value = 0.61;
      $("h-E").value = 65; $("h-nu").value = 0.22; $("h-rho").value = 2230;
      $("h-overlay").value = "glass";
      updateHertz();
    });
    $("btn-steel").addEventListener("click", () => {
      state.noisy = null;
      $("h-R").value = 1; $("h-Z").value = 5.2; $("h-phi").value = 0.61;
      $("h-E").value = 200; $("h-nu").value = 0.29; $("h-rho").value = 7800;
      $("h-overlay").value = "steel";
      updateHertz();
    });
    $("btn-noise").addEventListener("click", () => {
      const params = hertzParams();
      state.noisy = Phys.logSpaced(1e5, 1e6, 80).map((P) => {
        const v = Phys.hertz(Object.assign({ P }, params)).v;
        return { P, v: v * (1 + (Math.random() * 2 - 1) * 0.05) };
      });
      updateHertz();
    });
    window.addEventListener("resize", () => requestAnimationFrame(redraw));
    window.addEventListener("hashchange", () => {
      const v = location.hash.replace("#", "");
      if (v && v !== state.view) show(v);
    });
  }

  function exportCsv() {
    const lines = ["来源,样品,质量kg,压强Pa,声速m/s,r,标准差,点数"];
    state.book.concat(state.runs).map(annotate).forEach((r) => {
      lines.push([r.source, r.name, r.massKg, r.sampleId === "air" ? "" : r.P.toFixed(2), r.fit.ok ? r.fit.slope.toFixed(4) : "", r.fit.ok ? r.fit.r.toFixed(9) : "", r.fit.ok && r.fit.sm !== null ? r.fit.sm.toFixed(4) : "", r.points.length].join(","));
    });
    lines.push("");
    lines.push("来源,样品,质量kg,t_ms,L_mm");
    state.book.concat(state.runs).forEach((r) => {
      r.points.forEach((p) => lines.push([r.source, r.name, r.massKg, p[0], p[1]].join(",")));
    });
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "granular-sound-speed.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function init() {
    state.model = Phys.createEmpiricalModel(Data.REFERENCE);
    state.book = cloneBook();
    state.selectedId = state.book.find((r) => r.sampleId === "g1").id;
    load();
    const sel = $("sample");
    Data.SAMPLES.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
    if (!sampleById(state.sampleId)) state.sampleId = "air";
    syncNumbers();
    bind();
    alignCursors();
    const initial = location.hash.replace("#", "");
    show(initial || "guide");
  }

  init();
})();
