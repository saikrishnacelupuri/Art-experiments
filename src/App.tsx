import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Upload, Download, RefreshCw, X } from "lucide-react";

/**
 * Monochrome Dithering Editor
 * -------------------------------------------------------------
 * Single-file React component. Upload an image, choose an algorithm,
 * tweak tonal controls, pick a palette, preview side-by-side, and export PNG.
 *
 * Tailwind is available by default in this environment.
 */

// ---------- Utility: palettes ----------
const PALETTES: Record<string, { fg: string; bg: string }> = {
  "Black & White": { fg: "#000000", bg: "#ffffff" },
  Sepia: { fg: "#3e2f1c", bg: "#f3e8d0" },
  "Indigo & Ivory": { fg: "#1e1b4b", bg: "#fffff0" },
  "Teal & Sand": { fg: "#0f766e", bg: "#fbf1c7" },
  "Crimson & Cream": { fg: "#8b0000", bg: "#fff4f4" },
  "Forest & Sky": { fg: "#064e3b", bg: "#f0f9ff" },
};

// ---------- Utility: Bayer matrices ----------
const BAYER_2 = [
  [0, 2],
  [3, 1],
];
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const BAYER_8 = (() => {
  // Generate 8x8 from 4x4 recursively (simple expansion)
  // A known 8x8 Bayer matrix (0..63)
  return [
    [0, 48, 12, 60, 3, 51, 15, 63],
    [32, 16, 44, 28, 35, 19, 47, 31],
    [8, 56, 4, 52, 11, 59, 7, 55],
    [40, 24, 36, 20, 43, 27, 39, 23],
    [2, 50, 14, 62, 1, 49, 13, 61],
    [34, 18, 46, 30, 33, 17, 45, 29],
    [10, 58, 6, 54, 9, 57, 5, 53],
    [42, 26, 38, 22, 41, 25, 37, 21],
  ];
})();

// ---------- Types ----------
const ALGORITHMS = [
  "Threshold",
  "Floyd–Steinberg",
  "Atkinson",
  "Ordered Bayer 2x2",
  "Ordered Bayer 4x4",
  "Ordered Bayer 8x8",
  "Random",
] as const;

type Algorithm = typeof ALGORITHMS[number];

const DITHER_SIZES = [1, 2, 4, 8, 16, 32];

