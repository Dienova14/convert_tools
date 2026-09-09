import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";

import { readPage, stripRunningHeaders } from "./lib/page-content.js";
import { buildDocumentTable } from "./lib/document.js";
import { downloadCsv, downloadWorkbook } from "./lib/export.js";
import { readOcrPage, terminateOcrWorker } from "./lib/ocr/ocr-adapter.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const MAX_FILE_SIZE = 40 * 1024 * 1024;
const PREVIEW_LIMIT = 400;

const $ = id => document.getElementById(id);

const dropzone = $("dropzone");
const fileInput = $("fileInput");
const statusBox = $("status");
const workspace = $("workspace");
const previewWrap = $("previewWrap");
const progressBar = $("progressBar");

let currentFile = null;
let table = null;

/* Status & progres */

function setStatus(message, tone = "info") {
  statusBox.textContent = message || "";
  statusBox.dataset.tone = tone;
  statusBox.classList.toggle("hidden", !message);
}

function setProgress(value) {
  progressBar.parentElement.classList.toggle("hidden", value === null);
  progressBar.style.width = `${Math.round((value ?? 0) * 100)}%`;
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

/* Pilih berkas */

function selectFile(file) {
  if (!file) return;

  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    setStatus("Berkas harus PDF.", "error");
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    setStatus(`Ukuran ${formatBytes(file.size)} melebihi batas 40 MB.`, "error");
    return;
  }

  currentFile = file;
  table = null;

  $("fileName").textContent = file.name;
  $("fileMeta").textContent = `· ${formatBytes(file.size)}`;

  workspace.classList.remove("hidden");
  previewWrap.classList.add("hidden");
  setStatus("");
}

fileInput.addEventListener("change", event => selectFile(event.target.files[0]));

["dragenter", "dragover"].forEach(name =>
  dropzone.addEventListener(name, event => {
    event.preventDefault();
    dropzone.classList.add("drag");
  })
);

["dragleave", "drop"].forEach(name =>
  dropzone.addEventListener(name, event => {
    event.preventDefault();
    dropzone.classList.remove("drag");
  })
);

dropzone.addEventListener("drop", event => selectFile(event.dataTransfer.files[0]));

dropzone.addEventListener("click", event => {
  if (event.target.closest("label")) return;
  fileInput.click();
});

dropzone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

$("removeBtn").addEventListener("click", () => {
  currentFile = null;
  table = null;
  fileInput.value = "";

  workspace.classList.add("hidden");
  previewWrap.classList.add("hidden");
  setProgress(null);
  setStatus("");
});

/* Rentang halaman */

function parsePageRange(input, total) {
  const text = String(input || "").trim();
  if (!text) return Array.from({ length: total }, (_, i) => i + 1);

  const selected = new Set();

  for (const part of text.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;

    const match = chunk.match(/^(\d+)?\s*-\s*(\d+)?$/);

    if (match) {
      const from = Math.max(1, Number(match[1] || 1));
      const to = Math.min(total, Number(match[2] || total));
      for (let page = from; page <= to; page++) selected.add(page);
      continue;
    }

    const single = Number(chunk);
    if (Number.isInteger(single) && single >= 1 && single <= total) selected.add(single);
  }

  return [...selected].sort((a, b) => a - b);
}

function readOptions() {
  return {
    mode: $("tableMode").value,
    headerMode: $("headerMode").value,
    mergeMode: $("mergeMode").value,
    numberLocale: $("numberLocale").value,
    joinWrapped: $("joinWrapped").value === "on",
    joinAcrossPages: true,
    ocrLanguage: $("ocrLanguage")?.value || "eng",
    ocrScale: Number($("ocrScale")?.value || 3)
  };
}

function updateOcrUi() {
  const isOcr = $("tableMode").value === "ocr-adaptive";
  const isCatalog = $("tableMode").value === "catalog";
  $("ocrSettings")?.classList.toggle("hidden", !isOcr);
  const hint = $("modeHint");
  if (hint) {
    if (isCatalog) {
      hint.innerHTML = 'Mode <strong>Catalog Detection</strong> memisahkan setiap halaman katalog menjadi worksheet terpisah, mempertahankan header bertingkat dan section, tanpa mengubah engine lain.';
      return;
    }
    hint.innerHTML = isOcr
      ? 'Mode <strong>OCR Adaptive</strong> merender setiap halaman menjadi gambar, membaca kata + koordinat dengan OCR, lalu memakai engine Adaptive yang sama untuk mendeteksi kolom/baris. OCR berjalan lokal di browser.'
      : 'Gunakan <strong>Adaptive Detection</strong> untuk layout yang tidak konsisten. Jika PDF punya border, Adaptive akan memanfaatkan grid tersebut terlebih dahulu; jika tidak ada border, Adaptive mencari beberapa kemungkinan batas kolom lalu memilih struktur dengan skor terbaik.';
  }
}

