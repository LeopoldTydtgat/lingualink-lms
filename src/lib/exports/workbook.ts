// src/lib/exports/workbook.ts
//
// Shared XLSX writer for the admin data exports. Every export route builds a
// row set + a column spec and hands them here; this module owns the workbook
// LAYOUT ONLY — it never selects rows, never filters, never computes money.
//
// Why XLSX and not CSV:
//   1. A CSV served as text/csv;charset=utf-8 with no BOM is opened by Excel on
//      Windows in the ANSI code page, so accented names render as mojibake.
//      XLSX carries its encoding inside the container, so the question does not
//      arise.
//   2. CSV forces every value to a string. Numbers written here stay numbers
//      with a number FORMAT, so they sort and sum in Excel.
//
// Because string cells in XLSX are inline/shared strings and are never parsed
// as formulas, the CSV leading-=/+/@ escaping guard is not needed and must not
// be reintroduced — it would corrupt legitimate values.

import ExcelJS from 'exceljs'

// ─── Public types ─────────────────────────────────────────────────────────────

export type ExportCellFormat = 'text' | 'integer' | 'decimal1' | 'decimal2' | 'money2'

export interface ExportColumn {
  header: string
  key: string
  width: number
  format?: ExportCellFormat // default 'text'
  wrap?: boolean            // default false; true for long free-text columns
}

export interface BuildWorkbookOptions {
  title: string                       // e.g. "All Classes Report"
  columns: ExportColumn[]
  rows: Record<string, unknown>[]
  generatedAtLabel: string            // pre-formatted instant string
  timezoneLabel: string               // e.g. "SAST"
  filterLines: string[]               // human-readable applied filters; may be empty
  sheetName: string                   // <= 31 chars, no [ ] : * ? / \
  totalsRow?: Record<string, unknown> // optional; keyed by column key
  freezeColumns?: number              // default 0
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const ROW_TITLE = 1
const ROW_META = 2
const ROW_FILTERS = 3
const ROW_SPACER = 4
const ROW_HEADER = 5
const ROW_FIRST_DATA = 6

const BRAND_ORANGE = 'FFFF8303'
const HEADER_TEXT = 'FFFFFFFF'
const TITLE_TEXT = 'FF111827'
const SUBTLE_TEXT = 'FF6B7280'
const EMPTY_TEXT = 'FF9CA3AF'
const BORDER_STRONG = 'FFE0DFDC'
const BORDER_SOFT = 'FFF3F4F6'
const BAND_FILL = 'FFFAFAFA'
const TOTALS_FILL = 'FFF3F4F6'

// numFmt only affects NUMERIC cells. A column may legitimately hold a string in
// some rows (the literal 'varies', or 'Mixed currencies - see rows'); those stay
// text and are left exactly as the caller passed them — never coerced.
const NUM_FMT: Record<ExportCellFormat, string | null> = {
  text: null,
  integer: '0',
  decimal1: '0.0',
  decimal2: '0.00',
  money2: '#,##0.00',
}

function thin(argb: string): ExcelJS.Border {
  return { style: 'thin', color: { argb } }
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } }
}

// ─── Writer ───────────────────────────────────────────────────────────────────

