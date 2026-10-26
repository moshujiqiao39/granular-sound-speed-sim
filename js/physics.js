/* 时差法拟合、名义压强换算、赫兹接触声速。 */
(function (global) {
  function linearRegression(points) {
    const n = points.length;
    if (n < 2) return { ok: false, message: "至少需要 2 组 (t, L) 数据。" };
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += points[i][0];
      sy += points[i][1];
    }
    const mx = sx / n;
    const my = sy / n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = points[i][0] - mx;
      const dy = points[i][1] - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    if (sxx < 1e-18) return { ok: false, message: "自变量几乎不变，无法拟合斜率。" };
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let r = 0;
    if (syy > 1e-18) r = sxy / Math.sqrt(sxx * syy);
    if (r > 1) r = 1;
    if (r < -1) r = -1;
    let sm = null;
    if (n > 2) {
      const absR = Math.abs(r);
      if (absR > 1 - 1e-15) sm = 0;
      else if (absR > 1e-12) sm = Math.abs(slope) * Math.sqrt((1 / (r * r) - 1) / (n - 2));
    }
    return { ok: true, n, slope, intercept, r, r2: r * r, sm, mx, my, sxx, syy, sxy };
  }

  /** L(mm) = v(m/s) * t(ms) + b(mm)。斜率的单位正好是 m/s。 */
  function fitTimeDistance(points) {
    const fit = linearRegression(points);
    if (!fit.ok) return fit;
    const t0 = fit.slope !== 0 ? -fit.intercept / fit.slope : null;
    return Object.assign({}, fit, { t0 });
  }

  function pressurePa(massKg, g, diameterMm) {
    const radiusM = diameterMm / 1000 / 2;
    const area = Math.PI * radiusM * radiusM;
    if (area <= 0) return NaN;
    return (massKg * g) / area;
  }

  function airSpeed(tempC) {
    return 331.3 + 0.606 * tempC;
  }

  /**
   * P → F → δ → kn → Eeff → v
   * E* = E / (2(1-ν²))，ρeff = ρs φ
   * F = 4πR²P / (Zφ)
   * δ = [3F / (4 E* √R)]^(2/3)
   * kn = 2 E* √(Rδ)
   * Eeff = Zφ kn / (4πR)
   * v = √(Eeff / ρeff) ∝ P^(1/6)
   */
  function hertz(params) {
    const P = params.P;
    const R = params.R;
    const Z = params.Z;
    const phi = params.phi;
    const E = params.E;
    const nu = params.nu;
    const rho = params.rho;
    if (!(P > 0 && R > 0 && Z > 0 && phi > 0 && phi < 1 && E > 0 && rho > 0)) {
      return { ok: false, message: "参数超出物理允许范围。" };
    }
    if (nu <= -1 || nu >= 0.5) return { ok: false, message: "泊松比应在 -1 到 0.5 之间。" };
    const EStar = E / (2 * (1 - nu * nu));
    const rhoEff = rho * phi;
    const F = (P * (4 * Math.PI * R * R)) / (Z * phi);
    const delta = Math.pow((3 * F) / (4 * EStar * Math.sqrt(R)), 2 / 3);
    const kn = 2 * EStar * Math.sqrt(R) * Math.sqrt(delta);
    const Eeff = ((Z * phi) / (4 * Math.PI * R)) * kn;
    const v = Math.sqrt(Eeff / rhoEff);
    return { ok: true, EStar, rhoEff, F, delta, kn, Eeff, v };
  }

  function logSpaced(a, b, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      out.push(a * Math.pow(b / a, t));
    }
    return out;
  }

  function fitLogVelocity(pairs) {
    const pts = [];
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].P > 0 && pairs[i].v > 0) pts.push([Math.log(pairs[i].P), Math.log(pairs[i].v)]);
    }
    if (pts.length < 2) return { ok: false, message: "至少需要 2 个正压强下的声速才能估计幂指数。" };
    return linearRegression(pts);
  }

  function vOnCurve(pts, P) {
    if (!pts.length) return NaN;
    if (P <= pts[0].P) return pts[0].v;
    const last = pts[pts.length - 1];
    if (P >= last.P) {
      if (pts.length < 2) return last.v;
      const a = pts[pts.length - 2];
      if (a.P > 0 && last.P > a.P && a.v > 0 && last.v > 0) {
        let k = Math.log(last.v / a.v) / Math.log(last.P / a.P);
        if (!isFinite(k)) k = 0;
        k = Math.max(0, Math.min(0.25, k));
        return last.v * Math.pow(P / last.P, k);
      }
      return last.v;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (P <= b.P) {
        const span = b.P - a.P;
        const t = span === 0 ? 0 : (P - a.P) / span;
        return a.v + t * (b.v - a.v);
      }
    }
    return last.v;
  }

  /** 用已测声速建立 v(P)。压强按 g=9.8、管内径 80 mm 换算。 */
  function createEmpiricalModel(runs) {
    const curves = { glass: {}, steel: {} };
    runs.forEach((run) => {
      if (run.material !== "glass" && run.material !== "steel") return;
      const fit = fitTimeDistance(run.points);
      if (!fit.ok || !(fit.slope > 0)) return;
      const P = pressurePa(run.massKg, 9.8, 80);
      const d = run.diameterMm;
      if (!curves[run.material][d]) curves[run.material][d] = [];
      curves[run.material][d].push({ P, v: fit.slope, mass: run.massKg });
    });
    ["glass", "steel"].forEach((mat) => {
      Object.keys(curves[mat]).forEach((d) => {
        curves[mat][d].sort((a, b) => a.P - b.P);
      });
    });

    function speedAt(material, diameterMm, P) {
      const family = curves[material];
      if (!family) return NaN;
      const vOf = (d) => vOnCurve(family[d] || [], P);
      const d = diameterMm;
      if (d <= 1) return vOf(1);
      if (d >= 3) return vOf(3);
      if (d <= 2) {
        const t = d - 1;
        return vOf(1) * (1 - t) + vOf(2) * t;
      }
      const t = d - 2;
      return vOf(2) * (1 - t) + vOf(3) * t;
    }

    return { curves, speedAt };
  }

  function packingFactor(Z, phi) {
    return Math.pow(Z / 5.2, 1 / 3) * Math.pow(phi / 0.61, -1 / 6);
  }

  function materialSoftRatio(E, nu, rho) {
    const glass = hertz({ P: 1e5, R: 1e-3, Z: 5.2, phi: 0.61, E: 65e9, nu: 0.22, rho: 2230 });
    const user = hertz({ P: 1e5, R: 1e-3, Z: 5.2, phi: 0.61, E, nu, rho });
    if (!glass.ok || !user.ok || !(glass.v > 0)) return 1;
    return Math.pow(user.v / glass.v, 0.4);
  }

  function format(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    return Number(n).toFixed(digits);
  }

  const api = {
    linearRegression,
    fitTimeDistance,
    pressurePa,
    airSpeed,
    hertz,
    logSpaced,
    fitLogVelocity,
    createEmpiricalModel,
    packingFactor,
    materialSoftRatio,
    format
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LabPhysics = api;
})(typeof window !== "undefined" ? window : globalThis);
