import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildExportWorkbook, DATE_NUM_FMT, type ExportColumn } from './workbook'
import { zonedCalendarDateForExcel, ymdForExcel } from '@/lib/exportTime'

/**
 * The XLSX writer's cell TYPING, not its cosmetics.
 *
 * The 'date' column format is the reason this suite exists: the Lesson Date
 * columns stopped being text and became real Excel date cells so the column
 * sorts and date-filters chronologically. That only holds if three things are
 * true at once, and each is asserted below by round-tripping a real workbook
 * through ExcelJS rather than by inspecting the object we just built:
 *
 *   1. the cell is typed ValueType.Date (not String, not Number),
 *   2. its instant survives the write/read unchanged (no serial shift), and
 *   3. it carries the 'd mmmm yyyy' number format.
 *
 * The numeric formats are asserted alongside as a regression net — the 'date'
 * branch is set per data cell while those stay column-level, and it would be
 * easy to break one while adding the other.
 */

// Layout constants mirrored from workbook.ts (module-private there).
const ROW_HEADER = 5
const ROW_FIRST_DATA = 6

async function roundTrip(
  columns: ExportColumn[],
  rows: Record<string, unknown>[],
): Promise<ExcelJS.Worksheet> {
  const buffer = await buildExportWorkbook({
    title: 'Test Report',
    columns,
    rows,
    generatedAtLabel: '21 August 2026, 14:05',
    timezoneLabel: 'SAST',
    filterLines: [],
    sheetName: 'Test',
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.getWorksheet('Test')
  if (!ws) throw new Error('worksheet Test missing from the written workbook')
  return ws
}

describe("buildExportWorkbook 'date' column format", () => {
  const columns: ExportColumn[] = [
    { header: 'Date (SAST)', key: 'Date (SAST)', width: 18, format: 'date' },
    { header: 'Time (SAST)', key: 'Time (SAST)', width: 16 },
    { header: 'Duration (min)', key: 'Duration (min)', width: 14, format: 'integer' },
  ]

  it('writes a real Excel DATE cell, not text', async () => {
    const ws = await roundTrip(columns, [
      {
        'Date (SAST)': zonedCalendarDateForExcel('2026-08-20T23:30:00Z', 'Africa/Johannesburg'),
        'Time (SAST)': '01:30 - 02:30',
        'Duration (min)': 60,
      },
    ])
    const cell = ws.getCell(ROW_FIRST_DATA, 1)
    expect(cell.type).toBe(ExcelJS.ValueType.Date)
    expect(cell.value).toBeInstanceOf(Date)
  })

  it('round-trips the instant with no serial shift', async () => {
    const ws = await roundTrip(columns, [
      {
        'Date (SAST)': zonedCalendarDateForExcel('2026-08-20T23:30:00Z', 'Africa/Johannesburg'),
        'Time (SAST)': '01:30 - 02:30',
        'Duration (min)': 60,
      },
    ])
    // 23:30Z on 20 Aug is 21 August in SAST — that is the day the cell must hold.
    expect((ws.getCell(ROW_FIRST_DATA, 1).value as Date).toISOString()).toBe(
      '2026-08-21T00:00:00.000Z'
    )
  })

  it("applies the 'd mmmm yyyy' number format to the data cell", async () => {
    const ws = await roundTrip(columns, [
      {
        'Date (SAST)': zonedCalendarDateForExcel('2026-08-21T11:30:00Z', 'Africa/Johannesburg'),
        'Time (SAST)': '13:30 - 14:30',
        'Duration (min)': 60,
      },
    ])
    expect(ws.getCell(ROW_FIRST_DATA, 1).numFmt).toBe(DATE_NUM_FMT)
    expect(DATE_NUM_FMT).toBe('d mmmm yyyy')
  })

  it('renders a null date as an empty cell, never NaN', async () => {
    const ws = await roundTrip(columns, [
      { 'Date (SAST)': null, 'Time (SAST)': '', 'Duration (min)': 60 },
    ])
    const cell = ws.getCell(ROW_FIRST_DATA, 1)
    expect(cell.value).toBeNull()
    expect(cell.type).toBe(ExcelJS.ValueType.Null)
  })

  it('accepts a date-only value built by ymdForExcel with no timezone shift', async () => {
    const ws = await roundTrip(
      [{ header: 'Start Date', key: 'Start Date', width: 18, format: 'date' }],
      [{ 'Start Date': ymdForExcel('2026-08-01') }]
    )
    const cell = ws.getCell(ROW_FIRST_DATA, 1)
    expect(cell.type).toBe(ExcelJS.ValueType.Date)
    expect((cell.value as Date).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(cell.numFmt).toBe(DATE_NUM_FMT)
  })

  it('sorts chronologically, which is the whole point of a date cell', async () => {
    const ws = await roundTrip(columns, [
      { 'Date (SAST)': ymdForExcel('2026-03-02'), 'Time (SAST)': '', 'Duration (min)': 60 },
      { 'Date (SAST)': ymdForExcel('2026-04-01'), 'Time (SAST)': '', 'Duration (min)': 60 },
    ])
    const first = ws.getCell(ROW_FIRST_DATA, 1).value as Date
    const second = ws.getCell(ROW_FIRST_DATA + 1, 1).value as Date
    // As text, '1 April 2026' sorts BEFORE '2 March 2026'. As dates it does not.
    expect(second.getTime()).toBeGreaterThan(first.getTime())
  })

  it('leaves the header row as text, untouched by the date format', async () => {
    const ws = await roundTrip(columns, [
      {
        'Date (SAST)': zonedCalendarDateForExcel('2026-08-21T11:30:00Z', 'Africa/Johannesburg'),
        'Time (SAST)': '13:30 - 14:30',
        'Duration (min)': 60,
      },
    ])
    expect(ws.getCell(ROW_HEADER, 1).value).toBe('Date (SAST)')
    expect(ws.getCell(ROW_HEADER, 2).value).toBe('Time (SAST)')
  })

  it('keeps the title and generated-at banner rows intact', async () => {
    const ws = await roundTrip(columns, [
      {
        'Date (SAST)': zonedCalendarDateForExcel('2026-08-21T11:30:00Z', 'Africa/Johannesburg'),
        'Time (SAST)': '13:30 - 14:30',
        'Duration (min)': 60,
      },
    ])
    expect(ws.getCell(1, 1).value).toBe('Test Report')
    expect(ws.getCell(2, 1).value).toBe('Generated 21 August 2026, 14:05 (SAST) | 1 row(s)')
  })
})

describe('buildExportWorkbook numeric formats (regression net)', () => {
  it('still applies the numeric column formats', async () => {
    const ws = await roundTrip(
      [
        { header: 'Count', key: 'Count', width: 10, format: 'integer' },
        { header: 'Hours', key: 'Hours', width: 10, format: 'decimal2' },
        { header: 'Amount', key: 'Amount', width: 10, format: 'money2' },
        { header: 'Name', key: 'Name', width: 10 },
      ],
      [{ Count: 3, Hours: 1.5, Amount: 42.5, Name: 'Ada' }]
    )
    expect(ws.getCell(ROW_FIRST_DATA, 1).numFmt).toBe('0')
    expect(ws.getCell(ROW_FIRST_DATA, 2).numFmt).toBe('0.00')
    expect(ws.getCell(ROW_FIRST_DATA, 3).numFmt).toBe('#,##0.00')
    expect(ws.getCell(ROW_FIRST_DATA, 1).type).toBe(ExcelJS.ValueType.Number)
    expect(ws.getCell(ROW_FIRST_DATA, 4).value).toBe('Ada')
  })

  it('does not put a date format on a non-date column', async () => {
    const ws = await roundTrip(
      [{ header: 'Name', key: 'Name', width: 10 }],
      [{ Name: 'Ada' }]
    )
    expect(ws.getCell(ROW_FIRST_DATA, 1).numFmt).not.toBe(DATE_NUM_FMT)
  })

  it('still writes the empty-state row when there are no rows', async () => {
    const ws = await roundTrip(
      [{ header: 'Date (SAST)', key: 'Date (SAST)', width: 18, format: 'date' }],
      []
    )
    expect(ws.getCell(ROW_FIRST_DATA, 1).value).toBe('No records matched these filters.')
  })
})
