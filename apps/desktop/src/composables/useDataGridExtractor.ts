import { computed, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { useToast } from "@/composables/useToast";
import { normalizeSelectedColumnIndexes, type CellSelectionMatrix, type SelectionData } from "@/lib/dataGrid/gridSelection";
import {
  DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS,
  DATA_GRID_EXTRACTOR_CONTRACT_VERSION,
  DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS,
  DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
  normalizeDataGridExtractorOptions,
  type DataGridCopyExtractorId,
  type DataGridExtractPreview,
  type DataGridExtractRequest,
  type DataGridExtractorOptions,
  type DataGridExtractWarningCode,
} from "@/lib/dataGrid/dataGridCopyExtractor";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import type { DatabaseType } from "@/types/database";

interface ExtractorRowItem {
  id: number;
  data: SelectionData["rows"][number];
  isDraft?: boolean;
}

interface UseDataGridExtractorOptions {
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<ExtractorRowItem[]>;
  allColumns: ComputedRef<string[]>;
  allDisplayItems: ComputedRef<ExtractorRowItem[]>;
  allSourceColumns: ComputedRef<Array<string | undefined> | undefined>;
  visibleColumnIndexes: ComputedRef<number[]>;
  extractorOptions?: ComputedRef<DataGridExtractorOptions>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  tableMeta: ComputedRef<DataGridTableMeta | undefined>;
  hasCellSelection: ComputedRef<boolean>;
  selectedCells: ComputedRef<SelectionData>;
  selectedCellMatrix: ComputedRef<CellSelectionMatrix | null>;
  hasRowSelection: ComputedRef<boolean>;
  hasColumnSelection: ComputedRef<boolean>;
  selectedRowIds: Ref<Set<number>> | ComputedRef<Set<number>>;
  copyText: (text: string, gridCopy?: { rows: readonly (readonly unknown[])[]; includeHeader?: boolean }) => Promise<boolean>;
  canCopySqlInsert: (request: DataGridExtractRequest) => boolean;
  buildMongoInsert: (extractorOptions: DataGridExtractorOptions, rowLimit?: number) => Promise<string | undefined>;
}

export function useDataGridExtractor(options: UseDataGridExtractorOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const hasUnsupportedDiscreteSelection = computed(() => options.hasCellSelection.value && options.selectedCellMatrix.value === null);

  function selectionData(): SelectionData | null {
    if (options.hasRowSelection.value && options.selectedRowIds.value.size > 0) {
      const rows = options.displayItems.value.filter((item) => options.selectedRowIds.value.has(item.id) && !item.isDraft).map((item) => item.data);
      return rows.length > 0 ? { columns: options.columns.value, rows } : null;
    }
    return options.hasCellSelection.value ? options.selectedCells.value : null;
  }

  function buildRequest(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions = options.extractorOptions?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): DataGridExtractRequest | null {
    const visibleIndexes = options.visibleColumnIndexes.value;
    const sourceNames = options.allSourceColumns.value;
    const fullColumns = options.allColumns.value;
    const fullItemsById = new Map(options.allDisplayItems.value.map((item) => [item.id, item]));
    let sourceRows: unknown[][] = [];
    let selectedSourceIndexes: number[] = [];
    let selectionKind: DataGridExtractRequest["selectionKind"] = "cells";

    if (options.hasRowSelection.value && options.selectedRowIds.value.size > 0) {
      sourceRows = options.displayItems.value.filter((item) => options.selectedRowIds.value.has(item.id) && !item.isDraft).map((item) => (fullItemsById.get(item.id) ?? item).data);
      selectedSourceIndexes = normalizeSelectedColumnIndexes(visibleIndexes).filter((index) => index < fullColumns.length);
      selectionKind = "rows";
    } else if (options.selectedCellMatrix.value) {
      const matrix = options.selectedCellMatrix.value;
      sourceRows = matrix.rowIndexes
        .map((rowIndex) => options.displayItems.value[rowIndex])
        .filter((item): item is ExtractorRowItem => !!item && !item.isDraft)
        .map((item) => (fullItemsById.get(item.id) ?? item).data);
      selectedSourceIndexes = normalizeSelectedColumnIndexes(matrix.columnIndexes.map((index) => visibleIndexes[index] ?? index)).filter((index) => index < fullColumns.length);
      if (options.hasColumnSelection.value) selectionKind = "columns";
    }

    if (sourceRows.length === 0 || selectedSourceIndexes.length === 0) return null;
    const requiredSourceIndexes = [...selectedSourceIndexes];
    if (extractor === "sql-updates") {
      for (const primaryKey of options.tableMeta.value?.primaryKeys ?? []) {
        const primaryKeyIndex = fullColumns.findIndex((displayName, index) => normalizeName(sourceNames?.[index] ?? displayName) === normalizeName(primaryKey));
        if (primaryKeyIndex >= 0 && !requiredSourceIndexes.includes(primaryKeyIndex)) requiredSourceIndexes.push(primaryKeyIndex);
      }
    }
    const compactIndexBySource = new Map(requiredSourceIndexes.map((sourceIndex, compactIndex) => [sourceIndex, compactIndex]));
    const columns = requiredSourceIndexes.map((sourceIndex, compactIndex) => ({
      displayName: fullColumns[sourceIndex],
      sourceName: sourceNames?.[sourceIndex],
      sourceIndex: compactIndex,
    }));
    const selectedColumnIndexes = selectedSourceIndexes.map((sourceIndex) => compactIndexBySource.get(sourceIndex)).filter((index): index is number => index !== undefined);
    const rows = sourceRows.map((row) => requiredSourceIndexes.map((sourceIndex) => row[sourceIndex]));
    const descriptor = DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS[extractor];
    const tableMeta =
      descriptor.category === "sql"
        ? compactTableMeta(
            options.tableMeta.value,
            columns.map((column) => column.sourceName ?? column.displayName),
          )
        : undefined;
    return {
      version: DATA_GRID_EXTRACTOR_CONTRACT_VERSION,
      extractor,
      databaseType: descriptor.category === "sql" ? options.databaseType.value : undefined,
      tableMeta,
      columns,
      selectedColumnIndexes,
      rows,
      selectionKind,
      options: normalizeDataGridExtractorOptions(extractorOptions),
    };
  }

  function canBuildSqlUpdateRequest(): boolean {
    const request = buildRequest("sql-updates");
    const primaryKeys = request?.tableMeta?.primaryKeys ?? [];
    if (!request || primaryKeys.length === 0) return false;
    const primaryKeyNames = new Set(primaryKeys.map(normalizeName));
    const hasWritableColumn = request.selectedColumnIndexes.some((index) => {
      const column = request.columns[index];
      if (!column) return false;
      const sourceName = column.sourceName ?? column.displayName;
      return !primaryKeyNames.has(normalizeName(sourceName)) && (!request.options.sql.skipGeneratedColumns || !isAutoGeneratedColumn(sourceName, request.tableMeta)) && (!request.options.sql.skipComputedColumns || !isComputedColumn(sourceName, request.tableMeta));
    });
    if (!hasWritableColumn) return false;
    return primaryKeys.every((primaryKey) => {
      const column = request.columns.find((candidate) => normalizeName(candidate.sourceName ?? candidate.displayName) === normalizeName(primaryKey));
      return !!column && request.rows.every((row) => row[column.sourceIndex] !== null && row[column.sourceIndex] !== undefined);
    });
  }

  function canCopyWithExtractor(extractor: DataGridCopyExtractorId): boolean {
    if (hasUnsupportedDiscreteSelection.value) return false;
    if (!options.hasRowSelection.value && !options.hasCellSelection.value) return false;
    if (extractor === "sql-inserts") {
      const request = buildRequest(extractor);
      return request !== null && options.canCopySqlInsert(request);
    }
    if (extractor === "sql-updates") return canBuildSqlUpdateRequest();
    return selectionData() !== null;
  }

  async function copyWithExtractor(extractor: DataGridCopyExtractorId): Promise<boolean> {
    if (hasUnsupportedDiscreteSelection.value) {
      toast(t("grid.copyExtractorUnsupportedSelection"), 5000);
      return false;
    }
    if (!canCopyWithExtractor(extractor)) return false;
    const request = buildRequest(extractor);
    if (!request) return false;
    try {
      const result =
        extractor === "sql-inserts" && options.databaseType.value === "mongodb"
          ? {
              text: (await options.buildMongoInsert(request.options)) ?? "",
              mimeType: "application/javascript",
              fileExtension: "js",
              rowCount: request.rows.length,
              columnCount: request.selectedColumnIndexes.length,
            }
          : await api.extractDataGridSelection(request);
      if (!result.text) return false;
      const selection = selectionData();
      const copied = await options.copyText(result.text, extractor === "tsv" && selection ? { rows: selection.rows } : extractor === "tsv-with-headers" && selection ? { rows: selection.rows, includeHeader: true } : undefined);
      if (!copied) return false;
      showWarnings(result.warnings, result.omittedColumns);
      return true;
    } catch (error: unknown) {
      toast(t("grid.copyFailed", { message: errorMessage(error) }), 5000);
      return false;
    }
  }

  async function previewWithExtractor(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions): Promise<DataGridExtractPreview> {
    if (hasUnsupportedDiscreteSelection.value) throw new Error(t("grid.copyExtractorUnsupportedSelection"));
    const request = buildRequest(extractor, extractorOptions);
    if (!request) throw new Error(t("grid.copyExtractorEmptySelection"));
    const sourceRowCount = request.rows.length;
    const previewRowCount = Math.min(sourceRowCount, DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS);
    const result =
      extractor === "sql-inserts" && options.databaseType.value === "mongodb"
        ? {
            text: (await options.buildMongoInsert(request.options, DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS)) ?? "",
            mimeType: "application/javascript",
            fileExtension: "js",
            rowCount: previewRowCount,
            columnCount: request.selectedColumnIndexes.length,
          }
        : await api.extractDataGridSelection({ ...request, rows: request.rows.slice(0, DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS) });
    if (!result.text) throw new Error(t("grid.copyExtractorEmptySelection"));
    return { ...result, sourceRowCount, truncated: sourceRowCount > result.rowCount };
  }

  function showWarnings(warnings: Array<{ code: DataGridExtractWarningCode; message: string }> | undefined, omittedColumns: string[] | undefined) {
    if (!warnings?.length) return;
    for (const warning of warnings) {
      const message = warning.code === "omitted-columns" ? t("grid.copyExtractorWarningOmittedColumns", { columns: omittedColumns?.join(", ") || "-" }) : t("grid.copyExtractorWarningDuplicateJsonColumns");
      toast(message, 5000);
    }
  }

  return { copyWithExtractor, previewWithExtractor, canCopyWithExtractor };
}

function compactTableMeta(tableMeta: DataGridTableMeta | undefined, requiredColumns: string[]): DataGridTableMeta | undefined {
  if (!tableMeta?.columns) return tableMeta;
  const requiredNames = new Set(requiredColumns.map(normalizeName));
  return { ...tableMeta, columns: tableMeta.columns.filter((column) => requiredNames.has(normalizeName(column.name))) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const unquoted = (first === "`" && last === "`") || (first === '"' && last === '"') || (first === "[" && last === "]") ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/[a-z]/g, (character) => character.toUpperCase());
}

function columnExtra(column: string, tableMeta: DataGridTableMeta | undefined): string {
  const columnInfo = tableMeta?.columns?.find((item) => normalizeName(item.name) === normalizeName(column));
  return columnInfo?.extra?.toLowerCase() ?? "";
}

function isAutoGeneratedColumn(column: string, tableMeta: DataGridTableMeta | undefined): boolean {
  return /\b(auto_increment|autoincrement|identity)\b/.test(columnExtra(column, tableMeta));
}

function isComputedColumn(column: string, tableMeta: DataGridTableMeta | undefined): boolean {
  const extra = columnExtra(column, tableMeta);
  return extra.includes("generated always as") && !extra.includes("identity");
}