// Returns Buffer<ArrayBuffer> rather than the default Buffer<ArrayBufferLike>:
// only the former satisfies NextResponse's BodyInit, so the caller can hand the
// buffer straight to the response with no copy.
export async function buildExportWorkbook(opts: BuildWorkbookOptions): Promise<Buffer<ArrayBuffer>> {
  const { columns, rows } = opts
  const colCount = columns.length

  const workbook = new ExcelJS.Workbook()
  const ws = workbook.addWorksheet(opts.sheetName)

  // Keys + widths ONLY. Setting `header` here would make ExcelJS auto-write a
  // header into row 1 and destroy the title block; the header row is written
  // manually at ROW_HEADER below.
  ws.columns = columns.map(c => ({ key: c.key, width: c.width }))

  // Set column number formats BEFORE any cell exists so every cell created
  // afterwards inherits the format from its column style.
  for (const c of columns) {
    const fmt = NUM_FMT[c.format ?? 'text']
    if (fmt) ws.getColumn(c.key).numFmt = fmt
  }

  // Merge a whole row across the sheet and return its master cell.
  const bannerCell = (rowNumber: number): ExcelJS.Cell => {
    const cell = ws.getCell(rowNumber, 1)
    if (colCount > 1) ws.mergeCells(rowNumber, 1, rowNumber, colCount)
    return cell
  }

  // ── Row 1: title ──
  const titleCell = bannerCell(ROW_TITLE)
  titleCell.value = opts.title
  titleCell.font = { bold: true, size: 15, color: { argb: TITLE_TEXT } }
  titleCell.alignment = { horizontal: 'left', vertical: 'middle' }
  ws.getRow(ROW_TITLE).height = 26

  // ── Row 2: generated-at + row count ──
  const metaCell = bannerCell(ROW_META)
  metaCell.value = `Generated ${opts.generatedAtLabel} (${opts.timezoneLabel}) | ${rows.length} row(s)`
  metaCell.font = { size: 10, color: { argb: SUBTLE_TEXT } }
  metaCell.alignment = { horizontal: 'left', vertical: 'middle' }

  // ── Row 3: applied filters ──
  const filterCell = bannerCell(ROW_FILTERS)
  filterCell.value = opts.filterLines.length
    ? `Filters: ${opts.filterLines.join('  |  ')}`
    : 'Filters: none (all records)'
  filterCell.font = { size: 10, color: { argb: SUBTLE_TEXT } }
  filterCell.alignment = { horizontal: 'left', vertical: 'middle' }

  // ── Row 4: spacer ──
  ws.getRow(ROW_SPACER).height = 6

  // ── Row 5: header ──
  const headerRow = ws.getRow(ROW_HEADER)
  headerRow.height = 24
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = c.header
    cell.fill = solidFill(BRAND_ORANGE)
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 }
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
    cell.border = {
      top: thin(BORDER_STRONG),
      left: thin(BORDER_STRONG),
      bottom: thin(BORDER_STRONG),
      right: thin(BORDER_STRONG),
    }
  })

  // ── Row 6+: data ──
  if (rows.length === 0) {
    // A filtered-to-nothing export still gets the full title block and header
    // row — never an empty or headerless file.
    const emptyCell = bannerCell(ROW_FIRST_DATA)
    emptyCell.value = 'No records matched these filters.'
    emptyCell.font = { italic: true, color: { argb: EMPTY_TEXT } }
    emptyCell.alignment = { horizontal: 'left', vertical: 'middle' }
  } else {
    rows.forEach((row, idx) => {
      const excelRow = ws.getRow(ROW_FIRST_DATA + idx)
      const banded = (idx + 1) % 2 === 0 // every SECOND data row
      columns.forEach((c, i) => {
        const cell = excelRow.getCell(i + 1)
        const value = row[c.key]
        cell.value = (value === undefined ? null : value) as ExcelJS.CellValue
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: c.wrap ?? false }
        cell.border = { bottom: thin(BORDER_SOFT) }
        if (banded) cell.fill = solidFill(BAND_FILL)
      })
    })
  }

  // ── Totals row (one blank spacer row above it) ──
  if (opts.totalsRow) {
    const totalsRow = opts.totalsRow
    const lastContentRow = ROW_FIRST_DATA + (rows.length > 0 ? rows.length : 1) - 1
    const excelRow = ws.getRow(lastContentRow + 2)
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1)
      // Only the keys present are written; the rest stay blank but keep the band.
      if (Object.prototype.hasOwnProperty.call(totalsRow, c.key)) {
        const value = totalsRow[c.key]
        cell.value = (value === undefined ? null : value) as ExcelJS.CellValue
      }
      cell.font = { bold: true }
      cell.fill = solidFill(TOTALS_FILL)
      cell.border = { top: thin(BORDER_STRONG) }
    })
  }

  // ── Sheet-level settings ──
  ws.views = [{ state: 'frozen', xSplit: opts.freezeColumns ?? 0, ySplit: ROW_HEADER }]
  ws.autoFilter = {
    from: { row: ROW_HEADER, column: 1 },
    to: { row: ROW_HEADER, column: colCount },
  }
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${ROW_HEADER}:${ROW_HEADER}`,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  }

  return Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer)
}