$("tableMode").addEventListener("change", updateOcrUi);
updateOcrUi();

/* Perubahan opsi

   Preview dibangun dari snapshot opsi saat Preview ditekan.
   Jika opsi berubah setelah Preview, table lama tidak boleh dipakai
   untuk Download. User harus Preview ulang agar hasil tetap sinkron. */

const optionIds = [
  "tableMode",
  "headerMode",
  "mergeMode",
  "joinWrapped",
  "numberLocale",
  "pageRange"
];

for (const id of optionIds) {
  $(id).addEventListener("change", () => {
    if (!table) return;

    table = null;
    previewWrap.classList.add("hidden");
    setStatus("Opsi berubah. Klik Preview untuk membangun ulang tabel.", "info");
  });
}

/* Ekstraksi */

$("extractBtn").addEventListener("click", async () => {
  if (!currentFile) return;

  const button = $("extractBtn");
  button.disabled = true;
  button.textContent = "Membaca…";

  previewWrap.classList.add("hidden");
  setProgress(0);

  let document_ = null;

  try {
    const buffer = await currentFile.arrayBuffer();
    document_ = await pdfjsLib.getDocument({ data: buffer }).promise;

    const pageNumbers = parsePageRange($("pageRange").value, document_.numPages);

    if (!pageNumbers.length) {
      throw new Error(`Rentang halaman kosong. Dokumen ini punya ${document_.numPages} halaman.`);
    }

    const options = readOptions();
    const pages = [];

    for (let i = 0; i < pageNumbers.length; i++) {
      const pageNumber = pageNumbers[i];
      setStatus(`Membaca halaman ${pageNumber} (${i + 1} dari ${pageNumbers.length})…`);
      setProgress(i / pageNumbers.length);

      const page = await document_.getPage(pageNumber);
      let content;

      if (options.mode === "ocr-adaptive") {
        content = await readOcrPage(page, {
          language: options.ocrLanguage,
          scale: options.ocrScale,
          onProgress: progress => {
            const pageBase = i / pageNumbers.length;
            const pageSpan = 1 / pageNumbers.length;
            setProgress(Math.min(0.94, pageBase + progress * pageSpan));
          }
        });
      } else {
        content = await readPage(page, pdfjsLib, {
          readRulings: options.mode !== "stream",
          // Footer/outside-table cleanup is Adaptive-only. Catalog keeps the
          // exact previous readPage behavior.
          stripTableFooter: options.mode === "adaptive"
        });
      }

      if (options.mode === "ocr-adaptive" && !content.words?.length) {
        const detail = [
          `output=${content.ocrOutput || "empty"}`,
          `text=${content.ocrTextLength ?? 0} karakter`,
          `words=${content.ocrWordCount ?? 0}`
        ].join(", ");

        throw new Error(
          `OCR selesai tetapi tidak menghasilkan word + koordinat yang dapat dipakai untuk tabel ` +
          `(${detail}). Coba English terlebih dahulu, lalu cek resolusi OCR dan console browser.`
        );
      }

      pages.push({ ...content, pageNumber });
      page.cleanup();

      await yieldToUi();
    }

    setProgress(0.95);
    setStatus("Menyusun tabel…");

    if (options.mode !== "catalog") stripRunningHeaders(pages);

    const tableOptions = options.mode === "ocr-adaptive"
      ? { ...options, mode: "adaptive", inputSource: "ocr" }
      : options;

    table = buildDocumentTable(pages, tableOptions);

    renderPreview(table);
    previewWrap.classList.remove("hidden");

    const modeLabel = {
      lattice: "garis border",
      hybrid: "garis baris + celah spasi",
      stream: "celah spasi",
      grouped: "price list bertingkat",
      adaptive: "adaptive column detection",
      "adaptive-rowgap": "adaptive row-gap recovery",
      "ruling-stream": "vertical ruling + stream rows",
      "adaptive-lattice": "adaptive detection + border grid",
      "ocr-adaptive": "OCR + adaptive column detection",
      catalog: "catalog / multi-table structured detection"
    };

    const detected = options.mode === "ocr-adaptive"
      ? "OCR + adaptive column detection"
      : table.modes.map(mode => modeLabel[mode] || mode).join(", ");

    const catalogText = options.mode === "catalog" && table.tableCount
      ? ` ${table.tableCount} worksheet terdeteksi.`
      : "";

    const confidenceText = Number.isFinite(table.confidence)
      ? ` Confidence struktur: ${Math.round(table.confidence * 100)}%.`
      : "";

    const ocrConfidence = options.mode === "ocr-adaptive"
      ? pages.map(page => Number(page.ocrConfidence)).filter(Number.isFinite)
      : [];
    const ocrConfidenceText = ocrConfidence.length
      ? ` Confidence OCR rata-rata: ${Math.round(ocrConfidence.reduce((a, b) => a + b, 0) / ocrConfidence.length * 100)}%.`
      : "";

    const displayedRowCount = options.mode === "catalog" && Array.isArray(table.sheets)
      ? table.sheets.reduce((sum, sheet) =>
          sum + (sheet.leadingRows?.length || 0) +
          (sheet.headerRows?.length || 0) +
          (sheet.rows?.length || 0), 0)
      : table.rows.length;

    if (options.mode === "catalog" && table.diagnostics) {
      const d = table.diagnostics;
      console.debug("[Catalog diagnostics]", d);
    }

    // Diagnostics Adaptive: tampilkan jalur row-builder per halaman agar
    // regression rowgap/stream mudah dibedakan tanpa menebak dari hasil Excel.
    if (options.mode === "adaptive" && table.pageModes?.length) {
      for (const page of table.pageModes) {
        console.debug(
          `[Adaptive layout] page=${page.pageNumber} mode=${page.mode} confidence=${Number.isFinite(page.confidence) ? page.confidence.toFixed(3) : "n/a"}`
        );
      }
    }

    setStatus(
      `Selesai. ${displayedRowCount} baris × ${table.columnCount} kolom dari ${table.pageCount} halaman.${catalogText} Struktur dibaca lewat ${detected}.${confidenceText}${ocrConfidenceText}`,
      "ok"
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Gagal membaca tabel dari PDF ini.", "error");
    previewWrap.classList.add("hidden");
    table = null;
  } finally {
    if (document_) document_.destroy();
    await terminateOcrWorker();
    setProgress(null);
    button.disabled = false;
    button.textContent = "Preview";
  }
});

/* Preview */

function renderPreview(result) {
  const element = $("previewTable");
  element.innerHTML = "";

  if (result.header || result.headerRows?.length) {
    const head = document.createElement("thead");
    for (const row of (result.headerRows?.length ? result.headerRows : [result.header]).filter(Boolean)) {
      head.appendChild(buildRowElement(row, "th"));
    }
    element.appendChild(head);
  }

  const body = document.createElement("tbody");

  const previewRows = [
    ...(result.leadingRows || []),
    ...(result.rows || [])
  ];

  for (const row of previewRows.slice(0, PREVIEW_LIMIT)) {
    body.appendChild(buildRowElement(row, "td"));
  }

  element.appendChild(body);

  const totalPreviewRows = (result.leadingRows?.length || 0) + (result.rows?.length || 0);
  const shown = Math.min(totalPreviewRows, PREVIEW_LIMIT);
  $("rowCount").textContent =
    totalPreviewRows > shown
      ? `${result.rows.length} baris data · menampilkan ${shown} pertama`
      : `${result.rows.length} baris data`;
}

function buildRowElement(row, tag) {
  const tr = document.createElement("tr");
  const useMerges = $("mergeMode").value === "merge";
  const skip = new Set();

  row.cells.forEach((cell, index) => {
    if (!cell || skip.has(index)) return;

    const element = document.createElement(tag);
    element.textContent = cell.text || "";

    if (useMerges) {
      if (cell.colspan > 1) {
        element.colSpan = cell.colspan;
        for (let k = 1; k < cell.colspan; k++) skip.add(index + k);
      }
      if (cell.rowspan > 1) element.rowSpan = cell.rowspan;
    }

    if (cell.filledDown) element.classList.add("derived");

    tr.appendChild(element);
  });

  return tr;
}

/* Unduh */

function baseName() {
  return currentFile.name.replace(/\.pdf$/i, "");
}

$("downloadBtn").addEventListener("click", async () => {
  if (!table) {
    setStatus("Belum ada Preview yang valid. Klik Preview terlebih dahulu.", "error");
    return;
  }
  if (readOptions().mode === "catalog") {
    const { downloadCatalogWorkbook } = await import("./lib/catalog-export.js");
    await downloadCatalogWorkbook(table, `${baseName()}.xlsx`, readOptions());
  } else {
    downloadWorkbook(table, `${baseName()}.xlsx`, readOptions());
  }
});
