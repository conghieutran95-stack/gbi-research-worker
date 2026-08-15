import { parse } from "csv-parse/sync";

export type TransparencyCsvRow = {
  advertiser_id?: string;
  creative_id?: string;
  format?: string;
  format_name?: string;
  first_shown_date?: string;
  last_shown_date?: string;
  advertiser_name?: string;
  regions_shown?: string;
  ad_type?: string;
  image_url?: string;
  transparency_url?: string;

  // Giữ lại các cột khác nếu extension thay đổi cấu trúc.
  [key: string]: string | undefined;
};

export type NormalizedTransparencyRow = {
  advertiserId?: string;
  advertiserName?: string;
  creativeId?: string;

  format?: string;
  formatName?: string;
  adType?: string;

  firstShownDate?: string;
  lastShownDate?: string;
  regionsShown?: string;

  imageUrl?: string;
  transparencyUrl?: string;

  raw: TransparencyCsvRow;
};

export type CsvImportResult = {
  totalRows: number;
  validRows: number;
  advertisers: Array<{
    advertiserId: string;
    advertiserName?: string;
  }>;
  imageUrls: string[];
  rows: NormalizedTransparencyRow[];
};

function clean(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = String(value).trim();

  return text || undefined;
}

function pick(
  row: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = clean(row[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function normalizeUrl(value?: string): string | undefined {
  if (!value) return undefined;

  const url = value.trim();

  if (!/^https?:\/\//i.test(url)) {
    return undefined;
  }

  return url;
}

/**
 * Parse CSV exported by Google Ads Transparency Data Exporter.
 *
 * Supports both:
 * - domain search exports
 * - advertiser search exports
 */
export function parseTransparencyCsv(
  csvText: string
): CsvImportResult {
  if (!csvText || !csvText.trim()) {
    throw new Error("CSV content is empty");
  }

  const parsed = parse(csvText, {
    columns: (headers: string[]) =>
      headers.map(normalizeHeader),

    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    trim: true,
  }) as Array<Record<string, unknown>>;

  const rows: NormalizedTransparencyRow[] = [];

  const advertiserMap = new Map<
    string,
    {
      advertiserId: string;
      advertiserName?: string;
    }
  >();

  const imageUrlSet = new Set<string>();

  for (const rawRow of parsed) {
    const advertiserId = pick(
      rawRow,
      "advertiser_id",
      "advertiserid"
    );

    const advertiserName = pick(
      rawRow,
      "advertiser_name",
      "advertiser"
    );

    const creativeId = pick(
      rawRow,
      "creative_id",
      "creativeid"
    );

    const format = pick(
      rawRow,
      "format"
    );

    const formatName = pick(
      rawRow,
      "format_name",
      "formatname"
    );

    const adType = pick(
      rawRow,
      "ad_type",
      "adtype"
    );

    const firstShownDate = pick(
      rawRow,
      "first_shown_date",
      "first_shown",
      "firstshown"
    );

    const lastShownDate = pick(
      rawRow,
      "last_shown_date",
      "last_shown",
      "lastshown"
    );

    const regionsShown = pick(
      rawRow,
      "regions_shown",
      "regions"
    );

    const imageUrl = normalizeUrl(
      pick(
        rawRow,
        "image_url",
        "imageurl",
        "image"
      )
    );

    const transparencyUrl = normalizeUrl(
      pick(
        rawRow,
        "transparency_url",
        "adlibraryurl",
        "ad_library_url",
        "detailslink",
        "details_link"
      )
    );

    const normalizedRaw: TransparencyCsvRow = {};

    for (const [key, value] of Object.entries(rawRow)) {
      normalizedRaw[key] = clean(value);
    }

    const row: NormalizedTransparencyRow = {
      advertiserId,
      advertiserName,
      creativeId,

      format,
      formatName,
      adType,

      firstShownDate,
      lastShownDate,
      regionsShown,

      imageUrl,
      transparencyUrl,

      raw: normalizedRaw,
    };

    /*
     * Một dòng được coi là hữu ích nếu ít nhất có:
     * advertiser ID, creative ID hoặc image URL.
     */
    if (
      !advertiserId &&
      !creativeId &&
      !imageUrl
    ) {
      continue;
    }

    rows.push(row);

    if (advertiserId) {
      const existing =
        advertiserMap.get(advertiserId);

      if (!existing) {
        advertiserMap.set(advertiserId, {
          advertiserId,
          advertiserName,
        });
      } else if (
        !existing.advertiserName &&
        advertiserName
      ) {
        existing.advertiserName =
          advertiserName;
      }
    }

    if (imageUrl) {
      imageUrlSet.add(imageUrl);
    }
  }

  return {
    totalRows: parsed.length,

    validRows: rows.length,

    advertisers: [
      ...advertiserMap.values(),
    ],

    imageUrls: [
      ...imageUrlSet.values(),
    ],

    rows,
  };
}