// ---------- Component ----------
export default function MonochromeDitheringEditor() {
  const [imageURL, setImageURL] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [algorithm, setAlgorithm] = useState<Algorithm>("Floyd–Steinberg");
  const [paletteKey, setPaletteKey] = useState<string>("Black & White");
  const [ditherSize, setDitherSize] = useState<number>(4);

  // tonal controls
  const [brightness, setBrightness] = useState<number>(0); // range -100..100
  const [contrast, setContrast] = useState<number>(0); // -100..100
  const [gamma, setGamma] = useState<number>(1); // 0.2 .. 3
  const [invert, setInvert] = useState<boolean>(false);
  const [threshold, setThreshold] = useState<number>(128); // 0..255 (for Threshold algo)

  const imgRef = useRef<HTMLImageElement>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const ditherCanvasRef = useRef<HTMLCanvasElement>(null);

  // drag & drop handlers
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) readFile(f);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function readFile(file: File) {
    const url = URL.createObjectURL(file);
    setImageURL(url);
    setFileName(file.name);
  }

  // image load draws to the original canvas
  useEffect(() => {
    const img = imgRef.current;
    const oc = originalCanvasRef.current;
    if (!img || !oc || !imageURL) return;

    const handleLoad = () => {
      const maxW = 900; // constrain working size for perf
      const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      oc.width = w;
      oc.height = h;
      const ctx = oc.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      // After drawing original, process for dither preview
      processImage();
    };

    img.addEventListener("load", handleLoad);
    return () => img.removeEventListener("load", handleLoad);
  }, [imageURL]);

  // recompute when settings change
  useEffect(() => {
    if (!imageURL) return;
    const id = window.setTimeout(() => processImage(), 60);
    return () => window.clearTimeout(id);
  }, [algorithm, paletteKey, ditherSize, brightness, contrast, gamma, invert, threshold]);

  // ---------- Core processing ----------
  function applyTonalAdjustments(v: number): number {
    // v in [0,255]
    let x = v / 255; // [0,1]
    // brightness: simple add in linear domain
    x = x + brightness / 100;
    // contrast: scale around 0.5
    if (contrast !== 0) {
      const c = (100 + contrast) / 100; // 0..2
      x = (x - 0.5) * c + 0.5;
    }
    // gamma: pow mapping
    if (gamma > 0 && gamma !== 1) {
      x = Math.pow(Math.max(0, Math.min(1, x)), 1 / gamma);
    } else {
      x = Math.max(0, Math.min(1, x));
    }
    if (invert) x = 1 - x;
    return Math.round(x * 255);
  }

  function toLuma(r: number, g: number, b: number): number {
    // Rec. 709 luma
    return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }

  function processImage() {
    const oc = originalCanvasRef.current;
    const dc = ditherCanvasRef.current;
    if (!oc || !dc) return;
    const w = oc.width;
    const h = oc.height;
    if (!w || !h) return;

    const octx = oc.getContext("2d");
    const dctx = dc.getContext("2d");
    if (!octx || !dctx) return;

    const src = octx.getImageData(0, 0, w, h);
    const gray = new Uint8ClampedArray(w * h); // grayscale after tonal controls

    // 1) grayscale + adjustments
    for (let i = 0, p = 0; i < src.data.length; i += 4, p++) {
      const l = toLuma(src.data[i], src.data[i + 1], src.data[i + 2]);
      gray[p] = applyTonalAdjustments(l);
    }

    // 2) dither -> binary mask (0/1)
    const mask = new Uint8ClampedArray(w * h);

    switch (algorithm) {
      case "Threshold": {
        const T = Math.max(0, Math.min(255, threshold));
        for (let p = 0; p < gray.length; p++) mask[p] = gray[p] >= T ? 1 : 0;
        break;
      }
      case "Random": {
        for (let p = 0; p < gray.length; p++) {
          const rnd = Math.random() * 255;
          mask[p] = gray[p] >= rnd ? 1 : 0;
        }
        break;
      }
      case "Ordered Bayer 2x2":
      case "Ordered Bayer 4x4":
      case "Ordered Bayer 8x8": {
        const m = algorithm.includes("2x2") ? BAYER_2 : algorithm.includes("4x4") ? BAYER_4 : BAYER_8;
        const n = m.length;
        const scale = n * n; // max index + 1
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const t = ((m[y % n][x % n] + 0.5) * 255) / scale; // 0..255
            mask[idx] = gray[idx] > t ? 1 : 0;
          }
        }
        break;
      }
      case "Floyd–Steinberg": {
        const buf = new Float32Array(gray.length);
        for (let i = 0; i < gray.length; i++) buf[i] = gray[i];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const old = buf[i];
            const newVal = old < 128 ? 0 : 255;
            mask[i] = newVal === 255 ? 1 : 0;
            const err = old - newVal;
            if (x + 1 < w) buf[i + 1] += (err * 7) / 16;
            if (y + 1 < h) {
              if (x > 0) buf[i + w - 1] += (err * 3) / 16;
              buf[i + w] += (err * 5) / 16;
              if (x + 1 < w) buf[i + w + 1] += (err * 1) / 16;
            }
          }
        }
        break;
      }
      case "Atkinson": {
        const buf = new Float32Array(gray.length);
        for (let i = 0; i < gray.length; i++) buf[i] = gray[i];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const old = buf[i];
            const newVal = old < 128 ? 0 : 255;
            mask[i] = newVal === 255 ? 1 : 0;
            const err = (old - newVal) / 8; // Atkinson spreads 1/8 to 6 neighbors (some versions 1/8 to up to 8)
            // neighbors
            if (x + 1 < w) buf[i + 1] += err;
            if (x + 2 < w) buf[i + 2] += err;
            if (y + 1 < h) {
              if (x > 0) buf[i + w - 1] += err;
              buf[i + w] += err;
              if (x + 1 < w) buf[i + w + 1] += err;
            }
            if (y + 2 < h) buf[i + 2 * w] += err;
          }
        }
        break;
      }
    }

    // 3) paint to dither canvas with palette + pixel size (ditherSize)
    const { fg, bg } = PALETTES[paletteKey];

    const outW = w * ditherSize;
    const outH = h * ditherSize;
    dc.width = outW;
    dc.height = outH;

    // draw pixel blocks
    dctx.imageSmoothingEnabled = false;
    dctx.save();
    dctx.fillStyle = bg;
    dctx.fillRect(0, 0, outW, outH);
    dctx.fillStyle = fg;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          dctx.fillRect(x * ditherSize, y * ditherSize, ditherSize, ditherSize);
        }
      }
    }

    dctx.restore();
  }

  // ---------- Export ----------
  function downloadPNG() {
    const dc = ditherCanvasRef.current;
    if (!dc) return;
    const a = document.createElement("a");
    a.href = dc.toDataURL("image/png");
    a.download = (fileName ? fileName.replace(/\.[^.]+$/, "") : "dithered") + "_" + algorithm.replace(/\s+/g, "-") + ".png";
    a.click();
  }

  function clearImage() {
    setImageURL(null);
    setFileName("");
    const oc = originalCanvasRef.current;
    const dc = ditherCanvasRef.current;
    if (oc) {
      oc.width = 0; oc.height = 0;
    }
    if (dc) {
      dc.width = 0; dc.height = 0;
    }
  }

  const palette = useMemo(() => PALETTES[paletteKey], [paletteKey]);

  return (
    <div className="min-h-screen w-full bg-zinc-950 text-zinc-100 flex flex-col md:flex-row">
      {/* Left Sidebar - Controls */}
      <div className="w-full md:w-80 bg-zinc-900/50 border-b md:border-b-0 md:border-r border-zinc-800 flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-zinc-800">
          <h1 className="text-xl font-semibold tracking-tight">Dithering Editor</h1>
          <p className="text-zinc-400 text-sm mt-1">Configure your dithering settings</p>
        </div>

        {/* Scrollable Controls */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Image Upload */}
          <div>
            <div className="text-xs uppercase text-zinc-400 mb-3 font-medium">IMAGE</div>
            <div className="space-y-3">
              <label className="flex items-center justify-center w-full px-4 py-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition cursor-pointer border border-zinc-700">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) readFile(f);
                  }}
                />
                <span className="text-sm">Choose File</span>
              </label>
              {fileName && (
                <div className="text-xs text-zinc-400 truncate" title={fileName}>
                  {fileName}
                </div>
              )}
              {imageURL && (
                <button 
                  onClick={clearImage} 
                  className="text-xs text-zinc-300 hover:text-white underline underline-offset-2"
                >
                  Clear Image
                </button>
              )}
            </div>
          </div>

          {/* Algorithm */}
          <div>
            <div className="text-xs uppercase text-zinc-400 mb-3 font-medium">ALGORITHM</div>
            <select
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-600"
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as Algorithm)}
            >
              {ALGORITHMS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          {/* Palette */}
          <div>
            <div className="text-xs uppercase text-zinc-400 mb-3 font-medium">PALETTE</div>
            <select
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-600 mb-3"
              value={paletteKey}
              onChange={(e) => setPaletteKey(e.target.value)}
            >
              {Object.keys(PALETTES).map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Colors:</span>
              <span className="inline-block w-6 h-6 rounded border border-zinc-600" style={{ background: palette.bg }} />
              <span className="inline-block w-6 h-6 rounded border border-zinc-600" style={{ background: palette.fg }} />
            </div>
          </div>

          {/* Dither Size */}
          <div>
            <div className="text-xs uppercase text-zinc-400 mb-3 font-medium">PIXEL SIZE</div>
            <select
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-zinc-600"
              value={ditherSize}
              onChange={(e) => setDitherSize(parseInt(e.target.value, 10))}
            >
              {DITHER_SIZES.map((s) => (
                <option key={s} value={s}>{s}px</option>
              ))}
            </select>
          </div>

          {/* Threshold */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase text-zinc-400 font-medium">THRESHOLD</div>
              <div className="text-xs text-zinc-400 tabular-nums">{threshold}</div>
            </div>
            <input
              type="range"
              min={0}
              max={255}
              value={threshold}
              disabled={algorithm !== "Threshold"}
              onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
              className="w-full accent-zinc-100 disabled:opacity-50"
            />
          </div>

          {/* Tonal Controls */}
          <div>
            <div className="text-xs uppercase text-zinc-400 mb-3 font-medium">TONAL ADJUSTMENTS</div>
            <div className="space-y-4">
              <Slider
                label="Brightness"
                value={brightness}
                min={-100}
                max={100}
                step={1}
                onChange={setBrightness}
                compact
              />
              <Slider
                label="Contrast"
                value={contrast}
                min={-100}
                max={100}
                step={1}
                onChange={setContrast}
                compact
              />
              <Slider
                label="Gamma"
                value={gamma}
                min={0.2}
                max={3}
                step={0.01}
                onChange={setGamma}
                compact
              />
            </div>
          </div>

          {/* Invert Toggle */}
          <div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase text-zinc-400 font-medium">INVERT</div>
                <div className="text-xs text-zinc-500 mt-1">Flip black/white</div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
                <div className={`w-10 h-6 rounded-full transition ${invert ? "bg-zinc-200" : "bg-zinc-700"}`}>
                  <div className={`h-6 w-6 bg-white rounded-full shadow transition transform ${invert ? "translate-x-4" : "translate-x-0"}`} />
                </div>
              </label>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3 pt-4">
            <button
              onClick={() => processImage()}
              className="w-full px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition text-sm border border-zinc-700"
            >
              Reprocess
            </button>
            <button
              onClick={downloadPNG}
              className="w-full px-4 py-2 rounded-lg bg-white text-zinc-900 hover:bg-gray-100 transition text-sm font-medium"
              disabled={!imageURL}
            >
              Download PNG
            </button>
          </div>
        </div>
      </div>

      {/* Right Main Area - Preview */}
      <div className="flex-1 flex flex-col">
        {/* Main Content */}
        <div className="flex-1 p-6">
          {!imageURL ? (
            /* Dropzone */
            <div
              onDrop={onDrop}
              onDragOver={onDragOver}
              className="w-full h-full min-h-96 border-2 border-dashed border-zinc-700 rounded-2xl flex items-center justify-center text-center p-8 hover:border-zinc-600 transition-colors"
            >
              <div>
                <div className="text-4xl mb-4">📷</div>
                <div className="text-lg text-zinc-300 mb-2">Drag & drop an image here</div>
                <div className="text-sm text-zinc-500">or use the Choose File button in the sidebar</div>
              </div>
            </div>
          ) : (
            /* Preview Panes */
            <div className="h-full grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col">
                <div className="text-xs uppercase text-zinc-500 mb-3 font-medium">ORIGINAL</div>
                <div className="flex-1 bg-black/20 rounded-xl overflow-hidden border border-zinc-800 flex items-center justify-center">
                  <canvas ref={originalCanvasRef} className="max-w-full max-h-full object-contain" />
                </div>
              </div>
              <div className="flex flex-col">
                <div className="text-xs uppercase text-zinc-500 mb-3 font-medium">DITHERED PREVIEW</div>
                <div className="flex-1 bg-black/20 rounded-xl overflow-hidden border border-zinc-800 flex items-center justify-center">
                  <canvas ref={ditherCanvasRef} className="max-w-full max-h-full object-contain" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 text-xs text-zinc-500">
          Algorithms: Threshold, Floyd–Steinberg, Atkinson, Ordered Bayer (2×2, 4×4, 8×8), Random
        </div>
      </div>

      {/* Hidden img for decoding */}
      <img ref={imgRef} src={imageURL ?? undefined} alt="uploaded" className="hidden" />
    </div>
  );
}

function Slider({ 
  label, 
  value, 
  min, 
  max, 
  step, 
  onChange, 
  compact 
}: { 
  label: string; 
  value: number; 
  min: number; 
  max: number; 
  step?: number; 
  onChange: (v: number) => void;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-zinc-400">{label}</div>
          <div className="text-xs text-zinc-400 tabular-nums">
            {typeof value === "number" ? value.toFixed(step && step < 1 ? 2 : 0) : value}
          </div>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step ?? 1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full accent-zinc-100"
        />
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase text-zinc-400">{label}</div>
        <div className="text-xs text-zinc-400 tabular-nums">
          {typeof value === "number" ? value.toFixed(step && step < 1 ? 2 : 0) : value}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-zinc-100"
      />
    </div>
  );
}
